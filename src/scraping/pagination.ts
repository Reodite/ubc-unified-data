import type { Http } from "../core/http.ts";

/** Enumerate subsequent one-based pages; the first response is always read separately. */
function* remainingPageNumbers(pages: number): Generator<number> {
  for (let page = 2; page <= pages; page++) yield page;
}

/** Append pooled page batches in request order, retaining the caller's positions and worker limit. */
export async function collectPageBatches<T>(
  http: Pick<Http, "map">,
  first: T[],
  positions: readonly number[],
  read: (position: number) => Promise<T[]>,
  workers?: number,
): Promise<T[]> {
  const batches = await http.map(read, positions, workers);
  for (const batch of batches) first.push(...batch);
  return first;
}

/** Collect all numbered pages after an already-read first batch. */
export function collectNumberedPages<T>(
  http: Pick<Http, "map">,
  first: T[],
  pages: number,
  read: (page: number) => Promise<T[]>,
  workers?: number,
): Promise<T[]> {
  return collectPageBatches(http, first, [...remainingPageNumbers(pages)], read, workers);
}

/** Read page one even for a zero-total collection, then request each remaining page only after consumption. */
export async function* sequentialNumberedPages<T>(
  read: (page: number) => Promise<T>,
  totalPages: (first: T) => number,
): AsyncGenerator<T> {
  const first = await read(1);
  yield first;
  for (const page of remainingPageNumbers(totalPages(first))) yield await read(page);
}

/** Validate numeric totals only; callers own header syntax, zero-total policy and cross-page consistency. */
export function pageTotalsAgree(total: number, pages: number, perPage: number): boolean {
  return Number.isSafeInteger(total) && total >= 0 && pages === Math.ceil(total / perPage);
}

/** Accept a JSON:API string or href object, distinguishing absent links from malformed advertised links. */
export function nextLink(value: unknown, invalid: () => Error): string | null {
  if (value === null || value === undefined) return null;
  const href =
    typeof value === "string"
      ? value
      : typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).href
        : undefined;
  if (typeof href !== "string" || !href) throw invalid();
  return href;
}

/** Check collection boundaries and cycles without imposing an offset or empty-page policy. */
export function isUnvisitedCollectionPage(
  url: URL,
  origin: string,
  pathname: string,
  visited: ReadonlySet<string>,
): boolean {
  return url.origin === origin && url.pathname === pathname && !visited.has(url.href);
}
