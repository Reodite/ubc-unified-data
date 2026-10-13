import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostBatchConfig, ReadyHost } from "./batch-model.ts";
import { DOCUMENT_CATEGORIES } from "./categories.ts";
import {
  assertAdmittedHostname,
  formatRoutingPolicy,
  loadRoutingPolicy,
  loadSavedClassifications,
  parseRoutingPolicy,
  routeCompletedHost,
  saveFirstRoutingPolicy,
  type HostRoutingPolicy,
} from "./category-routing.ts";
import { assertSingleHostChange, type ChangedFile } from "./change-validation.ts";
import { documentFilename, sha256 } from "./document-format.ts";
import { lockGitPublication, saveGitPublication } from "./git-publication-lock.ts";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { isAbsent as absent, readPrivateJson as json, LARGE_PRIVATE_FILE } from "./private-files.ts";
import { hostDocumentRoots, readRegularFile } from "./public-validation.ts";
import { publishCompletedHost } from "./publication.ts";
import { parseGenericHostnames, specializedHostnames } from "./registry.ts";
import type { HostWorkQueue, HostWorkRecord } from "./work-queue.ts";

const GENERIC_LIST = "src/host-scrapers/generic-hosts.json";
const SPECIALIZED = specializedHostnames();

interface GitReceipt {
  hostname: string;
  parent: string;
  tree?: string;
  commit?: string;
  pushed?: boolean;
}

export interface BatchPublicationContext {
  directory: string;
  config: HostBatchConfig;
  queue: Pick<HostWorkQueue, "update">;
  owned(hostname: string, token: string): HostWorkRecord;
  verifyReady(row: HostWorkRecord): Promise<ReadyHost>;
}

export interface BatchPublicationIO {
  git(args: string[]): Buffer;
  readFile: typeof readRegularFile;
}

/** Serialize reviewed host publication and retain the durable fence across uncertain Git effects. */
export class BatchPublisher {
  constructor(
    private readonly context: BatchPublicationContext,
    private readonly io: BatchPublicationIO = {
      git: (args) =>
        execFileSync("git", ["--no-optional-locks", ...args], {
          cwd: context.config.repositoryRoot,
          maxBuffer: LARGE_PRIVATE_FILE,
          timeout: 120000,
        }),
      readFile: readRegularFile,
    },
  ) {}

  private async staged(tree: string, parent: string): Promise<ChangedFile[]> {
    const fields = this.io
      .git(["diff", "--name-status", "--no-renames", "-z", parent, tree])
      .toString("utf8")
      .split("\0");
    fields.pop();
    const files: ChangedFile[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      const status = fields[index]!;
      const path = fields[index + 1]!;
      if (!["A", "M", "D"].includes(status)) throw new Error("Unsupported staged change");
      const bytes = status === "D" ? null : this.io.git(["show", `${tree}:${path}`]);
      if (
        bytes &&
        !(await this.io.readFile(join(this.context.config.repositoryRoot, path), LARGE_PRIVATE_FILE)).equals(bytes)
      )
        throw new Error(`Staged bytes differ: ${path}`);
      files.push({
        path,
        bytes,
        previousBytes: status === "A" ? null : this.io.git(["show", `${parent}:${path}`]),
      });
    }
    return files;
  }

