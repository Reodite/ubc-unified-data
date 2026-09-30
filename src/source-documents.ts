import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { Http, Params } from "./base.ts";
import { compareStrings, InvalidValueError, simplifyJsonapi } from "./base.ts";
import { clean, headings, tables } from "./htmldoc.ts";

export type Row = Record<string, unknown>;

export interface SourceDocument extends Row {
  id: string;
  source_id: string;
  source_url: string;
  api_url: string | null;
  campus: string | null;
  title: string;
  content_html: string;
  content_text: string;
  content_sha256: string;
  source_modified_at: string | null;
  retrieved_at: string;
}

export function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Resolve public web links without admitting executable or credential-bearing URLs. */
export function webUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Plain text in document order, with boundaries between block elements and table cells. */
export function plainText(html: string): string {
  const $ = load(html, {}, false);
  $("script, style, noscript, template").remove();
  $("br, p, div, li, dt, dd, tr, td, th, h1, h2, h3, h4, h5, h6, section, article").each((_, element) => {
    $(element).before(" ").after(" ");
  });
  return clean($.root().text());
}

export function contentLinks(html: string, base: string): Array<{ text: string; url: string }> {
  const $ = load(html, {}, false);
  const found = new Map<string, { text: string; url: string }>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href")?.trim();
    if (!href || href.startsWith("#")) return;
    const url = webUrl(href, base);
    if (url && !found.has(url)) found.set(url, { text: plainText($(element).html() ?? ""), url });
  });
  return [...found.values()];
}

export function document(input: {
  sourceId: string;
  upstreamId: string | number;
  url: string;
  apiUrl?: string | null;
  campus: string | null;
  title: string;
  html: string;
  modified?: string | null;
  retrievedAt: string;
}): SourceDocument {
  const title = plainText(input.title);
  if (!title || !webUrl(input.url, input.url)) throw new InvalidValueError(`Invalid document: ${input.url}`);
  const $ = load(input.html, {}, false);
  $("script, style, noscript, template, form, iframe").remove();
  const html = $.root().html() ?? "";
  return {
    id: `${input.sourceId}:${input.upstreamId}`,
    source_id: input.sourceId,
    source_url: input.url,
    api_url: input.apiUrl ?? null,
    campus: input.campus,
    title,
    content_html: html,
    content_text: plainText(html),
    content_sha256: createHash("sha256").update(`${title}\n${html}`).digest("hex"),
    headings: headings(html),
    tables: tables(html),
    links: contentLinks(html, input.url),
    source_modified_at: input.modified ?? null,
    retrieved_at: input.retrievedAt,
  };
}

export function uniqueRows(rows: Row[], source: string): Row[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if ((typeof row.id !== "number" && typeof row.id !== "string") || String(row.id) === "") {
      throw new InvalidValueError(`Missing record id from ${source}`);
    }
    const id = String(row.id);
    if (ids.has(id)) throw new InvalidValueError(`Duplicate record id ${id} from ${source}`);
    ids.add(id);
  }
  return rows.sort((a, b) => compareStrings(String(a.id), String(b.id)));
}

function records(value: unknown, source: string): Row[] {
  if (!Array.isArray(value) || value.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
    throw new InvalidValueError(`Expected a record array from ${source}`);
  }
  return value as Row[];
}

/** Follow the entire advertised collection; reject duplicates, broken totals and pagination cycles. */
export async function wordpressPages(http: Http, host: string, filters: Params = {}): Promise<Row[]> {
  const url = `https://${host}/wp-json/wp/v2/pages`;
  const params = {
    ...filters,
    per_page: 100,
    orderby: "id",
    order: "asc",
    _fields: "id,link,title,content,parent,slug,status,type,modified_gmt",
  };
  const first = await http.get(url, { params: { ...params, page: 1 } });
  const totalHeader = first.headers.get("x-wp-total");
  const pagesHeader = first.headers.get("x-wp-totalpages");
  const total = Number(totalHeader);
  const pages = Number(pagesHeader);
  if (!totalHeader || !pagesHeader || !Number.isSafeInteger(total) || total < 1 || pages !== Math.ceil(total / 100)) {
    throw new InvalidValueError(`Missing or inconsistent WordPress totals from ${url}`);
  }
  const rows = records(await first.json(), url);
  const remaining = Array.from({ length: pages - 1 }, (_, i) => i + 2);
  const batches = await http.map(
    async (page) => records(await http.getJson(url, { params: { ...params, page } }), `${url}?page=${page}`),
    remaining,
    Math.min(http.workers, 3),
  );
  rows.push(...batches.flat());
  if (rows.length !== total) throw new InvalidValueError(`WordPress count mismatch at ${url}: ${rows.length}/${total}`);
  return uniqueRows(rows, url);
}

