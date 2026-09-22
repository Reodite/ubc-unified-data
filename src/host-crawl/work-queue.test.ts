import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "../base.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import type { HostWorkClaim, HostWorkQueue } from "./work-queue.ts";

let root: string;
let repository: string;
let moduleUrl: string;
let Queue: typeof HostWorkQueue;
let failed = false;
const queues: HostWorkQueue[] = [];
const children = new Set<ChildProcess>();
const hash = "a".repeat(64);

beforeAll(async () => {
  const temporaryRoot = process.env.HOST_QUEUE_TEST_ROOT ?? DEFAULT_EXTERNAL_ROOT;
  await mkdir(temporaryRoot, { recursive: true });
  root = await mkdtemp(join(temporaryRoot, "work-queue-"));
  repository = join(root, "repository");
  // Exact source copies keep both the repository and external SQLite fixtures inside the selected test workspace.
  for (const file of [
    "base.ts",
    "prose/client.ts",
    "host-crawl/paths.ts",
    "host-crawl/document-types.ts",
    "host-crawl/urls.ts",
    "host-crawl/work-queue.ts",
  ]) {
    const target = join(repository, "src", file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(ROOT, "src", file), target);
  }
  await symlink(join(ROOT, "node_modules"), join(repository, "node_modules"), "dir");
  moduleUrl = pathToFileURL(join(repository, "src/host-crawl/work-queue.ts")).href;
  Queue = (await import(moduleUrl)).HostWorkQueue;
});

afterEach(async (context) => {
  failed ||= context.task.result?.state === "fail";
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await stopped;
    }
  }
  children.clear();
  for (const queue of queues.splice(0)) queue.close();
});

afterAll(async () => {
  if (failed) console.error(`Preserved queue fixtures: ${root}`);
  else await rm(root, { recursive: true, force: true });
});

function open(file = join(root, randomUUID(), "queue.sqlite")) {
  const queue = Queue.open(file);
  queues.push(queue);
  return { file, queue };
}

