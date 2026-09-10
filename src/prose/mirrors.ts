import { readFile } from "node:fs/promises";
import path from "node:path";
import { compareStrings, DATA_DIR } from "../base.ts";
import { object, plainText, string, webUrl, type Row } from "../source-documents.ts";
import { fetchDisposition, ProseFetchError, type ProseClient } from "./client.ts";
import { extractArticle, needsRenderedHtml, NonArticleError } from "./html.ts";
import { makeArticle, urlKey, type CollectionResult, type InventoryEntry, type ProseSource } from "./model.ts";
import { commonExclusion } from "./sources.ts";
import { normalizedHref, secureUbcLink } from "./urls.ts";

export interface MirrorDefinition {
  source: ProseSource;
  files: string[];
  exclude?: (row: Row) => string | null;
}

function calendarScope(url: string, title = ""): string | null {
  const route = new URL(url).pathname;
  if (/\/(?:academic-staff|faculty-membership)(?:\/|$)/.test(route))
    return "Staff membership directory rather than a prose article.";
  if (/\/(?:redirect-error|404)(?:\/|$)/.test(route)) return "Navigation error page rather than an article.";
  const common = commonExclusion(url, title);
  if (common) return common;
  if (/undergraduate|bachelor/i.test(`${route} ${title}`)) return null;
  if (/\/(?:master-|doctor-philosophy|doctor-education|doctor-musical|professional-masters-degrees)/.test(route))
    return "Graduate degree program subtree outside undergraduate scope.";
  return null;
}

export const MIRROR_PROSE_SOURCES: MirrorDefinition[] = [
  {
    source: {
      key: "academic-calendar",
      title: "Vancouver Calendar undergraduate and shared prose",
      host: "vancouver.calendar.ubc.ca",
      campus: "vancouver",
      strategy: "mirror",
      scope: calendarScope,
      selectors: ["#unit-content > main", "article", "main"],
    },
    files: ["academic-calendar/vancouver/pages.json", "academic-calendar/vancouver/landing_pages.json"],
    exclude: (row) => (row.campus === "okanagan" ? "Okanagan Calendar record." : null),
  },
  {
    source: {
      key: "admissions",
      title: "Undergraduate admissions guidance",
      host: "you.ubc.ca",
      campus: null,
      strategy: "mirror",
      scope: (url, title) =>
        commonExclusion(url, title) ??
        (/^\/counsellors(?:\/|$)/.test(new URL(url).pathname)
          ? "School counsellor/representative-only section."
          : null),
      selectors: ["#container", ".admissions-content", ".pagebuilder", "main", ".entry-content", "article"],
    },
    files: ["admissions/pages.json"],
  },
  {
    source: {
      key: "student-services",
      title: "Student Services guidance",
      host: "students.ubc.ca",
      campus: "vancouver",
      strategy: "mirror",
      scope: commonExclusion,
    },
    files: ["campus-services/student_services_pages.json"],
  },
  {
    source: {
      key: "recreation",
      title: "Student and shared recreation guidance",
      host: "recreation.ubc.ca",
      campus: "vancouver",
      strategy: "mirror",
      scope: (url, title) =>
        commonExclusion(url, title) ??
        (/\/(?:pm-feed(?:-staffview)?|program-listing(?:-[^/]+)?)(?:\/|$)/.test(new URL(url).pathname)
          ? "Program/feed service endpoint rather than an explanatory article."
          : /\/(?:camps?|youth|children|birthday)(?:\/|$)/.test(new URL(url).pathname)
            ? "Child/youth-only recreation outside undergraduate/shared-service scope."
            : null),
    },
    files: ["campus-services/recreation_pages.json"],
  },
  {
    source: {
      key: "campus-facilities",
      title: "Shared campus facilities guidance",
      host: "facilities.ubc.ca",
      campus: "vancouver",
      strategy: "mirror",
      scope: (url, title) =>
        commonExclusion(url, title) ??
        (/\/(?:our-people|employee|employees|staff|working-here|employment)(?:\/|$)/.test(new URL(url).pathname)
          ? "Employee-only operations or staff directory."
          : null),
    },
    files: ["reports/facilities/pages.json"],
  },
  {
    source: {
      key: "student-finances",
      title: "Student-facing Finance guidance",
      host: "finance.ubc.ca",
      campus: null,
      strategy: "mirror",
      scope: (url, title) =>
        commonExclusion(url, title) ??
        (/student|tuition|scholarship|bursar|financial-assistance/i.test(`${url} ${title}`)
          ? null
          : "Finance staff/vendor material without an explicit student topic."),
    },
    files: ["reports/finance/pages.json", "reports/finance/posts.json"],
  },
  {
    source: {
      key: "it-services",
      title: "Student-facing IT service explanations",
      host: "it.ubc.ca",
      campus: null,
      strategy: "mirror",
      scope: commonExclusion,
      selectors: ["#unit-content > main", ".region-content", "article", "main"],
    },
    files: ["student-support/it_services.json"],
  },
  {
    source: {
      key: "wellbeing",
      title: "Undergraduate and shared Wellbeing resources",
      host: "wellbeing.ubc.ca",
      campus: null,
      strategy: "mirror",
      scope: commonExclusion,
      selectors: ["#unit-content > main", ".region-content", "article", "main"],
    },
    files: ["student-support/wellbeing_resources.json"],
  },
  {
    source: {
      key: "policies",
      title: "Undergraduate-relevant policy explanatory notes",
      host: "universitycounsel.ubc.ca",
      campus: null,
      strategy: "mirror",
      scope: commonExclusion,
      selectors: ["#unit-content > main", ".region-content", "article", "main"],
    },
    files: ["policies/index.json"],
  },
];

