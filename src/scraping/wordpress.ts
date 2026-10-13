import { InvalidValueError, type Http, type Params } from "../core/http.ts";
import { document, object, records, string, uniqueRows, type Row, type SourceDocument } from "../source-documents.ts";
import { collectNumberedPages, pageTotalsAgree } from "./pagination.ts";

/** Fetch every page of a WP REST collection using X-WP-TotalPages. */
export async function wpCollection(
  http: Http,
  host: string,
  pathName: string,
  opts: { params?: Params; perPage?: number; workers?: number } = {},
): Promise<unknown[]> {
  const url = `https://${host}/wp-json/${pathName}`;
  const base: Params = { ...(opts.params ?? {}), per_page: opts.perPage ?? 100 };

  const first = await http.get(url, { params: { ...base, page: 1 } });
  const records = (await first.json()) as unknown[];
  const pages = Number(first.headers.get("X-WP-TotalPages") || 1);

  if (pages > 1) {
    return collectNumberedPages(
      http,
      records,
      pages,
      async (page) => (await http.getJson(url, { params: { ...base, page } })) as unknown[],
      opts.workers,
    );
  }
  return records;
}

/** Follow the advertised collection; require positive first-page totals and complete, unique identities. */
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
  // Structured collections accept Number-compatible headers but require a nonempty collection.
  if (!totalHeader || !pagesHeader || total < 1 || !pageTotalsAgree(total, pages, 100)) {
    throw new InvalidValueError(`Missing or inconsistent WordPress totals from ${url}`);
  }
  const rows = await collectNumberedPages(
    http,
    records(await first.json(), url),
    pages,
    async (page) => records(await http.getJson(url, { params: { ...params, page } }), `${url}?page=${page}`),
    Math.min(http.workers, 3),
  );
  if (rows.length !== total) throw new InvalidValueError(`WordPress count mismatch at ${url}: ${rows.length}/${total}`);
  return uniqueRows(rows, url);
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
