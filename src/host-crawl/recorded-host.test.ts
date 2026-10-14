import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { createGenericScraper } from "./generic.ts";
import { deriveCollectionInputDigest } from "./inputs.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { collectRecordedSession, openRecordedHost } from "./recorded-host.ts";

const roots: string[] = [];
const producer: ProducerContext = {
  inputs_sha256: "a".repeat(64),
  runtime: { node: "26.8.1", icu: "78.3", unicode: "17.0", platform: "linux", arch: "x64" },
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  await mkdir(DEFAULT_EXTERNAL_ROOT, { recursive: true });
  const root = await mkdtemp(join(DEFAULT_EXTERNAL_ROOT, "recorded-host-test-"));
  roots.push(root);
  const hostname = "lifecycle.ubc.ca";
  const home = `https://${hostname}/`;
  const legacyStateFile = join(root, "legacy.sqlite");
  const database = new DatabaseSync(legacyStateFile);
  database.exec(
    "CREATE TABLE urls (host TEXT, url TEXT, kind TEXT, state TEXT, disposition TEXT, reason TEXT, snapshot TEXT, article_id TEXT, source_modified_at TEXT)",
  );
  database
    .prepare("INSERT INTO urls(host,url,kind,state) VALUES (?,?,?,?)")
    .run(hostname, `${home}guide/`, "page", "pending");
  database
    .prepare("INSERT INTO urls(host,url,kind,state) VALUES (?,?,?,?)")
    .run("other.ubc.ca", "https://other.ubc.ca/", "page", "pending");
  database.close();
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${home}robots.txt`)
      return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (url === home || url === `${home}guide/`)
      return new Response(
        `<title>${url === home ? "Student service" : "Application guide"}</title><main><h1>${url === home ? "Student service" : "Application guide"}</h1><p>Students can request an appointment and review the program requirements before applying.</p></main>`,
        { headers: { "content-type": "text/html" } },
      );
    return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
  });
  return {
    scraper: createGenericScraper(hostname),
    producer,
    directory: join(root, "recording"),
    legacyStateFile,
    transport: { fetcher: fetcher as typeof fetch, minimumMs: 1 },
    fetcher,
  };
}

describe("recorded host lifecycle", () => {
  it("freezes only the host frontier and reproduces sealed output without network access", async () => {
    const f = await fixture();
    const session = await openRecordedHost({ ...f, acquire: true });
    let collected: Awaited<ReturnType<typeof collectRecordedSession>>;
    try {
      expect(session.seed.urls.map((row) => row.url)).toEqual(["https://lifecycle.ubc.ca/guide/"]);
      collected = await collectRecordedSession(session, producer, { mode: "acquire", scopeExclusions: "fail" });
      expect(collected.completed.documents).toHaveLength(2);
      expect(collected.input).toBe(
        deriveCollectionInputDigest({ recording: collected.seal, seed: sha256(session.seed.bytes) }),
      );
      expect(collected.completed.documents.every((doc) => doc.input_sha256 === collected.input)).toBe(true);
      await collected.verifyInputs();
    } finally {
      session.recording.close();
    }
    f.fetcher.mockImplementation(async () => {
      throw new Error("Replay must not fetch");
    });
    const requests = f.fetcher.mock.calls.length;
    const replay = await openRecordedHost({ ...f, acquire: false });
    try {
      const result = await collectRecordedSession(replay, producer, { mode: "replay", scopeExclusions: "fail" });
      expect(result.completed).toEqual(collected.completed);
      expect(result.input).toBe(collected.input);
      expect(f.fetcher.mock.calls.length).toBe(requests);
    } finally {
      replay.recording.close();
    }
  });

  it("keeps sealed acquisition refusal distinct from an explicit batch reuse", async () => {
    const f = await fixture();
    const first = await openRecordedHost({ ...f, acquire: true });
    try {
      await collectRecordedSession(first, producer, { mode: "acquire", scopeExclusions: "skip-recorded" });
    } finally {
      first.recording.close();
    }
    await expect(openRecordedHost({ ...f, acquire: true })).rejects.toThrow("Sealed acquisition is immutable");
    const replay = await openRecordedHost({ ...f, acquire: true, reuseSealed: true });
    try {
      expect(replay.recording.options.acquire).toBe(false);
      await collectRecordedSession(replay, producer, { mode: "acquire", scopeExclusions: "skip-recorded" });
    } finally {
      replay.recording.close();
    }
  });

  it("refuses a changed frontier when rechecking publication inputs", async () => {
    const f = await fixture();
    const session = await openRecordedHost({ ...f, acquire: true });
    try {
      const collected = await collectRecordedSession(session, producer, { mode: "acquire", scopeExclusions: "fail" });
      await writeFile(session.seedPath, `${await readFile(session.seedPath, "utf8")}\n`);
      await expect(collected.verifyInputs()).rejects.toThrow("Saved frontier changed");
    } finally {
      session.recording.close();
    }
  });
});
