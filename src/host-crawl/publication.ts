import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertPublishableArticle } from "./article-quality.ts";
import { assertAdmittedHostname } from "./category-routing.ts";
import type { CompletedHost, VettedHost } from "./contracts.ts";
import { documentFilename, exactObject, formatDocument, parseDocument, sha256 } from "./document-format.ts";
import {
  assertNoSymlinkPath,
  hostDocumentRoots as documentRoots,
  formatHostList,
  HOST_LIST_PATH,
  maybeLstat,
  readRegularFile,
  registeredHostSet,
  requireDirectory,
  validatePublishedHosts,
  validateVettedHost,
  type RegisteredHosts,
} from "./public-validation.ts";
import {
  assertReceipt,
  atomicRename,
  directoryReceipt,
  fileReceipt,
  knownEntries,
  knownWorkspaceEntries,
  lockWorkspace,
  MAX_JOURNAL_BYTES,
  prepareExternalRoot,
  same,
  syncDirectory,
  writeExclusive,
} from "./publication/files.ts";
import {
  journalBytes,
  locations,
  parentPaths,
  parseJournal,
  type Journal,
  type OwnedDirectory,
} from "./publication/journal.ts";
import { recover, verifyParents } from "./publication/recovery.ts";
import { normalizeHost } from "./urls.ts";

type DocumentRoot = ReturnType<typeof documentRoots>[number];

export type PublicationBoundary =
  | "locked"
  | "journal-written"
  | "prepared"
  | "inputs-verified"
  | "parents-created"
  | "old-host-moved"
  | "new-host-installed"
  | "old-list-moved"
  | "new-list-installed"
  | "before-commit"
  | "commit-prepared"
  | "committed"
  | "before-cleanup";

export interface PublishCompletedHostOptions {
  completed: CompletedHost;
  repositoryRoot: string;
  /** Cooperating publishers for one repository must use the same externalRoot. */
  externalRoot: string;
  registeredHosts: RegisteredHosts;
  verifyInputs: () => Promise<void>;
  /**
   * Read and receipt only target-host document bytes, retaining the full index and file census.
   * Requires an outer repository/Git publication lock and a guard against other-host file changes.
   */
  incremental?: boolean;
  /** Failure injection only; no extraction or content override is accepted. */
  testHook?: (boundary: PublicationBoundary) => void | Promise<void>;
}

export interface WithdrawPublishedHostOptions {
  hostname: string;
  repositoryRoot: string;
  externalRoot: string;
  registeredHosts: RegisteredHosts;
  verifyInputs: () => Promise<void>;
  /** Requires the same outer repository/Git lock and other-host guard as incremental publication. */
  incremental?: boolean;
  testHook?: (boundary: PublicationBoundary) => void | Promise<void>;
}

export interface PublicationResult {
  changed: boolean;
  hosts: VettedHost[];
}

async function publicReceipt(
  repositoryRoot: string,
  hosts: readonly VettedHost[],
  parentRoots: readonly DocumentRoot[],
  targetRoots: readonly DocumentRoot[],
) {
  return {
    target: await Promise.all(
      [...new Set(targetRoots.map((root) => root.path))].sort().map(async (path) => ({
        path,
        receipt: await directoryReceipt(join(repositoryRoot, path)),
      })),
    ),
    list: await fileReceipt(join(repositoryRoot, HOST_LIST_PATH)),
    parents: await Promise.all(
      parentPaths(parentRoots).map(async (path) => ({
        path,
        mode: (await maybeLstat(join(repositoryRoot, path)))?.mode ?? null,
      })),
    ),
    hosts: await Promise.all(
      hosts.map(async (host) => ({
        hostname: host.hostname,
        directories: await Promise.all(
          documentRoots(host).map(async (root) => ({
            path: root.path,
            receipt: await directoryReceipt(join(repositoryRoot, root.path)),
          })),
        ),
      })),
    ),
  };
}

async function ensureParent(path: string): Promise<void> {
  await assertNoSymlinkPath(path);
  if (!(await maybeLstat(path))) {
    await mkdir(path, { mode: 0o755 });
    await chmod(path, 0o755);
    await syncDirectory(dirname(path));
  }
  await requireDirectory(path);
}

