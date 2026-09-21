import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProducerContext, Snapshot } from "./contracts.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { HostRecording, type RecordingOptions } from "./recording.ts";

const root = DEFAULT_EXTERNAL_ROOT;
const origin = "https://example.ubc.ca";
const page = `${origin}/page`;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const producer: ProducerContext = {
  inputs_sha256: "a".repeat(64),
  runtime: {
    node: process.versions.node,
    icu: process.versions.icu!,
    unicode: process.versions.unicode!,
    platform: process.platform,
    arch: process.arch,
  },
};
const opened: HostRecording[] = [];
const directories: string[] = [];
const forbiddenFetch = vi.fn(async () => {
  throw new Error("Fixture forbids real network");
});
beforeEach(() => {
  forbiddenFetch.mockClear();
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(async (context) => {
  for (const recording of opened.splice(0)) recording.close();
  for (const directory of directories.splice(0)) {
    if (context.task.result?.state === "fail") console.error(`Preserved text receipt fixture: ${directory}`);
    else await rm(directory, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  expect(forbiddenFetch).not.toHaveBeenCalled();
});
async function fixture(
  handler: (url: string) => Response = () =>
    new Response("Recorded text", { headers: { "content-type": "text/plain" } }),
  extra: Partial<RecordingOptions> = {},
) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "recording-text-bytes-test-"));
  directories.push(directory);
  const fetcher = vi.fn(async (value: string | URL | Request) => {
    const url = String(value);
    if (url === `${origin}/robots.txt`) return new Response("User-agent: *\nDisallow:\n");
    return handler(url);
  });
  const options: RecordingOptions = {
    hostname: "example.ubc.ca",
    directory,
    producer,
    acquire: true,
    minimumMs: 1,
    timeoutMs: 1000,
    ...extra,
    fetcher,
  };
  const recording = await HostRecording.open(options);
  opened.push(recording);
  return { recording, directory, fetcher, options };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function sql(f: Fixture, statement: string, ...values: SQLInputValue[]) {
  const db = new DatabaseSync(join(f.directory, "state.sqlite"));
  try {
    return db.prepare(statement).run(...values);
  } finally {
    db.close();
  }
}
function state(f: Fixture) {
  const db = new DatabaseSync(join(f.directory, "state.sqlite"), { readOnly: true });
  try {
    return Object.fromEntries(
      [
        ["config", "id"],
        ["outcomes", "url"],
        ["attempts", "id"],
        ["attempt_producers", "attempt_id"],
        ["outcome_failures", "id"],
        ["repair_authorizations", "url"],
      ].map(([table, key]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all()]),
    );
  } finally {
    db.close();
  }
}
async function object(f: Fixture, snapshot: Snapshot) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const sha256 = hash(bytes);
  await writeFile(join(f.directory, "objects", `${sha256}.json`), bytes);
  return { sha256, snapshot };
}
function duplicate(f: Fixture, digest: string) {
  sql(
    f,
    "INSERT INTO attempts(url,started,state,bytes,snapshot,body_sha,status,headers,error) SELECT url,started,state,bytes,snapshot,body_sha,status,headers,error FROM attempts WHERE snapshot=?",
    digest,
  );
}
async function rejectsWithoutEffects(f: Fixture, digest: string, error?: RegExp) {
  const before = state(f);
  const input = f.recording.inputDigest();
  const calls = f.fetcher.mock.calls.length;
  await expect(f.recording.readTextBytes(digest)).rejects.toThrow(error);
  expect(state(f)).toEqual(before);
  expect(f.recording.inputDigest()).toBe(input);
  expect(f.fetcher).toHaveBeenCalledTimes(calls);
}
async function redirected() {
  const raw = Buffer.from("\ufeffTerminal café\r\n");
  const f = await fixture((url) => {
    if (url.endsWith("/alias"))
      return new Response("First redirect body", { status: 301, headers: { location: "/middle" } });
    if (url.endsWith("/middle"))
      return new Response("Second redirect body", { status: 307, headers: { location: "./page" } });
    if (url === page) return new Response(raw, { headers: { "content-type": "text/plain; charset=utf-8" } });
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  const observation = await f.recording.read(`${origin}/alias`);
  const { redirects: _redirects, ...physical } = observation.snapshot;
  physical.requested_url = physical.url;
  const terminal = { sha256: hash(JSON.stringify(physical)), snapshot: physical };
  return { ...f, observation, terminal, raw };
}

describe("receipt-backed recorded text bytes", () => {
  it.each([
    ["UTF-8", Buffer.from("Original café\r\n"), "text/plain; charset=utf-8", "Original café\r\n"],
    ["UTF-8 BOM", Buffer.from("\ufeffOriginal café\r\n"), "text/plain; charset=utf-8", "Original café\r\n"],
    ["Latin-1", Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset="iso-8859-1"', "café"],
    ["UTF-16LE BOM", Buffer.from([0xff, 0xfe, 0x41, 0, 0xe9, 0]), "text/plain; charset=utf-16le", "Aé"],
    ["empty", Buffer.alloc(0), "text/plain; charset=utf-8", ""],
    ["empty binary charset", Buffer.alloc(0), "application/pdf; charset=binary", ""],
  ] as const)("returns exact %s bytes without re-encoding or writes", async (_label, raw, contentType, body) => {
    const f = await fixture(() => new Response(raw, { headers: { "content-type": contentType } }));
    const observation = await f.recording.read(page);
    expect(observation.snapshot.body).toBe(body);
    const before = state(f);
    const digest = f.recording.inputDigest();
    const dbBytes = await readFile(join(f.directory, "state.sqlite"));
    expect(await f.recording.readTextBytes(observation.sha256)).toEqual({ bytes: raw, sha256: hash(raw) });
    expect(await f.recording.readTextBytes(observation.sha256)).toEqual({ bytes: raw, sha256: hash(raw) });
    expect(state(f)).toEqual(before);
    expect(f.recording.inputDigest()).toBe(digest);
    expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(dbBytes);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await expect(f.recording.readBytes(observation.sha256)).rejects.toThrow(/binary observation/);
  });

  it("matches multi-hop terminal physical receipts instead of redirect bodies", async () => {
    const f = await redirected();
    expect(f.observation.snapshot.redirects).toHaveLength(2);
    expect(f.terminal.sha256).not.toBe(f.observation.sha256);
    expect(await f.recording.readSnapshot(f.terminal.sha256)).toEqual(f.terminal);
    const before = state(f);
    expect(await f.recording.readTextBytes(f.observation.sha256)).toEqual({ bytes: f.raw, sha256: hash(f.raw) });
    expect(await f.recording.readTextBytes(f.terminal.sha256)).toEqual({ bytes: f.raw, sha256: hash(f.raw) });
    const first = f.observation.snapshot.redirects![0]!;
    expect((await f.recording.readTextBytes(first.snapshot)).bytes.toString()).toBe("First redirect body");
    expect(state(f)).toEqual(before);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });

  it("replays a sealed redirect wrapper from a read-only recording", async () => {
    const f = await redirected();
    const seal = await f.recording.seal();
    f.recording.close();
    const before = state(f);
    const files = await Promise.all(["state.sqlite", "seal.json"].map((name) => readFile(join(f.directory, name))));
    const noNetwork = vi.fn(async () => {
      throw new Error("Replay cannot fetch");
    });
    const replay = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(replay);
    expect(await replay.read(`${origin}/alias`)).toEqual(f.observation);
    expect(await replay.readTextBytes(f.observation.sha256)).toEqual({ bytes: f.raw, sha256: hash(f.raw) });
    expect(await replay.verifySeal()).toBe(seal);
    expect(state(f)).toEqual(before);
    replay.close();
    expect(await Promise.all(["state.sqlite", "seal.json"].map((name) => readFile(join(f.directory, name))))).toEqual(
      files,
    );
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("uses the exact physical hash rather than the latest attempt at the same URL", async () => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    const raw = Buffer.from("Different newer text");
    const newer = await object(f, { ...observation.snapshot, body: raw.toString(), bytes: raw.length });
    await writeFile(join(f.directory, "objects", `${hash(raw)}.body`), raw);
    duplicate(f, observation.sha256);
    sql(
      f,
      "UPDATE attempts SET snapshot=?,body_sha=?,bytes=? WHERE id=(SELECT max(id) FROM attempts)",
      newer.sha256,
      hash(raw),
      raw.length,
    );
    expect((await f.recording.readTextBytes(observation.sha256)).bytes.toString()).toBe("Recorded text");
    expect(await f.recording.readTextBytes(newer.sha256)).toEqual({ bytes: raw, sha256: hash(raw) });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["unchanged", "body", "snapshot"] as const)(
    "tracks equal-byte JSON and raw objects independently: %s",
    async (change) => {
      let snapshotBytes = Buffer.alloc(0);
      const f = await fixture(
        (url) =>
          new Response(url === page ? "Recorded text" : snapshotBytes, {
            headers: { "content-type": "text/plain" },
          }),
      );
      const first = await f.recording.read(page);
      snapshotBytes = await readFile(join(f.directory, "objects", `${first.sha256}.json`));
      const second = await f.recording.read(`${origin}/snapshot-as-text`);
      const before = state(f);
      expect(await f.recording.readTextBytes(second.sha256)).toEqual({
        bytes: snapshotBytes,
        sha256: first.sha256,
      });
      await f.recording.readSnapshot(first.sha256);
      expect(state(f)).toEqual(before);
      expect(f.fetcher).toHaveBeenCalledTimes(3);
      if (change === "unchanged") {
        await expect(f.recording.assertUnchanged()).resolves.toBeUndefined();
      } else {
        sql(f, "UPDATE attempts SET body_sha=NULL,snapshot=NULL WHERE snapshot IN (?,?)", first.sha256, second.sha256);
        const extension = change === "body" ? "body" : "json";
        await writeFile(join(f.directory, "objects", `${first.sha256}.${extension}`), "Tampered object");
        await expect(f.recording.assertUnchanged()).rejects.toThrow(/changed/);
      }
    },
  );

  it("accepts matching duplicate receipts", async () => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    duplicate(f, observation.sha256);
    expect((await f.recording.readTextBytes(observation.sha256)).bytes.toString()).toBe("Recorded text");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["URL", "url", `${origin}/wrong`],
    ["status", "status", 201],
    ["size", "bytes", 999],
    ["negative size", "bytes", -1],
    ["digest", "body_sha", "f".repeat(64)],
    ["malformed digest", "body_sha", "../invalid"],
    ["missing digest", "body_sha", null],
    ["charset", "headers", JSON.stringify({ "content-type": "text/plain; charset=utf-16le" })],
    ["error", "error", "Failed despite an observed label"],
    ["failed", "state", "failed"],
    ["dispatching", "state", "dispatching"],
    ["uncertain", "state", "uncertain"],
  ] as const)("rejects a disagreeing duplicate %s receipt", async (_label, field, value) => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    duplicate(f, observation.sha256);
    sql(f, `UPDATE attempts SET ${field}=? WHERE id=(SELECT max(id) FROM attempts)`, value);
    await rejectsWithoutEffects(f, observation.sha256);
  });

  it.each([
    ["wrong URL", "url", `${origin}/wrong`],
    ["wrong status", "status", 204],
    ["wrong size", "bytes", 1],
    ["wrong snapshot", "snapshot", "d".repeat(64)],
    ["unbound", "snapshot", null],
    ["failed", "state", "failed"],
    ["dispatching", "state", "dispatching"],
    ["uncertain", "state", "uncertain"],
    ["missing raw digest", "body_sha", null],
  ] as const)("rejects a lone %s receipt", async (_label, field, value) => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    sql(f, `UPDATE attempts SET ${field}=? WHERE snapshot=?`, value, observation.sha256);
    await rejectsWithoutEffects(f, observation.sha256);
  });

  it.each(["missing", "altered", "symlink", "hardlink", "oversized"])("rejects a %s raw object", async (kind) => {
    const f = await fixture(undefined, { maxResponseBytes: 64 });
    const observation = await f.recording.read(page);
    const path = join(f.directory, "objects", `${hash("Recorded text")}.body`);
    if (kind === "altered") await writeFile(path, "Changed bytes");
    else if (kind === "oversized") await writeFile(path, Buffer.alloc(65));
    else if (kind === "hardlink") await link(path, join(f.directory, "linked-body"));
    else {
      await rm(path);
      if (kind === "symlink") {
        const target = join(f.directory, "raw-target");
        await writeFile(target, "Recorded text");
        await symlink(target, path);
      }
    }
    await rejectsWithoutEffects(f, observation.sha256);
  });

  it("rejects a raw size mismatch even when snapshot and duplicate receipt sizes agree", async () => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    const altered = await object(f, { ...observation.snapshot, bytes: observation.snapshot.bytes + 1 });
    sql(
      f,
      "UPDATE attempts SET snapshot=?,bytes=? WHERE snapshot=?",
      altered.sha256,
      altered.snapshot.bytes,
      observation.sha256,
    );
    duplicate(f, altered.sha256);
    await rejectsWithoutEffects(f, altered.sha256, /body changed/);
  });

  it("rejects a digest-valid raw object that disagrees with decoded snapshot text", async () => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    const altered = await object(f, { ...observation.snapshot, body: "Manufactured" });
    sql(f, "UPDATE attempts SET snapshot=? WHERE snapshot=?", altered.sha256, observation.sha256);
    await rejectsWithoutEffects(f, altered.sha256, /decoded|text|body/i);
  });

  it.each(["unsupported", "invalid UTF-8"])("uses fatal saved decoding for %s text", async (kind) => {
    const raw = Buffer.from([0xe9]);
    const f = await fixture(() => new Response(raw, { headers: { "content-type": "text/plain; charset=iso-8859-1" } }));
    const observation = await f.recording.read(page);
    const headers = { "content-type": `text/plain; charset=${kind === "unsupported" ? "binary" : "utf-8"}` };
    const altered = await object(f, { ...observation.snapshot, body: "\ufffd", headers });
    sql(
      f,
      "UPDATE attempts SET snapshot=?,headers=? WHERE snapshot=?",
      altered.sha256,
      JSON.stringify(headers),
      observation.sha256,
    );
    await rejectsWithoutEffects(f, altered.sha256);
  });

  it("rejects changed snapshot JSON at its original address", async () => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    await writeFile(
      join(f.directory, "objects", `${observation.sha256}.json`),
      JSON.stringify({ ...observation.snapshot, body: "Changed" }),
    );
    await rejectsWithoutEffects(f, observation.sha256, /snapshot bytes changed/);
  });

  it.each([
    [
      "no trace",
      (s: Snapshot) => {
        delete s.redirects;
      },
    ],
    [
      "empty trace",
      (s: Snapshot) => {
        s.redirects = [];
      },
    ],
    [
      "wrong start",
      (s: Snapshot) => {
        s.redirects![0]!.url = `${origin}/elsewhere`;
      },
    ],
    [
      "wrong location",
      (s: Snapshot) => {
        s.redirects![0]!.location = page;
      },
    ],
    [
      "wrong hop status",
      (s: Snapshot) => {
        s.redirects![0]!.status = 302;
      },
    ],
    [
      "wrong hop snapshot",
      (s: Snapshot) => {
        s.redirects![0]!.snapshot = s.redirects![1]!.snapshot;
      },
    ],
    [
      "missing hop",
      (s: Snapshot) => {
        s.redirects!.shift();
      },
    ],
    [
      "reordered hops",
      (s: Snapshot) => {
        s.redirects!.reverse();
      },
    ],
    [
      "cycle",
      (s: Snapshot) => {
        s.redirects![1]!.location = `${origin}/alias`;
      },
    ],
    [
      "extra hop",
      (s: Snapshot) => {
        s.redirects!.push(s.redirects![0]!);
      },
    ],
    [
      "wrong terminal",
      (s: Snapshot) => {
        s.url = `${origin}/not-terminal`;
      },
    ],
    [
      "wrong requested URL",
      (s: Snapshot) => {
        s.requested_url = page;
      },
    ],
    [
      "changed terminal body",
      (s: Snapshot) => {
        s.body = "Forged terminal";
      },
    ],
    [
      "null trace",
      (s: Snapshot) => {
        Object.assign(s, { redirects: null });
      },
    ],
    [
      "nonarray trace",
      (s: Snapshot) => {
        Object.assign(s, { redirects: {} });
      },
    ],
    [
      "null hop",
      (s: Snapshot) => {
        Object.assign(s, { redirects: [null] });
      },
    ],
  ] as const)("rejects a recorded but forged wrapper with %s", async (_label, mutate) => {
    const f = await redirected();
    const snapshot = structuredClone(f.observation.snapshot);
    mutate(snapshot);
    const forged = await object(f, snapshot);
    sql(f, "UPDATE outcomes SET snapshot=? WHERE url=?", forged.sha256, `${origin}/alias`);
    await rejectsWithoutEffects(f, forged.sha256);
  });

  it.each([
    "unrecorded",
    "failed logical outcome",
    "ambiguous logical binding",
    "missing terminal",
    "missing hop receipt",
    "failed hop receipt",
    "wrong terminal receipt",
  ])("rejects redirect evidence with %s", async (kind) => {
    const f = await redirected();
    if (kind === "unrecorded") sql(f, "DELETE FROM outcomes WHERE url=?", `${origin}/alias`);
    if (kind === "failed logical outcome") sql(f, "UPDATE outcomes SET error='failure' WHERE url=?", `${origin}/alias`);
    if (kind === "ambiguous logical binding")
      sql(f, "INSERT INTO outcomes(url,snapshot) VALUES (?,?)", `${origin}/forged-alias`, f.observation.sha256);
    if (kind === "missing terminal") await rm(join(f.directory, "objects", `${f.terminal.sha256}.json`));
    if (kind === "missing hop receipt")
      sql(f, "DELETE FROM attempts WHERE snapshot=?", f.observation.snapshot.redirects![0]!.snapshot);
    if (kind === "failed hop receipt")
      sql(f, "UPDATE attempts SET state='failed' WHERE snapshot=?", f.observation.snapshot.redirects![0]!.snapshot);
    if (kind === "wrong terminal receipt")
      sql(f, "UPDATE attempts SET url=? WHERE snapshot=?", `${origin}/alias`, f.terminal.sha256);
    await rejectsWithoutEffects(f, f.observation.sha256);
  });

  it("rejects a manufactured direct snapshot without its own receipt", async () => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    const unbound = await object(f, { ...observation.snapshot, retrieved_at: "2000-01-01T00:00:00.000Z" });
    await rejectsWithoutEffects(f, unbound.sha256);
  });

  it("rejects PDF snapshots while preserving PDF-only readBytes", async () => {
    const raw = Buffer.from("%PDF-1.7\nfixture\n%%EOF");
    const f = await fixture(() => new Response(raw, { headers: { "content-type": "application/pdf" } }), {
      documentFormats: ["pdf"],
    });
    const observation = await f.recording.read(`${origin}/guide.pdf`);
    expect(await f.recording.readBytes(observation.sha256)).toEqual(raw);
    await rejectsWithoutEffects(f, observation.sha256, /binary|text/i);
    expect(await f.recording.readBytes(observation.sha256)).toEqual(raw);
  });

  it("replays read-only cached text without changing seed, seal, config or any lineage table", async () => {
    let broken = true;
    const seed = Buffer.from("Fixture seed bytes\n");
    const f = await fixture(
      (url) => {
        if (url.endsWith("/broken") && broken) throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
        return new Response("Fixture text");
      },
      { seedSha256: hash(seed) },
    );
    await writeFile(join(f.directory, "seed.json"), seed);
    const observation = await f.recording.read(page);
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/fetch failed/);
    expect(f.recording.recoverTransientFailures()).toBe(1);
    broken = false;
    await f.recording.read(`${origin}/broken`);
    const before = state(f);
    expect(before.outcome_failures).toHaveLength(1);
    expect(before.repair_authorizations).toHaveLength(1);
    const digest = await f.recording.seal();
    f.recording.close();
    const paths = ["seed.json", "seal.json", "state.sqlite"];
    const files = await Promise.all(paths.map((path) => readFile(join(f.directory, path))));
    const noNetwork = vi.fn(async () => {
      throw new Error("Replay cannot fetch");
    });
    const replay = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(replay);
    expect(await replay.read(page)).toEqual(observation);
    expect(await replay.readTextBytes(observation.sha256)).toEqual({
      bytes: Buffer.from("Fixture text"),
      sha256: hash("Fixture text"),
    });
    expect(await replay.verifySeal()).toBe(digest);
    expect(replay.inputDigest()).toBe(digest);
    expect(state(f)).toEqual(before);
    replay.close();
    expect(await Promise.all(paths.map((path) => readFile(join(f.directory, path))))).toEqual(files);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it.each(["assertUnchanged", "verifySeal"] as const)("notices touched raw tampering at later %s", async (verify) => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    await f.recording.seal();
    await f.recording.readTextBytes(observation.sha256);
    await writeFile(join(f.directory, "objects", `${hash("Recorded text")}.body`), "Tampered text");
    await expect(f.recording[verify]()).rejects.toThrow(/changed/);
  });

  it("tracks touched raw artifacts even if receipt rows are subsequently detached", async () => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    await f.recording.readTextBytes(observation.sha256);
    sql(f, "UPDATE attempts SET body_sha=NULL WHERE snapshot=?", observation.sha256);
    await writeFile(join(f.directory, "objects", `${hash("Recorded text")}.body`), "Tampered text");
    await expect(f.recording.assertUnchanged()).rejects.toThrow(/changed/);
  });

  it("rejects reads after close", async () => {
    const f = await fixture();
    const observation = await f.recording.read(page);
    f.recording.close();
    await expect(f.recording.readTextBytes(observation.sha256)).rejects.toThrow(/closed/);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["../raw", "a".repeat(63), "A".repeat(64)])("rejects malformed snapshot digest %s", async (digest) => {
    const f = await fixture();
    await rejectsWithoutEffects(f, digest, /snapshot digest/);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