export async function drupalRecords(http: Http, host: string, resource: string, params: Params = {}): Promise<Row[]> {
  const endpoint = `https://${host}/jsonapi/${resource}`;
  const query = new URLSearchParams({ "page[limit]": "50", sort: "id" });
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  let next: string | null = `${endpoint}?${query}`;
  const visited = new Set<string>();
  const rows: Row[] = [];
  let expected: number | null = null;
  while (next) {
    const url = new URL(next);
    if (url.origin !== `https://${host}` || url.pathname !== `/jsonapi/${resource}` || visited.has(next)) {
      throw new InvalidValueError(`Unsafe or repeated JSON:API pagination link: ${next}`);
    }
    visited.add(next);
    const payload = object(await http.getJson(next));
    if (visited.size === 1 && typeof object(payload.meta).count === "number")
      expected = Number(object(payload.meta).count);
    const batch = records(payload.data, next);
    rows.push(...batch.map(simplifyJsonapi));
    const rawLink = object(payload.links).next;
    const link = typeof rawLink === "string" ? rawLink : object(rawLink).href;
    if (rawLink !== null && rawLink !== undefined && (typeof link !== "string" || !link)) {
      throw new InvalidValueError(`Invalid JSON:API next link from ${next}`);
    }
    if (link && batch.length === 0) throw new InvalidValueError(`Empty intermediate JSON:API page from ${next}`);
    next = link ? new URL(String(link), next).href : null;
  }
  if (expected !== null && rows.length !== expected) {
    throw new InvalidValueError(`JSON:API count mismatch at ${endpoint}: ${rows.length}/${expected}`);
  }
  return uniqueRows(rows, endpoint);
}

export function wordpressDocument(
  row: Row,
  sourceId: string,
  host: string,
  campus: string | null,
  at: string,
): SourceDocument {
  if (row.status !== "publish" || object(row.content).protected === true) {
    throw new InvalidValueError(`Non-public WordPress page from ${host}: ${row.id}`);
  }
  const url = string(row.link);
  if (new URL(url).hostname !== host) throw new InvalidValueError(`Unexpected WordPress source host: ${url}`);
  const modified = string(row.modified_gmt);
  return {
    ...document({
      sourceId,
      upstreamId: String(row.id),
      url,
      apiUrl: `https://${host}/wp-json/wp/v2/pages/${row.id}`,
      campus,
      title: string(object(row.title).rendered),
      html: string(object(row.content).rendered),
      modified: modified && modified !== "0000-00-00T00:00:00" ? `${modified}Z` : null,
      retrievedAt: at,
    }),
    upstream_id: row.id,
    parent_id: row.parent ? `${sourceId}:${row.parent}` : null,
    slug: row.slug,
  };
}

export const DOCUMENT_COLUMNS = {
  id: "Stable source-prefixed upstream identifier; use as the ingestion/upsert key",
  source_url: "Canonical official UBC page to cite; not an API or a mirrored copy",
  api_url: "Public record endpoint, when the source exposes one",
  content_text: "Derived plain text in reading order for search and retrieval",
  content_html: "Source content fragment, with scripts/forms/embeds removed; not safe to render as trusted HTML",
  content_sha256: "SHA-256 of title plus content_html, excluding retrieval timestamps",
  source_modified_at: "Publisher modification timestamp, or null when unavailable; not the collection time",
  retrieved_at: "UTC time this snapshot was collected",
  campus: "vancouver, okanagan, or null for university-wide/unlabelled content",
  tables: "Source table headers and rows as text; currency, eligibility and date qualifiers remain unparsed",
  links: "Deduplicated public HTTP(S) links resolved against source_url; linked files are not downloaded",
};
