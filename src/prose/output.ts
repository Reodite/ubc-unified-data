import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, Output, utcnow, type DatasetInfo } from "../base.ts";
import { object, string } from "../source-documents.ts";
import { urlKey, type CollectionResult, type InventoryStatus, type ProseSource } from "./model.ts";

export interface ProseCategorySummary extends Record<string, unknown> {
  title: string;
  status: "complete" | "complete_with_unavailable" | "partial" | "not_collected";
  mode: string;
  folder: string;
  articles: number;
  inventory_urls: number;
  dispositions: Record<InventoryStatus, number>;
  discovery_errors: string[];
  updated_at: string;
  datasets: DatasetInfo[];
}

const REFERENCE_TABLES: Record<string, string[]> = {
  "student-housing": [
    "housing/residences.json",
    "housing/room_types.json",
    "housing/fee_pages.json",
    "housing/guidance.json",
    "housing/fee_tables.json",
  ],
  "learning-commons": ["student-support/learning_commons_pages.json"],
};

export async function writeProseCategory(
  source: ProseSource,
  result: CollectionResult,
  root = DATA_DIR,
): Promise<ProseCategorySummary> {
  const references = new Map<string, Array<{ path: string; id: string | number | null }>>();
  for (const file of REFERENCE_TABLES[source.key] ?? []) {
    const rows = JSON.parse(await readFile(path.join(root, file), "utf8")) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const url = string(row.source_url);
      if (!url) continue;
      const key = urlKey(url);
      references.set(key, [
        ...(references.get(key) ?? []),
        { path: file, id: typeof row.id === "string" || typeof row.id === "number" ? row.id : null },
      ]);
    }
  }
  const out = new Output(`prose/${source.key}`, root);
  out.describe("articles", {
    grain: "one canonical public undergraduate/shared prose article, stored as sanitized Markdown",
    columns: {
      id: "Stable source-prefixed publisher identity, or canonical URL hash when none is exposed",
      category: "Always prose; structured datasets remain in their existing groups",
      subcategory: "Source/topic subdivision within prose",
      source_url: "Official public page to cite; content remains subject to publisher terms",
      content_markdown: "Sanitized explanatory prose, without raw HTML tokens or remote image embeddings",
      content_sha256: "SHA-256 of title plus newline plus content_markdown",
      markdown_path: "Standalone Markdown body, relative to the data root; identical to content_markdown",
      source_modified_at: "Publisher/API/sitemap modification time when exposed; null otherwise",
      retrieved_at: "Original retrieval time of the input snapshot, not its conversion time",
      source_records: "References back to preserved structured/mirrored tables",
      warnings: "Source and conversion limitations; complex table layouts are represented as labelled cell lists",
    },
  });
  for (const article of result.articles) {
    const links = references.get(urlKey(article.source_url)) ?? [];
    article.source_records.push(...links);
    const filename = `${createHash("sha256").update(article.id).digest("hex")}.md`;
    article.markdown_path = `prose/${source.key}/markdown/${filename}`;
    await out.raw(`markdown/${filename}`, article.content_markdown, { source: article.source_url });
  }
  await out.table("articles", result.articles, { source: `https://${source.host}/` });
  await out.json("_inventory.json", result.inventory);
  const dispositions: Record<InventoryStatus, number> = {
    collected: 0,
    excluded: 0,
    unavailable: 0,
    failed: 0,
    duplicate: 0,
    no_prose: 0,
  };
  for (const row of result.inventory) dispositions[row.status]++;
  const status =
    result.discoveryErrors.length || dispositions.failed
      ? "partial"
      : dispositions.unavailable
        ? "complete_with_unavailable"
        : "complete";
  await out.json("_coverage.json", {
    source: source.key,
    status,
    mode: source.strategy,
    format: "markdown",
    inventory_urls: result.inventory.length,
    articles: result.articles.length,
    dispositions,
    discovery_errors: result.discoveryErrors,
    discovery_notes: result.discoveryNotes,
    definitions: {
      complete:
        "Declared source inventories and discovered in-scope links are exhausted; not a claim about unlinked pages or the entire UBC web.",
      unavailable:
        "Advertised URL is unavailable after bounded retries, or blocked by access/robots restrictions; the inventory records the reason.",
      no_prose:
        "No explanatory body remained in the retrieved representation; interactive-only material is not reconstructed.",
      mirror:
        "Coverage refers to the existing mirrored article inventory, with its original timestamps; missing bodies may be fetched from their public pages.",
    },
  });
  if (status !== "partial") await out.prune();
  return {
    title: source.title,
    status,
    mode: source.strategy,
    folder: `prose/${source.key}`,
    articles: result.articles.length,
    inventory_urls: result.inventory.length,
    dispositions,
    discovery_errors: result.discoveryErrors,
    updated_at: utcnow(),
    datasets: out.datasets,
  };
}

export async function writeProseIndex(
  sources: ProseSource[],
  updated: Map<string, ProseCategorySummary>,
  root = DATA_DIR,
): Promise<void> {
  let previous: Record<string, unknown> = {};
  try {
    previous = object(
      object(JSON.parse(await readFile(path.join(root, "prose/_manifest.json"), "utf8"))).subcategories,
    );
  } catch {}
  const subcategories = Object.fromEntries(
    sources.map((source) => [
      source.key,
      updated.get(source.key) ??
        previous[source.key] ?? {
          title: source.title,
          status: "not_collected",
          mode: source.strategy,
          folder: `prose/${source.key}`,
        },
    ]),
  );
  const at = utcnow();
  const out = new Output("prose", root);
  await out.json("_manifest.json", {
    category: "prose",
    generated_at: at,
    format: "markdown",
    campus_scope: "Vancouver and shared undergraduate resources",
    subcategories,
  });
  await out.json("_catalog.json", {
    category: "prose",
    generated_at: at,
    how_to_read:
      "All prose lives below prose/<subcategory>/. Read articles.json (array), articles.csv (same rows) or each row's markdown_path. Structured source tables use separate groups. Check _coverage.json and _inventory.json before claiming completeness.",
    tables: sources.map((source) => {
      const summary = object(subcategories[source.key]);
      return {
        subcategory: source.key,
        title: source.title,
        status: summary.status,
        records: summary.articles ?? null,
        json: `prose/${source.key}/articles.json`,
        csv: summary.articles ? `prose/${source.key}/articles.csv` : null,
        inventory: `prose/${source.key}/_inventory.json`,
        coverage: `prose/${source.key}/_coverage.json`,
      };
    }),
  });
}
