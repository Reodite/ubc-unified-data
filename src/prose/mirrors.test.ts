import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProseClient } from "./client.ts";
import { collectMirroredSource, type MirrorDefinition } from "./mirrors.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const definition: MirrorDefinition = {
  source: {
    key: "example",
    title: "Mirrored guidance",
    host: "example.ubc.ca",
    campus: "vancouver",
    strategy: "mirror",
    scope: () => null,
    selectors: ["main"],
  },
  files: ["existing/pages.json"],
};
async function root(rows: unknown[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prose-mirror-"));
  directories.push(directory);
  await mkdir(path.join(directory, "existing"));
  await writeFile(path.join(directory, "existing/pages.json"), JSON.stringify(rows));
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      groups: { existing: { updated_at: "2026-08-11T00:00:00Z", datasets: [{ path: "existing/pages.json" }] } },
    }),
  );
  return directory;
}
const noNetwork = () =>
  new ProseClient({
    fetcher: (async () => {
      throw new Error("Unexpected network");
    }) as typeof fetch,
  });

describe("existing prose normalization", () => {
  it("preserves snapshot time and source record identifiers", async () => {
    const directory = await root([
      {
        id: 42,
        link: "https://example.ubc.ca/guide",
        status: "publish",
        title: { rendered: "Existing guide" },
        content: { rendered: "<p>Detailed public explanation.</p>", protected: false },
        modified_gmt: "2026-08-01T12:00:00",
      },
    ]);
    const result = await collectMirroredSource(definition, noNetwork(), directory);
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toMatchObject({
      retrieved_at: "2026-08-11T00:00:00Z",
      source_modified_at: "2026-08-01T12:00:00Z",
      source_records: [{ path: "existing/pages.json", id: 42 }],
    });
  });

  it("merges duplicate public URLs while retaining both source-record references", async () => {
    const directory = await root(
      [41, 42].map((id) => ({
        id,
        link: "https://example.ubc.ca/shared-guide",
        title: { rendered: "Shared guide" },
        content: { rendered: "<p>One public explanation.</p>" },
      })),
    );
    const result = await collectMirroredSource(definition, noNetwork(), directory);
    expect(result.articles).toHaveLength(1);
    expect(result.inventory).toHaveLength(1);
    expect(result.inventory[0]?.status).toBe("collected");
    expect(result.articles[0]?.source_records).toEqual([
      { path: "existing/pages.json", id: 41 },
      { path: "existing/pages.json", id: 42 },
    ]);
  });

  it("resolves a relative permalink without aborting the mirror", async () => {
    const directory = await root([
      { id: 42, link: "/guide", title: { rendered: "Guide" }, content: { rendered: "<p>Public instructions.</p>" } },
    ]);
    const result = await collectMirroredSource(definition, noNetwork(), directory);
    expect(result.articles[0]?.source_url).toBe("https://example.ubc.ca/guide");
  });

  it("does not declare an empty mirror to be an empty upstream article", async () => {
    const directory = await root([
      { id: 42, link: "https://example.ubc.ca/guide", title: { rendered: "Guide" }, content: { rendered: "" } },
    ]);
    const result = await collectMirroredSource(definition, noNetwork(), directory, false);
    expect(result.articles).toEqual([]);
    expect(result.inventory[0]).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("does not establish an empty upstream page"),
    });
  });

  it("fills missing bodies from public pages and records the response time", async () => {
    const directory = await root([
      { id: 42, link: "https://example.ubc.ca/guide", title: { rendered: "Guide" }, content: { rendered: "" } },
    ]);
    const client = new ProseClient({
      minInterval: 0,
      now: () => Date.parse("2026-09-11T00:00:00Z"),
      fetcher: (async (input) =>
        new Response(
          String(input).endsWith("robots.txt")
            ? ""
            : "<title>Guide</title><main><h1>Guide</h1><p>Previously absent explanation.</p></main>",
        )) as typeof fetch,
    });
    const result = await collectMirroredSource(definition, client, directory);
    expect(result.articles[0]?.content_markdown).toContain("Previously absent explanation");
    expect(result.articles[0]?.retrieved_at).toBe("2026-09-11T00:00:00.000Z");
    expect(result.articles[0]?.upstream_id).toBe(42);
  });

  it("excludes protected mirror rows without fetching their bodies", async () => {
    const directory = await root([
      {
        id: 42,
        link: "https://example.ubc.ca/guide",
        title: { rendered: "Private" },
        content: { rendered: "", protected: true },
      },
    ]);
    const result = await collectMirroredSource(definition, noNetwork(), directory);
    expect(result.inventory[0]?.status).toBe("excluded");
    expect(result.articles).toEqual([]);
  });
});
