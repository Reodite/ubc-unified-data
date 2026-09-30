import { load } from "cheerio";
import { object, string, webUrl } from "../source-documents.ts";
import { ProseFetchError, publicUbcUrl, type ProseClient } from "./client.ts";
import { mergeDiscovery, type DiscoveryEntry, type ProseSource } from "./model.ts";
import { normalizedHref, secureUbcLink } from "./urls.ts";

export interface DiscoveryResult {
  entries: DiscoveryEntry[];
  notes: string[];
  errors: string[];
  inventories: string[];
}

const NON_ARTICLE_TYPES = new Set([
  "attachment",
  "nav_menu_item",
  "wp_block",
  "wp_template",
  "wp_template_part",
  "wp_global_styles",
  "wp_navigation",
  "wp_font_family",
  "wp_font_face",
  "tribe_events",
  "event",
  "events",
  "person",
  "people",
  "profile",
]);

export function sitemapEntries(xml: string, origin: string): { children: string[]; entries: DiscoveryEntry[] } {
  const $ = load(xml, { xml: true });
  if ($("sitemapindex").length === 1) {
    return {
      children: $("sitemapindex > sitemap > loc")
        .map((_, node) => publicUbcUrl($(node).text().trim(), origin))
        .get(),
      entries: [],
    };
  }
  if ($("urlset").length !== 1) throw new Error(`Expected an XML sitemap at ${origin}`);
  return {
    children: [],
    entries: $("urlset > url")
      .map((_, node) => ({
        url: new URL($(node).children("loc").text().trim(), origin).href,
        modified: $(node).children("lastmod").text().trim() || null,
        discoveredBy: [origin],
      }))
      .get(),
  };
}

export async function discoverSitemaps(source: ProseSource, client: ProseClient): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { entries: [], notes: [], errors: [], inventories: [] };
  const policy = await client.policy(`https://${source.host}`);
  const advertised = policy.robots.getSitemaps().filter((value) => new URL(value).hostname === source.host);
  const roots = [...new Set([...(source.sitemaps ?? []), ...advertised])];
  const guessed = roots.length === 0;
  if (guessed) roots.push(`https://${source.host}/sitemap.xml`, `https://${source.host}/wp-sitemap.xml`);
  const queue = [...roots];
  const seen = new Set<string>();
  let foundRoot = false;
  while (queue.length) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (new URL(url).hostname !== source.host) {
      result.errors.push(`Sitemap leaves declared source host: ${url}`);
      continue;
    }
    if (/wp-sitemap-(?:users|taxonomies)-/.test(url)) {
      result.notes.push(`Non-article author/taxonomy sitemap excluded: ${url}`);
      continue;
    }
    try {
      const response = await client.get(url);
      const parsed = sitemapEntries(response.body, url);
      foundRoot = true;
      result.inventories.push(url);
      result.entries.push(...parsed.entries);
      queue.push(...parsed.children);
    } catch (error) {
      if (
        guessed &&
        roots.includes(url) &&
        error instanceof ProseFetchError &&
        [404, 410].includes(error.status ?? 0)
      ) {
        result.notes.push(`No sitemap at conventional endpoint: ${url}`);
      } else result.errors.push(`${url}: ${String(error)}`);
    }
  }
  if (!foundRoot)
    result.notes.push("No accessible sitemap found; source discovery relies on other inventories and public links.");
  result.entries = mergeDiscovery(result.entries);
  return result;
}

