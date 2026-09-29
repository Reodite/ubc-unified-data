import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, globSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "../base.ts";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { normalizeHost } from "./urls.ts";

const parser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  body: string,
) => { isDisallowed(url: string, agent: string): boolean | undefined };
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const FILE = "state/host-dispositions.sqlite";
const SCOPE = "Error: URL is outside the exact HTTPS host scope";
const LICENSED = "Owner excludes licensed-content/authproxy access.";

type Evidence =
  | {
      kind: "exact-host-redirect";
      url: string;
      attempt_id: number;
      status: number;
      location: string;
      recording_sha256: string;
    }
  | { kind: "robots-homepage"; snapshot_sha256: string; recording_sha256: string }
  | { kind: "licensed-proxy"; recorded_reason: string };

export interface UnavailableCandidate {
  hostname: string;
  queuePath: string;
  rationale: string;
}

function pathFor(root: string): string {
  return assertExternalPath(join(root, FILE));
}

function openedFile(path: string): void {
  assertExternalPath(path);
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0)
    throw new Error("Disposition ledger must be private, regular and unaliased");
  chmodSync(path, 0o600);
}

function currentQueuePath(root: string, hostname: string): string | null {
  let latest: { path: string; created: string } | null = null;
  for (const path of globSync(join(root, "runs", "**", "state", "queue.sqlite"))) {
    assertExternalPath(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT created_at FROM host_work WHERE hostname=?").get(hostname);
      if (!row) continue;
      const created = String(row.created_at);
      if (latest === null || created > latest.created) latest = { path, created };
      else if (created === latest.created && path.includes("/runs/resume-d1b9f3c0/")) latest = { path, created };
    } finally {
      db.close();
    }
  }
  return latest?.path ?? null;
}

function evidence(root: string, candidate: UnavailableCandidate): { evidence: Evidence; rowSha256: string } {
  const hostname = normalizeHost(candidate.hostname);
  if (hostname !== candidate.hostname || candidate.rationale.trim().length < 24 || candidate.rationale.length > 2000)
    throw new Error("Unavailable decision needs a normalized hostname and substantive rationale");
  const queuePath = assertExternalPath(candidate.queuePath);
  const part = relative(join(root, "runs"), queuePath);
  if (part.startsWith("..") || !part.endsWith("/state/queue.sqlite") || currentQueuePath(root, hostname) !== queuePath)
    throw new Error("Unavailable evidence must cite the latest exact queue row");
  const published = JSON.parse(readFileSync(join(ROOT, "data", "official-hosts.json"), "utf8")) as {
    hostname: string;
  }[];
  if (published.some((entry) => entry.hostname === hostname)) throw new Error("Published hosts cannot be unavailable");
  const queue = new DatabaseSync(queuePath, { readOnly: true });
  let row: Record<string, unknown> | undefined;
  try {
    row = queue.prepare("SELECT * FROM host_work WHERE hostname=?").get(hostname);
    if (row?.state !== "blocked" || row.admitted !== 0)
      throw new Error("Host has admitted content or no blocked claim");
    const last = queue
      .prepare("SELECT state FROM host_work_events WHERE hostname=? ORDER BY id DESC LIMIT 1")
      .get(hostname);
    if (last?.state !== "blocked") throw new Error("Missing terminal queue event");
  } finally {
    queue.close();
  }
  const reason = String((JSON.parse(String(row.details)) as { failure?: string }).failure ?? "");
  const directory = assertExternalPath(join(root, "hosts", hostname, "recording"));
  const state = assertExternalPath(join(directory, "state.sqlite"));
  let proof: Evidence;
  if (reason.startsWith(LICENSED) && hostname.endsWith(".ezproxy.library.ubc.ca") && !existsSync(state)) {
    proof = { kind: "licensed-proxy", recorded_reason: reason };
  } else {
    if (!existsSync(state)) throw new Error("Missing host recording evidence");
    const recordingSha = digest(readFileSync(state));
    const db = new DatabaseSync(state, { readOnly: true });
    try {
      const homepage = `https://${hostname}/`;
      const home = db.prepare("SELECT snapshot,error FROM outcomes WHERE url=?").get(homepage);
      if (home?.snapshot !== null || db.prepare("SELECT 1 FROM attempts WHERE url=? AND status=200").get(homepage))
        throw new Error("A recorded public homepage is not host-wide unavailable");
      if (reason === "URL is outside the exact HTTPS host scope" && home?.error === SCOPE) {
        const attempts = db
          .prepare("SELECT id,url,state,status,headers FROM attempts WHERE url IN (?,?) ORDER BY id")
          .all(`${homepage}robots.txt`, homepage);
        const redirect = attempts.find((attempt) => {
          if (attempt.state !== "observed" || ![301, 302, 303, 307, 308].includes(Number(attempt.status))) return false;
          const location = (JSON.parse(String(attempt.headers ?? "{}")) as { location?: string }).location;
          if (!location) return false;
          const target = new URL(location, String(attempt.url));
          return target.protocol !== "https:" || target.hostname !== hostname;
        });
        if (!redirect) throw new Error("No saved host-wide exact-scope redirect");
        const location = (JSON.parse(String(redirect.headers)) as { location: string }).location;
        proof = {
          kind: "exact-host-redirect",
          url: String(redirect.url),
          attempt_id: Number(redirect.id),
          status: Number(redirect.status),
          location,
          recording_sha256: recordingSha,
        };
      } else if (reason === `Robots disallows ${homepage}` && home?.error === `Error: ${reason}`) {
        const robotsUrl = `${homepage}robots.txt`;
        const receipt = db.prepare("SELECT snapshot FROM outcomes WHERE url=?").get(robotsUrl);
        const snapshotSha = String(receipt?.snapshot ?? "");
        if (!/^[a-f0-9]{64}$/.test(snapshotSha)) throw new Error("Missing saved robots policy");
        const bytes = readFileSync(assertExternalPath(join(directory, "objects", `${snapshotSha}.json`)));
        if (digest(bytes) !== snapshotSha) throw new Error("Robots snapshot differs from receipt");
        const saved = JSON.parse(bytes.toString("utf8")) as { status: number; body: string };
        if (saved.status !== 200 || parser(robotsUrl, saved.body).isDisallowed(homepage, "ubc-data") !== true)
          throw new Error("Saved robots policy does not deny the homepage");
        proof = { kind: "robots-homepage", snapshot_sha256: snapshotSha, recording_sha256: recordingSha };
      } else throw new Error("Failure does not prove host-wide unavailability");
    } finally {
      db.close();
    }
  }
  return { evidence: proof, rowSha256: digest(JSON.stringify(row)) };
}

