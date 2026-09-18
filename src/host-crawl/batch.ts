import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load } from "cheerio";
import { ROOT } from "../base.ts";
import { extractPdf } from "./adapters/pdf.ts";
import { assertSingleHostChange, type ChangedFile } from "./change-validation.ts";
import { collectRecordedHost, type CollectionFormats } from "./collect.ts";
import type { CompletedHost, HostArchive, ProducerContext } from "./contracts.ts";
import { documentFilename, sha256 } from "./document-format.ts";
import { cheapGuardCompletedHost, createGenericScraper } from "./generic.ts";
import { assertCollectedInput, decodeFrozenSeed } from "./inputs.ts";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT, DEFAULT_LEGACY_STATE_FILE } from "./paths.ts";
import { loadCachedPdfProfile } from "./pdf-profile-cache.ts";
import type { PdfProfile } from "./pdf-profile.ts";
import { assertSameProducer, captureProducer } from "./provenance.ts";
import { readRegularFile } from "./public-validation.ts";
import { publishCompletedHost } from "./publication.ts";
import { HostRecording } from "./recording.ts";
import { parseGenericHostnames } from "./registry.ts";
import { normalizeHost } from "./urls.ts";
import { HostWorkQueue, type HostWorkRecord } from "./work-queue.ts";

const GENERIC_LIST = "src/host-scrapers/generic-hosts.json";
const SPECIALIZED = ["bmlscpathology.med.ubc.ca", "bullyingandharassment.ubc.ca", "coop.ubc.ca"];
const TERMINAL = new Set(["published", "rejected", "blocked"]);
const LARGE_PRIVATE_FILE = 256 * 1024 * 1024;
export interface HostBatchConfig {
  repositoryRoot: string;
  producerRoot: string;
  producer: ProducerContext;
  baseline: string;
  main: string;
  bootstrapFiles: Record<string, string>;
  recoverTransientFailures?: boolean;
}
interface ReadyHost {
  version: 1;
  hostname: string;
  recording_seal: string;
  seed_sha256: string;
  pdf_profile_sha256: string | null;
  completed: CompletedHost;
}
interface GitReceipt {
  hostname: string;
  parent: string;
  tree?: string;
  commit?: string;
  pushed?: boolean;
}