/** Follow public JSON:API pagination through permission-filtered batches without requesting omitted records. */
export async function discoverDrupal(source: ProseSource, client: ProseClient): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { entries: [], notes: [], errors: [], inventories: [] };
  const origin = `https://${source.host}`;
  const index = object((await client.json(`${origin}/jsonapi`)).data);
  const advertised = new Set(Object.keys(object(index.links)));
  for (const type of source.drupalTypes ?? ["ubc_page", "ubc_landing_page"]) {
    const resourceType = `node--${type}`;
    if (!advertised.has(resourceType)) {
      result.notes.push(`JSON:API does not advertise ${resourceType} on ${source.host}.`);
      continue;
    }
    const endpoint = `${origin}/jsonapi/node/${type}`;
    const first = new URL(endpoint);
    first.searchParams.set("page[limit]", "50");
    first.searchParams.set("filter[status]", "1");
    first.searchParams.set("sort", "drupal_internal__nid");
    first.searchParams.set(`fields[${resourceType}]`, "drupal_internal__nid,title,path,changed,status");
    let next: string | null = first.href;
    const visited = new Set<string>();
    const ids = new Set<string>();
    let omissionPages = 0;
    let lastOffset = -1;
    try {
      while (next) {
        const url: URL = new URL(next);
        const offset = Number(url.searchParams.get("page[offset]") ?? "0");
        if (
          url.origin !== origin ||
          url.pathname !== new URL(endpoint).pathname ||
          visited.has(url.href) ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset <= lastOffset
        )
          throw new Error(`Unsafe or cyclic JSON:API next link: ${url.href}`);
        lastOffset = offset;
        visited.add(url.href);
        const { response, data } = await client.json(url.href);
        const payload = object(data);
        if (!Array.isArray(payload.data)) throw new Error(`Expected JSON:API record array: ${url.href}`);
        result.inventories.push(url.href);
        const omitted = object(object(payload.meta).omitted);
        if (Object.keys(omitted).length) omissionPages++;
        for (const raw of payload.data) {
          const row = object(raw);
          const attributes = object(row.attributes);
          if (row.type !== resourceType || !string(row.id) || ids.has(String(row.id)))
            throw new Error(`Invalid or duplicate JSON:API identity at ${url.href}`);
          ids.add(String(row.id));
          const alias = string(object(attributes.path).alias);
          const nid = attributes.drupal_internal__nid;
          if (!alias && typeof nid !== "number") throw new Error(`JSON:API record has no public route: ${row.id}`);
          result.entries.push({
            url: publicUbcUrl(alias || `/node/${nid}`, origin),
            discoveredBy: [endpoint],
            upstreamId: String(row.id),
            title: string(attributes.title),
            apiUrl: `${endpoint}/${row.id}`,
            modified: string(attributes.changed) || null,
            retrievedAt: response.retrieved_at,
            protected: attributes.status !== true,
            recordType: type,
          });
        }
        const rawNext = object(payload.links).next;
        const link = typeof rawNext === "string" ? rawNext : object(rawNext).href;
        if (rawNext !== null && rawNext !== undefined && (typeof link !== "string" || !link))
          throw new Error(`Invalid JSON:API next link: ${url.href}`);
        next = typeof link === "string" && link ? new URL(link, url).href : null;
      }
      result.notes.push(
        `${endpoint}: ${ids.size} accessible records across ${visited.size} terminally exhausted pages; ${omissionPages} pages reported inaccessible-resource omissions; omission links were not requested.`,
      );
    } catch (error) {
      result.errors.push(`${endpoint}: ${String(error)}${error instanceof ProseFetchError ? ` [${error.url}]` : ""}`);
    }
  }
  result.entries = mergeDiscovery(result.entries);
  return result;
}

