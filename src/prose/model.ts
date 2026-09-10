import { createHash } from "node:crypto";
import { plainText } from "../source-documents.ts";
import { publicUbcUrl } from "./client.ts";
import { toSafeMarkdown } from "./markdown.ts";
import { secureUbcLink } from "./urls.ts";

export interface ProseSource {
  key: string;
  title: string;
  host: string;
  campus: "vancouver" | null;
  strategy: "wordpress" | "drupal" | "sitemap" | "mirror";
  roots?: string[];
  wordpressTypes?: string[];
  drupalTypes?: string[];
  sitemaps?: string[];
  scope: (url: string, title?: string, recordType?: string) => string | null;
  selectors?: string[];
  exclusions?: string[];
}

export interface ArticleInput {
  url: string;
  title: string;
  html: string;
  upstreamId?: string | number;
  apiUrl?: string | null;
  sourceModifiedAt?: string | null;
  retrievedAt: string;
  sourceRecords?: Array<{ path: string; id: string | number | null }>;
  warnings?: string[];
}

export interface ProseArticle extends Record<string, unknown> {
  id: string;
  category: "prose";
  subcategory: string;
  source_id: string;
  source_url: string;
  api_url: string | null;
  upstream_id: string | number | null;
  title: string;
  content_markdown: string;
  content_sha256: string;
  campus: "vancouver" | null;
  audience: "undergraduate_and_shared";
  source_modified_at: string | null;
  retrieved_at: string;
  source_records: Array<{ path: string; id: string | number | null }>;
  links: Array<{ text: string; url: string }>;
  warnings: string[];
}

export type InventoryStatus = "collected" | "excluded" | "unavailable" | "failed" | "duplicate" | "no_prose";

export interface InventoryEntry extends Record<string, unknown> {
  url: string;
  discovered_by: string[];
  source_modified_at: string | null;
  status: InventoryStatus;
  reason: string | null;
  article_id: string | null;
  resolved_url?: string;
  http_status?: number | null;
}

export interface DiscoveryEntry {
  url: string;
  discoveredBy: string[];
  modified: string | null;
  upstreamId?: string | number;
  title?: string;
  html?: string;
  apiUrl?: string;
  retrievedAt?: string;
  protected?: boolean;
  recordType?: string;
}

export interface CollectionResult {
  source: string;
  articles: ProseArticle[];
  inventory: InventoryEntry[];
  discoveryErrors: string[];
  discoveryNotes: string[];
}

export function urlKey(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error(`Invalid article inventory URL: ${value}`);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.searchParams.sort();
  return url.href;
}

export function contentHash(title: string, markdown: string): string {
  return createHash("sha256").update(`${title}\n${markdown}`).digest("hex");
}

export function makeArticle(source: ProseSource, input: ArticleInput): ProseArticle | null {
  const sourceUrl = publicUbcUrl(secureUbcLink(input.url));
  const title = plainText(input.title);
  if (!title) throw new Error(`Article has no title: ${sourceUrl}`);
  if (!Number.isFinite(Date.parse(input.retrievedAt))) throw new Error(`Invalid retrieval time: ${sourceUrl}`);
  const converted = toSafeMarkdown(input.html, sourceUrl);
  if (!converted.markdown.trim()) return null;
  const identity = input.upstreamId ?? createHash("sha256").update(urlKey(sourceUrl)).digest("hex").slice(0, 24);
  return {
    id: `prose:${source.key}:${identity}`,
    category: "prose",
    subcategory: source.key,
    source_id: source.key,
    source_url: sourceUrl,
    api_url: input.apiUrl ?? null,
    upstream_id: input.upstreamId ?? null,
    title,
    content_markdown: converted.markdown,
    content_sha256: contentHash(title, converted.markdown),
    campus: source.campus,
    audience: "undergraduate_and_shared",
    source_modified_at: input.sourceModifiedAt ?? null,
    retrieved_at: input.retrievedAt,
    source_records: input.sourceRecords ?? [],
    links: converted.links,
    warnings: [...new Set([...(input.warnings ?? []), ...converted.warnings])],
  };
}

export function mergeDiscovery(entries: DiscoveryEntry[]): DiscoveryEntry[] {
  const merged = new Map<string, DiscoveryEntry>();
  for (const entry of entries) {
    const key = urlKey(entry.url);
    const previous = merged.get(key);
    if (!previous) merged.set(key, { ...entry, discoveredBy: [...entry.discoveredBy] });
    else {
      merged.set(key, {
        ...previous,
        ...entry,
        discoveredBy: [...new Set([...previous.discoveredBy, ...entry.discoveredBy])],
        modified: entry.modified ?? previous.modified,
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.url.localeCompare(b.url, "en"));
}
