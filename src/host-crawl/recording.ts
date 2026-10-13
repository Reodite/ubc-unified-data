import { createHash } from "node:crypto";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { USER_AGENT } from "../core/http.ts";
import { readResponseBytes, RETRYABLE_HTTP_STATUSES as retryable } from "../core/response.ts";
import { publicUbcUrl } from "../prose/client.ts";
import { DocumentPolicyError, NonTextMediaError, type Observation, type Snapshot } from "./contracts.ts";
import { RecordingError, savedRequestFailure } from "./errors.ts";
import { assertExternalPath } from "./paths.ts";
import { readRegularFile } from "./public-validation.ts";
import type { AcquisitionBudgetGrant, RecordingOptions } from "./recording/contracts.ts";
import { durableObject, RecordedObjects } from "./recording/objects.ts";
import { matchesTransportFailure, RecordingRecovery, transientTransportFailure } from "./recording/recovery.ts";
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
export type { AcquisitionBudgetGrant, RecordingOptions } from "./recording/contracts.ts";

/** Persist request intents and immutable outcomes externally; replay never falls through to a network request. */
export class HostRecording {
  private constructor(
    readonly options: RecordingOptions,
    private db: DatabaseSync,
    private lock: DatabaseSync,
    private config: Record<string, unknown>,
  ) {
    this.objects = new RecordedObjects(
      db,
      config,
      options,
      () => this.assertOpen(),
      (value) => this.scoped(value),
    );
    this.recovery = new RecordingRecovery(db, config, options, {
      assertOpen: () => this.assertOpen(),
      isSealed: () => this.sealed,
      hasActiveRequests: () => this.active.size !== 0,
      scoped: (value) => this.scoped(value),
      observedRedirectTrace: (value) => this.observedRedirectTrace(value),
    });
  }
  private readonly objects: RecordedObjects;
  private readonly recovery: RecordingRecovery;
  private rules?: ReturnType<typeof parser>;
  private lastStart = 0;
  private started = Date.now();
  private active = new Set<string>();
  private closed = false;
  private sealed = false;
  private readTail: Promise<void> = Promise.resolve();

  static async open(options: RecordingOptions): Promise<HostRecording> {
    if (normalizeHost(options.hostname) !== options.hostname)
      throw new RecordingError("Noncanonical recording hostname");
    const directory = assertExternalPath(options.directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "objects"), { recursive: true, mode: 0o700 });
    const lockPath = assertExternalPath(join(directory, "owner.sqlite"));
    try {
      const info = await lstat(lockPath);
      if (!info.isFile() || info.nlink !== 1)
        throw new RecordingError("Recording lock must be a regular unaliased file");
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
            throw new RecordingError("Recording database must be a regular unaliased file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (options.acquire) {
        try {
          await lstat(join(directory, "seal.json"));
          throw new RecordingError("Sealed acquisition is immutable; use offline replay");
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
        throw new RecordingError("Invalid declared recording document formats");
      for (const [key, value] of Object.entries(requested))
        if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1))
          throw new RecordingError(`Invalid acquisition bound: ${key}`);
      const old = db.prepare("SELECT value FROM config WHERE id=1").get()?.value;
      if (!old && !options.acquire) throw new RecordingError("No saved recording to replay");
      if (!old) db.prepare("INSERT INTO config VALUES (1,?)").run(JSON.stringify(requested));
      const config = old ? JSON.parse(String(old)) : requested;
      if (config.hostname !== options.hostname || config.seed_sha256 !== (options.seedSha256 ?? null))
        throw new RecordingError("Recording hostname or frontier digest mismatch");
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
        throw new RecordingError("Acquisition options changed; replay saved input or create a new explicit recording");
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
        throw new RecordingError(
          "Uncertain prior requests require explicit acquisition resume; saved outcomes are preserved",
        );
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
    if (this.closed) throw new RecordingError("Recording is closed");
  }
  async readSnapshot(sha256: string): Promise<Observation> {
    return this.objects.readSnapshot(sha256);
  }