  async publish(hostname: string, token: string, sampleReview: string) {
    const { directory, config, queue, owned, verifyReady } = this.context;
    assertAdmittedHostname(hostname);
    const lock = lockGitPublication(
      config.repositoryRoot,
      this.io.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim(),
    );
    try {
      const row = owned(hostname, token);
      if (!["ready", "publishing", "published"].includes(row.state) || !sampleReview.trim())
        throw new Error("Publication requires ready output and one quick content sample review");
      if (this.io.git(["branch", "--show-current"]).toString().trim() !== "feat/prose-documents")
        throw new Error("Publication is restricted to feat/prose-documents");
      if (this.io.git(["rev-parse", "refs/heads/main"]).toString().trim() !== config.main)
        throw new Error("Protected local main changed");
      const origin = this.io.git(["remote", "get-url", "--push", "--all", "origin"]).toString().trim();
      if (
        !["https://github.com/Reodite/ubc-unified-data", "https://github.com/Reodite/ubc-unified-data.git"].includes(
          origin,
        )
      )
        throw new Error("Unexpected publication push destination");
      await lock.claim({ batch_directory: directory, hostname, token }, row.state === "published");
      const receiptPath = assertExternalPath(
        join(directory, "publications", `${hostname}.json`),
        config.repositoryRoot,
      );
      const saveReceipt = (value: GitReceipt) => saveGitPublication(receiptPath, value, config.repositoryRoot);
      let receipt: GitReceipt;
      try {
        receipt = (await json(receiptPath)) as GitReceipt;
      } catch (error) {
        if (!absent(error) || row.state === "published") throw error;
        receipt = { hostname, parent: this.io.git(["rev-parse", "HEAD"]).toString().trim() };
        await saveReceipt(receipt);
      }
      if (receipt.hostname !== hostname) throw new Error("Publication receipt hostname differs");
      if (row.state === "published" && (!receipt.commit || !receipt.tree || !receipt.pushed))
        throw new Error("Published claim lacks a completed Git receipt");
      if (row.state === "ready") queue.update(hostname, token, "publishing", { sample_review: sampleReview });
      const head = this.io.git(["rev-parse", "HEAD"]).toString().trim();
      if (!receipt.commit && receipt.tree && head !== receipt.parent) {
        if (
          this.io.git(["rev-parse", "HEAD^"]).toString().trim() !== receipt.parent ||
          this.io.git(["rev-parse", "HEAD^{tree}"]).toString().trim() !== receipt.tree
        )
          throw new Error("Unrecognized HEAD after interrupted commit");
        receipt.commit = head;
        await saveReceipt(receipt);
      }
      if (!receipt.commit) {
        if (head !== receipt.parent) throw new Error("Publication parent changed");
        const initial = head === config.baseline;
        const routingPath = `src/host-scrapers/routing/${hostname}.json`;
        const ownsDocument = (path: string) =>
          [hostname, ...DOCUMENT_CATEGORIES.map((category) => `${category}/${hostname}`)].some((owner) =>
            path.startsWith(`data/documents/${owner}/`),
          );
        const allowed = new Set([
          GENERIC_LIST,
          routingPath,
          "data/official-hosts.json",
          ...(initial ? Object.keys(config.bootstrapFiles) : []),
        ]);
        const dirty = new Set(
          this.io
            .git(["ls-files", "--modified", "--others", "--exclude-standard", "-z"])
            .toString()
            .split("\0")
            .filter(Boolean),
        );
        for (const file of dirty)
          if (!allowed.has(file) && !ownsDocument(file))
            throw new Error(`Unrelated working change blocks publication: ${file}`);
        if (initial)
          for (const [file, hash] of Object.entries(config.bootstrapFiles)) {
            if (
              file !== GENERIC_LIST &&
              sha256(await this.io.readFile(join(config.repositoryRoot, file), LARGE_PRIVATE_FILE)) !== hash
            )
              throw new Error(`Bootstrap input changed: ${file}`);
          }
        const ready = await verifyReady(row);
        let policy: HostRoutingPolicy | undefined;
        if (row.details.routing_policy) {
          policy = parseRoutingPolicy(formatRoutingPolicy(row.details.routing_policy as HostRoutingPolicy));
          if (sha256(formatRoutingPolicy(policy)) !== row.details.routing_policy_sha256)
            throw new Error("Saved classification receipt differs");
          await saveFirstRoutingPolicy(policy, config.repositoryRoot);
        } else if (config.requireSavedRouting) policy = await loadRoutingPolicy(hostname, config.repositoryRoot);
        const completed = policy
          ? routeCompletedHost(ready.completed, policy, await loadSavedClassifications(config.repositoryRoot, hostname))
          : ready.completed;
        {
          const namesPath = join(config.repositoryRoot, GENERIC_LIST);
          const names = parseGenericHostnames(await this.io.readFile(namesPath));
          if (!names.includes(hostname)) {
            names.push(hostname);
            names.sort();
            await writeFile(namesPath, `${JSON.stringify(names, null, 2)}\n`);
          }
          const verifyInputs = async () => {
            const verified = await verifyReady(row);
            const expected = policy
              ? routeCompletedHost(
                  verified.completed,
                  await loadRoutingPolicy(hostname, config.repositoryRoot),
                  await loadSavedClassifications(config.repositoryRoot, hostname),
                )
              : verified.completed;
            if (JSON.stringify(expected) !== JSON.stringify(completed))
              throw new Error("Categorized ready result changed");
          };
          await publishCompletedHost({
            completed,
            repositoryRoot: config.repositoryRoot,
            externalRoot: DEFAULT_EXTERNAL_ROOT,
            registeredHosts: [...SPECIALIZED, ...names],
            verifyInputs,
            incremental: true,
          });
        }
        const paths = [
          GENERIC_LIST,
          ...(policy ? [routingPath] : []),
          "data/official-hosts.json",
          ...hostDocumentRoots(completed.host).map((root) => root.path),
          ...(initial ? Object.keys(config.bootstrapFiles) : []),
        ];
        this.io.git(["add", "--", ...new Set(paths)]);
        // Validate immutable tree bytes, not an index that may change across asynchronous file reads.
        const tree = this.io.git(["write-tree"]).toString().trim();
        const files = await this.staged(tree, receipt.parent);
        if (assertSingleHostChange(files) !== hostname) throw new Error("Staged commit belongs to another hostname");
        for (const file of files)
          if (!allowed.has(file.path) && !ownsDocument(file.path))
            throw new Error(`Unrelated staged change: ${file.path}`);
        for (const document of completed.documents)
          if (
            !files.some(
              (file) =>
                file.path ===
                `data/documents/${document.category ? `${document.category}/` : ""}${hostname}/${documentFilename(document.id)}`,
            )
          )
            throw new Error("A final document is missing from the stage");
        receipt.tree = tree;
        await saveReceipt(receipt);
        if (this.io.git(["write-tree"]).toString().trim() !== tree)
          throw new Error("Git index changed after staged tree validation");
        if (this.io.git(["rev-parse", "HEAD"]).toString().trim() !== receipt.parent)
          throw new Error("Publication parent changed before commit");
        this.io.git(["commit", "-m", `feat: publish ${hostname} documents`]);
        // Hooks and noncooperating Git writers must not turn an unvalidated tree into a valid receipt.
        if (
          this.io.git(["rev-parse", "HEAD^{tree}"]).toString().trim() !== tree ||
          this.io.git(["rev-parse", "HEAD^"]).toString().trim() !== receipt.parent
        )
          throw new Error("Committed tree or parent differs from validated stage");
        receipt.commit = this.io.git(["rev-parse", "HEAD"]).toString().trim();
        await saveReceipt(receipt);
      }
      if (this.io.git(["rev-parse", "HEAD"]).toString().trim() !== receipt.commit)
        throw new Error("Committed hostname is no longer HEAD");
      if (
        !receipt.tree ||
        this.io.git(["rev-parse", "HEAD^{tree}"]).toString().trim() !== receipt.tree ||
        this.io.git(["rev-parse", "HEAD^"]).toString().trim() !== receipt.parent
      )
        throw new Error("Committed tree or parent differs from publication receipt");
      if (this.io.git(["status", "--porcelain"]).length) throw new Error("Publication left a dirty checkout");
      this.io.git(["push", "origin", "HEAD:refs/heads/feat/prose-documents"]);
      const remote = this.io
        .git(["ls-remote", "--heads", "origin", "refs/heads/feat/prose-documents", "refs/heads/main"])
        .toString();
      if (
        !remote.includes(`${receipt.commit}\trefs/heads/feat/prose-documents`) ||
        !remote.includes(`${config.main}\trefs/heads/main`)
      )
        throw new Error("Remote feature/main verification failed");
      receipt.pushed = true;
      await saveReceipt(receipt);
      if (row.state !== "published")
        queue.update(hostname, token, "published", { commit: receipt.commit, pushed: true });
      await lock.finish();
      return { hostname, commit: receipt.commit, documents: row.details.documents, published: true };
    } finally {
      lock.close();
    }
  }
}