export function inspectUnavailableCandidates(
  candidates: readonly UnavailableCandidate[],
  root = DEFAULT_EXTERNAL_ROOT,
) {
  if (!candidates.length || candidates.length > 500)
    throw new Error("Expected a finite nonempty unavailable selection");
  const hosts = candidates.map((candidate) => normalizeHost(candidate.hostname));
  if (new Set(hosts).size !== hosts.length) throw new Error("Duplicate unavailable hostname");
  return candidates.map((candidate) => ({ candidate, ...evidence(root, candidate) }));
}

export function currentUnavailableHosts(root = DEFAULT_EXTERNAL_ROOT): ReadonlySet<string> {
  const file = pathFor(root);
  if (!existsSync(file)) return new Set();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== 1)
      throw new Error("Unsupported disposition ledger schema");
    const rows = db
      .prepare(
        `SELECT hostname,kind FROM host_disposition_events AS event
      WHERE id=(SELECT max(id) FROM host_disposition_events WHERE hostname=event.hostname)`,
      )
      .all();
    return new Set(rows.filter((row) => row.kind === "unavailable").map((row) => String(row.hostname)));
  } finally {
    db.close();
  }
}

export class HostDispositionLedger {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly root: string,
  ) {}

  static open(root = DEFAULT_EXTERNAL_ROOT): HostDispositionLedger {
    const file = pathFor(root);
    mkdirSync(join(root, "state"), { recursive: true, mode: 0o700 });
    openedFile(file);
    const db = new DatabaseSync(file);
    try {
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      if (![0, 1].includes(version)) throw new Error("Unsupported disposition ledger schema");
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS host_disposition_events (
          id INTEGER PRIMARY KEY,
          hostname TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('unavailable','reopened')),
          queue_path TEXT NOT NULL,
          queue_row_sha256 TEXT NOT NULL,
          evidence TEXT NOT NULL,
          rationale TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS host_disposition_host ON host_disposition_events(hostname,id);
        CREATE TRIGGER IF NOT EXISTS host_disposition_no_update BEFORE UPDATE ON host_disposition_events
          BEGIN SELECT RAISE(ABORT,'Disposition events are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS host_disposition_no_delete BEFORE DELETE ON host_disposition_events
          BEGIN SELECT RAISE(ABORT,'Disposition events are immutable'); END;
        PRAGMA user_version=1;`);
      return new HostDispositionLedger(db, root);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  appendUnavailable(candidates: readonly UnavailableCandidate[]): number {
    const verified = inspectUnavailableCandidates(candidates, this.root);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.db.prepare(
        "SELECT kind FROM host_disposition_events WHERE hostname=? ORDER BY id DESC LIMIT 1",
      );
      const insert = this.db.prepare(
        "INSERT INTO host_disposition_events(hostname,kind,queue_path,queue_row_sha256,evidence,rationale,recorded_at) VALUES (?,'unavailable',?,?,?,?,?)",
      );
      for (const { candidate, evidence: proof, rowSha256 } of verified) {
        if (latest.get(candidate.hostname)?.kind === "unavailable") throw new Error("Host is already unavailable");
        insert.run(
          candidate.hostname,
          candidate.queuePath,
          rowSha256,
          JSON.stringify(proof),
          candidate.rationale.trim(),
          new Date().toISOString(),
        );
      }
      this.db.exec("COMMIT");
      return verified.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reopen(hostname: string, rationale: string): void {
    hostname = normalizeHost(hostname);
    if (rationale.trim().length < 24 || rationale.length > 2000)
      throw new Error("Reopening needs explicit new authority");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare("SELECT * FROM host_disposition_events WHERE hostname=? ORDER BY id DESC LIMIT 1")
        .get(hostname);
      if (previous?.kind !== "unavailable") throw new Error("Host is not unavailable");
      this.db
        .prepare(
          "INSERT INTO host_disposition_events(hostname,kind,queue_path,queue_row_sha256,evidence,rationale,recorded_at) VALUES (?,'reopened',?,?,?,?,?)",
        )
        .run(
          hostname,
          String(previous.queue_path),
          String(previous.queue_row_sha256),
          JSON.stringify({ prior_event_id: Number(previous.id) }),
          rationale.trim(),
          new Date().toISOString(),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
