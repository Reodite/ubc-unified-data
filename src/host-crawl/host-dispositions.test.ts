import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentUnavailableHosts, HostDispositionLedger } from "./host-dispositions.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { HostWorkQueue } from "./work-queue.ts";

let root: string;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const rationale =
  "This hostname cannot serve its own public homepage within the recorded exact-host and robots boundaries.";

beforeAll(async () => {
  await mkdir(DEFAULT_EXTERNAL_ROOT, { recursive: true });
  root = await mkdtemp(join(DEFAULT_EXTERNAL_ROOT, "host-dispositions-test-"));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function blocked(hostname: string, failure: string, admitted = false) {
  const queuePath = join(root, "runs", hostname, "state", "queue.sqlite");
  const queue = HostWorkQueue.open(queuePath);
  try {
    queue.seed([{ hostname }]);
    const claim = queue.claim("w1")!;
    if (admitted) queue.update(hostname, claim.token, "admitted");
    queue.update(hostname, claim.token, "blocked", { failure });
  } finally {
    queue.close();
  }
  return queuePath;
}

async function recording(
  hostname: string,
  rows: { url: string; status?: number; location?: string; error?: string }[],
) {
  const directory = join(root, "hosts", hostname, "recording");
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, "state.sqlite"));
  try {
    db.exec(
      "CREATE TABLE outcomes(url TEXT PRIMARY KEY,snapshot TEXT,error TEXT); CREATE TABLE attempts(id INTEGER PRIMARY KEY,url TEXT,state TEXT,status INTEGER,headers TEXT)",
    );
    for (const row of rows) {
      db.prepare("INSERT INTO outcomes VALUES (?,?,?)").run(row.url, null, row.error ?? null);
      if (row.status !== undefined)
        db.prepare("INSERT INTO attempts(url,state,status,headers) VALUES (?,'observed',?,?)").run(
          row.url,
          row.status,
          JSON.stringify(row.location ? { location: row.location } : {}),
        );
    }
  } finally {
    db.close();
  }
  return directory;
}

async function scope(hostname: string) {
  const home = `https://${hostname}/`;
  const queuePath = await blocked(hostname, "URL is outside the exact HTTPS host scope");
  await recording(hostname, [
    {
      url: `${home}robots.txt`,
      status: 301,
      location: "https://canonical.ubc.ca/robots.txt",
      error: "Error: URL is outside the exact HTTPS host scope",
    },
    { url: home, error: "Error: URL is outside the exact HTTPS host scope" },
  ]);
  return { hostname, queuePath, rationale };
}

describe("evidence-backed unavailable hosts", () => {
  it("records exact-host moves atomically without editing terminal queues or existing recordings", async () => {
    const candidate = await scope("moved-fixture.ubc.ca");
    const beforeQueue = await readFile(candidate.queuePath);
    const state = join(root, "hosts", candidate.hostname, "recording", "state.sqlite");
    const beforeRecording = await readFile(state);
    const ledger = HostDispositionLedger.open(root);
    try {
      expect(ledger.appendUnavailable([candidate])).toBe(1);
      expect([...currentUnavailableHosts(root)]).toEqual([candidate.hostname]);
      expect(() => ledger.appendUnavailable([candidate])).toThrow("already unavailable");
      const db = new DatabaseSync(join(root, "state", "host-dispositions.sqlite"));
      try {
        expect(() => db.exec("UPDATE host_disposition_events SET kind='reopened'")).toThrow("immutable");
        expect(() => db.exec("DELETE FROM host_disposition_events")).toThrow("immutable");
      } finally {
        db.close();
      }
      ledger.reopen(
        candidate.hostname,
        "A reviewed new exact-host homepage may now be collected without altering the prior claim.",
      );
      expect(currentUnavailableHosts(root).size).toBe(0);
    } finally {
      ledger.close();
    }
    expect(await readFile(candidate.queuePath)).toEqual(beforeQueue);
    expect(await readFile(state)).toEqual(beforeRecording);
  });

  it("accepts an original saved robots denial but not a merely failed page", async () => {
    const hostname = "robots-fixture.ubc.ca";
    const home = `https://${hostname}/`;
    const queuePath = await blocked(hostname, `Robots disallows ${home}`);
    const directory = await recording(hostname, [{ url: home, error: `Error: Robots disallows ${home}` }]);
    const body = "User-agent: *\nDisallow: /\n";
    const snapshot = JSON.stringify({ status: 200, body });
    const hash = sha256(snapshot);
    await mkdir(join(directory, "objects"), { recursive: true });
    await writeFile(join(directory, "objects", `${hash}.json`), snapshot);
    const db = new DatabaseSync(join(directory, "state.sqlite"));
    try {
      db.prepare("INSERT INTO outcomes VALUES (?,?,?)").run(`${home}robots.txt`, hash, null);
    } finally {
      db.close();
    }
    const ledger = HostDispositionLedger.open(root);
    try {
      expect(ledger.appendUnavailable([{ hostname, queuePath, rationale }])).toBe(1);
      const partial = await blocked("partial-fixture.ubc.ca", "Missing complete HTML for a page", true);
      expect(() =>
        ledger.appendUnavailable([{ hostname: "partial-fixture.ubc.ca", queuePath: partial, rationale }]),
      ).toThrow("admitted content");
    } finally {
      ledger.close();
    }
  });

  it("rolls back an entire selection when one host lacks host-wide evidence", async () => {
    const candidate = await scope("second-move.ubc.ca");
    const hostname = "budget-fixture.ubc.ca";
    const queuePath = await blocked(hostname, "Acquisition request/byte budget exhausted");
    await recording(hostname, [
      { url: `https://${hostname}/`, error: "Error: Acquisition request/byte budget exhausted" },
    ]);
    const ledger = HostDispositionLedger.open(root);
    try {
      expect(() => ledger.appendUnavailable([candidate, { hostname, queuePath, rationale }])).toThrow(
        "host-wide unavailability",
      );
      expect(currentUnavailableHosts(root).has(candidate.hostname)).toBe(false);
    } finally {
      ledger.close();
    }
  });
});
