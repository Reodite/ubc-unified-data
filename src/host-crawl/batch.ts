import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { load } from "cheerio";
import { ROOT } from "../core/output.ts";
import type { HostBatchConfig, ReadyHostV1 } from "./batch-model.ts";
import { BatchPublisher } from "./batch-publication.ts";
import {
  assertAdmittedHostname,
  formatRoutingPolicy,
  parseRoutingPolicy,
  type HostRoutingPolicy,
} from "./category-routing.ts";
import { sha256 } from "./document-format.ts";
import { cheapGuardCompletedHost, createGenericScraper } from "./generic.ts";
import { currentUnavailableHosts } from "./host-dispositions.ts";
import { assertExternalPath } from "./paths.ts";
import {
  isAbsent as absent,
  writeImmutable as immutable,
  readPrivateJson as json,
  savePrivateJson as save,
} from "./private-files.ts";
import { assertSameProducer, captureProducer } from "./provenance.ts";
import { verifyReadyHost } from "./ready-host.ts";
import { collectRecordedSession, openRecordedHost } from "./recorded-host.ts";
import { normalizeHost } from "./urls.ts";
import { HostWorkQueue, type HostWorkRecord } from "./work-queue.ts";

export type { HostBatchConfig } from "./batch-model.ts";

const TERMINAL = new Set(["published", "rejected", "blocked"]);

/** Collectors use an immutable source snapshot; the Git boundary alone is serialized. */
export class HostBatch {
  private readonly publisher: BatchPublisher;

  private constructor(
    readonly directory: string,
    readonly config: HostBatchConfig,
    readonly queue: HostWorkQueue,
  ) {
    this.publisher = new BatchPublisher({
      directory,
      config,
      queue,
      owned: (hostname, token) => this.owned(hostname, token),
      verifyReady: (row) =>
        verifyReadyHost({ directory, config, openRecording: (hostname) => this.recording(hostname, false) }, row),
    });
  }

  static async open(directory: string): Promise<HostBatch> {
    directory = assertExternalPath(directory);
    const config = (await json(join(directory, "config.json"))) as HostBatchConfig;
    if (
      !config ||
      resolve(config.repositoryRoot) !== config.repositoryRoot ||
      !/^[a-f0-9]{40}$/.test(config.baseline) ||
      !/^[a-f0-9]{40}$/.test(config.main)
    )
      throw new Error("Invalid batch repository identity");
    assertExternalPath(config.producerRoot, config.repositoryRoot);
    await mkdir(join(directory, "workers"), { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "publications"), { recursive: true, mode: 0o700 });
    return new HostBatch(directory, config, HostWorkQueue.open(join(directory, "state", "queue.sqlite")));
  }

  seed(items: Parameters<HostWorkQueue["seed"]>[0]): void {
    const unavailable = currentUnavailableHosts();
    if (items.some((item) => unavailable.has(normalizeHost(item.hostname))))
      throw new Error("Cannot seed a reviewed unavailable hostname");
    this.queue.seed(items);
  }
  close(): void {
    this.queue.close();
  }

