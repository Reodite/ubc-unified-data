import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { RecordingError } from "../errors.ts";
import { assertExternalPath } from "../paths.ts";
import { readRegularFile } from "../public-validation.ts";
import { decodeRecordedText } from "../text-decoding.ts";
import type { AcquisitionBudgetGrant, RecordingOptions } from "./contracts.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const transientTransportFailure = (error: string): boolean =>
  /\b(?:ECONNRESET|AbortError|TimeoutError)\b|other side closed/i.test(error) &&
  !/\b(?:ENOTFOUND|EAI_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z_]+)\b|certificate|hostname mismatch|\bDNS\b/i.test(
    error,
  );
export const matchesTransportFailure = (logical: string, physical: string): boolean => {
  const reason = logical.replace(/^(?:Error: Saved request failure: )+/, "");
  return reason === physical || reason === physical.split("; cause: ", 1)[0];
};

interface RecordingRecoveryState {
  assertOpen(): void;
  isSealed(): boolean;
  hasActiveRequests(): boolean;
  scoped(value: string): string;
  observedRedirectTrace(value: string): string[];
}

/** Own additive acquisition grants and transactional recovery of preserved failure lineage. */
export class RecordingRecovery {
  constructor(
    private readonly db: Pick<DatabaseSync, "prepare" | "exec">,
    private readonly config: Readonly<Record<string, unknown>>,
    private readonly options: Pick<RecordingOptions, "hostname" | "directory" | "producer" | "acquire">,
    private readonly state: RecordingRecoveryState,
  ) {}

  attemptCeiling(url: string): number {
    return Number(
      this.db.prepare("SELECT attempt_ceiling FROM repair_authorizations WHERE url=?").get(url)?.attempt_ceiling ?? 3,
    );
  }

  budgetGrants(): Record<string, unknown>[] {
    const table = (name: string) =>
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
        ? this.db.prepare(`SELECT * FROM ${name} ORDER BY id`).all()
        : [];
    const grants = [...table("acquisition_budget_grants"), ...table("acquisition_budget_grants_v2")];
    grants.sort((left, right) => String(left.id).localeCompare(String(right.id)));
    for (let index = 1; index < grants.length; index++)
      if (grants[index - 1]!.id === grants[index]!.id)
        throw new RecordingError("Duplicate acquisition budget grant identifier");
    return grants;
  }

  effectiveAcquisitionBounds(): {
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
      throw new RecordingError("Effective acquisition budget exceeds a safe integer");
    return { maxRequests, maxBytes, ...(minimumIntervalMs ? { minimumIntervalMs } : {}) };
  }

  /** Add explicit capacity without replacing the immutable recording configuration or prior attempts. */
  authorizeBudgetGrant(grant: AcquisitionBudgetGrant): boolean {
    this.state.assertOpen();
    if (!this.options.acquire || this.state.isSealed())
      throw new RecordingError("Budget grants require unsealed explicit acquisition");
    if (this.state.hasActiveRequests()) throw new RecordingError("Budget grants require an idle recording");
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(grant.id)) throw new RecordingError("Invalid budget grant identifier");
    if (!/^[a-f0-9]{64}$/.test(grant.authoritySha256))
      throw new RecordingError("Invalid budget grant authority digest");
    for (const [key, value] of Object.entries(grant))
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
        throw new RecordingError(`Invalid budget grant bound: ${key}`);
    if (grant.additionalRequests === 0 && grant.additionalBytes === 0)
      throw new RecordingError("Budget grant must add requests, bytes or both");
    if (grant.minimumIntervalMs < 1000)
      throw new RecordingError("Budget grant request interval must be at least one second");
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
        if (stored[key] !== value) throw new RecordingError("Saved budget grant differs from the requested authority");
      return false;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE state='dispatching' LIMIT 1").get())
        throw new RecordingError("Budget grants require no dispatching attempts");
      const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
      if (Number(stats.requests) !== grant.expectedRequests || Number(stats.bytes) !== grant.expectedBytes)
        throw new RecordingError("Budget grant does not match the preserved acquisition counters");
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

