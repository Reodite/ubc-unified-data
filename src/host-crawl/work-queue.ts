import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertExternalPath } from "./paths.ts";
import { normalizeHost } from "./urls.ts";

export const HOST_WORKERS = ["w1", "w2", "w3", "w4", "w5"] as const;
export type HostWorker = (typeof HOST_WORKERS)[number];
export const HOST_WORK_STATES = [
  "pending",
  "claimed",
  "admitted",
  "collecting",
  "ready",
  "publishing",
  "published",
  "rejected",
  "blocked",
] as const;
export type HostWorkState = (typeof HOST_WORK_STATES)[number];

export interface HostWorkSeed {
  hostname: string;
  /** Lower priorities are claimed first; equal priorities use normalized hostname order. */
  priority?: number;
  admitted?: boolean;
  homepage_sha256?: string;
  origin?: string;
}

export interface HostWorkClaim {
  hostname: string;
  token: string;
  worker: HostWorker;
  state: HostWorkState;
  homepage_sha256?: string;
  admitted: boolean;
}

export interface HostWorkEvent {
  id: number;
  from_state: HostWorkState | null;
  state: HostWorkState;
  token: string | null;
  worker: HostWorker | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface HostWorkRecord extends HostWorkSeed {
  priority: number;
  admitted: boolean;
  state: HostWorkState;
  token: string | null;
  worker: HostWorker | null;
  details: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  events: HostWorkEvent[];
}

export type HostWorkStats = Record<HostWorkState, number> & { total: number };
const terminal = new Set<HostWorkState>(["published", "rejected", "blocked"]);
const transitions: Record<HostWorkState, readonly HostWorkState[]> = {
  pending: [],
  claimed: ["admitted", "collecting", "rejected", "blocked"],
  admitted: ["collecting", "rejected", "blocked"],
  collecting: ["ready", "rejected", "blocked"],
  ready: ["publishing", "rejected", "blocked"],
  publishing: ["published", "blocked"],
  published: [],
  rejected: [],
  blocked: [],
};

type Row = Record<string, unknown>;

function homepageHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f\d]{64}$/i.test(value)) throw new Error("Invalid homepage_sha256");
  return value.toLowerCase();
}

