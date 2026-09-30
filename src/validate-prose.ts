import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, stringifyCsv } from "./base.ts";
import { ProseFetchError, publicUbcUrl } from "./prose/client.ts";
import { markdownLinks } from "./prose/markdown.ts";
import { contentHash, type InventoryStatus } from "./prose/model.ts";
import { object, string, type Row } from "./source-documents.ts";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function localPath(root: string, relative: string, prefix: string): string {
  const target = path.resolve(root, relative);
  check(
    relative.startsWith(`${prefix}/`) && target.startsWith(`${path.resolve(root, prefix)}${path.sep}`),
    `Unsafe prose path: ${relative}`,
  );
  return target;
}

/** Verify article safety, provenance, Markdown/CSV bytes and exhaustive inventory accounting without network access. */
export async function validateProseData(root = DATA_DIR, selected?: string[]): Promise<Row> {
  const manifest = object(JSON.parse(await readFile(path.join(root, "prose/_manifest.json"), "utf8")));
  const catalog = object(JSON.parse(await readFile(path.join(root, "prose/_catalog.json"), "utf8")));
  check(manifest.category === "prose" && catalog.category === "prose", "Missing top-level prose category");
  check(manifest.format === "markdown", "Unexpected prose format");
  const subcategories = object(manifest.subcategories);
  const keys = selected?.length ? selected : Object.keys(subcategories);
  check(keys.length > 0, "No prose subcategories recorded");
  const allIds = new Set<string>();
  const referenceCache = new Map<string, Set<unknown>>();
  const results: Row[] = [];
  for (const key of keys) {
    check(/^[a-z0-9-]+$/.test(key), `Invalid subcategory: ${key}`);
    const summary = object(subcategories[key]);
    check(
      ["complete", "complete_with_unavailable"].includes(String(summary.status)),
      `Prose subcategory ${key} is ${summary.status ?? "missing"}`,
    );
    const prefix = `prose/${key}`;
    const articles: unknown = JSON.parse(await readFile(path.join(root, prefix, "articles.json"), "utf8"));
    const inventory: unknown = JSON.parse(await readFile(path.join(root, prefix, "_inventory.json"), "utf8"));
    const coverage = object(JSON.parse(await readFile(path.join(root, prefix, "_coverage.json"), "utf8")));
    check(coverage.format === "markdown", `Unexpected prose format: ${key}`);
    check(Array.isArray(articles) && Array.isArray(inventory), `Article/inventory envelope must be arrays: ${key}`);
    check(
      articles.length === summary.articles && articles.length === coverage.articles,
      `Article count mismatch: ${key}`,
    );
    check(
      inventory.length === summary.inventory_urls && inventory.length === coverage.inventory_urls,
      `Inventory count mismatch: ${key}`,
    );
    check(
      coverage.status === summary.status &&
        Array.isArray(coverage.discovery_errors) &&
        coverage.discovery_errors.length === 0,
      `Incomplete source discovery: ${key}`,
    );
    const table = (catalog.tables as Row[]).find((row) => row.subcategory === key);
    check(
      table?.records === articles.length && table.json === `${prefix}/articles.json` && table.status === summary.status,
      `Prose catalog mismatch: ${key}`,
    );
    if (articles.length)
      check(
        (await readFile(path.join(root, prefix, "articles.csv"), "utf8")) === stringifyCsv(articles as Row[]),
        `Prose JSON/CSV mismatch: ${key}`,
      );
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const raw of articles) {
      const article = object(raw);
      const id = string(article.id);
      check(id.startsWith(`prose:${key}:`) && !allIds.has(id), `Missing/duplicate prose id: ${id}`);
      allIds.add(id);
      ids.add(id);
      check(
        article.category === "prose" && article.subcategory === key && article.source_id === key,
        `Article category mismatch: ${id}`,
      );
      const title = string(article.title);
      const markdown = string(article.content_markdown);
      check(title && markdown.trim(), `Empty article title or Markdown: ${id}`);
      check(!("content_html" in article) && !("content_text" in article), `Raw/parallel prose field found: ${id}`);
      const url = publicUbcUrl(string(article.source_url));
      check(!urls.has(url), `Duplicate canonical article URL: ${url}`);
      urls.add(url);
      if (article.api_url) publicUbcUrl(String(article.api_url));
      check(["vancouver", null].includes(article.campus as string | null), `Unexpected prose campus: ${id}`);
      check(article.audience === "undergraduate_and_shared", `Unexpected prose audience: ${id}`);
      check(Number.isFinite(Date.parse(string(article.retrieved_at))), `Invalid article retrieval time: ${id}`);
      check(
        article.source_modified_at === null || Number.isFinite(Date.parse(string(article.source_modified_at))),
        `Invalid article modification time: ${id}`,
      );
      const links = markdownLinks(markdown);
      check(JSON.stringify(article.links) === JSON.stringify(links), `Prose link metadata mismatch: ${id}`);
      check(article.content_sha256 === contentHash(title, markdown), `Prose content hash mismatch: ${id}`);
      const markdownPath = localPath(root, string(article.markdown_path), `${prefix}/markdown`);
      check(
        markdownPath.endsWith(".md") && (await readFile(markdownPath, "utf8")) === markdown,
        `Standalone Markdown mismatch: ${id}`,
      );
      check(
        Array.isArray(article.links) && Array.isArray(article.warnings) && Array.isArray(article.source_records),
        `Missing article provenance arrays: ${id}`,
      );
      for (const rawReference of article.source_records) {
        const reference = object(rawReference);
        const file = string(reference.path);
        const absolute = path.resolve(root, file);
        check(
          file.endsWith(".json") && absolute.startsWith(`${path.resolve(root)}${path.sep}`),
          `Unsafe source reference: ${file}`,
        );
        let known = referenceCache.get(file);
        if (!known) {
          const rows = JSON.parse(await readFile(absolute, "utf8")) as Row[];
          check(Array.isArray(rows), `Referenced source is not a row array: ${file}`);
          known = new Set(rows.map((row) => row.id));
          referenceCache.set(file, known);
        }
        if (reference.id !== null)
          check(known.has(reference.id), `Dangling prose source reference: ${id} -> ${file}:${reference.id}`);
      }
    }
    const dispositions: Record<InventoryStatus, number> = {
      collected: 0,
      excluded: 0,
      unavailable: 0,
      failed: 0,
      duplicate: 0,
      no_prose: 0,
    };
    const inventoryUrls = new Set<string>();
    const collectedIds = new Set<string>();
    for (const raw of inventory) {
      const entry = object(raw);
      const status = String(entry.status) as InventoryStatus;
      check(Object.hasOwn(dispositions, status), `Unknown inventory status: ${key}:${status}`);
      dispositions[status]++;
      const url = string(entry.url);
      check(url && !inventoryUrls.has(url), `Duplicate/missing inventory URL: ${key}:${url}`);
      inventoryUrls.add(url);
      check(Array.isArray(entry.discovered_by) && entry.discovered_by.length, `No discovery provenance: ${url}`);
      if (status === "collected" || status === "duplicate") {
        check(ids.has(String(entry.article_id)), `Dangling inventory article: ${url}`);
        if (status === "collected") collectedIds.add(String(entry.article_id));
      } else check(string(entry.reason), `Unexplained inventory exclusion/failure: ${url}`);
    }
    check(
      dispositions.failed === 0 && collectedIds.size === ids.size && dispositions.collected === articles.length,
      `Incomplete article inventory accounting: ${key}`,
    );
    for (const [status, count] of Object.entries(dispositions))
      check(
        object(coverage.dispositions)[status] === count && object(summary.dispositions)[status] === count,
        `Disposition count mismatch: ${key}:${status}`,
      );
    check(Array.isArray(summary.datasets), `Missing file manifest: ${key}`);
    for (const rawDataset of summary.datasets) {
      const dataset = object(rawDataset);
      const relative = string(dataset.path);
      const target = localPath(root, relative, prefix);
      check((await stat(target)).size === dataset.bytes, `Prose byte-size mismatch: ${relative}`);
    }
    results.push({
      subcategory: key,
      articles: articles.length,
      inventory_urls: inventory.length,
      unavailable: dispositions.unavailable,
      status: summary.status,
    });
  }
  return {
    category: "prose",
    articles: allIds.size,
    subcategories: results,
    note: "Checks establish safety, consistency and declared-inventory coverage, not source accuracy, eligibility or freshness.",
  };
}

if (import.meta.main) {
  validateProseData(DATA_DIR, process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof ProseFetchError ? error.message : error);
      process.exitCode = 1;
    });
}
