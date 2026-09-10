import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "prose-output-"));
  directories.push(root);
  return root;
}

async function exportWithUmask(root: string, mask: number): Promise<string[]> {
  // A child process isolates the process-wide umask from other tests and test pools.
  const program = `
    import { makeArticle } from ${JSON.stringify(new URL("./model.ts", import.meta.url).href)};
    import { writeProseCategory, writeProseIndex } from ${JSON.stringify(new URL("./output.ts", import.meta.url).href)};
    process.umask(Number(process.argv[1]));
    const root = process.argv[2];
    const source = {
      key: "example", title: "Example guidance", host: "example.ubc.ca",
      campus: "vancouver", strategy: "sitemap", scope: () => null,
    };
    const article = makeArticle(source, {
      url: "https://example.ubc.ca/guide", title: "Registration guide",
      html: "<p>Confirm enrolment after submitting.</p>", upstreamId: 1,
      retrievedAt: "2026-09-11T00:00:00Z",
    });
    if (!article) throw new Error("Fixture article is empty");
    const summary = await writeProseCategory(source, {
      source: source.key, articles: [article], discoveryErrors: [], discoveryNotes: [],
      inventory: [{
        url: article.source_url, discovered_by: ["https://example.ubc.ca/sitemap.xml"],
        source_modified_at: null, status: "collected", article_id: article.id, reason: null,
      }],
    }, root);
    await writeProseIndex([source], new Map([[source.key, summary]]), root);
    console.log(JSON.stringify([
      ...summary.datasets.map((dataset) => dataset.path), "prose/_catalog.json", "prose/_manifest.json",
    ]));
  `;
  const { stdout } = await execute(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", program, String(mask), root],
    { timeout: 10_000 },
  );
  return JSON.parse(stdout) as string[];
}

async function mode(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

describe.skipIf(process.platform === "win32")("prose export filesystem permissions", () => {
  it.each([
    { mask: 0o022, label: "022" },
    { mask: 0o027, label: "027" },
  ])(
    "uses umask $label for new export directories and files",
    async ({ mask }) => {
      const root = await temporaryRoot();
      const files = await exportWithUmask(root, mask);
      for (const directory of ["prose", "prose/example", "prose/example/markdown"]) {
        expect(await mode(path.join(root, directory))).toBe(0o777 & ~mask);
      }
      expect(files).toContain("prose/example/articles.csv");
      expect(files.some((file) => file.endsWith(".md"))).toBe(true);
      for (const file of files) expect(await mode(path.join(root, file))).toBe(0o666 & ~mask);
    },
    15_000,
  );

  it("preserves an existing export directory's mode", async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, "prose");
    await mkdir(directory);
    await chmod(directory, 0o750);
    await exportWithUmask(root, 0o022);
    expect(await mode(directory)).toBe(0o750);
  }, 15_000);
});
