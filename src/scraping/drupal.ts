import { simplifyJsonapi } from "../core/drupal.ts";
import { InvalidValueError, type Http, type Params } from "../core/http.ts";
import { document, object, records, string, uniqueRows, type Row, type SourceDocument } from "../source-documents.ts";
import { isUnvisitedCollectionPage, nextLink } from "./pagination.ts";

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