/** Accept a complete JSON array, including the fully parsed suffix of a theme-prefixed WordPress response. */
export function wordpressPayload(body: string): { rows: unknown[]; discardedPrefix: boolean } {
  try {
    const parsed: unknown = JSON.parse(body.replace(/^\uFEFF/, ""));
    if (Array.isArray(parsed)) return { rows: parsed, discardedPrefix: false };
  } catch {}
  if (/^\s*<!doctype html/i.test(body)) {
    for (const match of body.matchAll(/\[\s*\{\s*"id"\s*:/g)) {
      try {
        const parsed: unknown = JSON.parse(body.slice(match.index));
        if (Array.isArray(parsed)) return { rows: parsed, discardedPrefix: true };
      } catch {}
    }
  }
  throw new Error("WordPress response contains no complete JSON record array");
}

/** Exhaust advertised WordPress content collections, counting unexposed placeholders without probing their records. */
export async function discoverWordpress(source: ProseSource, client: ProseClient): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { entries: [], notes: [], errors: [], inventories: [] };
  const origin = `https://${source.host}`;
  const typesEndpoint = `${origin}/wp-json/wp/v2/types`;
  const types = object((await client.json(typesEndpoint)).data);
  const selected = Object.entries(types).filter(([type, raw]) => {
    const rest = string(object(raw).rest_base);
    return rest && (source.wordpressTypes ? source.wordpressTypes.includes(rest) : !NON_ARTICLE_TYPES.has(type));
  });
  if (!selected.length) throw new Error(`No exposed prose content types at ${typesEndpoint}`);
  for (const [type, raw] of selected) {
    const entry = object(raw);
    const namespace = string(entry.rest_namespace) || "wp/v2";
    const endpoint = `${origin}/wp-json/${namespace}/${entry.rest_base}`;
    const seen = new Set<string>();
    let slots = 0;
    let omitted = 0;
    let expected: number | null = null;
    let pages = 1;
    try {
      for (let page = 1; page <= pages; page++) {
        const url = new URL(endpoint);
        for (const [key, value] of Object.entries({
          per_page: "100",
          page: String(page),
          order: "asc",
          orderby: "id",
          _fields: "id,link,title,content,parent,slug,status,type,modified_gmt,date_gmt,categories,tags,excerpt",
        }))
          url.searchParams.set(key, value);
        const response = await client.get(url.href);
        const parsed = wordpressPayload(response.body);
        const data = parsed.rows;
        if (parsed.discardedPrefix)
          result.notes.push(`Discarded theme HTML before a fully parsed WordPress JSON array: ${url.href}`);
        const totalHeader = response.headers["x-wp-total"];
        const pagesHeader = response.headers["x-wp-totalpages"];
        const total = Number(totalHeader);
        const advertisedPages = Number(pagesHeader);
        if (
          totalHeader === undefined ||
          pagesHeader === undefined ||
          !Number.isSafeInteger(total) ||
          total < 0 ||
          advertisedPages !== Math.ceil(total / 100) ||
          (expected !== null && expected !== total)
        )
          throw new Error(`Missing/changing WordPress totals: ${url.href}`);
        if (!Array.isArray(data)) throw new Error(`WordPress response is not an array: ${url.href}`);
        pages = advertisedPages;
        expected = total;
        slots += data.length;
        result.inventories.push(url.href);
        for (const rawRow of data) {
          const row = object(rawRow);
          if (row.id === undefined || !string(row.link)) {
            omitted++;
            continue;
          }
          const identity = String(row.id);
          if (seen.has(identity)) throw new Error(`Duplicate WordPress ${type} id ${identity}: ${endpoint}`);
          seen.add(identity);
          const modified = string(row.modified_gmt);
          const rawLink = string(row.link);
          const permalink = webUrl(normalizedHref(rawLink), origin);
          const needsResolution = !permalink;
          if (needsResolution)
            result.notes.push(
              `Invalid permalink for published ${type} ${identity}; resolving its standard public ?p= URL.`,
            );
          result.entries.push({
            url: secureUbcLink(permalink ?? `${origin}/?p=${encodeURIComponent(identity)}`),
            discoveredBy: [endpoint],
            upstreamId: identity,
            title: string(object(row.title).rendered),
            html: needsResolution ? undefined : string(object(row.content).rendered),
            apiUrl: `${endpoint}/${row.id}`,
            retrievedAt: response.retrieved_at,
            modified: modified && modified !== "0000-00-00T00:00:00" ? `${modified}Z` : null,
            protected: object(row.content).protected === true || row.status !== "publish",
            recordType: type,
          });
        }
      }
      if (slots !== expected) throw new Error(`WordPress inventory mismatch: ${endpoint}: ${slots}/${expected}`);
      result.notes.push(
        `${endpoint}: ${slots} advertised records, ${seen.size} identified, ${omitted} unexposed placeholders.`,
      );
    } catch (error) {
      result.errors.push(`${endpoint}: ${String(error)}${error instanceof ProseFetchError ? ` [${error.url}]` : ""}`);
    }
  }
  result.entries = mergeDiscovery(result.entries);
  return result;
}
