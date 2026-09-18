import { load } from "cheerio";
import type { HostScraper, Observation } from "../contracts.ts";
import { hostUrl } from "../urls.ts";

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

export function wordpressCollectionUrl(base: string, page: number): string {
  const url = new URL(base);
  if (url.search || url.hash || !Number.isSafeInteger(page) || page < 1)
    throw new Error("Invalid CMS collection request");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  url.searchParams.set("order", "asc");
  url.searchParams.set("orderby", "id");
  url.searchParams.set("_fields", "id,link,title,status,type,modified_gmt");
  return url.href;
}

/** Exhaust advertised public post collections; unknown content types and inconsistent totals block publication. */
export async function discoverWordpress(
  scraper: HostScraper,
  homepage: Observation,
  read: (url: string) => Promise<Observation>,
): Promise<DiscoveredPage[]> {
  const $ = load(homepage.snapshot.body);
  const advertised = $("link[rel='https://api.w.org/'][href]")
    .map((_, node) => $(node).attr("href")!)
    .get();
  for (const match of (homepage.snapshot.headers.link ?? "").matchAll(/<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/g))
    advertised.push(match[1]!);
  const roots = [...new Set(advertised.map((url) => hostUrl(url, scraper.hostname)))];
  if (roots.length !== 1) throw new Error("One advertised WordPress API root is required");
  const apiRoot = new URL(roots[0]!);
  if (apiRoot.search || !apiRoot.pathname.endsWith("/")) throw new Error("Unsupported WordPress API root");
  const catalog = object(json(await read(apiRoot.href)));
  const routes = object(catalog.routes);
  const routeUrl = (key: string): string => {
    const route = object(routes[key]);
    if (!Array.isArray(route.methods) || !route.methods.includes("GET")) throw new Error("CMS route lacks public GET");
    const href = hostUrl(link(route, "self"), scraper.hostname);
    if (href !== new URL(key.replace(/^\//, ""), apiRoot).href)
      throw new Error("CMS route escapes its advertised namespace");
    return href;
  };
  const types = object(json(await read(routeUrl("/wp/v2/types"))));
  const allowed = new Set(scraper.adapter.allowedTypes);
  if (!allowed.size || allowed.size !== scraper.adapter.allowedTypes.length)
    throw new Error("Invalid declared CMS types");
  for (const key of Object.keys(types))
    if (!allowed.has(key) && !NON_DOCUMENT_TYPES.has(key)) throw new Error(`Unreviewed public CMS type: ${key}`);
  const pages: DiscoveredPage[] = [];
  for (const type of [...allowed].sort()) {
    const definition = object(types[type]);
    const namespace = string(definition.rest_namespace);
    const restBase = string(definition.rest_base);
    if (namespace !== "wp/v2" || !/^[a-z0-9-]+$/.test(restBase))
      throw new Error("Unsupported content collection namespace");
    const collection = routeUrl(`/${namespace}/${restBase}`);
    if (scraper.adapter.apiContentFallback) {
      const item = object(routes[`/${namespace}/${restBase}/(?P<id>[\\d]+)`]);
      if (!Array.isArray(item.methods) || !item.methods.includes("GET"))
        throw new Error("CMS item route lacks public GET");
    }
    if (hostUrl(link(definition, "wp:items"), scraper.hostname) !== collection)
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
        pages.push({
          url: hostUrl(string(row.link), scraper.hostname),
          modified: modified(row.modified_gmt),
          id,
          type,
          api_url: `${collection}/${id}`,
        });
      }
      if (page >= Math.max(1, pageCount)) break;
      if (records.length === 0) throw new Error("Premature empty CMS page");
    }
    if (ids.size !== expectedTotal) throw new Error("CMS inventory did not exhaust its advertised total");
  }
  return pages;
}
