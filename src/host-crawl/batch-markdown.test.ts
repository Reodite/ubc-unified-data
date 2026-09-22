import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTENT_TYPES, makeZip, rootRelationships } from "./adapters/ooxml-test-helper.ts";
import { OOXML_PROFILE_SHA256 } from "./adapters/ooxml.ts";
import { HostBatch } from "./batch.ts";
import type { Observation, ProducerContext, SavedUrl } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { createGenericScraper } from "./generic.ts";
import { deriveCollectionInputDigest } from "./inputs.ts";
import { DEFAULT_EXTERNAL_ROOT, EXTERNAL_BOUNDARY } from "./paths.ts";

const hostname = "manufacturing.engineering.ubc.ca";
const origin = `https://${hostname}`;
const targetUrl = `${origin}/node/1.md`;
const docxUrl = `${origin}/program.docx`;
const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const id = randomUUID();
  const directory = join(DEFAULT_EXTERNAL_ROOT, "test-markdown-batch", id);
  const repositoryRoot = join(EXTERNAL_BOUNDARY, `markdown-batch-repository-${id}`);
  const producerRoot = join(directory, "producer");
  roots.push(directory, repositoryRoot);
  const producer: ProducerContext = {
    inputs_sha256: hash("producer"),
    runtime: {
      node: process.versions.node,
      icu: process.versions.icu!,
      unicode: process.versions.unicode!,
      platform: process.platform,
      arch: process.arch,
    },
  };
  await mkdir(join(directory, "state"), { recursive: true });
  await mkdir(producerRoot, { recursive: true });
  await mkdir(repositoryRoot, { recursive: true });
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      repositoryRoot,
      producerRoot,
      producer,
      baseline: "a".repeat(40),
      main: "b".repeat(40),
      bootstrapFiles: {},
    }),
  );
  const batch = await HostBatch.open(directory);
  batch.seed([{ hostname, admitted: true }]);
  const claim = await batch.claim("w1");
  if (!claim?.token) throw new Error("Missing batch fixture claim");
  batch.queue.update(hostname, claim.token, "admitted", { homepage_decision: "fixture" });

  const values = new Map<string, Observation>();
  const put = (url: string, body: string, contentType: string): Observation => {
    const snapshot = {
      url,
      requested_url: url,
      status: 200,
      headers: { "content-type": contentType },
      body,
      bytes: Buffer.byteLength(body),
      retrieved_at: "2026-01-01T00:00:00Z",
    };
    const observation = { snapshot, sha256: hash(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  put(
    `${origin}/`,
    '<html><head><link rel="alternate" type="text/markdown" href="/node/1.md" title="Manufacturing guide"></head><body><main><h1>Manufacturing Engineering</h1><p>Official public program requirements.</p><a href="/node/1.md">Markdown</a><a href="/program.docx">Program document</a></main></body></html>',
    "text/html; charset=utf-8",
  );
  put(`${origin}/robots.txt`, "User-agent: *\n", "text/plain");
  const markdownBytes = Buffer.from("# Runtime body title\n\nExact source guidance.\n", "utf8");
  const target = put(targetUrl, markdownBytes.toString("utf8"), "text/markdown; charset=utf-8");
  const docxBytes = makeZip([
    { name: "[Content_Types].xml", body: CONTENT_TYPES },
    { name: "_rels/.rels", body: rootRelationships("word/document.xml") },
    {
      name: "word/document.xml",
      body: `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Program requirements</w:t></w:r></w:p><w:p><w:r><w:t>Complete required courses.</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
  const docxSnapshot: Observation["snapshot"] = {
    url: docxUrl,
    requested_url: docxUrl,
    status: 200,
    headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    body: "",
    bytes: docxBytes.length,
    retrieved_at: "2026-01-01T00:00:00Z",
    binary: {
      format: "docx",
      media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256: hash(docxBytes),
    },
  };
  const docxObservation = { snapshot: docxSnapshot, sha256: hash(JSON.stringify(docxSnapshot)) };
  values.set(docxUrl, docxObservation);
  const savedTarget: SavedUrl = {
    url: targetUrl,
    kind: "page",
    state: "pending",
    disposition: null,
    reason: null,
    snapshot: null,
    article_id: null,
    source_modified_at: null,
  };
  const seedBytes = Buffer.from(JSON.stringify({ hostname, urls: [savedTarget] }));
  const recordingDirectory = join(directory, "recording");
  const seedPath = join(directory, `seed-${id}.json`);
  await mkdir(recordingDirectory, { recursive: true });
  await writeFile(seedPath, seedBytes);
  const seal = hash("recording seal");
  const close = vi.fn();
  const recording = {
    inputDigest: () => hash("recording input"),
    read: vi.fn(async (url: string) => {
      const observation = values.get(url);
      if (!observation) throw new Error(`Missing observation: ${url}`);
      return observation;
    }),
    readDocument: vi.fn(async (url: string) => {
      const observation = values.get(url);
      if (!observation) throw new Error(`Missing document observation: ${url}`);
      return observation;
    }),
    readSnapshot: vi.fn(async (snapshot: string) => {
      const observation = [...values.values()].find((value) => value.sha256 === snapshot);
      if (!observation) throw new Error(`Missing snapshot: ${snapshot}`);
      return observation;
    }),
    readBytes: vi.fn(async (snapshot: string) => {
      if (snapshot !== docxObservation.sha256) throw new Error("Unexpected binary receipt");
      return Buffer.from(docxBytes);
    }),
    readTextBytes: vi.fn(async (snapshot: string) => {
      if (snapshot !== target.sha256) throw new Error("Unexpected Markdown receipt");
      return { bytes: Buffer.from(markdownBytes), sha256: hash(markdownBytes) };
    }),
    observedDestination: (url: string) => url,
    observedScopeExclusion: () => null,
    apiFallbackEligible: () => false,
    assertUnchanged: vi.fn(async () => {}),
    seal: vi.fn(async () => seal),
    close,
  };
  const scraper = createGenericScraper(hostname);
  (
    batch as unknown as {
      recording(
        hostname: string,
        acquire: boolean,
      ): Promise<{
        recording: typeof recording;
        directory: string;
        scraper: typeof scraper;
        seed: { bytes: Buffer; urls: SavedUrl[] };
        seedPath: string;
      }>;
    }
  ).recording = async () => ({
    recording,
    directory: recordingDirectory,
    scraper,
    seed: { bytes: seedBytes, urls: [savedTarget] },
    seedPath,
  });
  return { batch, directory, token: claim.token, producer, seedBytes, seal, close };
}

describe("batch ready v3 writer", () => {
  it("binds real runtime profile into every document and ready bytes before returning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Unexpected network"))),
    );
    const f = await fixture();
    try {
      const result = await f.batch.collect(hostname, f.token);
      expect(result).toMatchObject({ hostname, state: "ready", documents: 3 });
      const row = f.batch.queue.get(hostname)!;
      expect(row.state).toBe("ready");
      const readyBytes = await readFile(String(row.details.ready_path));
      expect(sha256(readyBytes)).toBe(row.details.ready_sha256);
      const ready = JSON.parse(readyBytes.toString("utf8")) as {
        version: number;
        recording_seal: string;
        seed_sha256: string;
        profiles: { pdf: string | null; docx: string | null; pptx: string | null; markdown: string };
        completed: {
          documents: Array<{ input_sha256: string; extraction?: { format: string; profile_sha256: string } }>;
        };
      };
      expect(ready.version).toBe(3);
      expect(ready.profiles).toMatchObject({ pdf: null, docx: OOXML_PROFILE_SHA256, pptx: null });
      expect(ready.profiles.markdown).toMatch(/^[a-f0-9]{64}$/);
      const expectedInput = deriveCollectionInputDigest({
        recording: f.seal,
        seed: sha256(f.seedBytes),
        docx_profile: OOXML_PROFILE_SHA256,
        markdown_profile: ready.profiles.markdown,
      });
      expect(new Set(ready.completed.documents.map((document) => document.input_sha256))).toEqual(
        new Set([expectedInput]),
      );
      const markdown = ready.completed.documents.find((document) => document.extraction?.format === "markdown");
      expect(markdown?.extraction?.profile_sha256).toBe(ready.profiles.markdown);
      const docx = ready.completed.documents.find((document) => document.extraction?.format === "docx");
      expect(docx?.extraction?.profile_sha256).toBe(OOXML_PROFILE_SHA256);
      expect(f.close).toHaveBeenCalledOnce();
    } finally {
      f.batch.close();
    }
  }, 180_000);
});
