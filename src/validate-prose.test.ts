import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringifyCsv } from "./base.ts";
import { makeArticle, type CollectionResult, type ProseSource } from "./prose/model.ts";
import { writeProseCategory, writeProseIndex } from "./prose/output.ts";
import { validateProseData } from "./validate-prose.ts";

const source: ProseSource = {
  key: "example",
  title: "Example undergraduate prose",
  host: "example.ubc.ca",
  campus: "vancouver",
  strategy: "sitemap",
  scope: () => null,
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function corpus(unavailable = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubc-prose-test-"));
  directories.push(root);
  const article = makeArticle(source, {
    url: "https://example.ubc.ca/guide",
    title: "Registration guide",
    html: "<h2>Before registering</h2><p>A saved schedule does not register you.</p><p>Confirm enrolment after submitting.</p>",
    upstreamId: 1,
    retrievedAt: "2026-09-11T00:00:00Z",
  })!;
  const result: CollectionResult = {
    source: source.key,
    articles: [article],
    discoveryErrors: [],
    discoveryNotes: ["Exhausted a synthetic sitemap."],
    inventory: [
      {
        url: article.source_url,
        discovered_by: ["https://example.ubc.ca/sitemap.xml"],
        source_modified_at: null,
        status: "collected",
        article_id: article.id,
        reason: null,
      },
    ],
  };
  if (unavailable)
    result.inventory.push({
      url: "https://example.ubc.ca/removed",
      discovered_by: ["https://example.ubc.ca/sitemap.xml"],
      source_modified_at: null,
      status: "unavailable",
      reason: "HTTP 404",
      article_id: null,
    });
  const summary = await writeProseCategory(source, result, root);
  await writeProseIndex([source], new Map([[source.key, summary]]), root);
  return { root, article };
}

async function changeRows(root: string, mutate: (rows: Array<Record<string, unknown>>) => void) {
  const file = path.join(root, "prose/example/articles.json");
  const rows = JSON.parse(await readFile(file, "utf8")) as Array<Record<string, unknown>>;
  mutate(rows);
  await writeFile(file, JSON.stringify(rows));
  await writeFile(path.join(root, "prose/example/articles.csv"), stringifyCsv(rows));
}

describe("unified prose verification", () => {
  it("validates JSON, CSV, standalone Markdown and complete inventories", async () => {
    const { root } = await corpus();
    const checked = await validateProseData(root);
    expect(checked.articles).toBe(1);
    expect(checked.category).toBe("prose");
    for (const file of ["_manifest.json", "example/_coverage.json"]) {
      const metadata = JSON.parse(await readFile(path.join(root, "prose", file), "utf8"));
      expect(metadata.format).toBe("markdown");
    }
  });

  it.each(["_manifest.json", "example/_coverage.json"])("rejects unsupported prose format in %s", async (file) => {
    const { root } = await corpus();
    const target = path.join(root, "prose", file);
    const metadata = JSON.parse(await readFile(target, "utf8"));
    metadata.format = "html";
    await writeFile(target, JSON.stringify(metadata));
    await expect(validateProseData(root)).rejects.toThrow("Unexpected prose format");
  });

  it("reports unavailable source pages without pretending they were collected", async () => {
    const { root } = await corpus(true);
    const checked = await validateProseData(root);
    expect(checked.subcategories).toEqual([
      expect.objectContaining({ status: "complete_with_unavailable", articles: 1, inventory_urls: 2, unavailable: 1 }),
    ]);
  });

  it("rejects partial or uncollected subcategories", async () => {
    const { root } = await corpus();
    const file = path.join(root, "prose/_manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.subcategories.example.status = "partial";
    await writeFile(file, JSON.stringify(manifest));
    await expect(validateProseData(root)).rejects.toThrow("is partial");
  });

  it("rejects unsafe Markdown even when its CSV matches", async () => {
    const { root } = await corpus();
    await changeRows(root, (rows) => {
      rows[0]!.content_markdown = "<script>alert(1)</script>";
    });
    await expect(validateProseData(root)).rejects.toThrow("raw HTML is forbidden");
  });

  it("rejects prose content hash tampering", async () => {
    const { root } = await corpus();
    await changeRows(root, (rows) => {
      rows[0]!.content_markdown += "\n\nDifferent instructions.";
    });
    await expect(validateProseData(root)).rejects.toThrow("content hash mismatch");
  });

  it("rejects link metadata that differs from the validated body", async () => {
    const { root } = await corpus();
    await changeRows(root, (rows) => {
      rows[0]!.links = [{ text: "Forged link", url: "javascript:alert(1)" }];
    });
    await expect(validateProseData(root)).rejects.toThrow("link metadata mismatch");
  });

  it("rejects CSV drift", async () => {
    const { root } = await corpus();
    await writeFile(path.join(root, "prose/example/articles.csv"), "different bytes");
    await expect(validateProseData(root)).rejects.toThrow("JSON/CSV mismatch");
  });

  it("rejects standalone Markdown drift", async () => {
    const { root, article } = await corpus();
    await writeFile(path.join(root, String(article.markdown_path)), "Changed body");
    await expect(validateProseData(root)).rejects.toThrow("Standalone Markdown mismatch");
  });

  it("rejects paths outside the prose subcategory", async () => {
    const { root } = await corpus();
    await changeRows(root, (rows) => {
      rows[0]!.markdown_path = "prose/example/markdown/../../escape.md";
    });
    await expect(validateProseData(root)).rejects.toThrow("Unsafe prose path");
  });

  it("rejects dangling article inventory references", async () => {
    const { root } = await corpus();
    const file = path.join(root, "prose/example/_inventory.json");
    const rows = JSON.parse(await readFile(file, "utf8"));
    rows[0].article_id = "missing";
    await writeFile(file, JSON.stringify(rows));
    await expect(validateProseData(root)).rejects.toThrow("Dangling inventory article");
  });
});
