import { createHash } from "node:crypto";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { USER_AGENT } from "../base.ts";
import { publicUbcUrl } from "../prose/client.ts";
import {
  DocumentPolicyError,
  NonTextMediaError,
  type Observation,
  type ProducerContext,
  type Snapshot,
} from "./contracts.ts";
import { assertExternalPath } from "./paths.ts";
import { readRegularFile } from "./public-validation.ts";
import { decodeRecordedText } from "./text-decoding.ts";
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
const transientTransportFailure = (error: string): boolean =>
  /\b(?:ECONNRESET|AbortError|TimeoutError)\b|other side closed/i.test(error) &&
  !/\b(?:ENOTFOUND|EAI_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z_]+)\b|certificate|hostname mismatch|\bDNS\b/i.test(
    error,
  );
const matchesTransportFailure = (logical: string, physical: string): boolean => {
  const reason = logical.replace(/^(?:Error: Saved request failure: )+/, "");
  return reason === physical || reason === physical.split("; cause: ", 1)[0];
};
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
export interface AcquisitionBudgetGrant {
  id: string;
  authoritySha256: string;
  expectedRequests: number;
  expectedBytes: number;
  additionalRequests: number;
  additionalBytes: number;
  minimumIntervalMs: number;
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
  recoverTransientFailures?: boolean;
  documentFormats?: readonly "pdf"[];
  documentUrlAllowed?: (url: string) => boolean;
  htmlDocumentsOnly?: boolean;
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
  // Equal-byte snapshot JSON and raw responses occupy distinct artifact paths.
  private seenTextBodies = new Map<string, string>();

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
        ...(options.documentFormats?.length ? { documentFormats: [...options.documentFormats] } : {}),
      };
      if (
        options.documentFormats?.some((format) => format !== "pdf") ||
        new Set(options.documentFormats).size !== (options.documentFormats?.length ?? 0)
      )
        throw new Error("Invalid declared recording document formats");
      for (const [key, value] of Object.entries(requested))
        if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1))
          throw new Error(`Invalid acquisition bound: ${key}`);
      const old = db.prepare("SELECT value FROM config WHERE id=1").get()?.value;
      if (!old && !options.acquire) throw new Error("No saved recording to replay");
      if (!old) db.prepare("INSERT INTO config VALUES (1,?)").run(JSON.stringify(requested));
      const config = old ? JSON.parse(String(old)) : requested;
      if (config.hostname !== options.hostname || config.seed_sha256 !== (options.seedSha256 ?? null))
        throw new Error("Recording hostname or frontier digest mismatch");
      const compatibleRequest: Record<string, unknown> = { ...requested };
      if (old && options.htmlDocumentsOnly === true) {
        compatibleRequest.maxResponseBytes = config.maxResponseBytes;
        if (Object.hasOwn(config, "documentFormats")) compatibleRequest.documentFormats = config.documentFormats;
        else delete compatibleRequest.documentFormats;
      }
      if (
        options.acquire &&
        JSON.stringify({ ...config, producer: requested.producer }) !== JSON.stringify(compatibleRequest)
      )
        throw new Error("Acquisition options changed; replay saved input or create a new explicit recording");
      if (options.acquire) {
        db.exec(
          "CREATE TABLE IF NOT EXISTS attempt_producers (attempt_id INTEGER PRIMARY KEY, producer TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outcome_failures (id INTEGER PRIMARY KEY, url TEXT NOT NULL, error TEXT NOT NULL, recorded_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS repair_authorizations (url TEXT PRIMARY KEY, reason TEXT NOT NULL, authorized_at TEXT NOT NULL, producer TEXT NOT NULL, attempt_count INTEGER NOT NULL, attempt_ceiling INTEGER NOT NULL CHECK(attempt_ceiling <= 6 AND attempt_ceiling > attempt_count AND attempt_ceiling <= attempt_count + 3)); CREATE TABLE IF NOT EXISTS acquisition_budget_grants (id TEXT PRIMARY KEY, authority_sha256 TEXT NOT NULL, authorized_at TEXT NOT NULL, expected_requests INTEGER NOT NULL, expected_bytes INTEGER NOT NULL, additional_requests INTEGER NOT NULL CHECK(additional_requests > 0), additional_bytes INTEGER NOT NULL CHECK(additional_bytes > 0), minimum_interval_ms INTEGER NOT NULL CHECK(minimum_interval_ms >= 1000)); CREATE TABLE IF NOT EXISTS acquisition_budget_grants_v2 (id TEXT PRIMARY KEY, authority_sha256 TEXT NOT NULL, authorized_at TEXT NOT NULL, expected_requests INTEGER NOT NULL, expected_bytes INTEGER NOT NULL, additional_requests INTEGER NOT NULL CHECK(additional_requests >= 0), additional_bytes INTEGER NOT NULL CHECK(additional_bytes >= 0), minimum_interval_ms INTEGER NOT NULL CHECK(minimum_interval_ms >= 1000), CHECK(additional_requests > 0 OR additional_bytes > 0));",
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
    if (snapshot.binary) await this.binaryBytes(snapshot);
    this.seen.set(sha256, path);
    return { sha256, snapshot };
  }

  private async binaryBytes(snapshot: Snapshot): Promise<Buffer> {
    const binary = snapshot.binary;
    if (
      binary?.media_type !== "application/pdf" ||
      !/^[a-f0-9]{64}$/.test(binary.sha256) ||
      snapshot.body !== "" ||
      !Number.isSafeInteger(snapshot.bytes) ||
      snapshot.bytes < 1 ||
      !Array.isArray(this.config.documentFormats) ||
      !this.config.documentFormats.includes("pdf")
    )
      throw new Error("Invalid or undeclared binary observation");
    const path = assertExternalPath(join(this.options.directory, "objects", `${binary.sha256}.body`));
    const bytes = await readRegularFile(path, Number(this.config.maxResponseBytes));
    if (bytes.length !== snapshot.bytes || hash(bytes) !== binary.sha256)
      throw new Error("Recorded binary body changed");
    return bytes;
  }

  async readBytes(snapshotSha256: string): Promise<Buffer> {
    return this.binaryBytes((await this.readSnapshot(snapshotSha256)).snapshot);
  }

  private async readPhysicalTextBytes(observation: Observation): Promise<{ bytes: Buffer; sha256: string }> {
    const { snapshot, sha256: snapshotSha256 } = observation;
    if (
      Object.hasOwn(snapshot, "binary") ||
      Object.hasOwn(snapshot, "redirects") ||
      snapshot.requested_url !== snapshot.url ||
      this.scoped(snapshot.url) !== snapshot.url ||
      !Number.isSafeInteger(snapshot.bytes) ||
      snapshot.bytes < 0 ||
      snapshot.bytes > Number(this.config.maxResponseBytes) ||
      !snapshot.headers ||
      typeof snapshot.headers !== "object" ||
      Array.isArray(snapshot.headers) ||
      Object.values(snapshot.headers).some((value) => typeof value !== "string") ||
      hash(JSON.stringify(snapshot)) !== snapshotSha256
    )
      throw new Error("Invalid physical text observation");
    const receipts = this.db
      .prepare("SELECT url,state,bytes,body_sha,status,headers,error FROM attempts WHERE snapshot=?")
      .all(snapshotSha256);
    const sha256 = receipts[0]?.body_sha;
    if (
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      receipts.some(
        (receipt) =>
          receipt.state !== "observed" ||
          receipt.error !== null ||
          receipt.url !== snapshot.url ||
          receipt.status !== snapshot.status ||
          receipt.bytes !== snapshot.bytes ||
          receipt.body_sha !== sha256 ||
          receipt.headers !== JSON.stringify(snapshot.headers),
      )
    )
      throw new Error("Missing or disagreeing observed text receipts");
    const path = assertExternalPath(join(this.options.directory, "objects", `${sha256}.body`));
    const bytes = await readRegularFile(path, Number(this.config.maxResponseBytes));
    if (bytes.length !== snapshot.bytes || hash(bytes) !== sha256) throw new Error("Recorded text body changed");
    this.seenTextBodies.set(path, sha256);
    const decoded = decodeRecordedText(bytes, snapshot.headers["content-type"] ?? "");
    if (decoded !== snapshot.body) throw new Error("Recorded text decoding differs from snapshot body");
    return { bytes, sha256 };
  }

  /** Return original text bytes only through exact observed physical receipts, without acquisition or state writes. */
  async readTextBytes(snapshotSha256: string): Promise<{ bytes: Buffer; sha256: string }> {
    const observation = await this.readSnapshot(snapshotSha256);
    const { snapshot } = observation;
    if (Object.hasOwn(snapshot, "binary")) throw new Error("Binary observation is not recorded text");
    if (!Object.hasOwn(snapshot, "redirects")) return this.readPhysicalTextBytes(observation);

    const { redirects, ...physical } = snapshot;
    const redirectStatuses = [301, 302, 303, 307, 308];
    const outcomes = this.db.prepare("SELECT url,error FROM outcomes WHERE snapshot=?").all(snapshotSha256);
    if (
      !Array.isArray(redirects) ||
      redirects.length < 1 ||
      redirects.length >= 8 ||
      redirectStatuses.includes(snapshot.status) ||
      outcomes.length !== 1 ||
      outcomes[0]!.url !== snapshot.requested_url ||
      outcomes[0]!.error !== null ||
      this.scoped(snapshot.requested_url) !== snapshot.requested_url ||
      hash(JSON.stringify(snapshot)) !== snapshotSha256
    )
      throw new Error("Invalid recorded logical text wrapper");

    let url = snapshot.requested_url;
    const visited = new Set<string>();
    for (const hop of redirects) {
      if (
        !hop ||
        typeof hop !== "object" ||
        Object.keys(hop).join(",") !== "url,location,status,snapshot" ||
        hop.url !== url ||
        visited.has(url) ||
        !redirectStatuses.includes(hop.status)
      )
        throw new Error("Invalid recorded text redirect trace");
      visited.add(url);
      const observed = await this.readSnapshot(hop.snapshot);
      await this.readPhysicalTextBytes(observed);
      if (
        observed.snapshot.url !== url ||
        observed.snapshot.status !== hop.status ||
        !observed.snapshot.headers.location ||
        this.scoped(new URL(observed.snapshot.headers.location, url).href) !== hop.location
      )
        throw new Error("Recorded text redirect evidence disagrees");
      url = hop.location;
    }
    if (url !== snapshot.url || visited.has(url)) throw new Error("Recorded text redirect terminal disagrees");

    // Assignment preserves the physical property's position in the recorder's newline-free JSON encoding.
    physical.requested_url = physical.url;
    const terminal = await this.readSnapshot(hash(JSON.stringify(physical)));
    return this.readPhysicalTextBytes(terminal);
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

  private attemptCeiling(url: string): number {
    return Number(
      this.db.prepare("SELECT attempt_ceiling FROM repair_authorizations WHERE url=?").get(url)?.attempt_ceiling ?? 3,
    );
  }

  private budgetGrants(): Record<string, unknown>[] {
    const table = (name: string) =>
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
        ? this.db.prepare(`SELECT * FROM ${name} ORDER BY id`).all()
        : [];
    const grants = [...table("acquisition_budget_grants"), ...table("acquisition_budget_grants_v2")];
    grants.sort((left, right) => String(left.id).localeCompare(String(right.id)));
    for (let index = 1; index < grants.length; index++)
      if (grants[index - 1]!.id === grants[index]!.id) throw new Error("Duplicate acquisition budget grant identifier");
    return grants;
  }

  private effectiveAcquisitionBounds(): {
    maxRequests: number;
    maxBytes: number;
    minimumIntervalMs?: number;
  } {
    let maxRequests = Number(this.config.maxRequests);
    let maxBytes = Number(this.config.maxBytes);
    let minimumIntervalMs: number | undefined;
    for (const grant of this.budgetGrants()) {
      maxRequests += Number(grant.additional_requests);
      maxBytes += Number(grant.additional_bytes);
      minimumIntervalMs = Math.max(minimumIntervalMs ?? 0, Number(grant.minimum_interval_ms));
    }
    if (!Number.isSafeInteger(maxRequests) || !Number.isSafeInteger(maxBytes))
      throw new Error("Effective acquisition budget exceeds a safe integer");
    return { maxRequests, maxBytes, ...(minimumIntervalMs ? { minimumIntervalMs } : {}) };
  }

  /** Add explicit capacity without replacing the immutable recording configuration or prior attempts. */
  authorizeBudgetGrant(grant: AcquisitionBudgetGrant): boolean {
    this.assertOpen();
    if (!this.options.acquire || this.sealed) throw new Error("Budget grants require unsealed explicit acquisition");
    if (this.active.size) throw new Error("Budget grants require an idle recording");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(grant.id)) throw new Error("Invalid budget grant identifier");
    if (!/^[a-f0-9]{64}$/.test(grant.authoritySha256)) throw new Error("Invalid budget grant authority digest");
    for (const [key, value] of Object.entries(grant))
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
        throw new Error(`Invalid budget grant bound: ${key}`);
    if (grant.additionalRequests === 0 && grant.additionalBytes === 0)
      throw new Error("Budget grant must add requests, bytes or both");
    if (grant.minimumIntervalMs < 1000) throw new Error("Budget grant request interval must be at least one second");
    const stored = this.budgetGrants().find((row) => row.id === grant.id);
    const values = {
      id: grant.id,
      authority_sha256: grant.authoritySha256,
      expected_requests: grant.expectedRequests,
      expected_bytes: grant.expectedBytes,
      additional_requests: grant.additionalRequests,
      additional_bytes: grant.additionalBytes,
      minimum_interval_ms: grant.minimumIntervalMs,
    };
    if (stored) {
      for (const [key, value] of Object.entries(values))
        if (stored[key] !== value) throw new Error("Saved budget grant differs from the requested authority");
      return false;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE state='dispatching' LIMIT 1").get())
        throw new Error("Budget grants require no dispatching attempts");
      const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
      if (Number(stats.requests) !== grant.expectedRequests || Number(stats.bytes) !== grant.expectedBytes)
        throw new Error("Budget grant does not match the preserved acquisition counters");
      const table =
        grant.additionalRequests > 0 && grant.additionalBytes > 0
          ? "acquisition_budget_grants"
          : "acquisition_budget_grants_v2";
      this.db
        .prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?,?)`)
        .run(
          grant.id,
          grant.authoritySha256,
          new Date().toISOString(),
          grant.expectedRequests,
          grant.expectedBytes,
          grant.additionalRequests,
          grant.additionalBytes,
          grant.minimumIntervalMs,
        );
      this.effectiveAcquisitionBounds();
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async dispatch(url: string, minimum: number, document = false): Promise<Observation> {
    const repair = this.db.prepare("SELECT * FROM repair_authorizations WHERE url=?").get(url);
    const ceiling = Number(repair?.attempt_ceiling ?? 3);
    const saved = this.db
      .prepare("SELECT state,status,headers,snapshot,error FROM attempts WHERE url=? ORDER BY id DESC LIMIT 1")
      .get(url);
    const count = Number(this.db.prepare("SELECT count(*) n FROM attempts WHERE url=?").get(url)!.n);
    if (saved?.state === "excluded-media") {
      const headers = JSON.parse(String(saved.headers)) as Record<string, string>;
      const mediaType = headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType))
        throw new Error("Invalid saved media classification");
      throw new NonTextMediaError(mediaType);
    }
    if (saved?.state === "observed" && saved.snapshot && (!retryable.has(Number(saved.status)) || count >= ceiling))
      return this.readSnapshot(String(saved.snapshot));
    if (count >= ceiling) throw new Error("Physical URL attempt bound exhausted");
    const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
    const bounds = this.effectiveAcquisitionBounds();
    if (Number(stats.requests) >= bounds.maxRequests || Number(stats.bytes) >= bounds.maxBytes)
      throw new Error("Acquisition request/byte budget exhausted");
    if (Date.now() - this.started >= Number(this.config.maxDurationMs))
      throw new Error("Acquisition duration exhausted");
    const backoff =
      repair && saved?.state === "failed" && saved.status === null && transientTransportFailure(String(saved.error))
        ? minimum * 2 ** Math.max(0, count - Number(repair.attempt_count))
        : minimum;
    const wait = Math.max(0, this.lastStart + backoff - Date.now());
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
        headers: {
          "User-Agent": USER_AGENT,
          ...(repair && (!this.options.fetcher || this.options.fetcher === fetch) ? { Connection: "close" } : {}),
        },
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      this.db
        .prepare("UPDATE attempts SET status=?,headers=? WHERE id=?")
        .run(response.status, JSON.stringify(Object.fromEntries(response.headers)), id);
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const attachment = /^attachment(?:;|$)/i.test(response.headers.get("content-disposition") ?? "");
      const nonHtmlDocument =
        document &&
        this.options.htmlDocumentsOnly === true &&
        (attachment || (mediaType !== "" && !["text/html", "application/xhtml+xml"].includes(mediaType)));
      if (response.status === 200 && (nonHtmlDocument || /^(?:image|audio|video)\/[a-z0-9.+-]+$/.test(mediaType))) {
        await response.body?.cancel();
        throw new NonTextMediaError(mediaType || "application/octet-stream");
      }
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      if (reader)
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          received += item.value.length;
          this.db.prepare("UPDATE attempts SET bytes=? WHERE id=?").run(received, id);
          if (received > Number(this.config.maxResponseBytes) || Number(stats.bytes) + received > bounds.maxBytes) {
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
      const pdf =
        raw.length > 0 &&
        Array.isArray(this.config.documentFormats) &&
        this.config.documentFormats.includes("pdf") &&
        (mediaType === "application/pdf" ||
          (mediaType === "application/octet-stream" && raw.subarray(0, 5).toString("ascii") === "%PDF-"));
      if (raw.length > 0 && !pdf && !/text|json|xml|javascript|^$/i.test(contentType))
        throw new Error(`Unsupported recorded document format: ${contentType}`);
      const snapshot: Snapshot = {
        requested_url: url,
        url,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: pdf ? "" : decodeRecordedText(raw, contentType),
        retrieved_at: new Date().toISOString(),
        bytes: raw.length,
        ...(pdf ? { binary: { media_type: "application/pdf" as const, sha256: hash(raw) } } : {}),
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

  private async readWithRepair(value: string, document = false): Promise<Observation> {
    try {
      return await this.readLogical(value, true, document);
    } catch (error) {
      if (
        this.options.recoverTransientFailures &&
        this.options.acquire &&
        !this.sealed &&
        this.recoverTransientFailures([value, `https://${this.options.hostname}/robots.txt`]) > 0
      )
        return this.readLogical(value, true, document);
      throw error;
    }
  }

  read(value: string): Promise<Observation> {
    const result = this.readTail.then(() => this.readWithRepair(value));
    this.readTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  readDocument(value: string): Promise<Observation> {
    const result = this.readTail.then(() => this.readWithRepair(value, true));
    this.readTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private assertDocumentUrl(url: string): void {
    if (!this.options.documentUrlAllowed?.(url)) throw new DocumentPolicyError(`Document URL policy excludes ${url}`);
  }

  private assertDocumentObservation(snapshot: Snapshot): void {
    for (const value of [
      snapshot.requested_url,
      snapshot.url,
      ...(snapshot.redirects ?? []).flatMap((hop) => [hop.url, hostUrl(hop.location, this.options.hostname, hop.url)]),
    ])
      this.assertDocumentUrl(this.scoped(value));
  }

  private async readLogical(value: string, enforceRobots = true, document = false): Promise<Observation> {
    this.assertOpen();
    const initial = this.scoped(value);
    if (document) this.assertDocumentUrl(initial);
    if (initial === `https://${this.options.hostname}/robots.txt`) enforceRobots = false;
    const cached = this.db.prepare("SELECT snapshot,error FROM outcomes WHERE url=?").get(initial);
    if (cached?.error) {
      if (String(cached.error).startsWith("DocumentPolicyError: "))
        throw new DocumentPolicyError(
          `Saved document policy refusal: ${String(cached.error).slice("DocumentPolicyError: ".length)}`,
        );
      const media = /^NonTextMediaError: Observed non-text media: ([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)$/.exec(
        String(cached.error),
      );
      if (media) throw new NonTextMediaError(media[1]!);
      throw new Error(`Saved request failure: ${cached.error}`);
    }
    if (cached?.snapshot) {
      const observation = await this.readSnapshot(String(cached.snapshot));
      if (document) this.assertDocumentObservation(observation.snapshot);
      return observation;
    }
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
        if (document) this.assertDocumentUrl(url);
        const policy = enforceRobots ? await this.policy() : undefined;
        if (policy?.isDisallowed(url, "ubc-data")) throw new Error(`Robots disallows ${url}`);
        const grantedInterval = this.effectiveAcquisitionBounds().minimumIntervalMs;
        const minimum = Math.max(
          Number(this.config.minimumMs),
          grantedInterval ?? (policy?.getCrawlDelay("ubc-data") ?? 0) * 1000,
        );
        let observation: Observation;
        for (;;) {
          const prior = Number(this.db.prepare("SELECT count(*) n FROM attempts WHERE url=?").get(url)!.n);
          const ceiling = this.attemptCeiling(url);
          try {
            observation = await this.dispatch(url, minimum, document);
          } catch (error) {
            const failed = this.db
              .prepare("SELECT status,error FROM attempts WHERE url=? ORDER BY id DESC LIMIT 1")
              .get(url);
            const status = failed?.status;
            if (
              prior < ceiling - 1 &&
              (status === null || status === 200 || retryable.has(Number(status))) &&
              (/fetch failed|TimeoutError|AbortError|terminated/.test(String(error)) ||
                (ceiling > 3 &&
                  status === null &&
                  transientTransportFailure(String(failed?.error)) &&
                  matchesTransportFailure(String(error), String(failed?.error))))
            )
              continue;
            throw error;
          }
          if (!retryable.has(observation.snapshot.status) || prior >= ceiling - 1) break;
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

  /** Classify only recorded redirects to a well-formed destination excluded by host or document policy. */
  observedScopeExclusion(value: string): string | null {
    this.assertOpen();
    let url = this.scoped(value);
    const seen = new Set<string>();
    while (!seen.has(url) && seen.size < 8) {
      seen.add(url);
      const row = this.db
        .prepare("SELECT state,status,headers FROM attempts WHERE url=? ORDER BY id DESC LIMIT 1")
        .get(url);
      if (row?.state !== "observed" || ![301, 302, 303, 307, 308].includes(Number(row.status))) return null;
      const headers = JSON.parse(String(row.headers)) as Record<string, string>;
      if (!headers.location) throw new Error("Observed redirect lacks its recorded location");
      const next = new URL(headers.location, url);
      if (next.username || next.password || !["http:", "https:"].includes(next.protocol))
        throw new Error("Observed redirect has an unsafe destination");
      if (next.protocol !== "https:" || next.hostname.toLowerCase().replace(/\.$/, "") !== this.options.hostname)
        return "Observed redirect leaves the exact HTTPS host scope";
      const scopedNext = hostUrl(next.href, this.options.hostname);
      if (seen.has(scopedNext)) throw new Error("Observed redirect cycle or bound exceeded");
      if (this.options.documentUrlAllowed?.(scopedNext) === false)
        return "Observed redirect leaves the declared document URL policy";
      url = this.scoped(scopedNext);
    }
    throw new Error("Observed redirect cycle or bound exceeded");
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

  /** Filter logical failures, authorize one bounded repair per physical URL, and return the archived failure count. */
  recoverTransientFailures(urls?: readonly string[]): number {
    this.assertOpen();
    if (!this.options.acquire || this.sealed) throw new Error("Recovery requires unsealed explicit acquisition");
    if (this.active.size) throw new Error("Recovery requires an idle recording");
    const selected = urls ? new Set(urls.map((url) => this.scoped(url))) : undefined;
    const failures = this.db
      .prepare("SELECT url,error FROM outcomes WHERE error IS NOT NULL AND snapshot IS NULL ORDER BY url")
      .all()
      .filter((row) => !selected || selected.has(String(row.url)));
    const now = new Date().toISOString();
    let recovered = 0;
    const archive = (url: string, error: string) => {
      this.db.prepare("INSERT INTO outcome_failures(url,error,recorded_at) VALUES (?,?,?)").run(url, error, now);
      this.db.prepare("DELETE FROM outcomes WHERE url=? AND error=? AND snapshot IS NULL").run(url, error);
      recovered++;
    };
    const transportAttempts = (url: string) => {
      const attempts = this.db.prepare("SELECT state,status,error FROM attempts WHERE url=? ORDER BY id").all(url);
      return attempts.length &&
        attempts.every(
          (row) => row.state === "failed" && row.status === null && transientTransportFailure(String(row.error)),
        )
        ? attempts
        : undefined;
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const failure of failures) {
        const logical = String(failure.url);
        let physical: string;
        try {
          physical = this.observedRedirectTrace(logical).at(-1)!;
        } catch {
          continue;
        }
        const attempts = transportAttempts(physical);
        if (!attempts) continue;
        const reason = String(attempts.at(-1)!.error);
        if (
          !matchesTransportFailure(String(failure.error), reason) &&
          !(failure.error === "Error: Physical URL attempt bound exhausted" && attempts.length >= 3)
        )
          continue;
        const authorization = this.db
          .prepare("SELECT attempt_ceiling FROM repair_authorizations WHERE url=?")
          .get(physical);
        if (attempts.length >= Number(authorization?.attempt_ceiling ?? 6)) continue;
        if (!authorization)
          this.db
            .prepare("INSERT INTO repair_authorizations VALUES (?,?,?,?,?,?)")
            .run(
              physical,
              reason,
              now,
              JSON.stringify(this.options.producer),
              attempts.length,
              Math.min(6, attempts.length + 3),
            );
        archive(logical, String(failure.error));
      }
      const homepage = `https://${this.options.hostname}/`;
      const homeFailure = failures.find((row) => row.url === homepage);
      if (homeFailure && !this.db.prepare("SELECT 1 FROM attempts WHERE url=? LIMIT 1").get(homepage)) {
        const robots = `https://${this.options.hostname}/robots.txt`;
        let physical: string | undefined;
        try {
          physical = this.observedRedirectTrace(robots).at(-1);
        } catch {
          physical = undefined;
        }
        if (physical) {
          const authorization = this.db
            .prepare("SELECT reason,attempt_ceiling FROM repair_authorizations WHERE url=?")
            .get(physical);
          const attempts = this.db.prepare("SELECT state,status FROM attempts WHERE url=? ORDER BY id").all(physical);
          const last = attempts.at(-1);
          const robotsObserved = this.db.prepare("SELECT snapshot FROM outcomes WHERE url=?").get(robots)?.snapshot;
          const available =
            transportAttempts(physical) ||
            (robotsObserved && last?.state === "observed" && [200, 404, 410].includes(Number(last.status)));
          if (
            authorization &&
            available &&
            attempts.length < Number(authorization.attempt_ceiling) &&
            matchesTransportFailure(String(homeFailure.error), String(authorization.reason))
          )
            archive(homepage, String(homeFailure.error));
        }
      }
      this.db.exec("COMMIT");
      return recovered;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Archive explicitly selected, byte-verified legacy HTML decode failures without changing their attempts or budgets. */
  async recoverHtmlDecodeFailures(urls: readonly string[]): Promise<number> {
    this.assertOpen();
    if (!this.options.acquire || this.sealed) throw new Error("Decode recovery requires unsealed explicit acquisition");
    if (this.active.size) throw new Error("Decode recovery requires an idle recording");
    if (!urls.length) return 0;
    const selected = new Set(urls.map((url) => this.scoped(url)));
    if (selected.size !== urls.length) throw new Error("Decode recovery requires distinct exact URLs");
    const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
    const bounds = this.effectiveAcquisitionBounds();
    if (Number(stats.requests) + selected.size > bounds.maxRequests || Number(stats.bytes) >= bounds.maxBytes)
      throw new Error("Decode recovery requires remaining acquisition capacity");
    const verified: { url: string; error: string; attemptId: number }[] = [];
    for (const url of selected) {
      const outcome = this.db.prepare("SELECT snapshot,error FROM outcomes WHERE url=?").get(url);
      const attempts = this.db.prepare("SELECT * FROM attempts WHERE url=? ORDER BY id").all(url);
      const attempt = attempts[0];
      if (
        attempts.length !== 1 ||
        attempt?.state !== "failed" ||
        attempt.status !== 200 ||
        attempt.snapshot !== null ||
        !/^[a-f0-9]{64}$/.test(String(attempt.body_sha)) ||
        !Number.isSafeInteger(attempt.bytes) ||
        Number(attempt.bytes) < 1 ||
        Number(attempt.bytes) > Number(this.config.maxResponseBytes) ||
        outcome?.snapshot !== null ||
        typeof outcome.error !== "string" ||
        outcome.error !== attempt.error
      )
        throw new Error(`Not a single saved HTTP-200 decode failure: ${url}`);
      let headers: Record<string, unknown>;
      try {
        headers = JSON.parse(String(attempt.headers));
      } catch {
        throw new Error(`Invalid saved decode headers: ${url}`);
      }
      if (
        !headers ||
        Array.isArray(headers) ||
        Object.values(headers).some((value) => typeof value !== "string") ||
        typeof headers["content-type"] !== "string" ||
        headers["content-type"].split(";", 1)[0]?.trim().toLowerCase() !== "text/html" ||
        /charset\s*=/i.test(headers["content-type"])
      )
        throw new Error(`Not charset-absent HTML: ${url}`);
      const path = assertExternalPath(join(this.options.directory, "objects", `${attempt.body_sha}.body`));
      const bytes = await readRegularFile(path, Number(this.config.maxResponseBytes));
      if (bytes.length !== attempt.bytes || hash(bytes) !== attempt.body_sha)
        throw new Error(`Saved decode body changed: ${url}`);
      let originalError: string;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        throw new Error("Original UTF-8 decode succeeded");
      } catch (error) {
        originalError = String(error);
      }
      if (originalError !== outcome.error || !/^(?:TypeError|Error): /.test(originalError))
        throw new Error(`Saved failure is not the original UTF-8 decode: ${url}`);
      decodeRecordedText(bytes, headers["content-type"]);
      verified.push({ url, error: outcome.error, attemptId: Number(attempt.id) });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE state='dispatching' LIMIT 1").get())
        throw new Error("Decode recovery requires no dispatching attempts");
      const current = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
      if (current.requests !== stats.requests || current.bytes !== stats.bytes)
        throw new Error("Decode recovery counters changed");
      for (const item of verified) {
        const outcome = this.db.prepare("SELECT snapshot,error FROM outcomes WHERE url=?").get(item.url);
        const attempt = this.db.prepare("SELECT id FROM attempts WHERE url=?").all(item.url);
        if (
          outcome?.snapshot !== null ||
          outcome.error !== item.error ||
          attempt.length !== 1 ||
          attempt[0]?.id !== item.attemptId
        )
          throw new Error("Decode recovery lineage changed");
        this.db
          .prepare("INSERT INTO outcome_failures(url,error,recorded_at) VALUES (?,?,?)")
          .run(item.url, item.error, new Date().toISOString());
        this.db.prepare("DELETE FROM outcomes WHERE url=? AND error=? AND snapshot IS NULL").run(item.url, item.error);
      }
      this.db.exec("COMMIT");
      return verified.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Archive selected pre-dispatch budget failures only after an additive grant creates remaining capacity. */
  resumeBudgetFailures(urls?: readonly string[]): number {
    this.assertOpen();
    if (!this.options.acquire || this.sealed) throw new Error("Budget resume requires unsealed explicit acquisition");
    if (this.active.size) throw new Error("Budget resume requires an idle recording");
    const selected = urls ? new Set(urls.map((url) => this.scoped(url))) : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE state='dispatching' LIMIT 1").get())
        throw new Error("Budget resume requires no dispatching attempts");
      if (!this.budgetGrants().length) throw new Error("Budget resume requires an additive grant");
      const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
      const bounds = this.effectiveAcquisitionBounds();
      if (Number(stats.requests) >= bounds.maxRequests || Number(stats.bytes) >= bounds.maxBytes)
        throw new Error("Budget resume requires remaining effective capacity");
      const failures = this.db
        .prepare("SELECT url,error FROM outcomes WHERE snapshot IS NULL AND error=? ORDER BY url")
        .all("Error: Acquisition request/byte budget exhausted")
        .filter((row) => !selected || selected.has(String(row.url)));
      const now = new Date().toISOString();
      for (const failure of failures) {
        this.db
          .prepare("INSERT INTO outcome_failures(url,error,recorded_at) VALUES (?,?,?)")
          .run(String(failure.url), String(failure.error), now);
        this.db
          .prepare("DELETE FROM outcomes WHERE url=? AND error=? AND snapshot IS NULL")
          .run(String(failure.url), String(failure.error));
      }
      this.db.exec("COMMIT");
      return failures.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Archive selected per-invocation duration failures without renewing acquisition budgets or attempt limits. */
  resumeDurationFailures(urls?: readonly string[]): number {
    this.assertOpen();
    if (!this.options.acquire || this.sealed) throw new Error("Duration resume requires unsealed explicit acquisition");
    if (this.active.size) throw new Error("Duration resume requires an idle recording");
    const selected = urls ? new Set(urls.map((url) => this.scoped(url))) : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE state='dispatching' LIMIT 1").get())
        throw new Error("Duration resume requires no dispatching attempts");
      const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
      const bounds = this.effectiveAcquisitionBounds();
      const failures =
        Number(stats.requests) < bounds.maxRequests && Number(stats.bytes) < bounds.maxBytes
          ? this.db
              .prepare("SELECT url,error FROM outcomes WHERE snapshot IS NULL AND error IN (?,?,?) ORDER BY url")
              .all(
                "Error: Acquisition duration exhausted",
                "Error: Acquisition wait exceeds remaining duration",
                "Error: Retry wait exceeds duration budget",
              )
              .filter((row) => !selected || selected.has(String(row.url)))
          : [];
      const now = new Date().toISOString();
      for (const failure of failures) {
        this.db
          .prepare("INSERT INTO outcome_failures(url,error,recorded_at) VALUES (?,?,?)")
          .run(String(failure.url), String(failure.error), now);
        this.db
          .prepare("DELETE FROM outcomes WHERE url=? AND error=? AND snapshot IS NULL")
          .run(String(failure.url), String(failure.error));
      }
      this.db.exec("COMMIT");
      return failures.length;
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
    const repairs = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='repair_authorizations'")
      .get()
      ? this.db.prepare("SELECT * FROM repair_authorizations ORDER BY url").all()
      : [];
    const grants = this.budgetGrants();
    return hash(
      JSON.stringify({
        config: this.config,
        outcomes,
        attempts,
        producers,
        failures,
        ...(repairs.length ? { repairs } : {}),
        ...(grants.length ? { grants } : {}),
      }),
    );
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
    for (const [path, sha] of this.seenTextBodies)
      if (hash(await readRegularFile(path, Number(this.config.maxResponseBytes))) !== sha)
        throw new Error("Recorded text object changed");
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