  async claim(worker: string) {
    if (!/^w[1-5]$/.test(worker)) throw new Error("Expected worker w1..w5");
    const receipt = join(this.directory, "workers", `${worker}.json`);
    const unavailable = currentUnavailableHosts();
    try {
      const previous = (await json(receipt)) as { hostname: string; token: string };
      const row = this.queue.get(previous.hostname);
      if (row && !TERMINAL.has(row.state)) {
        if (unavailable.has(row.hostname)) throw new Error("Retained claim is now unavailable");
        if (row.worker !== worker || row.token !== previous.token)
          throw new Error("Worker receipt does not own its retained claim");
        return { ...row, resumed: true };
      }
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const retained = this.queue.current(worker);
    if (retained && unavailable.has(retained.hostname)) throw new Error("Retained claim is now unavailable");
    const claim = retained ?? this.queue.claim(worker, unavailable);
    if (claim) await save(receipt, claim);
    return claim;
  }

  owned(hostname: string, token: string): HostWorkRecord {
    const row = this.queue.get(normalizeHost(hostname));
    if (!row || !token || row.token !== token) throw new Error("Hostname claim is not owned by this token");
    return row;
  }

  private async recording(hostname: string, acquire: boolean, homepageOnly = false) {
    assertAdmittedHostname(hostname);
    if (acquire && resolve(ROOT) !== this.config.producerRoot)
      throw new Error("Acquisition must run from the frozen batch producer");
    assertSameProducer(this.config.producer, await captureProducer(this.config.producerRoot));
    const scraper = createGenericScraper(hostname);
    const session = await openRecordedHost({
      scraper,
      producer: this.config.producer,
      acquire,
      reuseSealed: true,
      recoverTransientFailures: this.config.recoverTransientFailures === true,
    });
    const { recording, sealed } = session;
    try {
      const budgetGrant = this.config.acquisitionBudgetGrants?.[hostname];
      if (acquire && !sealed && budgetGrant) recording.authorizeBudgetGrant(budgetGrant);
      if (acquire && !sealed && this.config.recoverTransientFailures) {
        const selected = homepageOnly ? [`https://${hostname}/robots.txt`, `https://${hostname}/`] : undefined;
        recording.recoverTransientFailures(selected);
        recording.resumeDurationFailures(selected);
      }
      return session;
    } catch (error) {
      recording.close();
      throw error;
    }
  }

  async homepage(hostname: string, token: string) {
    const row = this.owned(hostname, token);
    if (row.state !== "claimed") throw new Error("Homepage triage requires a claimed hostname");
    const { recording, scraper } = await this.recording(hostname, true, true);
    try {
      const homepage = await recording.readDocument(`https://${hostname}/`);
      let decision: ReturnType<typeof scraper.extract>;
      try {
        decision = scraper.extract(homepage.snapshot);
      } catch (error) {
        decision = { kind: "excluded", reason: error instanceof Error ? error.message : String(error) };
      }
      const $ = load(decision.kind === "document" ? decision.input.html : homepage.snapshot.body);
      $("script,style,noscript,nav,header,footer,form,svg").remove();
      $("br").replaceWith("\n");
      $("p,li,h1,h2,h3,h4,section,div").append("\n");
      const text = $.root()
        .text()
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n/g, "\n\n")
        .trim();
      const preview = {
        hostname,
        title: decision.kind === "document" ? decision.input.title : null,
        url: homepage.snapshot.url,
        snapshot_sha256: homepage.sha256,
        status: homepage.snapshot.status,
        admitted: row.admitted,
        extraction: decision.kind,
        ...(decision.kind === "excluded" ? { extraction_reason: decision.reason } : {}),
        vetting: scraper.vetHomepage(homepage.snapshot),
        text: text.length > 12000 ? `${text.slice(0, 8500)}\n[homepage preview shortened]\n${text.slice(-3500)}` : text,
        total_text_characters: text.length,
      };
      this.queue.update(hostname, token, "claimed", {
        recorded_homepage_sha256: homepage.sha256,
        homepage_acceptable: preview.vetting.accepted && decision.kind === "document",
      });
      await save(join(this.directory, "workers", `${row.worker}-homepage.json`), preview);
      return preview;
    } finally {
      recording.close();
    }
  }

  decide(hostname: string, token: string, accept: boolean, reason: string, policy?: HostRoutingPolicy): void {
    const row = this.owned(hostname, token);
    if (row.state !== "claimed" || !row.details.recorded_homepage_sha256 || !reason.trim())
      throw new Error("A recorded homepage and short decision reason are required");
    if (accept && row.details.homepage_acceptable !== true)
      throw new Error("Recorded homepage is not usable public prose");
    if (accept) {
      assertAdmittedHostname(hostname);
      if (this.config.requireSavedRouting && !policy)
        throw new Error("Admission requires a saved first classification");
      if (policy && parseRoutingPolicy(formatRoutingPolicy(policy)).hostname !== hostname)
        throw new Error("Classification hostname mismatch");
    }
    this.queue.update(hostname, token, accept ? "admitted" : "rejected", {
      homepage_decision: reason,
      ...(accept && policy
        ? { routing_policy: policy, routing_policy_sha256: sha256(formatRoutingPolicy(policy)) }
        : {}),
    });
  }

  async collect(hostname: string, token: string) {
    const row = this.owned(hostname, token);
    if (row.state !== "admitted")
      throw new Error("Only admitted hosts can begin collection; interrupted work is not blindly restarted");
    this.queue.update(hostname, token, "collecting");
    const session = await this.recording(hostname, true);
    const { recording, directory } = session;
    try {
      const { completed, seal, seedSha256 } = await collectRecordedSession(session, this.config.producer, {
        mode: "acquire",
        scopeExclusions: "skip-recorded",
      });
      const guarded = cheapGuardCompletedHost(completed);
      const ready: ReadyHostV1 = {
        version: 1,
        hostname,
        recording_seal: seal,
        seed_sha256: seedSha256,
        pdf_profile_sha256: null,
        completed: guarded,
      };
      const bytes = Buffer.from(`${JSON.stringify(ready, null, 2)}\n`);
      const path = join(directory, `batch-ready-${sha256(bytes)}.json`);
      await immutable(path, bytes);
      this.queue.update(hostname, token, "ready", {
        ready_path: path,
        ready_sha256: sha256(bytes),
        documents: guarded.documents.length,
      });
      const sample =
        guarded.documents.find((document) => document.source_url === `https://${hostname}/`) ?? guarded.documents[0]!;
      return {
        hostname,
        state: "ready",
        documents: guarded.documents.length,
        sample: {
          title: sample.title,
          source_url: sample.source_url,
          body: sample.content_markdown.slice(0, 5000),
          shortened: sample.content_markdown.length > 5000,
        },
      };
    } finally {
      recording.close();
    }
  }

  block(hostname: string, token: string, reason: string): void {
    const row = this.owned(hostname, token);
    if (!TERMINAL.has(row.state) && row.state !== "publishing")
      this.queue.update(hostname, token, "blocked", { failure: reason });
  }

  async publish(hostname: string, token: string, sampleReview: string) {
    return this.publisher.publish(hostname, token, sampleReview);
  }
}