function privateFile(path: string): void {
  assertExternalPath(path);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Queue files must be regular and unaliased");
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function record(row: Row): Omit<HostWorkRecord, "events"> {
  return {
    hostname: String(row.hostname),
    priority: Number(row.priority),
    admitted: row.admitted === 1,
    ...(row.homepage_sha256 === null ? {} : { homepage_sha256: String(row.homepage_sha256) }),
    ...(row.origin === null ? {} : { origin: String(row.origin) }),
    state: row.state as HostWorkState,
    token: row.token as string | null,
    worker: row.worker as HostWorker | null,
    details: JSON.parse(String(row.details)),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** A private queue with persistent claims. Reopening never releases ownership or retries failed hosts. */
export class HostWorkQueue {
  private closed = false;
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): HostWorkQueue {
    const file = assertExternalPath(path);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    for (const suffix of ["", "-journal", "-wal", "-shm"]) privateFile(`${file}${suffix}`);
    try {
      closeSync(openSync(file, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    privateFile(file);
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      const queue = new HostWorkQueue(db);
      queue.transaction(() => {
        const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
        if (version !== 0 && version !== 1) throw new Error(`Unsupported queue schema: ${version}`);
        db.exec(`
          CREATE TABLE IF NOT EXISTS host_work (
            hostname TEXT PRIMARY KEY CHECK(hostname=lower(hostname) AND hostname NOT LIKE '%.'),
            priority INTEGER NOT NULL,
            admitted INTEGER NOT NULL CHECK(admitted IN (0,1)),
            homepage_sha256 TEXT,
            origin TEXT,
            state TEXT NOT NULL CHECK(state IN (${HOST_WORK_STATES.map((state) => `'${state}'`).join(",")})),
            token TEXT UNIQUE,
            worker TEXT CHECK(worker IN ('w1','w2','w3','w4','w5')),
            details TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK((state='pending' AND token IS NULL AND worker IS NULL)
              OR (state<>'pending' AND token IS NOT NULL AND worker IS NOT NULL))
          ) STRICT;
          CREATE INDEX IF NOT EXISTS host_work_pending ON host_work(priority,hostname) WHERE state='pending';
          CREATE UNIQUE INDEX IF NOT EXISTS host_work_active_worker ON host_work(worker)
            WHERE state NOT IN ('pending','published','rejected','blocked');
          CREATE TABLE IF NOT EXISTS host_work_events (
            id INTEGER PRIMARY KEY,
            hostname TEXT NOT NULL REFERENCES host_work(hostname),
            from_state TEXT,
            state TEXT NOT NULL,
            token TEXT,
            worker TEXT,
            details TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS host_work_event_host ON host_work_events(hostname,id);
          CREATE TRIGGER IF NOT EXISTS host_work_events_no_update BEFORE UPDATE ON host_work_events
            BEGIN SELECT RAISE(ABORT, 'Queue events are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS host_work_events_no_delete BEFORE DELETE ON host_work_events
            BEGIN SELECT RAISE(ABORT, 'Queue events are immutable'); END;
          PRAGMA user_version=1;
        `);
      });
      return queue;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Insert new normalized hosts only. Existing priorities, cached triage and terminal outcomes remain intact. */
  seed(items: HostWorkSeed[]): void {
    this.assertOpen();
    const normalized = items.map((item) => {
      const hostname = normalizeHost(item.hostname);
      const priority = item.priority ?? 0;
      if (!Number.isSafeInteger(priority)) throw new Error("Invalid queue priority");
      if (item.admitted !== undefined && typeof item.admitted !== "boolean") throw new Error("Invalid admission");
      if (item.origin !== undefined && typeof item.origin !== "string") throw new Error("Invalid queue origin");
      return {
        ...item,
        hostname,
        priority,
        admitted: item.admitted ?? false,
        homepage_sha256: homepageHash(item.homepage_sha256),
      };
    });
    this.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO host_work
        (hostname,priority,admitted,homepage_sha256,origin,state,token,worker,details,created_at,updated_at)
        VALUES (?,?,?,?,?,'pending',NULL,NULL,'{}',?,?) ON CONFLICT(hostname) DO NOTHING`);
      for (const item of normalized) {
        const now = new Date().toISOString();
        const result = insert.run(
          item.hostname,
          item.priority,
          Number(item.admitted),
          item.homepage_sha256 ?? null,
          item.origin ?? null,
          now,
          now,
        );
        if (result.changes) this.event(item.hostname, null, "pending", null, null, item, now);
      }
    });
  }

  /** Claim one pending host. A busy worker returns null; use get() and the saved token for explicit recovery. */
  claim(worker: string): HostWorkClaim | null {
    this.assertOpen();
    if (!HOST_WORKERS.includes(worker as HostWorker)) throw new Error("Worker must be one of w1..w5");
    return this.transaction(() => {
      if (
        this.db
          .prepare("SELECT 1 FROM host_work WHERE worker=? AND state NOT IN ('published','rejected','blocked')")
          .get(worker)
      )
        return null;
      const row = this.db
        .prepare(
          "SELECT * FROM host_work WHERE state='pending' ORDER BY priority ASC,hostname COLLATE BINARY ASC LIMIT 1",
        )
        .get();
      if (!row) return null;
      const host = record(row);
      const token = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE host_work SET state='claimed',token=?,worker=?,updated_at=? WHERE hostname=?")
        .run(token, worker, now, host.hostname);
      this.event(host.hostname, "pending", "claimed", token, worker as HostWorker, {}, now);
      return {
        hostname: host.hostname,
        token,
        worker: worker as HostWorker,
        state: "claimed",
        admitted: host.admitted,
        ...(host.homepage_sha256 ? { homepage_sha256: host.homepage_sha256 } : {}),
      };
    });
  }

  current(worker: string): HostWorkRecord | null {
    this.assertOpen();
    if (!HOST_WORKERS.includes(worker as HostWorker)) throw new Error("Worker must be one of w1..w5");
    const row = this.db
      .prepare(
        "SELECT hostname FROM host_work WHERE worker=? AND state NOT IN ('pending','published','rejected','blocked')",
      )
      .get(worker);
    return row ? this.get(String(row.hostname)) : null;
  }

  /** Advance an owned claim; details merge into the result and remain verbatim in immutable events. */
  update(hostname: string, token: string, state: HostWorkState, details: object = {}): void {
    this.assertOpen();
    hostname = normalizeHost(hostname);
    if (!HOST_WORK_STATES.includes(state)) throw new Error("Invalid queue state");
    if (!details || Array.isArray(details) || ![Object.prototype, null].includes(Object.getPrototypeOf(details)))
      throw new Error("Queue details must be a JSON object");
    const saved: Record<string, unknown> = JSON.parse(JSON.stringify(details));
    if (!saved || typeof saved !== "object" || Array.isArray(saved))
      throw new Error("Queue details must be a JSON object");
    const hash = homepageHash(saved.homepage_sha256);
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM host_work WHERE hostname=?").get(hostname);
      if (!row || !token || row.token !== token) throw new Error("Queue claim token does not own this hostname");
      const host = record(row);
      if (terminal.has(host.state)) throw new Error(`Terminal queue state is immutable: ${host.state}`);
      if (state !== host.state && !transitions[host.state].includes(state))
        throw new Error(`Invalid queue transition: ${host.state} -> ${state}`);
      const admitted = host.admitted || state === "admitted";
      if (state === "collecting" && !admitted) throw new Error("Collection requires homepage admission");
      if (saved.admitted !== undefined && saved.admitted !== admitted)
        throw new Error("Admission must follow queue state");
      if (hash && host.homepage_sha256 && hash !== host.homepage_sha256)
        throw new Error("Cached homepage digest is immutable");
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE host_work SET state=?,admitted=?,homepage_sha256=?,details=?,updated_at=? WHERE hostname=? AND token=?",
        )
        .run(
          state,
          Number(admitted),
          host.homepage_sha256 ?? hash ?? null,
          JSON.stringify({ ...host.details, ...saved }),
          now,
          hostname,
          token,
        );
      this.event(hostname, host.state, state, token, host.worker, saved, now);
    });
  }

  get(hostname: string): HostWorkRecord | null {
    this.assertOpen();
    hostname = normalizeHost(hostname);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM host_work WHERE hostname=?").get(hostname);
      if (!row) return null;
      const events = this.db
        .prepare("SELECT * FROM host_work_events WHERE hostname=? ORDER BY id")
        .all(hostname)
        .map((event) => ({
          id: Number(event.id),
          from_state: event.from_state as HostWorkState | null,
          state: event.state as HostWorkState,
          token: event.token as string | null,
          worker: event.worker as HostWorker | null,
          details: JSON.parse(String(event.details)),
          created_at: String(event.created_at),
        }));
      return { ...record(row), events };
    }, false);
  }

  stats(): HostWorkStats {
    this.assertOpen();
    const counts = Object.fromEntries(HOST_WORK_STATES.map((state) => [state, 0])) as HostWorkStats;
    counts.total = 0;
    for (const row of this.db.prepare("SELECT state,count(*) AS count FROM host_work GROUP BY state").all()) {
      counts[row.state as HostWorkState] = Number(row.count);
      counts.total += Number(row.count);
    }
    return counts;
  }

  close(): void {
    if (!this.closed) this.db.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Host work queue is closed");
  }

  private transaction<T>(run: () => T, write = true): T {
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private event(
    hostname: string,
    from: HostWorkState | null,
    state: HostWorkState,
    token: string | null,
    worker: HostWorker | null,
    details: object,
    now: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO host_work_events(hostname,from_state,state,token,worker,details,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(hostname, from, state, token, worker, JSON.stringify(details), now);
  }
}
