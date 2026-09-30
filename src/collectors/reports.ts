/** Institutional reports: finance, budget, enrolment and Facts & Figures.
 *
 * UBC does not publish its financials or institutional research as an API -- they
 * are PDF/CSV/XLSX documents attached to pages on finance.ubc.ca and pair.ubc.ca
 * (Planning, Analytics & Institutional Research). So this collector builds an
 * *index*: every page, plus every document linked from it with a resolved URL,
 * file type and the page it came from. That index is the machine-readable part;
 * the documents themselves stay at their source URLs.
 */

import type { Http, Output } from "../base.ts";
import { compareStrings, errorMessage, errorName, register, wpCollection } from "../base.ts";
import { unescapeHtml } from "../htmldoc.ts";

export const SITES: Record<string, [string, string[]]> = {
  finance: ["finance.ubc.ca", ["wp/v2/pages", "wp/v2/posts", "wp/v2/resources"]],
  pair: ["pair.ubc.ca", ["wp/v2/pages", "wp/v2/posts"]],
  facilities: ["facilities.ubc.ca", ["wp/v2/pages"]],
};

export const DOCUMENT_TYPES = new Set(["pdf", "csv", "xlsx", "xls", "docx", "doc", "pptx", "zip"]);
const HREF_RE = /href=["']([^"']+)["']/gi;
const TAG_RE = /<[^>]+>/g;

function text(value: unknown): string {
  if (value !== null && typeof value === "object") {
    value = (value as Record<string, unknown>)["rendered"] ?? "";
  }
  return typeof value === "string" ? value : "";
}

function plain(value: string): string {
  return unescapeHtml(value.replace(TAG_RE, " ")).trim();
}

/** Resolve `href` against `base` the way a URL joiner does: absolute URLs pass
 * through, host-relative URLs keep the scheme and host, protocol-relative and
 * other forms resolve against the page path. */
function urljoin(base: string, href: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}
function urlParsePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
function fileSuffix(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  return dot >= 0 ? pathname.slice(dot + 1).toLowerCase() : "";
}
function fileStem(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf("/") + 1);
}

export function documents(
  record: Record<string, unknown>,
  baseUrl: string,
  site: string,
  body: string | null = null,
): Array<Record<string, unknown>> {
  const pageLink = record["link"] ?? baseUrl;
  const sourceBody = body === null ? text(record["content"]) + text(record["excerpt"]) : body;
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const match of sourceBody.matchAll(HREF_RE)) {
    const href = match[1] ?? "";
    const url = urljoin(String(pageLink), unescapeHtml(href));
    const pathname = urlParsePath(url);
    const suffix = fileSuffix(pathname);
    if (!DOCUMENT_TYPES.has(suffix) || url in seen) continue;
    seen.add(url);
    rows.push({
      site,
      file_type: suffix,
      url,
      filename: fileStem(pathname),
      page_title: plain(text(record["title"])),
      page_url: pageLink,
      page_modified: record["modified_gmt"] ?? record["modified"],
    });
  }
  return rows;
}

export const Reports = register(
  class {
    name = "reports";
    folder = "reports";
    title = "Institutional reports (finance, budget, enrolment, Facts & Figures)";
    description =
      "An index of UBC's published institutional documents -- annual financial " +
      "reports, budgets, tuition and fee schedules, annual enrolment reports and " +
      "Facts & Figures sheets -- with a direct download URL, file type and the " +
      "source page for each, plus the underlying page content.";
    sources = Object.values(SITES).map(([host]) => `https://${host}`);

    async collect(http: Http, out: Output): Promise<void> {
      const allDocuments: Array<Record<string, unknown>> = [];
      const status: Array<Record<string, unknown>> = [];

      for (const [site, [host, paths]] of Object.entries(SITES)) {
        for (const path of paths) {
          const source = `https://${host}/wp-json/${path}`;
          let records: Array<Record<string, unknown>>;
          try {
            records = (await wpCollection(http, host, path)) as Array<Record<string, unknown>>;
          } catch (error) {
            status.push({
              site,
              endpoint: source,
              records: 0,
              skipped: `${errorName(error)}: ${errorMessage(error)}`,
            });
            continue;
          }

          const collectionName = path.slice(path.lastIndexOf("/") + 1);
          if (records.length > 0) {
            await out.table(`${site}/${collectionName}`, records, { source });
          }

          const empty: Array<Record<string, unknown>> = [];
          for (const record of records) {
            const found = documents(record, `https://${host}`, site);
            allDocuments.push(...found);
            // pair.ubc.ca returns every page with empty `content` over REST,
            // so the PDFs are only visible in the rendered page.
            if (found.length === 0 && text(record["content"]).trim() === "") {
              empty.push(record);
            }
          }

          const recovered = await this.fromHtml(http, empty, host, site);
          allDocuments.push(...recovered);
          status.push({
            site,
            endpoint: source,
            records: records.length,
            pages_refetched_as_html: empty.length,
            documents_recovered_from_html: recovered.length,
            skipped: null,
          });
        }
      }

      // One page can link the same document twice; collapse on URL, but keep
      // how many pages referenced it -- a high count usually means boilerplate.
      const counts: Record<string, number> = {};
      for (const row of allDocuments) {
        counts[String(row["url"])] = (counts[String(row["url"])] ?? 0) + 1;
      }
      const unique: Array<Record<string, unknown>> = [];
      const byUrl = new Map<string, Record<string, unknown>>();
      for (const row of allDocuments) {
        // The last page linking a URL supplies that document's metadata.
        byUrl.set(String(row["url"]), row);
      }
      unique.push(...byUrl.values());
      for (const row of unique) {
        row["linked_from_pages"] = counts[String(row["url"])];
      }
      unique.sort((a, b) => {
        for (const field of ["site", "file_type", "filename"] as const) {
          const cmp = compareStrings(String(a[field]), String(b[field]));
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
      out.describe("documents", {
        grain: "one published document, deduplicated across the pages that link it",
        columns: {
          site: "finance, pair or facilities",
          url: "direct download; the document itself is not mirrored here",
          filename: "the file as UBC named it -- usually the only title it has",
          file_type: "pdf, csv, xlsx...",
          page_title: "the page it was linked from",
          page_url: "that page",
          linked_from_pages: "how many pages link it; a high count usually means boilerplate",
        },
        joins: [],
      });
      await out.table("documents", unique);
      await out.json("_sources.json", status);
    }

    async fromHtml(
      http: Http,
      records: Array<Record<string, unknown>>,
      host: string,
      site: string,
    ): Promise<Array<Record<string, unknown>>> {
      if (records.length === 0) return [];

      const scrape = async (record: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
        const link = record["link"];
        if (!link) return [];
        let body: string;
        try {
          body = await http.getText(String(link));
        } catch {
          return [];
        }
        return documents(record, `https://${host}`, site, body);
      };

      const chunks = await http.map(scrape, records);
      const rows: Array<Record<string, unknown>> = [];
      for (const chunk of chunks) rows.push(...chunk);
      return rows;
    }
  },
);