async function claimant(file: string, worker: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
    import { HostWorkQueue } from ${JSON.stringify(moduleUrl)};
    const queue = HostWorkQueue.open(${JSON.stringify(file)});
    process.once('message', () => {
      process.send({claim: queue.claim(${JSON.stringify(worker)})});
    });
    process.send({ready: true});
    setInterval(() => {}, 1000);
  `,
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, TMPDIR: root, TSX_DISABLE_CACHE: "1" },
    },
  );
  children.add(child);
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let receiveClaim: (claim: HostWorkClaim | null) => void;
  let rejectClaim: (error: Error) => void;
  const result = new Promise<HostWorkClaim | null>((resolve, reject) => {
    receiveClaim = resolve;
    rejectClaim = reject;
  });
  // The caller observes result after startup; keep startup failures from producing an unhandled sibling promise.
  void result.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    child.on("message", (message: { ready?: boolean; claim?: HostWorkClaim | null }) => {
      if (message.ready) resolve();
      else if ("claim" in message) receiveClaim(message.claim ?? null);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const error = new Error(`Claimant exited (${code}, ${signal}): ${stderr}`);
      reject(error);
      rejectClaim(error);
    });
  });
  return { child, result };
}

describe("durable host work queue", () => {
  let prepared: { queue: HostWorkQueue; file: string; claimants: Awaited<ReturnType<typeof claimant>>[] } | undefined;
  beforeEach(async ({ task }) => {
    prepared = undefined;
    const workers = task.name.includes("five concurrent")
      ? ["w1", "w2", "w3", "w4", "w5"]
      : task.name.includes("keeps crashed")
        ? ["w1"]
        : [];
    if (!workers.length) return;
    const opened = open();
    prepared = { ...opened, claimants: await Promise.all(workers.map((worker) => claimant(opened.file, worker))) };
  });
  it("atomically gives five concurrent workers distinct priority-ordered hosts", async () => {
    const { queue, claimants } = prepared!;
    queue.seed([
      { hostname: "z.ubc.ca", priority: 10 },
      { hostname: "e.ubc.ca" },
      { hostname: "c.ubc.ca" },
      { hostname: "d.ubc.ca" },
      { hostname: "b.ubc.ca" },
      { hostname: "a.ubc.ca", priority: -1 },
    ]);
    const workers = ["w1", "w2", "w3", "w4", "w5"];
    for (const agent of claimants) agent.child.send("claim");
    const claims = await Promise.all(claimants.map((agent) => agent.result));
    expect(claims.map((claim) => claim!.hostname).sort()).toEqual([
      "a.ubc.ca",
      "b.ubc.ca",
      "c.ubc.ca",
      "d.ubc.ca",
      "e.ubc.ca",
    ]);
    expect(new Set(claims.map((claim) => claim!.token)).size).toBe(5);
    expect(claims.map((claim) => claim!.worker).sort()).toEqual(workers);
    expect(
      claims
        .map((claim) => queue.get(claim!.hostname)!)
        .sort((a, b) => a.events[1]!.id - b.events[1]!.id)
        .map((host) => host.hostname),
    ).toEqual(["a.ubc.ca", "b.ubc.ca", "c.ubc.ca", "d.ubc.ca", "e.ubc.ca"]);
    for (const worker of workers) expect(queue.claim(worker)).toBeNull();
    for (const worker of ["w0", "w6", "W1", "w1 ", ""]) expect(() => queue.claim(worker)).toThrow(/w1\.\.w5/);
    expect(queue.stats()).toMatchObject({ total: 6, claimed: 5, pending: 1 });
  });

  it("deduplicates canonical seeds and preserves cached homepage triage", () => {
    const { queue } = open();
    queue.seed([
      {
        hostname: "Example.UBC.CA.",
        admitted: true,
        homepage_sha256: hash.toUpperCase(),
        priority: -2,
        origin: "cache",
      },
    ]);
    const initial = queue.get("example.ubc.ca");
    queue.seed([
      {
        hostname: "EXAMPLE.ubc.ca",
        priority: -20,
        admitted: false,
        homepage_sha256: "b".repeat(64),
        origin: "later",
      },
    ]);
    expect(queue.get("example.ubc.ca")).toEqual(initial);
    expect(initial!.events).toHaveLength(1);
    expect(queue.stats().total).toBe(1);
    const claim = queue.claim("w1")!;
    expect(claim).toMatchObject({
      hostname: "example.ubc.ca",
      admitted: true,
      homepage_sha256: hash,
    });
    queue.update(claim.hostname, claim.token, "collecting");
    expect(queue.get(claim.hostname)!.admitted).toBe(true);
    expect(() => queue.seed([{ hostname: "atomic.ubc.ca" }, { hostname: "not-official.example" }])).toThrow();
    expect(queue.get("atomic.ubc.ca")).toBeNull();
  });

  it("enforces token ownership, admission and forward transitions without changing rejected writes", () => {
    const { queue } = open();
    queue.seed([{ hostname: "a.ubc.ca" }, { hostname: "b.ubc.ca" }]);
    const a = queue.claim("w1")!;
    const b = queue.claim("w2")!;
    const before = queue.get(a.hostname);
    expect(() => queue.update(a.hostname, b.token, "rejected")).toThrow(/token/);
    expect(() => queue.update(a.hostname, "", "blocked")).toThrow(/token/);
    expect(() => queue.update(a.hostname, a.token, "collecting")).toThrow(/admission/);
    expect(() => queue.update(a.hostname, a.token, "published")).toThrow(/transition/);
    expect(() => queue.update(a.hostname, a.token, "pending")).toThrow(/transition/);
    expect(queue.get(a.hostname)).toEqual(before);
    queue.update(a.hostname, a.token, "admitted", {
      homepage_sha256: hash,
      triage: { useful: true },
    });
    const admitted = queue.get(a.hostname);
    expect(() =>
      queue.update(a.hostname, a.token, "collecting", {
        homepage_sha256: "b".repeat(64),
      }),
    ).toThrow(/immutable/);
    expect(() => queue.update(a.hostname, a.token, "collecting", { admitted: false })).toThrow(/Admission/);
    expect(queue.get(a.hostname)).toEqual(admitted);
    queue.update(a.hostname, a.token, "collecting", {
      recording: "private-recording",
    });
    expect(() => queue.update(a.hostname, a.token, "admitted")).toThrow(/transition/);
    queue.update(a.hostname, a.token, "ready", { result: { documents: 2 } });
    queue.update(a.hostname, a.token, "publishing");
    queue.update(a.hostname, a.token, "published", { commit: "abc123" });
    expect(queue.get(a.hostname)!.details).toEqual({
      homepage_sha256: hash,
      triage: { useful: true },
      recording: "private-recording",
      result: { documents: 2 },
      commit: "abc123",
    });
  });

  it("retains terminal outcomes and immutable event history across reseeding and reopening", () => {
    const { queue, file } = open();
    queue.seed([{ hostname: "a.ubc.ca", admitted: true }, { hostname: "b.ubc.ca" }, { hostname: "c.ubc.ca" }]);
    const published = queue.claim("w1")!;
    for (const state of ["collecting", "ready", "publishing", "published"] as const)
      queue.update(published.hostname, published.token, state, {
        commit: "retained-commit",
      });
    const rejected = queue.claim("w1")!;
    queue.update(rejected.hostname, rejected.token, "rejected", {
      rejection: "Homepage has no useful prose",
    });
    const blocked = queue.claim("w1")!;
    queue.update(blocked.hostname, blocked.token, "blocked", {
      error: "Uncertain external effect",
      result: { path: "private" },
    });
    const original = [published, rejected, blocked].map((claim) => queue.get(claim.hostname));
    for (const claim of [published, rejected, blocked]) {
      expect(() => queue.update(claim.hostname, claim.token, "claimed")).toThrow(/Terminal/);
      expect(() => queue.update(claim.hostname, claim.token, queue.get(claim.hostname)!.state)).toThrow(/Terminal/);
    }
    queue.close();
    const reopened = open(file).queue;
    reopened.seed(
      original.map((host) => ({
        hostname: host!.hostname.toUpperCase(),
        admitted: true,
        priority: -100,
      })),
    );
    expect([published, rejected, blocked].map((claim) => reopened.get(claim.hostname))).toEqual(original);
    expect(reopened.claim("w1")).toBeNull();
    expect(reopened.stats()).toEqual({
      total: 3,
      pending: 0,
      claimed: 0,
      admitted: 0,
      collecting: 0,
      ready: 0,
      publishing: 0,
      published: 1,
      rejected: 1,
      blocked: 1,
    });
    const database = new DatabaseSync(file);
    try {
      expect(() => database.exec("UPDATE host_work_events SET details='{}'")).toThrow(/immutable/);
      expect(() => database.exec("DELETE FROM host_work_events")).toThrow(/immutable/);
      expect(database.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally {
      database.close();
    }
  });

  it("keeps crashed and uncertain publication claims until explicit token-owned recovery", async () => {
    const { queue, file, claimants } = prepared!;
    queue.seed([{ hostname: "a.ubc.ca", admitted: true, homepage_sha256: hash }, { hostname: "b.ubc.ca" }]);
    const agent = claimants[0]!;
    agent.child.send("claim");
    const claim = (await agent.result)!;
    const crashed = new Promise<void>((resolve) => agent.child.once("exit", () => resolve()));
    agent.child.kill("SIGKILL");
    await crashed;
    queue.close();
    const reopened = open(file).queue;
    expect(reopened.get(claim.hostname)).toMatchObject({
      state: "claimed",
      token: claim.token,
      worker: "w1",
    });
    expect(reopened.current("w1")).toEqual(reopened.get(claim.hostname));
    expect(reopened.claim("w1")).toBeNull();
    expect(reopened.claim("w2")!.hostname).toBe("b.ubc.ca");
    for (const state of ["collecting", "ready", "publishing"] as const)
      reopened.update(claim.hostname, claim.token, state);
    const uncertain = reopened.get(claim.hostname);
    reopened.close();
    const final = open(file).queue;
    expect(final.get(claim.hostname)).toEqual(uncertain);
    expect(final.claim("w1")).toBeNull();
    final.update(claim.hostname, claim.token, "blocked", {
      error: "Publisher outcome needs reconciliation",
    });
    expect(final.current("w1")).toBeNull();
    final.seed([{ hostname: "c.ubc.ca" }]);
    expect(final.claim("w1")!.hostname).toBe("c.ubc.ca");
    expect(final.get(claim.hostname)!.state).toBe("blocked");
  });

  it("requires private external files and rejects sidecar aliases", async () => {
    expect(() => Queue.open(join(repository, "queue.sqlite"))).toThrow(/external/);
    expect(() => Queue.open("/tmp/queue.sqlite")).toThrow(/external/);
    const { file } = open();
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    const aliasFile = join(root, randomUUID(), "queue.sqlite");
    await mkdir(dirname(aliasFile));
    await symlink(file, `${aliasFile}-journal`);
    expect(() => Queue.open(aliasFile)).toThrow(/Symlink/);
  });
});
