import type { Http, Params } from "./http.ts";

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
  const url = `https://${host}/jsonapi/${resource}`;
  const base: Params = { ...(opts.params ?? {}), "page[limit]": opts.pageSize ?? 50 };

  const first = (await http.getJson(url, { params: { ...base, "page[offset]": 0 } })) as AnyJson;
  const records = ((first["data"] as unknown[]) ?? []).map((item) => simplifyJsonapi(item as Record<string, unknown>));
  const total = (first["meta"] as Record<string, unknown> | undefined)?.["count"];

  if (typeof total === "number" && Number.isInteger(total) && (total as number) > records.length) {
    const fetch = async (offset: number): Promise<Array<Record<string, unknown>>> => {
      const payload = (await http.getJson(url, { params: { ...base, "page[offset]": offset } })) as AnyJson;
      return ((payload["data"] as unknown[]) ?? []).map((item) => simplifyJsonapi(item as Record<string, unknown>));
    };
    const offsets = [];
    for (let offset = opts.pageSize ?? 50; offset < (total as number); offset += opts.pageSize ?? 50)
      offsets.push(offset);
    for (const chunk of await http.map(fetch, offsets, opts.workers)) records.push(...chunk);
    return records;
  }

  let nextLink: string | undefined = (
    (first["links"] as Record<string, unknown> | undefined)?.["next"] as Record<string, unknown> | undefined
  )?.["href"] as string | undefined;
  while (nextLink) {
    const payload = (await http.getJson(nextLink)) as AnyJson;
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