  retryNetworkFailure(value: string): void {
    if (!this.options.acquire || this.state.isSealed())
      throw new RecordingError("Retry requires unsealed explicit acquisition");
    const url = this.state.scoped(value);
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
      throw new RecordingError(
        "Only a recorded transient network failure within the three-attempt bound can be retried",
      );
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
    this.state.assertOpen();
    if (!this.options.acquire || this.state.isSealed())
      throw new RecordingError("Recovery requires unsealed explicit acquisition");
    if (this.state.hasActiveRequests()) throw new RecordingError("Recovery requires an idle recording");
    const selected = urls ? new Set(urls.map((url) => this.state.scoped(url))) : undefined;
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
          physical = this.state.observedRedirectTrace(logical).at(-1)!;
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
          physical = this.state.observedRedirectTrace(robots).at(-1);
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
    this.state.assertOpen();
    if (!this.options.acquire || this.state.isSealed())
      throw new RecordingError("Decode recovery requires unsealed explicit acquisition");
    if (this.state.hasActiveRequests()) throw new RecordingError("Decode recovery requires an idle recording");
    if (!urls.length) return 0;
    const selected = new Set(urls.map((url) => this.state.scoped(url)));
    if (selected.size !== urls.length) throw new RecordingError("Decode recovery requires distinct exact URLs");
    const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
    const bounds = this.effectiveAcquisitionBounds();
    if (Number(stats.requests) + selected.size > bounds.maxRequests || Number(stats.bytes) >= bounds.maxBytes)
      throw new RecordingError("Decode recovery requires remaining acquisition capacity");
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
        throw new RecordingError(`Not a single saved HTTP-200 decode failure: ${url}`);
      let headers: Record<string, unknown>;
      try {
        headers = JSON.parse(String(attempt.headers));
      } catch {
        throw new RecordingError(`Invalid saved decode headers: ${url}`);
      }
      if (
        !headers ||
        Array.isArray(headers) ||
        Object.values(headers).some((value) => typeof value !== "string") ||
        typeof headers["content-type"] !== "string" ||
        headers["content-type"].split(";", 1)[0]?.trim().toLowerCase() !== "text/html" ||
        /charset\s*=/i.test(headers["content-type"])
      )
        throw new RecordingError(`Not charset-absent HTML: ${url}`);
      const path = assertExternalPath(join(this.options.directory, "objects", `${attempt.body_sha}.body`));
      const bytes = await readRegularFile(path, Number(this.config.maxResponseBytes));
      if (bytes.length !== attempt.bytes || hash(bytes) !== attempt.body_sha)
        throw new RecordingError(`Saved decode body changed: ${url}`);
      let originalError: string;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        throw new RecordingError("Original UTF-8 decode succeeded");
      } catch (error) {
        originalError = String(error);
      }
      if (originalError !== outcome.error || !/^(?:TypeError|Error): /.test(originalError))
        throw new RecordingError(`Saved failure is not the original UTF-8 decode: ${url}`);
      decodeRecordedText(bytes, headers["content-type"]);
      verified.push({ url, error: outcome.error, attemptId: Number(attempt.id) });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE state='dispatching' LIMIT 1").get())
        throw new RecordingError("Decode recovery requires no dispatching attempts");
      const current = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
      if (current.requests !== stats.requests || current.bytes !== stats.bytes)
        throw new RecordingError("Decode recovery counters changed");
      for (const item of verified) {
        const outcome = this.db.prepare("SELECT snapshot,error FROM outcomes WHERE url=?").get(item.url);
        const attempt = this.db.prepare("SELECT id FROM attempts WHERE url=?").all(item.url);
        if (
          outcome?.snapshot !== null ||
          outcome.error !== item.error ||
          attempt.length !== 1 ||
          attempt[0]?.id !== item.attemptId
        )
          throw new RecordingError("Decode recovery lineage changed");
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
    this.state.assertOpen();
    if (!this.options.acquire || this.state.isSealed())
      throw new RecordingError("Budget resume requires unsealed explicit acquisition");
    if (this.state.hasActiveRequests()) throw new RecordingError("Budget resume requires an idle recording");
    const selected = urls ? new Set(urls.map((url) => this.state.scoped(url))) : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE state='dispatching' LIMIT 1").get())
        throw new RecordingError("Budget resume requires no dispatching attempts");
      if (!this.budgetGrants().length) throw new RecordingError("Budget resume requires an additive grant");
      const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
      const bounds = this.effectiveAcquisitionBounds();
      if (Number(stats.requests) >= bounds.maxRequests || Number(stats.bytes) >= bounds.maxBytes)
        throw new RecordingError("Budget resume requires remaining effective capacity");
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

  /** Archive exact HTTP-200 streaming byte failures for selected URLs after a recorded grant leaves retry capacity. */
  resumeResponseBudgetFailures(urls: readonly string[]): number {
    this.state.assertOpen();
    if (!this.options.acquire || this.state.isSealed())
      throw new RecordingError("Response budget resume requires unsealed explicit acquisition");
    if (this.state.hasActiveRequests()) throw new RecordingError("Response budget resume requires an idle recording");
    const selected = new Set(
      urls.map((url) => {
        const scoped = this.state.scoped(url);
        if (scoped !== url) throw new RecordingError("Response budget resume requires exact same-host URLs");
        return scoped;
      }),
    );
    if (selected.size !== urls.length) throw new RecordingError("Response budget resume requires distinct exact URLs");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE state IN ('dispatching','uncertain') LIMIT 1").get())
        throw new RecordingError("Response budget resume requires no dispatching or uncertain attempts");
      if (!this.budgetGrants().length) throw new RecordingError("Response budget resume requires an additive grant");
      const stats = this.db.prepare("SELECT count(*) requests, coalesce(sum(bytes),0) bytes FROM attempts").get()!;
      const bounds = this.effectiveAcquisitionBounds();
      if (Number(stats.requests) + selected.size > bounds.maxRequests || Number(stats.bytes) >= bounds.maxBytes)
        throw new RecordingError("Response budget resume requires remaining effective request and byte capacity");
      const error = "Error: Acquisition response/total byte budget exceeded";
      for (const url of selected) {
        const outcome = this.db.prepare("SELECT snapshot,error FROM outcomes WHERE url=?").get(url);
        const attempts = this.db
          .prepare("SELECT state,status,bytes,snapshot,body_sha,error FROM attempts WHERE url=? ORDER BY id")
          .all(url);
        const last = attempts.at(-1);
        if (
          outcome?.snapshot !== null ||
          outcome.error !== error ||
          attempts.length === 0 ||
          attempts.length >= 3 ||
          last?.state !== "failed" ||
          last.status !== 200 ||
          !Number.isSafeInteger(last.bytes) ||
          Number(last.bytes) < 1 ||
          Number(last.bytes) > Number(this.config.maxResponseBytes) ||
          last.snapshot !== null ||
          last.body_sha !== null ||
          last.error !== error
        )
          throw new RecordingError(`Not a resumable HTTP-200 response byte failure: ${url}`);
      }
      const now = new Date().toISOString();
      for (const url of selected) {
        this.db.prepare("INSERT INTO outcome_failures(url,error,recorded_at) VALUES (?,?,?)").run(url, error, now);
        this.db.prepare("DELETE FROM outcomes WHERE url=? AND error=? AND snapshot IS NULL").run(url, error);
      }
      this.db.exec("COMMIT");
      return selected.size;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Archive selected per-invocation duration failures without renewing acquisition budgets or attempt limits. */
  resumeDurationFailures(urls?: readonly string[]): number {
    this.state.assertOpen();
    if (!this.options.acquire || this.state.isSealed())
      throw new RecordingError("Duration resume requires unsealed explicit acquisition");
    if (this.state.hasActiveRequests()) throw new RecordingError("Duration resume requires an idle recording");
    const selected = urls ? new Set(urls.map((url) => this.state.scoped(url))) : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM attempts WHERE state='dispatching' LIMIT 1").get())
        throw new RecordingError("Duration resume requires no dispatching attempts");
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
}
