import { InvalidValueError, type Http, type Params } from "../core/http.ts";
import { document, object, records, string, uniqueRows, type Row, type SourceDocument } from "../source-documents.ts";
import { collectPageBatches, isUnvisitedCollectionPage, nextLink } from "./pagination.ts";

/** Drop editorial/revision metadata; promote `path.alias` to its own column. */
export const JSONAPI_DROP = new Set([
  "metatag",
  "path",
  "promote",
  "sticky",
  "default_langcode",
  "revision_translation_affected",
  "revision_timestamp",
  "vid",
  "publish_on",
  "unpublish_on",
  "langcode",
]);

export function simplifyJsonapi(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: record["id"], type: record["type"] };
  const attrs = (record["attributes"] ?? {}) as Record<string, unknown>;
  for (const [rawKey, value] of Object.entries(attrs)) {
    const key = rawKey.startsWith("drupal_internal__") ? rawKey.slice("drupal_internal__".length) : rawKey;
    if (key === "path") {
      const alias = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["alias"] : null;
      if (alias) out["alias"] = alias;
      continue;
    }
    if (JSONAPI_DROP.has(key)) continue;
    out[key] = value;
  }

  const related: Record<string, unknown> = {};
  const relationships = (record["relationships"] ?? {}) as Record<string, unknown>;
  for (const [rawKey, value] of Object.entries(relationships)) {
    const data = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["data"] : null;
    if (data === null || data === undefined) continue;
    const key = rawKey.startsWith("field_") ? rawKey.slice("field_".length) : rawKey;
    if (Array.isArray(data)) {
      related[key] = data
        .filter((item) => typeof item === "object" && item !== null)
        .map((item) => (item as Record<string, unknown>)["id"]);
    } else if (typeof data === "object") {
      related[key] = (data as Record<string, unknown>)["id"];
    }
  }
  if (Object.keys(related).length > 0) out["related"] = related;
  return out;
}

/** Resource types a Drupal site exposes, e.g. `node--course`. */
export async function jsonapiIndex(http: Http, host: string): Promise<Set<string>> {
  const payload = (await http.getJson(`https://${host}/jsonapi`)) as Record<string, unknown>;
  const links = (payload["links"] ?? {}) as Record<string, unknown>;
  return new Set(Object.keys(links).filter((key) => key.includes("--")));
}

/** Fetch all records, pooling offsets when a total is available, otherwise
 * following `links.next`. Drupal caps `page[limit]` at 50. */
export async function jsonapiCollection(
  http: Http,
  host: string,
  resource: string,
  opts: { params?: Params; workers?: number; pageSize?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const pageSize = opts.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    throw new InvalidValueError("JSON:API page size must be a positive safe integer");
  const url = `https://${host}/jsonapi/${resource}`;
  const base: Params = { ...(opts.params ?? {}), "page[limit]": pageSize };

  const first = (await http.getJson(url, { params: { ...base, "page[offset]": 0 } })) as AnyJson;
  const records = ((first["data"] as unknown[]) ?? []).map((item) => simplifyJsonapi(item as Record<string, unknown>));
  const total = (first["meta"] as Record<string, unknown> | undefined)?.["count"];

  if (typeof total === "number" && Number.isInteger(total) && total > records.length) {
    if (!Number.isSafeInteger(total)) throw new InvalidValueError("JSON:API count exceeds safe pagination bounds");
    const offsets = [];
    for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset);
    return collectPageBatches(
      http,
      records,
      offsets,
      async (offset) => {
        const payload = (await http.getJson(url, { params: { ...base, "page[offset]": offset } })) as AnyJson;
        return ((payload["data"] as unknown[]) ?? []).map((item) => simplifyJsonapi(item as Record<string, unknown>));
      },
      opts.workers,
    );
  }

  const firstUrl = new URL(url);
  for (const [key, value] of Object.entries({ ...base, "page[offset]": 0 }))
    if (value !== undefined) firstUrl.searchParams.append(key, String(value));
  const visited = new Set([firstUrl.href]);
  let nextLink: string | undefined = (
    (first["links"] as Record<string, unknown> | undefined)?.["next"] as Record<string, unknown> | undefined
  )?.["href"] as string | undefined;
  while (nextLink) {
    const target = new URL(nextLink, url);
    if (!isUnvisitedCollectionPage(target, firstUrl.origin, firstUrl.pathname, visited))
      throw new InvalidValueError(`Unsafe or repeated JSON:API pagination link: ${nextLink}`);
    visited.add(target.href);
    const payload = (await http.getJson(target.href)) as AnyJson;
    const batch = (payload["data"] as unknown[]) ?? [];
    if (batch.length === 0) break;
    records.push(...batch.map((item) => simplifyJsonapi(item as Record<string, unknown>)));
    nextLink = (
      (payload["links"] as Record<string, unknown> | undefined)?.["next"] as Record<string, unknown> | undefined
    )?.["href"] as string | undefined;
  }
  return records;
}