export function mirroredHtml(row: Row): string {
  return (
    string(row.content_html) ||
    string(object(row.body).processed) ||
    string(object(row.body).value) ||
    string(object(row.content).rendered)
  );
}

/** Normalize prior snapshots without treating conversion time as a new source retrieval. */
export async function collectMirroredSource(
  definition: MirrorDefinition,
  client: ProseClient,
  root = DATA_DIR,
  fetchMissing = true,
): Promise<CollectionResult> {
  const source = definition.source;
  const result: CollectionResult = {
    source: source.key,
    articles: [],
    inventory: [],
    discoveryErrors: [],
    discoveryNotes: [],
  };
  const manifest = object(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")));
  const dates = new Map<string, string>();
  for (const group of Object.values(object(manifest.groups))) {
    const item = object(group);
    for (const dataset of Array.isArray(item.datasets) ? item.datasets : [])
      dates.set(string(object(dataset).path), string(item.updated_at));
  }
  const seen = new Map<string, string>();
  for (const file of definition.files) {
    const rows = JSON.parse(await readFile(path.join(root, file), "utf8")) as unknown;
    if (!Array.isArray(rows)) throw new Error(`Mirror is not a row array: ${file}`);
    result.discoveryNotes.push(
      `Mirrored inventory: ${file}; ${rows.length} rows; source snapshot ${dates.get(file) ?? "unknown"}.`,
    );
    for (const raw of rows) {
      const row = object(raw);
      const rawUrl = string(row.source_url) || string(row.url) || string(row.link);
      const resolved = rawUrl ? webUrl(normalizedHref(rawUrl), `https://${source.host}`) : null;
      const url = resolved ? secureUbcLink(resolved) : "";
      const title = string(row.title) || string(object(row.title).rendered);
      const inventory: InventoryEntry = {
        url: url || `mirror:${file}:${row.id ?? result.inventory.length}`,
        discovered_by: [file],
        source_modified_at: string(row.source_modified_at) || string(row.changed) || string(row.modified_gmt) || null,
        status: "failed",
        article_id: null,
        reason: null,
      };
      result.inventory.push(inventory);
      if (!url) {
        inventory.status = "excluded";
        inventory.reason = "Mirrored placeholder has no public article URL.";
        continue;
      }
      const excluded = definition.exclude?.(row) ?? source.scope(url, plainText(title));
      if (
        excluded ||
        object(row.content).protected === true ||
        row.status === false ||
        (typeof row.status === "string" && row.status !== "publish")
      ) {
        inventory.status = "excluded";
        inventory.reason = excluded ?? "Protected or unpublished source record.";
        continue;
      }
      try {
        let input = {
          url,
          title,
          html: mirroredHtml(row),
          upstreamId: typeof row.id === "number" ? row.id : String(row.id),
          apiUrl: string(row.api_url) || null,
          sourceModifiedAt:
            string(row.source_modified_at) ||
            string(row.changed) ||
            (string(row.modified_gmt) ? `${row.modified_gmt}Z` : null),
          retrievedAt: string(row.retrieved_at) || dates.get(file) || "",
          sourceRecords: [{ path: file, id: typeof row.id === "string" || typeof row.id === "number" ? row.id : null }],
          warnings: [
            "Imported from an existing source snapshot; retained retrieval time describes that snapshot, not this conversion.",
          ],
        };
        if (needsRenderedHtml(input.html)) {
          if (!fetchMissing) {
            inventory.status = "unavailable";
            inventory.reason =
              "The mirror has no complete prose body and network filling is disabled; this does not establish an empty upstream page.";
            continue;
          }
          const response = await client.get(url);
          const redirectedScope = source.scope(response.url, plainText(title));
          if (redirectedScope) {
            inventory.status = "excluded";
            inventory.reason = redirectedScope;
            inventory.resolved_url = response.url;
            continue;
          }
          const rendered = extractArticle(response, source);
          input = {
            ...input,
            ...rendered,
            upstreamId: input.upstreamId,
            apiUrl: input.apiUrl,
            sourceRecords: input.sourceRecords,
            warnings: rendered.warnings ?? [],
          };
        }
        const article = makeArticle(source, input);
        if (!article) {
          inventory.status = "no_prose";
          inventory.reason = "No prose remains in the source body after sanitization.";
          continue;
        }
        const previous = seen.get(urlKey(article.source_url));
        if (previous) {
          result.articles.find((row) => row.id === previous)!.source_records.push(...article.source_records);
          inventory.status = "duplicate";
          inventory.reason = "Same canonical article is represented in another mirrored table.";
          inventory.article_id = previous;
        } else {
          seen.set(urlKey(article.source_url), article.id);
          result.articles.push(article);
          inventory.status = "collected";
          inventory.article_id = article.id;
        }
      } catch (error) {
        inventory.reason = String(error);
        if (error instanceof NonArticleError) inventory.status = "excluded";
        if (error instanceof ProseFetchError) {
          inventory.http_status = error.status;
          inventory.status = fetchDisposition(error);
        }
      }
    }
  }
  const inventoryByUrl = new Map<string, InventoryEntry>();
  for (const entry of result.inventory) {
    const previous = inventoryByUrl.get(entry.url);
    if (!previous) inventoryByUrl.set(entry.url, entry);
    else {
      const retained = entry.status === "collected" ? entry : previous;
      retained.discovered_by = [...new Set([...previous.discovered_by, ...entry.discovered_by])];
      inventoryByUrl.set(entry.url, retained);
    }
  }
  result.inventory = [...inventoryByUrl.values()];
  result.articles.sort((a, b) => compareStrings(a.id, b.id));
  result.inventory.sort((a, b) => compareStrings(a.url, b.url));
  return result;
}