/** Publish one complete host with external staging and a process-released SQLite write lock. */
export async function publishCompletedHost(options: PublishCompletedHostOptions): Promise<PublicationResult> {
  exactObject(
    options,
    [
      "completed",
      "repositoryRoot",
      "externalRoot",
      "registeredHosts",
      "verifyInputs",
      ...(Object.hasOwn(options, "testHook") ? ["testHook"] : []),
      ...(Object.hasOwn(options, "incremental") ? ["incremental"] : []),
    ],
    "publication options",
  );
  const { completed, repositoryRoot, externalRoot, verifyInputs, testHook, incremental = false } = options;
  if (typeof incremental !== "boolean") throw new Error("Incremental publication must be a boolean");
  const registeredHosts = registeredHostSet(options.registeredHosts);
  exactObject(completed, ["complete", "host", "documents"], "completed host");
  if (
    completed.complete !== true ||
    !Array.isArray(completed.documents) ||
    !completed.documents.length ||
    typeof verifyInputs !== "function"
  )
    throw new Error("Only complete, nonempty, input-verified hosts can be published");
  validateVettedHost(completed.host, registeredHosts);
  assertAdmittedHostname(completed.host.hostname);
  if (completed.host.document_count !== completed.documents.length)
    throw new Error("Completed host document count mismatch");
  const host = structuredClone(completed.host);
  const roots = documentRoots(host);
  const output = completed.documents
    .map((doc) => {
      const bytes = formatDocument(doc);
      const category = doc.category;
      const root = roots.find((item) => item.category === category);
      if (!root) throw new Error("Document category does not match a host root");
      const expected = { hostname: host.hostname, filename: documentFilename(doc.id), category: root.category };
      const parsed = parseDocument(bytes, expected);
      assertPublishableArticle(parsed);
      return { path: root.path, name: documentFilename(parsed.id), bytes, document: parsed };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const root of roots)
    if (output.filter((item) => item.path === root.path).length !== root.document_count)
      throw new Error("Completed category document count mismatch");
  const urls = new Set<string>();
  const ids = new Set<string>();
  for (const item of output) {
    const doc = item.document;
    if (ids.has(doc.id)) throw new Error("Duplicate completed document ID");
    ids.add(doc.id);
    if (doc.input_sha256 !== output[0]!.document.input_sha256 || !same(doc.producer, output[0]!.document.producer))
      throw new Error("Inconsistent host input or producer metadata");
    for (const url of [doc.source_url, ...doc.alternate_urls]) {
      if (urls.has(url)) throw new Error("Duplicate completed document URL");
      urls.add(url);
    }
  }
  return publishTransaction(
    { repositoryRoot, externalRoot, registeredHosts, verifyInputs, testHook, incremental },
    host.hostname,
    host,
    output,
  );
}

/** Remove one explicitly rejected host using the same receipt-verified publication transaction. */
export async function withdrawPublishedHost(options: WithdrawPublishedHostOptions): Promise<PublicationResult> {
  exactObject(
    options,
    [
      "hostname",
      "repositoryRoot",
      "externalRoot",
      "registeredHosts",
      "verifyInputs",
      ...(Object.hasOwn(options, "testHook") ? ["testHook"] : []),
      ...(Object.hasOwn(options, "incremental") ? ["incremental"] : []),
    ],
    "withdrawal options",
  );
  const registeredHosts = registeredHostSet(options.registeredHosts);
  if (
    typeof options.hostname !== "string" ||
    normalizeHost(options.hostname) !== options.hostname ||
    !registeredHosts.has(options.hostname)
  )
    throw new Error("Unregistered withdrawal hostname");
  if (typeof options.verifyInputs !== "function") throw new Error("Withdrawal requires an input guard");
  if (options.incremental !== undefined && typeof options.incremental !== "boolean")
    throw new Error("Incremental publication must be a boolean");
  return publishTransaction(options, options.hostname, null, []);
}

type PreparedOutput = Array<{ path: string; name: string; bytes: Buffer }>;

async function publishTransaction(
  options: Omit<PublishCompletedHostOptions, "completed">,
  hostname: string,
  host: VettedHost | null,
  output: PreparedOutput,
): Promise<PublicationResult> {
  const { repositoryRoot, externalRoot, registeredHosts, verifyInputs, testHook, incremental = false } = options;
  const validation = { repositoryRoot, registeredHosts, documentHostnames: incremental ? [hostname] : undefined };
  const workspace = await prepareExternalRoot(repositoryRoot, externalRoot);
  const database = await lockWorkspace(workspace, repositoryRoot);
  try {
    await testHook?.("locked");
    await recover(workspace, repositoryRoot, registeredHosts, incremental);
    const existing = await validatePublishedHosts({ ...validation, allowAbsent: true });
    const previousHost = existing.find((entry) => entry.hostname === hostname);
    const oldRoots = previousHost ? documentRoots(previousHost) : [];
    const newRoots = host ? documentRoots(host) : [];
    const parentRoots = [...existing.flatMap(documentRoots), ...newRoots];
    const readPublicReceipt = (entries: readonly VettedHost[]) =>
      publicReceipt(
        repositoryRoot,
        incremental ? entries.filter((entry) => entry.hostname === hostname) : entries,
        parentRoots,
        [...oldRoots, ...newRoots],
      );
    const baseline = await readPublicReceipt(existing);
    const hosts = [...existing.filter((entry) => entry.hostname !== hostname), ...(host ? [host] : [])].sort((a, b) =>
      a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0,
    );
    if (!host && !previousHost) {
      await verifyInputs();
      await validatePublishedHosts({ ...validation, allowAbsent: true });
      assertReceipt(await readPublicReceipt(existing), baseline, "public output changed during input verification");
      return { changed: false, hosts };
    }
    const list = formatHostList(hosts, registeredHosts);
    const oldDirectories = await Promise.all(
      oldRoots.map(async (root) => ({
        path: root.path,
        receipt: await directoryReceipt(join(repositoryRoot, root.path)),
      })),
    );
    const directories: OwnedDirectory[] = [];
    for (const path of [...new Set([...oldRoots, ...newRoots].map((root) => root.path))].sort()) {
      const old = oldDirectories.find((item) => item.path === path)?.receipt ?? null;
      const current = await directoryReceipt(join(repositoryRoot, path));
      assertReceipt(current, old, "unindexed host destination");
      const next = newRoots.find((root) => root.path === path);
      const inherited = old ?? (oldRoots.length === 1 && !oldRoots[0]!.category ? oldDirectories[0]!.receipt : null);
      directories.push({
        path,
        old,
        new: next
          ? {
              mode: inherited?.mode ?? 0o755,
              files: output
                .filter((item) => item.path === path)
                .map((item) => ({
                  name: item.name,
                  sha256: sha256(item.bytes),
                  size: item.bytes.length,
                  mode:
                    oldDirectories
                      .flatMap((directory) => directory.receipt?.files ?? [])
                      .find((file) => file.name === item.name)?.mode ?? 0o644,
                })),
            }
          : null,
      });
    }
    const parents = await Promise.all(
      parentPaths(directories).map(async (path) => {
        await assertNoSymlinkPath(join(repositoryRoot, path));
        const info = await maybeLstat(join(repositoryRoot, path));
        if (info) await requireDirectory(join(repositoryRoot, path));
        return { path, mode: info ? info.mode & 0o7777 : null };
      }),
    );
    const oldList = baseline.list;
    const common = {
      repository_root: repositoryRoot,
      hostname,
      old_list: oldList,
      new_list: { sha256: sha256(list), size: list.length, mode: oldList?.mode ?? 0o644 },
    };
    const only = directories[0]!;
    const journal: Journal =
      directories.length === 1 && only.path === `data/documents/${hostname}` && only.new
        ? {
            format_version: 1,
            repository_root: repositoryRoot,
            hostname,
            data_mode: parents[0]!.mode,
            documents_mode: parents[1]!.mode,
            old_host: only.old,
            new_host: only.new,
            old_list: oldList,
            new_list: common.new_list,
          }
        : {
            format_version: 2,
            repository_root: repositoryRoot,
            hostname,
            parents,
            directories,
            old_list: oldList,
            new_list: common.new_list,
          };
    parseJournal(journalBytes(journal), repositoryRoot, registeredHosts);
    if (directories.every((item) => same(item.old, item.new)) && same(oldList, journal.new_list)) {
      await verifyInputs();
      await validatePublishedHosts(validation);
      assertReceipt(await readPublicReceipt(existing), baseline, "public output changed during input verification");
      return { changed: false, hosts };
    }
    if (directories.some((item) => item.old && (item.old.mode & 0o222) === 0))
      throw new Error("Host directory mode forbids writable publication");
    const paths = locations(workspace, journal);
    await verifyParents(workspace, journal, false);
    await writeExclusive(join(workspace, "journal.json"), journalBytes(journal), 0o600);
    try {
      await testHook?.("journal-written");
      await mkdir(paths.transaction, { mode: 0o700 });
      await syncDirectory(workspace);
      for (const directory of paths.directories) {
        if (!directory.new) continue;
        await mkdir(directory.stage, { mode: directory.new.mode | 0o700 });
        await chmod(directory.stage, directory.new.mode | 0o700);
        for (const item of output.filter((item) => item.path === directory.path))
          await writeExclusive(
            join(directory.stage, item.name),
            item.bytes,
            directory.new.files.find((file) => file.name === item.name)!.mode,
          );
        await chmod(directory.stage, directory.new.mode);
        await syncDirectory(directory.stage);
        assertReceipt(await directoryReceipt(directory.stage), directory.new, "prepared host");
        for (const item of output.filter((item) => item.path === directory.path))
          if (!(await readRegularFile(join(directory.stage, item.name))).equals(item.bytes))
            throw new Error("Prepared document bytes differ");
      }
      await writeExclusive(paths.newList, list, journal.new_list.mode);
      assertReceipt(await fileReceipt(paths.newList), journal.new_list, "prepared host list");
      if (!(await readRegularFile(paths.newList, MAX_JOURNAL_BYTES)).equals(list))
        throw new Error("Prepared host list bytes differ");
      await testHook?.("prepared");
      await verifyInputs();
      await testHook?.("inputs-verified");
      await validatePublishedHosts({ ...validation, allowAbsent: true });
      assertReceipt(await readPublicReceipt(existing), baseline, "public output changed before installation");
      for (const directory of paths.directories)
        assertReceipt(
          await directoryReceipt(directory.stage),
          directory.new,
          "prepared host changed before installation",
        );
      assertReceipt(await fileReceipt(paths.newList), journal.new_list, "prepared list changed before installation");
      await knownWorkspaceEntries(workspace);
      await knownEntries(paths.transaction, paths.names);
      if (!(await readRegularFile(join(workspace, "journal.json"), MAX_JOURNAL_BYTES)).equals(journalBytes(journal)))
        throw new Error("Journal changed before installation");
      for (const parent of paths.parents) await ensureParent(parent.current);
      await testHook?.("parents-created");
      for (const directory of paths.directories) {
        if (!directory.old) continue;
        await atomicRename(directory.current, directory.backup);
        await testHook?.("old-host-moved");
      }
      if (!paths.directories.some((item) => item.old)) await testHook?.("old-host-moved");
      for (const directory of paths.directories) {
        if (!directory.new) continue;
        await atomicRename(directory.stage, directory.current);
        await testHook?.("new-host-installed");
      }
      if (!paths.directories.some((item) => item.new)) await testHook?.("new-host-installed");
      if (oldList) await atomicRename(paths.list, paths.oldList);
      await testHook?.("old-list-moved");
      await atomicRename(paths.newList, paths.list);
      await testHook?.("new-list-installed");
      await validatePublishedHosts(validation);
      for (const directory of paths.directories)
        assertReceipt(await directoryReceipt(directory.current), directory.new, "installed host");
      assertReceipt(await fileReceipt(paths.list), journal.new_list, "installed list");
      const installed = await readPublicReceipt(hosts);
      for (const parent of baseline.parents)
        assertReceipt(
          installed.parents.find((item) => item.path === parent.path)?.mode,
          parent.mode ?? 0o40755,
          "publication parent mode changed",
        );
      for (const previous of baseline.hosts) {
        if (previous.hostname !== hostname)
          assertReceipt(
            installed.hosts.find((item) => item.hostname === previous.hostname),
            previous,
            "other host changed during installation",
          );
      }
      await testHook?.("before-commit");
      await validatePublishedHosts(validation);
      assertReceipt(await readPublicReceipt(hosts), installed, "public output changed before commit marker");
      await writeExclusive(join(workspace, "commit-ready.json"), journalBytes(journal), 0o600);
      await testHook?.("commit-prepared");
      assertReceipt(await readPublicReceipt(hosts), installed, "public output changed before atomic commit");
      if (
        !(await readRegularFile(join(workspace, "commit-ready.json"), MAX_JOURNAL_BYTES)).equals(journalBytes(journal))
      )
        throw new Error("Prepared commit marker changed");
      await atomicRename(join(workspace, "commit-ready.json"), join(workspace, "committed.json"));
      await testHook?.("committed");
      await testHook?.("before-cleanup");
      await recover(workspace, repositoryRoot, registeredHosts, incremental);
      return { changed: true, hosts };
    } catch (error) {
      try {
        await recover(workspace, repositoryRoot, registeredHosts, incremental);
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "Publication failed; recovery refused unverified artifacts");
      }
      throw error;
    }
  } finally {
    database.close();
  }
}
