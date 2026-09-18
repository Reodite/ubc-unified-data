import { load } from "cheerio";
import type { HostScraper, Observation } from "../contracts.ts";
import { hostUrl, inventoryUrl } from "../urls.ts";

const NON_DOCUMENT_TYPES = new Set([
  "attachment",
  "nav_menu_item",
  "wp_block",
  "wp_template",
  "wp_template_part",
  "wp_navigation",
  "wp_font_family",
  "wp_font_face",
  "wp_global_styles",
]);

export interface DiscoveredPage {
  url: string;
  modified: string | null;
  id: number;
  type: string;
  api_url: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a CMS object");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty CMS string");
  return value;
}

function link(value: unknown, relation: string): string {
  const links = object(object(value)._links)[relation];
  if (!Array.isArray(links) || links.length !== 1) throw new Error(`Ambiguous CMS ${relation} link`);
  return string(object(links[0]).href);
}

function total(observation: Observation, field: string): number {
  const value = observation.snapshot.headers[field];
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Missing or invalid ${field}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Oversized ${field}`);
  return number;
}

function json(observation: Observation): unknown {
  if (observation.snapshot.status !== 200 || !/json/i.test(observation.snapshot.headers["content-type"] ?? ""))
    throw new Error("A complete public JSON observation is required");
  return JSON.parse(observation.snapshot.body);
}

function modified(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = string(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text) ||
    !Number.isFinite(Date.parse(`${text}Z`)) ||
    new Date(`${text}Z`).toISOString() !== `${text}.000Z`
  )
    throw new Error("Invalid WordPress GMT modification time");
  return `${text}Z`;
}

function cmsUrl(value: string, base?: string): URL {
  const path = value.split(/[?#]/, 1)[0]!;
  if (/[\s\\#]/.test(value) || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%(?:2f|5c|25)/i.test(path))
    throw new Error("Invalid CMS route URL");
  const url = new URL(value, base);
  if (/\/{2,}/.test(url.pathname)) throw new Error("Invalid CMS route URL");
  return url;
}

function restRoute(url: URL): string | null {
  if (!url.search) return null;
  const query = url.search.slice(1).replace(/%2f/gi, "/");
  if (!/^rest_route=\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?$/.test(query)) throw new Error("Invalid CMS rest_route query");
  return query.slice("rest_route=".length);
}

function routeIdentity(url: URL): string {
  const route = restRoute(url);
  return route === null ? url.href : `${url.origin}${url.pathname}?rest_route=${route}`;
}

export function wordpressCollectionUrl(base: string, page: number): string {
  const url = cmsUrl(base);
  restRoute(url);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid CMS collection request");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  url.searchParams.set("order", "asc");
  url.searchParams.set("orderby", "id");
  url.searchParams.set("_fields", "id,link,title,status,type,modified_gmt");
  return url.href;
}

/** Read advertised API roots without probing unadvertised endpoints. */
export function advertisedWordpressRoots(homepage: Observation): string[] {
  const $ = load(homepage.snapshot.body);
  const advertised = $("link[rel='https://api.w.org/'][href]")
    .map((_, node) => $(node).attr("href")!)
    .get();
  for (const match of (homepage.snapshot.headers.link ?? "").matchAll(/<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/g))
    advertised.push(match[1]!);
  return advertised;
}

/** Exhaust declared public collections; inconsistent inventories block publication. */
export async function discoverWordpress(
  scraper: HostScraper,
  homepage: Observation,
  read: (url: string) => Promise<Observation>,
): Promise<DiscoveredPage[]> {
  const roots = [
    ...new Set(
      advertisedWordpressRoots(homepage)
        .map((url) => {
          const candidate = scraper.adapter.exactHostInventory
            ? inventoryUrl(url, scraper.hostname)
            : hostUrl(url, scraper.hostname);
          if (candidate !== null) cmsUrl(url, `https://${scraper.hostname}/`);
          return candidate;
        })
        .filter((url): url is string => url !== null),
    ),
  ];
  if (roots.length !== 1) throw new Error("One advertised WordPress API root is required");
  const apiRoot = new URL(roots[0]!);
  const queryRoot = restRoute(apiRoot);
  if (queryRoot !== null ? !scraper.adapter.exactHostInventory || queryRoot !== "/" : !apiRoot.pathname.endsWith("/"))
    throw new Error("Unsupported WordPress API root");
  const catalog = object(json(await read(apiRoot.href)));
  const routes = object(catalog.routes);
  const routeUrl = (key: string): string => {
    const route = object(routes[key]);
    if (!Array.isArray(route.methods) || !route.methods.includes("GET")) throw new Error("CMS route lacks public GET");
    const href = hostUrl(cmsUrl(link(route, "self"), apiRoot.origin).href, scraper.hostname);
    const expected = new URL(queryRoot === null ? key.replace(/^\//, "") : apiRoot.href, apiRoot);
    if (queryRoot !== null) expected.searchParams.set("rest_route", key);
    if (routeIdentity(new URL(href)) !== routeIdentity(expected))
      throw new Error("CMS route escapes its advertised namespace");
    return href;
  };
  const types = object(json(await read(routeUrl("/wp/v2/types"))));
  const allowed = new Set(
    scraper.adapter.allPublicTypes
      ? Object.keys(types).filter((key) => !NON_DOCUMENT_TYPES.has(key))
      : scraper.adapter.allowedTypes,
  );
  if (!allowed.size || (!scraper.adapter.allPublicTypes && allowed.size !== scraper.adapter.allowedTypes.length))
    throw new Error("Invalid declared CMS types");
  for (const key of Object.keys(types))
    if (!allowed.has(key) && !NON_DOCUMENT_TYPES.has(key)) throw new Error(`Unreviewed public CMS type: ${key}`);
  const pages: DiscoveredPage[] = [];
  for (const type of [...allowed].sort()) {
    const definition = object(types[type]);
    const namespace = string(definition.rest_namespace);
    const restBase = string(definition.rest_base);
    const validRestBase = scraper.adapter.exactHostInventory ? /^[a-z0-9_-]+$/ : /^[a-z0-9-]+$/;
    if (namespace !== "wp/v2" || !validRestBase.test(restBase))
      throw new Error("Unsupported content collection namespace");
    const collection = routeUrl(`/${namespace}/${restBase}`);
    if (scraper.adapter.apiContentFallback) {
      const item = object(routes[`/${namespace}/${restBase}/(?P<id>[\\d]+)`]);
      if (!Array.isArray(item.methods) || !item.methods.includes("GET"))
        throw new Error("CMS item route lacks public GET");
    }
    const items = hostUrl(cmsUrl(link(definition, "wp:items"), apiRoot.origin).href, scraper.hostname);
    if (routeIdentity(new URL(items)) !== routeIdentity(new URL(collection)))
      throw new Error("CMS type/route link mismatch");
    let expectedTotal: number | undefined;
    let expectedPages: number | undefined;
    const ids = new Set<number>();
    for (let page = 1; ; page++) {
      const observation = await read(wordpressCollectionUrl(collection, page));
      const records = json(observation);
      if (!Array.isArray(records) || records.length > 100) throw new Error("Invalid CMS page envelope");
      const count = total(observation, "x-wp-total");
      const pageCount = total(observation, "x-wp-totalpages");
      if (pageCount !== Math.ceil(count / 100)) throw new Error("CMS pagination totals disagree");
      expectedTotal ??= count;
      expectedPages ??= pageCount;
      if (count !== expectedTotal || pageCount !== expectedPages)
        throw new Error("CMS totals changed during discovery");
      for (const raw of records) {
        const row = object(raw);
        const id = row.id;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || ids.has(id))
          throw new Error("Invalid or duplicate CMS identity");
        if (row.status !== "publish" || row.type !== type) throw new Error("Unexpected CMS publication status/type");
        ids.add(id);
        const sourceModified = modified(row.modified_gmt);
        const url = scraper.adapter.exactHostInventory
          ? inventoryUrl(string(row.link), scraper.hostname)
          : hostUrl(string(row.link), scraper.hostname);
        if (!url) continue;
        const itemUrl = new URL(collection);
        if (queryRoot !== null) itemUrl.searchParams.set("rest_route", `${restRoute(itemUrl)}/${id}`);
        else itemUrl.pathname += `/${id}`;
        pages.push({
          url,
          modified: sourceModified,
          id,
          type,
          api_url: itemUrl.href,
        });
      }
      if (page >= Math.max(1, pageCount)) break;
      if (records.length === 0) throw new Error("Premature empty CMS page");
    }
    if (ids.size !== expectedTotal) throw new Error("CMS inventory did not exhaust its advertised total");
  }
  return pages;
}