async function json(path: string): Promise<unknown> {
  return JSON.parse((await readRegularFile(path, LARGE_PRIVATE_FILE)).toString("utf8"));
}
async function save(path: string, value: unknown): Promise<void> {
  assertExternalPath(path);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.new`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
async function immutable(path: string, bytes: Buffer): Promise<void> {
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await readRegularFile(path, LARGE_PRIVATE_FILE)).equals(bytes)
    )
      throw error;
  }
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Collectors use an immutable source snapshot; the Git boundary alone is serialized. */
export class HostBatch {
  private constructor(
    readonly directory: string,
    readonly config: HostBatchConfig,
    readonly queue: HostWorkQueue,
  ) {}

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
    this.queue.seed(items);
  }
  close(): void {
    this.queue.close();
  }

  async claim(worker: string) {
    if (!/^w[1-5]$/.test(worker)) throw new Error("Expected worker w1..w5");
    const receipt = join(this.directory, "workers", `${worker}.json`);
    try {
      const previous = (await json(receipt)) as { hostname: string; token: string };
      const row = this.queue.get(previous.hostname);
      if (row && !TERMINAL.has(row.state)) {
        if (row.worker !== worker || row.token !== previous.token)
          throw new Error("Worker receipt does not own its retained claim");
        return { ...row, resumed: true };
      }
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const retained = this.queue.current(worker);
    const claim = retained ?? this.queue.claim(worker);
    if (claim) await save(receipt, claim);
    return claim;
  }

  owned(hostname: string, token: string): HostWorkRecord {
    const row = this.queue.get(normalizeHost(hostname));
    if (!row || !token || row.token !== token) throw new Error("Hostname claim is not owned by this token");
    return row;
  }

  private async recording(hostname: string, acquire: boolean, homepageOnly = false) {
    if (acquire && resolve(ROOT) !== this.config.producerRoot)
      throw new Error("Acquisition must run from the frozen batch producer");
    assertSameProducer(this.config.producer, await captureProducer(this.config.producerRoot));
    const scraper = createGenericScraper(hostname);
    const directory = assertExternalPath(join(DEFAULT_EXTERNAL_ROOT, "hosts", hostname, "recording"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const seedPath = join(directory, "seed.json");
    let bytes: Buffer;
    try {
      bytes = await readRegularFile(seedPath, 16 * 1024 * 1024);
    } catch (error) {
      if (!absent(error) || !acquire) throw error;
      const database = new DatabaseSync(DEFAULT_LEGACY_STATE_FILE, { readOnly: true });
      try {
        database.exec("PRAGMA query_only=ON");
        const urls = database
          .prepare(
            "SELECT url,kind,state,disposition,reason,snapshot,article_id,source_modified_at FROM urls WHERE host=? ORDER BY url",
          )
          .all(hostname);
        bytes = Buffer.from(JSON.stringify({ hostname, urls }));
      } finally {
        database.close();
      }
      await immutable(seedPath, bytes);
    }
    const seed = decodeFrozenSeed(bytes, hostname);
    let sealed = false;
    try {
      await readRegularFile(join(directory, "seal.json"));
      sealed = true;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const recording = await HostRecording.open({
      hostname,
      directory,
      producer: this.config.producer,
      seedSha256: sha256(seed.bytes),
      acquire: acquire && !sealed,
      recoverTransientFailures: this.config.recoverTransientFailures === true,
      documentFormats: scraper.documentFormats,
      documentUrlAllowed: (url) => scraper.excludeUrl!(url) === null,
      maxResponseBytes: 32 * 1024 * 1024,
    });
    try {
      if (acquire && !sealed && this.config.recoverTransientFailures) {
        const selected = homepageOnly ? [`https://${hostname}/robots.txt`, `https://${hostname}/`] : undefined;
        recording.recoverTransientFailures(selected);
        recording.resumeDurationFailures(selected);
      }
      return { recording, directory, scraper, seed, seedPath };
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

  decide(hostname: string, token: string, accept: boolean, reason: string): void {
    const row = this.owned(hostname, token);
    if (row.state !== "claimed" || !row.details.recorded_homepage_sha256 || !reason.trim())
      throw new Error("A recorded homepage and short decision reason are required");
    if (accept && row.details.homepage_acceptable !== true)
      throw new Error("Recorded homepage is not usable public prose");
    this.queue.update(hostname, token, accept ? "admitted" : "rejected", { homepage_decision: reason });
  }

  async collect(hostname: string, token: string) {
    const row = this.owned(hostname, token);
    if (row.state !== "admitted")
      throw new Error("Only admitted hosts can begin collection; interrupted work is not blindly restarted");
    this.queue.update(hostname, token, "collecting");
    const { recording, directory, scraper, seed, seedPath } = await this.recording(hostname, true);
    try {
      const homepage = await recording.readDocument(`https://${hostname}/`);
      const archive: HostArchive = {
        hostname,
        input_sha256: recording.inputDigest(),
        homepage,
        urls: seed.urls,
        retained: [],
        read: (url) => recording.read(url),
        readDocument: (url) => recording.readDocument(url),
        readSnapshot: (hash) => recording.readSnapshot(hash),
        readBytes: (hash) => recording.readBytes(hash),
        observedDestination: (url) => recording.observedDestination(url),
        observedScopeExclusion: (url) => recording.observedScopeExclusion(url),
        apiFallbackEligible: (url) => recording.apiFallbackEligible(url),
        assertUnchanged: () => recording.assertUnchanged(),
        close() {},
      };
      let profile: PdfProfile | undefined;
      const formats: CollectionFormats = {
        pdf: {
          get profile_sha256() {
            if (!profile) throw new Error("PDF profile was not initialized by extraction");
            return profile.sha256;
          },
          extract: async (bytes, sourceUrl) => {
            profile ??= await loadCachedPdfProfile(join(this.directory, "pdf-profile-cache"));
            return extractPdf({ bytes, sourceUrl, workspace: join(directory, "pdf-runtime"), profile });
          },
        },
      };
      const completed = await collectRecordedHost(scraper, archive, this.config.producer, formats);
      const seal = await recording.seal();
      if (!(await readRegularFile(seedPath, 16 * 1024 * 1024)).equals(seed.bytes))
        throw new Error("Saved frontier changed");
      const input = sha256(
        Buffer.from(
          JSON.stringify({
            recording: seal,
            seed: sha256(seed.bytes),
            ...(profile ? { pdf_profile: profile.sha256 } : {}),
          }),
        ),
      );
      for (const document of completed.documents) document.input_sha256 = input;
      const guarded = cheapGuardCompletedHost(completed);
      const ready: ReadyHost = {
        version: 1,
        hostname,
        recording_seal: seal,
        seed_sha256: sha256(seed.bytes),
        pdf_profile_sha256: profile?.sha256 ?? null,
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

  private git(args: string[]): Buffer {
    return execFileSync("git", ["--no-optional-locks", ...args], {
      cwd: this.config.repositoryRoot,
      maxBuffer: LARGE_PRIVATE_FILE,
      timeout: 120000,
    });
  }

  private async staged(): Promise<ChangedFile[]> {
    const fields = this.git(["diff", "--cached", "--name-status", "--no-renames", "-z"]).toString("utf8").split("\0");
    fields.pop();
    const files: ChangedFile[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      const status = fields[index]!;
      const path = fields[index + 1]!;
      if (!["A", "M", "D"].includes(status)) throw new Error("Unsupported staged change");
      const bytes = status === "D" ? null : this.git(["show", `:${path}`]);
      if (bytes && !(await readRegularFile(join(this.config.repositoryRoot, path), LARGE_PRIVATE_FILE)).equals(bytes))
        throw new Error(`Staged bytes differ: ${path}`);
      files.push({
        path,
        bytes,
        ...(path === GENERIC_LIST ? { previousBytes: status === "A" ? null : this.git(["show", `HEAD:${path}`]) } : {}),
      });
    }
    return files;
  }

  async publish(hostname: string, token: string, sampleReview: string) {
    const row = this.owned(hostname, token);
    if (!["ready", "publishing"].includes(row.state) || !sampleReview.trim())
      throw new Error("Publication requires ready output and one quick content sample review");
    const lock = new DatabaseSync(join(this.directory, "state", "git-publication.sqlite"));
    lock.exec(
      "PRAGMA busy_timeout=600000; CREATE TABLE IF NOT EXISTS owner(repository_root TEXT PRIMARY KEY); BEGIN IMMEDIATE",
    );
    try {
      const owners = lock.prepare("SELECT repository_root FROM owner").all();
      if (owners.length && (owners.length !== 1 || owners[0]!.repository_root !== this.config.repositoryRoot))
        throw new Error("Publication lock belongs to another repository");
      if (!owners.length) lock.prepare("INSERT INTO owner VALUES (?)").run(this.config.repositoryRoot);
      if (this.git(["branch", "--show-current"]).toString().trim() !== "feat/prose-documents")
        throw new Error("Publication is restricted to feat/prose-documents");
      if (this.git(["rev-parse", "refs/heads/main"]).toString().trim() !== this.config.main)
        throw new Error("Protected local main changed");
      const origin = this.git(["remote", "get-url", "--push", "--all", "origin"]).toString().trim();
      if (
        !["https://github.com/Reodite/ubc-unified-data", "https://github.com/Reodite/ubc-unified-data.git"].includes(
          origin,
        )
      )
        throw new Error("Unexpected publication push destination");
      const marker = join(this.directory, "state", "active-publication.json");
      try {
        const prior = ((await json(marker)) as { hostname: string }).hostname;
        if (prior !== hostname && this.queue.get(prior)?.state !== "published")
          throw new Error("Another hostname has an unfinished publication");
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const receiptPath = join(this.directory, "publications", `${hostname}.json`);
      let receipt: GitReceipt;
      try {
        receipt = (await json(receiptPath)) as GitReceipt;
      } catch (error) {
        if (!absent(error)) throw error;
        receipt = { hostname, parent: this.git(["rev-parse", "HEAD"]).toString().trim() };
        await save(receiptPath, receipt);
      }
      if (receipt.hostname !== hostname) throw new Error("Publication receipt hostname differs");
      await save(marker, { hostname });
      if (row.state === "ready") this.queue.update(hostname, token, "publishing", { sample_review: sampleReview });
      const head = this.git(["rev-parse", "HEAD"]).toString().trim();
      if (!receipt.commit && receipt.tree && head !== receipt.parent) {
        if (
          this.git(["rev-parse", "HEAD^"]).toString().trim() !== receipt.parent ||
          this.git(["rev-parse", "HEAD^{tree}"]).toString().trim() !== receipt.tree
        )
          throw new Error("Unrecognized HEAD after interrupted commit");
        receipt.commit = head;
        await save(receiptPath, receipt);
      }
      if (!receipt.commit) {
        if (head !== receipt.parent) throw new Error("Publication parent changed");
        const initial = head === this.config.baseline;
        const allowed = new Set([
          GENERIC_LIST,
          "data/official-hosts.json",
          ...(initial ? Object.keys(this.config.bootstrapFiles) : []),
        ]);
        const dirty = new Set(
          this.git(["ls-files", "--modified", "--others", "--exclude-standard", "-z"])
            .toString()
            .split("\0")
            .filter(Boolean),
        );
        for (const file of dirty)
          if (!allowed.has(file) && !file.startsWith(`data/documents/${hostname}/`))
            throw new Error(`Unrelated working change blocks publication: ${file}`);
        if (initial)
          for (const [file, hash] of Object.entries(this.config.bootstrapFiles)) {
            if (
              file !== GENERIC_LIST &&
              sha256(await readRegularFile(join(this.config.repositoryRoot, file), LARGE_PRIVATE_FILE)) !== hash
            )
              throw new Error(`Bootstrap input changed: ${file}`);
          }
        const path = String(row.details.ready_path);
        assertExternalPath(path);
        const bytes = await readRegularFile(path, LARGE_PRIVATE_FILE);
        if (sha256(bytes) !== row.details.ready_sha256) throw new Error("Ready result bytes changed");
        const ready = JSON.parse(bytes.toString("utf8")) as ReadyHost;
        if (ready.version !== 1 || ready.hostname !== hostname) throw new Error("Invalid ready result owner");
        cheapGuardCompletedHost(ready.completed);
        const { recording, seed } = await this.recording(hostname, false);
        try {
          const namesPath = join(this.config.repositoryRoot, GENERIC_LIST);
          const names = parseGenericHostnames(await readRegularFile(namesPath));
          if (!names.includes(hostname)) {
            names.push(hostname);
            names.sort();
            await writeFile(namesPath, `${JSON.stringify(names, null, 2)}\n`);
          }
          const verifyInputs = async () => {
            if (sha256(seed.bytes) !== ready.seed_sha256) throw new Error("Ready frontier differs");
            assertCollectedInput(ready.recording_seal, await recording.verifySeal());
            assertSameProducer(this.config.producer, await captureProducer(this.config.producerRoot));
            const expectedInput = sha256(
              Buffer.from(
                JSON.stringify({
                  recording: ready.recording_seal,
                  seed: ready.seed_sha256,
                  ...(ready.pdf_profile_sha256 ? { pdf_profile: ready.pdf_profile_sha256 } : {}),
                }),
              ),
            );
            for (const document of ready.completed.documents) {
              assertSameProducer(this.config.producer, document.producer);
              assertCollectedInput(expectedInput, document.input_sha256);
            }
            if (
              ready.pdf_profile_sha256 &&
              (await loadCachedPdfProfile(join(this.directory, "pdf-profile-cache"))).sha256 !==
                ready.pdf_profile_sha256
            )
              throw new Error("Ready PDF profile differs");
          };
          await publishCompletedHost({
            completed: ready.completed,
            repositoryRoot: this.config.repositoryRoot,
            externalRoot: DEFAULT_EXTERNAL_ROOT,
            registeredHosts: [...SPECIALIZED, ...names],
            verifyInputs,
            incremental: true,
          });
        } finally {
          recording.close();
        }
        const paths = [
          GENERIC_LIST,
          "data/official-hosts.json",
          `data/documents/${hostname}`,
          ...(initial ? Object.keys(this.config.bootstrapFiles) : []),
        ];
        this.git(["add", "--", ...new Set(paths)]);
        const files = await this.staged();
        if (assertSingleHostChange(files) !== hostname) throw new Error("Staged commit belongs to another hostname");
        for (const file of files)
          if (!allowed.has(file.path) && !file.path.startsWith(`data/documents/${hostname}/`))
            throw new Error(`Unrelated staged change: ${file.path}`);
        for (const document of ready.completed.documents)
          if (!files.some((file) => file.path === `data/documents/${hostname}/${documentFilename(document.id)}`))
            throw new Error("A final document is missing from the stage");
        receipt.tree = this.git(["write-tree"]).toString().trim();
        await save(receiptPath, receipt);
        this.git(["commit", "-m", `feat: publish ${hostname} documents`]);
        receipt.commit = this.git(["rev-parse", "HEAD"]).toString().trim();
        await save(receiptPath, receipt);
      }
      if (this.git(["rev-parse", "HEAD"]).toString().trim() !== receipt.commit)
        throw new Error("Committed hostname is no longer HEAD");
      if (this.git(["status", "--porcelain"]).length) throw new Error("Publication left a dirty checkout");
      this.git(["push", "origin", "HEAD:refs/heads/feat/prose-documents"]);
      const remote = this.git([
        "ls-remote",
        "--heads",
        "origin",
        "refs/heads/feat/prose-documents",
        "refs/heads/main",
      ]).toString();
      if (
        !remote.includes(`${receipt.commit}\trefs/heads/feat/prose-documents`) ||
        !remote.includes(`${this.config.main}\trefs/heads/main`)
      )
        throw new Error("Remote feature/main verification failed");
      receipt.pushed = true;
      await save(receiptPath, receipt);
      this.queue.update(hostname, token, "published", { commit: receipt.commit, pushed: true });
      const { unlink } = await import("node:fs/promises");
      await unlink(marker);
      lock.exec("COMMIT");
      return { hostname, commit: receipt.commit, documents: row.details.documents, published: true };
    } finally {
      lock.close();
    }
  }
}
