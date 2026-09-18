import { createHash } from "node:crypto";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { USER_AGENT } from "../base.ts";
import { publicUbcUrl } from "../prose/client.ts";
import { NonTextMediaError, type Observation, type ProducerContext, type Snapshot } from "./contracts.ts";
import { assertExternalPath } from "./paths.ts";
import { readRegularFile } from "./public-validation.ts";
import { hostUrl, normalizeHost } from "./urls.ts";

const parser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  body: string,
) => {
  isDisallowed(url: string, agent: string): boolean | undefined;
  getCrawlDelay(agent: string): number | undefined;
  getSitemaps(): string[];
};
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const retryable = new Set([408, 429, 500, 502, 503, 504]);
async function durableObject(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(join(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export interface RecordingOptions {
  hostname: string;
  directory: string;
  producer: ProducerContext;
  acquire: boolean;
  seedSha256?: string;
  maxRequests?: number;
  maxBytes?: number;
  maxResponseBytes?: number;
  maxDurationMs?: number;
  minimumMs?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  resumeInterrupted?: boolean;
}

/** Persist request intents and immutable outcomes externally; replay never falls through to a network request. */
export class HostRecording {
  private constructor(
    readonly options: RecordingOptions,
    private db: DatabaseSync,
    private lock: DatabaseSync,
    private config: Record<string, unknown>,
  ) {}
  private rules?: ReturnType<typeof parser>;
  private lastStart = 0;
  private started = Date.now();
  private active = new Set<string>();
  private closed = false;
  private sealed = false;
  private readTail: Promise<void> = Promise.resolve();
  private seen = new Map<string, string>();

  static async open(options: RecordingOptions): Promise<HostRecording> {
    if (normalizeHost(options.hostname) !== options.hostname) throw new Error("Noncanonical recording hostname");
    const directory = assertExternalPath(options.directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "objects"), { recursive: true, mode: 0o700 });
    const lockPath = assertExternalPath(join(directory, "owner.sqlite"));
    try {
      const info = await lstat(lockPath);
      if (!info.isFile() || info.nlink !== 1) throw new Error("Recording lock must be a regular unaliased file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lock = new DatabaseSync(lockPath);
    let db: DatabaseSync | undefined;
    try {
      lock.exec("CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;");
      const statePath = assertExternalPath(join(directory, "state.sqlite"));
      for (const path of [lockPath, statePath]) {
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.nlink !== 1)
            throw new Error("Recording database must be a regular unaliased file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (options.acquire) {
        try {
          await lstat(join(directory, "seal.json"));
          throw new Error("Sealed acquisition is immutable; use offline replay");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      db = new DatabaseSync(statePath, { readOnly: !options.acquire });
      if (options.acquire)
        db.exec(
          "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outcomes (url TEXT PRIMARY KEY, snapshot TEXT, error TEXT); CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, url TEXT NOT NULL, started TEXT NOT NULL, state TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, snapshot TEXT, body_sha TEXT, status INTEGER, headers TEXT, error TEXT);",
        );
      else db.exec("PRAGMA query_only=ON;");
      const requested = {
        version: 1,
        hostname: options.hostname,
        producer: options.producer,
        seed_sha256: options.seedSha256 ?? null,
        maxRequests: options.maxRequests ?? 1000,
        maxBytes: options.maxBytes ?? 128 * 1024 * 1024,
        maxResponseBytes: options.maxResponseBytes ?? 8 * 1024 * 1024,
        maxDurationMs: options.maxDurationMs ?? 20 * 60 * 1000,
        minimumMs: options.minimumMs ?? 750,
        timeoutMs: options.timeoutMs ?? 30000,
      };
      for (const [key, value] of Object.entries(requested))
        if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1))
          throw new Error(`Invalid acquisition bound: ${key}`);
      const old = db.prepare("SELECT value FROM config WHERE id=1").get()?.value;
      if (!old && !options.acquire) throw new Error("No saved recording to replay");
      if (!old) db.prepare("INSERT INTO config VALUES (1,?)").run(JSON.stringify(requested));
      const config = old ? JSON.parse(String(old)) : requested;
      if (config.hostname !== options.hostname || config.seed_sha256 !== (options.seedSha256 ?? null))
        throw new Error("Recording hostname or frontier digest mismatch");
      if (options.acquire && JSON.stringify({ ...config, producer: requested.producer }) !== JSON.stringify(requested))
        throw new Error("Acquisition options changed; replay saved input or create a new explicit recording");
      if (options.acquire) {
        db.exec(
          "CREATE TABLE IF NOT EXISTS attempt_producers (attempt_id INTEGER PRIMARY KEY, producer TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outcome_failures (id INTEGER PRIMARY KEY, url TEXT NOT NULL, error TEXT NOT NULL, recorded_at TEXT NOT NULL);",
        );
        db.prepare("INSERT OR IGNORE INTO attempt_producers SELECT id,? FROM attempts").run(
          JSON.stringify(config.producer),
        );
      }
      const pending = db.prepare("SELECT count(*) n FROM attempts WHERE state='dispatching'").get()!.n;
      if (pending && (!options.acquire || !options.resumeInterrupted))
        throw new Error("Uncertain prior requests require explicit acquisition resume; saved outcomes are preserved");
      if (pending)
        db.prepare(
          "UPDATE attempts SET state='uncertain', bytes=max(bytes,?), error='Interrupted with no committed response; explicit resume requested; maximum response bytes reserved' WHERE state='dispatching'",
        ).run(Number(config.maxResponseBytes));
      const recording = new HostRecording(options, db, lock, config);
      return recording;
    } catch (error) {
      db?.close();
      lock.close();
      throw error;
    }
  }

  private scoped(value: string): string {
    return publicUbcUrl(hostUrl(value, this.options.hostname));
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("Recording is closed");
  }
  private async store(snapshot: Snapshot): Promise<Observation> {
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const sha256 = hash(bytes);
    const path = assertExternalPath(join(this.options.directory, "objects", `${sha256}.json`));
    try {
      await durableObject(path, bytes);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(await readRegularFile(path, 64 * 1024 * 1024)).equals(bytes)
      )
        throw error;
    }
    this.seen.set(sha256, path);
    return { sha256, snapshot };
  }
  async readSnapshot(sha256: string): Promise<Observation> {
    this.assertOpen();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid snapshot digest");
    const path = assertExternalPath(join(this.options.directory, "objects", `${sha256}.json`));
    const bytes = await readRegularFile(path, 64 * 1024 * 1024);
    if (hash(bytes) !== sha256) throw new Error("Recorded snapshot bytes changed");
    const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Snapshot;
    this.scoped(snapshot.url);
    this.scoped(snapshot.requested_url);
    if (
      typeof snapshot.body !== "string" ||
      !Number.isFinite(Date.parse(snapshot.retrieved_at)) ||
      !Number.isInteger(snapshot.status)
    )
      throw new Error("Invalid recorded observation");
    this.seen.set(sha256, path);
    return { sha256, snapshot };
  }

  private async policy() {
    if (!this.rules) {
      const robots = await this.readLogical(`https://${this.options.hostname}/robots.txt`, false);
      if (![200, 404, 410].includes(robots.snapshot.status)) throw new Error("Robots policy unavailable");
      this.rules = parser(robots.snapshot.url, robots.snapshot.status === 200 ? robots.snapshot.body : "");
    }
    return this.rules;
  }
  async sitemaps(): Promise<string[]> {
    return (await this.policy()).getSitemaps();
  }

  private async dispatch(url: string, minimum: number): Promise<Observation> {
    const saved = this.db
      .prepare("SELECT state,status,headers,snapshot FROM attempts WHERE url=? ORDER BY id DESC LIMIT 1")
      .get(url);
    const count = Number(this.db.prepare("SELECT count(*) n FROM attempts WHERE url=?").get(url)!.n);
    if (saved?.state === "excluded-media") {
      const headers = JSON.parse(String(saved.headers)) as Record<string, string>;
      const mediaType = headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!/^(?:image|audio|video)\/[a-z0-9.+-]+$/.test(mediaType))
        throw new Error("Invalid saved media classification");
      throw new NonTextMediaError(mediaType);
    }
    if (saved?.state === "observed" && saved.snapshot && (!retryable.has(Number(saved.status)) || count >= 3))
      return this.readSnapshot(String(saved.snapshot));
    if (count >= 3) throw new Error("Physical URL attempt bound exhausted");
    const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
    if (
      Number(stats.requests) >= Number(this.config.maxRequests) ||
      Number(stats.bytes) >= Number(this.config.maxBytes)
    )
      throw new Error("Acquisition request/byte budget exhausted");
    if (Date.now() - this.started >= Number(this.config.maxDurationMs))
      throw new Error("Acquisition duration exhausted");
    const wait = Math.max(0, this.lastStart + minimum - Date.now());
    if (Date.now() - this.started + wait >= Number(this.config.maxDurationMs))
      throw new Error("Acquisition wait exceeds remaining duration");
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastStart = Date.now();
    let id: number;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("INSERT INTO attempts(url,started,state) VALUES (?,?,'dispatching')")
        .run(url, new Date().toISOString());
      id = Number(row.lastInsertRowid);
      this.db.prepare("INSERT INTO attempt_producers VALUES (?,?)").run(id, JSON.stringify(this.options.producer));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    let received = 0;
    const controller = new AbortController();
    const remaining = Number(this.config.maxDurationMs) - (Date.now() - this.started);
    const timer = setTimeout(() => controller.abort(), Math.min(Number(this.config.timeoutMs), remaining));
    try {
      const response = await (this.options.fetcher ?? fetch)(url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      this.db
        .prepare("UPDATE attempts SET status=?,headers=? WHERE id=?")
        .run(response.status, JSON.stringify(Object.fromEntries(response.headers)), id);
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (response.status === 200 && /^(?:image|audio|video)\/[a-z0-9.+-]+$/.test(mediaType)) {
        await response.body?.cancel();
        throw new NonTextMediaError(mediaType);
      }
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      if (reader)
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          received += item.value.length;
          this.db.prepare("UPDATE attempts SET bytes=? WHERE id=?").run(received, id);
          if (
            received > Number(this.config.maxResponseBytes) ||
            Number(stats.bytes) + received > Number(this.config.maxBytes)
          ) {
            await reader.cancel();
            throw new Error("Acquisition response/total byte budget exceeded");
          }
          chunks.push(item.value);
        }
      const raw = Buffer.concat(chunks);
      const rawPath = assertExternalPath(join(this.options.directory, "objects", `${hash(raw)}.body`));
      try {
        await durableObject(rawPath, raw);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !(await readRegularFile(rawPath, Number(this.config.maxResponseBytes))).equals(raw)
        )
          throw error;
      }
      this.db.prepare("UPDATE attempts SET body_sha=? WHERE id=?").run(hash(raw), id);
      const contentType = response.headers.get("content-type") ?? "";
      if (!/text|json|xml|javascript|^$/i.test(contentType))
        throw new Error(`Unsupported recorded document format: ${contentType}`);
      const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
      const snapshot: Snapshot = {
        requested_url: url,
        url,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: new TextDecoder(charset, { fatal: true }).decode(raw),
        retrieved_at: new Date().toISOString(),
        bytes: raw.length,
      };
      const observation = await this.store(snapshot);
      this.db.prepare("UPDATE attempts SET state='observed',snapshot=? WHERE id=?").run(observation.sha256, id);
      return observation;
    } catch (error) {
      const detail =
        error instanceof Error && error.cause
          ? `${error.name}: ${error.message}; cause: ${String(error.cause)}`
          : String(error);
      this.db
        .prepare("UPDATE attempts SET state=?,error=? WHERE id=?")
        .run(error instanceof NonTextMediaError ? "excluded-media" : "failed", detail, id);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  read(value: string): Promise<Observation> {
    const result = this.readTail.then(() => this.readLogical(value));
    this.readTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async readLogical(value: string, enforceRobots = true): Promise<Observation> {
    this.assertOpen();
    const initial = this.scoped(value);
    if (initial === `https://${this.options.hostname}/robots.txt`) enforceRobots = false;
    const cached = this.db.prepare("SELECT snapshot,error FROM outcomes WHERE url=?").get(initial);
    if (cached?.error) {
      const media = /^NonTextMediaError: Observed non-text media: ((?:image|audio|video)\/[a-z0-9.+-]+)$/.exec(
        String(cached.error),
      );
      if (media) throw new NonTextMediaError(media[1]!);
      throw new Error(`Saved request failure: ${cached.error}`);
    }
    if (cached?.snapshot) return this.readSnapshot(String(cached.snapshot));
    if (!this.options.acquire || this.sealed) throw new Error(`Missing recorded request: ${initial}`);
    if (this.active.has(initial)) throw new Error("Recursive request dependency");
    this.active.add(initial);
    try {
      let url = initial;
      const visited = new Set<string>();
      const redirects: NonNullable<Snapshot["redirects"]> = [];
      for (;;) {
        if (visited.has(url) || visited.size >= 8) throw new Error("Redirect loop or bound exceeded");
        visited.add(url);
        const policy = enforceRobots ? await this.policy() : undefined;
        if (policy?.isDisallowed(url, "ubc-data")) throw new Error(`Robots disallows ${url}`);
        const minimum = Math.max(Number(this.config.minimumMs), (policy?.getCrawlDelay("ubc-data") ?? 0) * 1000);
        let observation: Observation;
        for (;;) {
          const prior = Number(this.db.prepare("SELECT count(*) n FROM attempts WHERE url=?").get(url)!.n);
          try {
            observation = await this.dispatch(url, minimum);
          } catch (error) {
            const status = this.db
              .prepare("SELECT status FROM attempts WHERE url=? ORDER BY id DESC LIMIT 1")
              .get(url)?.status;
            if (
              prior < 2 &&
              (status === null || status === 200 || retryable.has(Number(status))) &&
              /fetch failed|TimeoutError|AbortError|terminated/.test(String(error))
            )
              continue;
            throw error;
          }
          if (!retryable.has(observation.snapshot.status) || prior >= 2) break;
          const header = observation.snapshot.headers["retry-after"];
          const number = header === undefined ? NaN : Number(header);
          const delay = Number.isFinite(number)
            ? number * 1000
            : header
              ? Date.parse(header) - Date.now()
              : 1000 * 2 ** prior;
          const wait = Math.max(0, Number.isFinite(delay) ? delay : 1000 * 2 ** prior);
          if (Date.now() - this.started + wait >= Number(this.config.maxDurationMs))
            throw new Error("Retry wait exceeds duration budget");
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        if ([301, 302, 303, 307, 308].includes(observation.snapshot.status)) {
          const location = observation.snapshot.headers.location;
          if (!location) throw new Error("Redirect lacks Location");
          const next = this.scoped(new URL(location, url).href);
          redirects.push({ url, location: next, status: observation.snapshot.status, snapshot: observation.sha256 });
          url = next;
          continue;
        }
        const final = redirects.length
          ? await this.store({ ...observation.snapshot, requested_url: initial, redirects })
          : observation;
        this.db.prepare("INSERT INTO outcomes(url,snapshot) VALUES (?,?)").run(initial, final.sha256);
        return final;
      }
    } catch (error) {
      this.db.prepare("INSERT OR IGNORE INTO outcomes(url,error) VALUES (?,?)").run(initial, String(error));
      throw error;
    } finally {
      this.active.delete(initial);
    }
  }

  private observedRedirectTrace(value: string): string[] {
    this.assertOpen();
    let url = this.scoped(value);
    const seen = new Set<string>();
    while (!seen.has(url) && seen.size < 8) {
      seen.add(url);
      const row = this.db
        .prepare("SELECT state,status,headers FROM attempts WHERE url=? ORDER BY id DESC LIMIT 1")
        .get(url);
      if (row?.state !== "observed" || ![301, 302, 303, 307, 308].includes(Number(row.status))) return [...seen];
      const headers = JSON.parse(String(row.headers)) as Record<string, string>;
      if (!headers.location) throw new Error("Observed redirect lacks its recorded location");
      url = this.scoped(new URL(headers.location, url).href);
    }
    throw new Error("Observed redirect cycle or bound exceeded");
  }

  observedDestination(value: string): string {
    return this.observedRedirectTrace(value).at(-1)!;
  }

  apiFallbackEligible(value: string): boolean {
    const trace = this.observedRedirectTrace(value);
    for (const url of trace)
      if (this.db.prepare("SELECT 1 FROM attempts WHERE url=? AND status IN (401,403,404) LIMIT 1").get(url))
        return false;
    const last = this.db
      .prepare("SELECT state,status,error FROM attempts WHERE url=? ORDER BY id DESC LIMIT 1")
      .get(trace.at(-1)!);
    return (
      last?.state === "failed" &&
      (last.status === null || last.status === 200) &&
      /fetch failed|TimeoutError|AbortError|terminated/.test(String(last.error))
    );
  }

  retryNetworkFailure(value: string): void {
    if (!this.options.acquire || this.sealed) throw new Error("Retry requires unsealed explicit acquisition");
    const url = this.scoped(value);
    const outcome = this.db.prepare("SELECT error FROM outcomes WHERE url=?").get(url);
    const attempts = this.db.prepare("SELECT state,status,error FROM attempts WHERE url=? ORDER BY id").all(url);
    const last = attempts.at(-1);
    if (
      !outcome?.error ||
      !last ||
      last.state !== "failed" ||
      last.status !== null ||
      attempts.length >= 3 ||
      !/fetch failed|TimeoutError|AbortError/.test(String(last.error))
    )
      throw new Error("Only a recorded transient network failure within the three-attempt bound can be retried");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO outcome_failures(url,error,recorded_at) VALUES (?,?,?)")
        .run(url, String(outcome.error), new Date().toISOString());
      this.db.prepare("DELETE FROM outcomes WHERE url=?").run(url);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  inputDigest(): string {
    const outcomes = this.db.prepare("SELECT * FROM outcomes ORDER BY url").all();
    const attempts = this.db.prepare("SELECT * FROM attempts ORDER BY id").all();
    const producers = this.db.prepare("SELECT * FROM attempt_producers ORDER BY attempt_id").all();
    const failures = this.db.prepare("SELECT * FROM outcome_failures ORDER BY id").all();
    return hash(JSON.stringify({ config: this.config, outcomes, attempts, producers, failures }));
  }
  async seal(): Promise<string> {
    this.assertOpen();
    await this.assertUnchanged();
    if (this.db.prepare("SELECT 1 FROM attempts WHERE state='dispatching' LIMIT 1").get())
      throw new Error("Unfinished acquisition");
    const digest = this.inputDigest();
    const target = assertExternalPath(join(this.options.directory, "seal.json"));
    const body = Buffer.from(
      `${JSON.stringify({ version: 1, hostname: this.options.hostname, input_sha256: digest })}\n`,
    );
    try {
      const existing = await readRegularFile(target);
      if (!existing.equals(body)) throw new Error("Existing seal differs");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await durableObject(`${target}.tmp`, body);
      await rename(`${target}.tmp`, target);
      const parent = await open(this.options.directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    this.sealed = true;
    return digest;
  }
  async verifySeal(): Promise<string> {
    const saved = JSON.parse(
      (await readRegularFile(assertExternalPath(join(this.options.directory, "seal.json")))).toString("utf8"),
    );
    if (saved.hostname !== this.options.hostname || saved.input_sha256 !== this.inputDigest())
      throw new Error("Recording seal mismatch");
    await this.assertUnchanged();
    if (saved.input_sha256 !== this.inputDigest()) throw new Error("Recording changed during seal verification");
    return saved.input_sha256;
  }
  async assertUnchanged(): Promise<void> {
    this.assertOpen();
    for (const row of this.db
      .prepare("SELECT snapshot,body_sha FROM attempts WHERE snapshot IS NOT NULL OR body_sha IS NOT NULL")
      .all()) {
      if (row.snapshot) await this.readSnapshot(String(row.snapshot));
      if (row.body_sha) {
        if (!/^[a-f0-9]{64}$/.test(String(row.body_sha))) throw new Error("Invalid raw-body digest");
        const path = assertExternalPath(join(this.options.directory, "objects", `${row.body_sha}.body`));
        if (hash(await readRegularFile(path, Number(this.config.maxResponseBytes))) !== row.body_sha)
          throw new Error("Recorded raw body changed");
      }
    }
    for (const [sha, path] of this.seen)
      if (hash(await readRegularFile(path, 64 * 1024 * 1024)) !== sha) throw new Error("Recording object changed");
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.db.close();
      } finally {
        this.lock.close();
      }
    }
  }
}