type AnyJson = Record<string, unknown>;

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
    if (!isUnvisitedCollectionPage(url, `https://${host}`, `/jsonapi/${resource}`, visited)) {
      throw new InvalidValueError(`Unsafe or repeated JSON:API pagination link: ${next}`);
    }
    visited.add(next);
    const payload = object(await http.getJson(next));
    if (visited.size === 1 && typeof object(payload.meta).count === "number")
      expected = Number(object(payload.meta).count);
    const batch = records(payload.data, next);
    rows.push(...batch.map(simplifyJsonapi));
    const link = nextLink(
      object(payload.links).next,
      () => new InvalidValueError(`Invalid JSON:API next link from ${next}`),
    );
    if (link && batch.length === 0) throw new InvalidValueError(`Empty intermediate JSON:API page from ${next}`);
    next = link ? new URL(link, next).href : null;
  }
  if (expected !== null && rows.length !== expected) {
    throw new InvalidValueError(`JSON:API count mismatch at ${endpoint}: ${rows.length}/${expected}`);
  }
  return uniqueRows(rows, endpoint);
}

export function richText(value: unknown): string {
  return string(object(value).processed) || string(object(value).value);
}

export function drupalDocument(
  row: Row,
  sourceId: string,
  host: string,
  resource: string,
  campus: string | null,
  at: string,
  fields: Record<string, string> = {},
): SourceDocument {
  if (row.status !== true) throw new InvalidValueError(`Non-public Drupal node from ${host}: ${row.id}`);
  const alias = string(row.alias) || `/node/${row.nid}`;
  const url = new URL(alias, `https://${host}`).href;
  if (new URL(url).hostname !== host) throw new InvalidValueError(`Unexpected Drupal source host: ${url}`);
  const fragments = [richText(row.body)];
  for (const [name, label] of Object.entries(fields)) {
    const html = richText(row[name]);
    if (html) fragments.push(`<h2>${label}</h2>\n${html}`);
  }
  return {
    ...document({
      sourceId,
      upstreamId: String(row.id),
      url,
      apiUrl: `https://${host}/jsonapi/${resource}/${row.id}`,
      campus,
      title: string(row.title),
      html: fragments.join("\n"),
      modified: string(row.changed) || string(object(row.changed).value) || null,
      retrievedAt: at,
    }),
    upstream_id: row.id,
    unavailable_relationships: unavailableRelationships(row),
    related: Object.fromEntries(
      Object.entries(object(row.related)).filter(([key]) => !["uid", "revision_uid", "node_type"].includes(key)),
    ),
  };
}

export function unavailableRelationships(row: Row): string[] {
  return Object.entries(object(row.related))
    .filter(([, value]) => value === "missing" || (Array.isArray(value) && value.includes("missing")))
    .map(([key]) => key);
}
