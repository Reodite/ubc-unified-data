import { createHash } from "node:crypto";
import { load } from "cheerio";
import { InvalidValueError } from "./core/http.ts";
import { compareStrings } from "./core/utils.ts";
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

export function records(value: unknown, source: string): Row[] {
  if (!Array.isArray(value) || value.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
    throw new InvalidValueError(`Expected a record array from ${source}`);
  }
  return value as Row[];
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