  async readBytes(snapshotSha256: string): Promise<Buffer> {
    return this.objects.readBytes(snapshotSha256);
  }

  /** Return original text bytes only through exact observed physical receipts, without acquisition or state writes. */
  async readTextBytes(snapshotSha256: string): Promise<{ bytes: Buffer; sha256: string }> {
    return this.objects.readTextBytes(snapshotSha256);
  }

  private async policy() {
    if (!this.rules) {
      const robots = await this.readLogical(`https://${this.options.hostname}/robots.txt`, false);
      if (![200, 404, 410].includes(robots.snapshot.status)) throw new RecordingError("Robots policy unavailable");
      this.rules = parser(robots.snapshot.url, robots.snapshot.status === 200 ? robots.snapshot.body : "");
    }
    return this.rules;
  }
  async sitemaps(): Promise<string[]> {
    return (await this.policy()).getSitemaps();
  }

  /** Add explicit capacity without replacing the immutable recording configuration or prior attempts. */
  authorizeBudgetGrant(grant: AcquisitionBudgetGrant): boolean {
    return this.recovery.authorizeBudgetGrant(grant);
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
        throw new RecordingError("Invalid saved media classification");
      throw new NonTextMediaError(mediaType);
    }
    if (saved?.state === "observed" && saved.snapshot && (!retryable.has(Number(saved.status)) || count >= ceiling))
      return this.readSnapshot(String(saved.snapshot));
    if (count >= ceiling) throw new RecordingError("Physical URL attempt bound exhausted", "unavailable");
    const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
    const bounds = this.recovery.effectiveAcquisitionBounds();
    if (Number(stats.requests) >= bounds.maxRequests || Number(stats.bytes) >= bounds.maxBytes)
      throw new RecordingError("Acquisition request/byte budget exhausted", "limit");
    if (Date.now() - this.started >= Number(this.config.maxDurationMs))
      throw new RecordingError("Acquisition duration exhausted", "limit");
    const backoff =
      repair && saved?.state === "failed" && saved.status === null && transientTransportFailure(String(saved.error))
        ? minimum * 2 ** Math.max(0, count - Number(repair.attempt_count))
        : minimum;
    const wait = Math.max(0, this.lastStart + backoff - Date.now());
    if (Date.now() - this.started + wait >= Number(this.config.maxDurationMs))
      throw new RecordingError("Acquisition wait exceeds remaining duration", "limit");
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
      const raw = await readResponseBytes(response, (size) => {
        received = size;
        this.db.prepare("UPDATE attempts SET bytes=? WHERE id=?").run(received, id);
        if (received > Number(this.config.maxResponseBytes) || Number(stats.bytes) + received > bounds.maxBytes)
          throw new RecordingError("Acquisition response/total byte budget exceeded", "limit");
      });
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
        throw new RecordingError(`Unsupported recorded document format: ${contentType}`);
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
      const observation = await this.objects.store(snapshot);
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
      throw savedRequestFailure(String(cached.error));
    }
    if (cached?.snapshot) {
      const observation = await this.readSnapshot(String(cached.snapshot));
      if (document) this.assertDocumentObservation(observation.snapshot);
      return observation;
    }
    if (!this.options.acquire || this.sealed)
      throw new RecordingError(`Missing recorded request: ${initial}`, "unavailable");
    if (this.active.has(initial)) throw new RecordingError("Recursive request dependency");
    this.active.add(initial);
    try {
      let url = initial;
      const visited = new Set<string>();
      const redirects: NonNullable<Snapshot["redirects"]> = [];
      for (;;) {
        if (visited.has(url) || visited.size >= 8) throw new RecordingError("Redirect loop or bound exceeded");
        visited.add(url);
        if (document) this.assertDocumentUrl(url);
        const policy = enforceRobots ? await this.policy() : undefined;
        if (policy?.isDisallowed(url, "ubc-data")) throw new RecordingError(`Robots disallows ${url}`);
        const grantedInterval = this.recovery.effectiveAcquisitionBounds().minimumIntervalMs;
        const minimum = Math.max(
          Number(this.config.minimumMs),
          grantedInterval ?? (policy?.getCrawlDelay("ubc-data") ?? 0) * 1000,
        );
        let observation: Observation;
        for (;;) {
          const prior = Number(this.db.prepare("SELECT count(*) n FROM attempts WHERE url=?").get(url)!.n);
          const ceiling = this.recovery.attemptCeiling(url);
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
            throw new RecordingError("Retry wait exceeds duration budget", "limit");
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        if ([301, 302, 303, 307, 308].includes(observation.snapshot.status)) {
          const location = observation.snapshot.headers.location;
          if (!location) throw new RecordingError("Redirect lacks Location");
          const next = this.scoped(new URL(location, url).href);
          redirects.push({ url, location: next, status: observation.snapshot.status, snapshot: observation.sha256 });
          url = next;
          continue;
        }
        const final = redirects.length
          ? await this.objects.store({ ...observation.snapshot, requested_url: initial, redirects })
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
      if (!headers.location) throw new RecordingError("Observed redirect lacks its recorded location");
      url = this.scoped(new URL(headers.location, url).href);
    }
    throw new RecordingError("Observed redirect cycle or bound exceeded");
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
      if (!headers.location) throw new RecordingError("Observed redirect lacks its recorded location");
      const next = new URL(headers.location, url);
      if (next.username || next.password || !["http:", "https:"].includes(next.protocol))
        throw new RecordingError("Observed redirect has an unsafe destination");
      if (next.protocol !== "https:" || next.hostname.toLowerCase().replace(/\.$/, "") !== this.options.hostname)
        return "Observed redirect leaves the exact HTTPS host scope";
      const scopedNext = hostUrl(next.href, this.options.hostname);
      if (seen.has(scopedNext)) throw new RecordingError("Observed redirect cycle or bound exceeded");
      if (this.options.documentUrlAllowed?.(scopedNext) === false)
        return "Observed redirect leaves the declared document URL policy";
      url = this.scoped(scopedNext);
    }
    throw new RecordingError("Observed redirect cycle or bound exceeded");
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
    this.recovery.retryNetworkFailure(value);
  }

  /** Filter logical failures, authorize one bounded repair per physical URL, and return the archived failure count. */
  recoverTransientFailures(urls?: readonly string[]): number {
    return this.recovery.recoverTransientFailures(urls);
  }

  /** Archive explicitly selected, byte-verified legacy HTML decode failures without changing their attempts or budgets. */
  async recoverHtmlDecodeFailures(urls: readonly string[]): Promise<number> {
    return this.recovery.recoverHtmlDecodeFailures(urls);
  }

  /** Archive selected pre-dispatch budget failures only after an additive grant creates remaining capacity. */
  resumeBudgetFailures(urls?: readonly string[]): number {
    return this.recovery.resumeBudgetFailures(urls);
  }

  /** Archive exact HTTP-200 streaming byte failures for selected URLs after a recorded grant leaves retry capacity. */
  resumeResponseBudgetFailures(urls: readonly string[]): number {
    return this.recovery.resumeResponseBudgetFailures(urls);
  }

  /** Archive selected per-invocation duration failures without renewing acquisition budgets or attempt limits. */
  resumeDurationFailures(urls?: readonly string[]): number {
    return this.recovery.resumeDurationFailures(urls);
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
    const grants = this.recovery.budgetGrants();
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
      throw new RecordingError("Unfinished acquisition");
    const digest = this.inputDigest();
    const target = assertExternalPath(join(this.options.directory, "seal.json"));
    const body = Buffer.from(
      `${JSON.stringify({ version: 1, hostname: this.options.hostname, input_sha256: digest })}\n`,
    );
    try {
      const existing = await readRegularFile(target);
      if (!existing.equals(body)) throw new RecordingError("Existing seal differs");
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
      throw new RecordingError("Recording seal mismatch");
    await this.assertUnchanged();
    if (saved.input_sha256 !== this.inputDigest())
      throw new RecordingError("Recording changed during seal verification");
    return saved.input_sha256;
  }
  async assertUnchanged(): Promise<void> {
    return this.objects.assertUnchanged();
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
