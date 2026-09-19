import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompletedHost, VettedHost } from "./contracts.ts";
import { digest, documentFilename, exactObject, formatDocument, parseDocument, sha256 } from "./document-format.ts";
import { EXTERNAL_BOUNDARY } from "./paths.ts";
import {
  assertNoSymlinkPath,
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
import { normalizeHost } from "./urls.ts";

const LOCK_SCHEMA = "CREATE TABLE owner(repository_root TEXT NOT NULL, format_version INTEGER NOT NULL)";
const EXTERNAL_NAMES = new Set(["lock.sqlite", "journal.json", "commit-ready.json", "committed.json", "transaction"]);
const TRANSACTION_NAMES = new Set(["new-host", "old-host", "new-list", "old-list"]);
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;

interface FileReceipt {
  sha256: string;
  size: number;
  mode: number;
}
interface DirectoryReceipt {
  mode: number;
  files: Array<FileReceipt & { name: string }>;
}
interface Journal {
  format_version: 1;
  repository_root: string;
  hostname: string;
  data_mode: number | null;
  documents_mode: number | null;
  old_host: DirectoryReceipt | null;
  new_host: DirectoryReceipt;
  old_list: FileReceipt | null;
  new_list: FileReceipt;
}

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

export interface PublicationResult {
  changed: boolean;
  hosts: VettedHost[];
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
}

async function prepareExternalRoot(repositoryRoot: string, externalRoot: string): Promise<string> {
  if (
    !isAbsolute(externalRoot) ||
    resolve(externalRoot) !== externalRoot ||
    externalRoot === EXTERNAL_BOUNDARY ||
    !contained(EXTERNAL_BOUNDARY, externalRoot)
  )
    throw new Error(`External root must be a normalized descendant of ${EXTERNAL_BOUNDARY}`);
  if (contained(repositoryRoot, externalRoot) || contained(externalRoot, repositoryRoot))
    throw new Error("External root and repository must not overlap");
  await requireDirectory(repositoryRoot);
  await assertNoSymlinkPath(externalRoot);
  await mkdir(externalRoot, { recursive: true, mode: 0o700 });
  await requireDirectory(externalRoot);
  const workspace = join(externalRoot, `host-publication-${sha256(repositoryRoot)}`);
  await assertNoSymlinkPath(workspace);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await requireDirectory(workspace);
  if ((await maybeLstat(workspace))!.dev !== (await maybeLstat(repositoryRoot))!.dev)
    throw new Error("Cross-device publication is forbidden");
  await knownEntries(workspace, EXTERNAL_NAMES);
  return workspace;
}

async function knownEntries(directory: string, allowed: ReadonlySet<string>): Promise<void> {
  if (!(await maybeLstat(directory))) return;
  await requireDirectory(directory);
  for (const name of await readdir(directory)) {
    if (!allowed.has(name)) throw new Error(`Unrecognized publication artifact: ${join(directory, name)}`);
    await assertNoSymlinkPath(join(directory, name));
  }
}

async function lockWorkspace(workspace: string, repositoryRoot: string): Promise<DatabaseSync> {
  const path = join(workspace, "lock.sqlite");
  const existing = await maybeLstat(path);
  if (existing) {
    const bytes = await readRegularFile(path, MAX_JOURNAL_BYTES);
    if (bytes.subarray(0, 16).toString() !== "SQLite format 3\u0000") throw new Error("Unrecognized publication lock");
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const schema = reader
        .prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all();
      const owners = reader.prepare("SELECT repository_root, format_version FROM owner").all();
      if (
        schema.length !== 1 ||
        schema[0]!.name !== "owner" ||
        schema[0]!.sql !== LOCK_SCHEMA ||
        owners.length !== 1 ||
        owners[0]!.repository_root !== repositoryRoot ||
        owners[0]!.format_version !== 1
      )
        throw new Error("Unrecognized publication lock ownership");
    } finally {
      reader.close();
    }
  } else {
    const file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await file.close();
    const initial = new DatabaseSync(path);
    try {
      initial.exec(LOCK_SCHEMA);
      initial.prepare("INSERT INTO owner VALUES (?, 1)").run(repositoryRoot);
    } finally {
      initial.close();
    }
    await syncDirectory(workspace);
  }
  await assertNoSymlinkPath(path);
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    database.close();
    throw new Error("Publication lock is held or unavailable", { cause: error });
  }
}

async function syncDirectory(path: string): Promise<void> {
  await requireDirectory(path);
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeExclusive(path: string, bytes: Buffer, mode: number): Promise<void> {
  await assertNoSymlinkPath(path);
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.chmod(mode);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}

async function atomicRename(source: string, destination: string): Promise<void> {
  await assertNoSymlinkPath(source);
  await assertNoSymlinkPath(destination);
  if (await maybeLstat(destination)) throw new Error(`Rename destination already exists: ${destination}`);
  if ((await maybeLstat(source))?.dev !== (await maybeLstat(dirname(destination)))?.dev)
    throw new Error("Cross-device rename is forbidden");
  // Rename errors, including EXDEV, propagate; copying would destroy transaction atomicity.
  await rename(source, destination);
  await syncDirectory(dirname(source));
  if (dirname(source) !== dirname(destination)) await syncDirectory(dirname(destination));
}

async function fileReceipt(path: string): Promise<FileReceipt | null> {
  const info = await maybeLstat(path);
  if (!info) return null;
  const bytes = await readRegularFile(path, MAX_JOURNAL_BYTES);
  return { sha256: sha256(bytes), size: bytes.length, mode: info.mode & 0o7777 };
}

async function directoryReceipt(path: string): Promise<DirectoryReceipt | null> {
  const info = await maybeLstat(path);
  if (!info) return null;
  await requireDirectory(path);
  const files: DirectoryReceipt["files"] = [];
  for (const name of (await readdir(path)).sort()) {
    if (!/^[a-f0-9]{64}\.md$/.test(name)) throw new Error(`Unrecognized document artifact: ${join(path, name)}`);
    const receipt = await fileReceipt(join(path, name));
    if (!receipt) throw new Error("Document disappeared while taking receipt");
    files.push({ name, ...receipt });
  }
  return { mode: info.mode & 0o7777, files };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertReceipt(actual: unknown, expected: unknown, label: string): void {
  if (!same(actual, expected)) throw new Error(`Owned receipt mismatch: ${label}`);
}

function validateMode(mode: unknown): void {
  if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777)
    throw new Error("Invalid receipt mode");
}

function validateFileReceipt(value: unknown, named = false): asserts value is FileReceipt {
  exactObject(value, [...(named ? ["name"] : []), "sha256", "size", "mode"], "file receipt");
  digest(value.sha256, "receipt");
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 1 || (value.size as number) > MAX_JOURNAL_BYTES)
    throw new Error("Invalid receipt size");
  validateMode(value.mode);
  if (named && (typeof value.name !== "string" || !/^[a-f0-9]{64}\.md$/.test(value.name)))
    throw new Error("Invalid receipt filename");
}

function validateDirectoryReceipt(value: unknown): asserts value is DirectoryReceipt {
  exactObject(value, ["mode", "files"], "directory receipt");
  validateMode(value.mode);
  if (!Array.isArray(value.files) || !value.files.length) throw new Error("Invalid receipt files");
  let previous = "";
  for (const item of value.files) {
    validateFileReceipt(item, true);
    const name = (item as FileReceipt & { name: string }).name;
    if (name <= previous || item.size > 1024 * 1024) throw new Error("Unsorted or oversized receipt file");
    previous = name;
  }
}

function journalBytes(journal: Journal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
}

function parseJournal(bytes: Buffer, repositoryRoot: string, registeredHosts: RegisteredHosts): Journal {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  exactObject(
    value,
    [
      "format_version",
      "repository_root",
      "hostname",
      "data_mode",
      "documents_mode",
      "old_host",
      "new_host",
      "old_list",
      "new_list",
    ],
    "publication journal",
  );
  if (
    value.format_version !== 1 ||
    value.repository_root !== repositoryRoot ||
    typeof value.hostname !== "string" ||
    normalizeHost(value.hostname) !== value.hostname ||
    !registeredHostSet(registeredHosts).has(value.hostname)
  )
    throw new Error("Publication journal owner mismatch");
  for (const key of ["data_mode", "documents_mode"] as const) if (value[key] !== null) validateMode(value[key]);
  if (value.data_mode === null && value.documents_mode !== null) throw new Error("Impossible journal parent state");
  if (value.old_host !== null) validateDirectoryReceipt(value.old_host);
  validateDirectoryReceipt(value.new_host);
  if (value.old_list !== null) validateFileReceipt(value.old_list);
  validateFileReceipt(value.new_list);
  const journal = value as unknown as Journal;
  if (!journalBytes(journal).equals(bytes)) throw new Error("Noncanonical publication journal");
  return journal;
}

function locations(workspace: string, journal: Journal) {
  const transaction = join(workspace, "transaction");
  return {
    transaction,
    host: join(journal.repository_root, "data/documents", journal.hostname),
    list: join(journal.repository_root, HOST_LIST_PATH),
    data: join(journal.repository_root, "data"),
    documents: join(journal.repository_root, "data/documents"),
    oldHost: join(transaction, "old-host"),
    newHost: join(transaction, "new-host"),
    oldList: join(transaction, "old-list"),
    newList: join(transaction, "new-list"),
  };
}

async function verifySubset(path: string, receipt: DirectoryReceipt | null, cleanupMode = false): Promise<void> {
  const actual = await directoryReceipt(path);
  if (!actual) return;
  if (!receipt || (actual.mode !== receipt.mode && !(cleanupMode && actual.mode === (receipt.mode | 0o700))))
    throw new Error(`Owned directory receipt mismatch: ${path}`);
  for (const file of actual.files)
    assertReceipt(
      file,
      receipt.files.find((item) => item.name === file.name),
      path,
    );
}

async function verifyArtifacts(
  workspace: string,
  journal: Journal,
  committed: boolean,
  cleanupPhase = false,
): Promise<void> {
  await knownEntries(workspace, EXTERNAL_NAMES);
  const paths = locations(workspace, journal);
  await knownEntries(paths.transaction, TRANSACTION_NAMES);
  const ready = join(workspace, "commit-ready.json");
  if (cleanupPhase && (await maybeLstat(ready))) {
    if (!(await readRegularFile(ready, MAX_JOURNAL_BYTES)).equals(journalBytes(journal)))
      throw new Error("Unverified prepared commit marker");
  }
  await verifySubset(paths.newHost, journal.new_host, true);
  await verifySubset(paths.oldHost, journal.old_host, committed);
  for (const [path, expected] of [
    [paths.newList, journal.new_list],
    [paths.oldList, journal.old_list],
  ] as const) {
    const actual = await fileReceipt(path);
    if (actual) assertReceipt(actual, expected, path);
  }
}

async function removeOwnedFile(path: string, receipt: FileReceipt): Promise<void> {
  assertReceipt(await fileReceipt(path), receipt, path);
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function removeOwnedDirectory(path: string, receipt: DirectoryReceipt | null): Promise<void> {
  if (!(await maybeLstat(path))) return;
  await verifySubset(path, receipt, true);
  // Backups with read-only modes need owner permissions only while their verified contents are removed.
  await chmod(path, receipt!.mode | 0o700);
  for (const name of await readdir(path)) {
    const owned = receipt!.files.find((file) => file.name === name)!;
    const { name: _, ...file } = owned;
    await removeOwnedFile(join(path, name), file);
  }
  await requireDirectory(path);
  await rmdir(path);
  await syncDirectory(dirname(path));
}

async function cleanup(workspace: string, journal: Journal, committed: boolean): Promise<void> {
  await verifyArtifacts(workspace, journal, committed, true);
  const paths = locations(workspace, journal);
  await removeOwnedDirectory(paths.oldHost, journal.old_host);
  await removeOwnedDirectory(paths.newHost, journal.new_host);
  for (const [path, receipt] of [
    [paths.oldList, journal.old_list],
    [paths.newList, journal.new_list],
  ] as const) {
    if (await maybeLstat(path)) await removeOwnedFile(path, receipt!);
  }
  if (await maybeLstat(paths.transaction)) {
    await rmdir(paths.transaction);
    await syncDirectory(workspace);
  }
  // The committed marker carries the full receipt so a crash during journal cleanup still rolls forward.
  for (const name of ["commit-ready.json", "journal.json", "committed.json"]) {
    const path = join(workspace, name);
    if (await maybeLstat(path)) {
      if (!(await readRegularFile(path, MAX_JOURNAL_BYTES)).equals(journalBytes(journal)))
        throw new Error("Journal changed before cleanup");
      await unlink(path);
      await syncDirectory(workspace);
    }
  }
}

async function recover(
  workspace: string,
  repositoryRoot: string,
  registeredHosts: RegisteredHosts,
  incremental = false,
): Promise<void> {
  await knownEntries(workspace, EXTERNAL_NAMES);
  const journalPath = join(workspace, "journal.json");
  const commitPath = join(workspace, "committed.json");
  const hasJournal = !!(await maybeLstat(journalPath));
  const committed = !!(await maybeLstat(commitPath));
  if (!hasJournal && !committed) {
    if ((await maybeLstat(join(workspace, "transaction"))) || (await maybeLstat(join(workspace, "commit-ready.json"))))
      throw new Error("Unrecognized transaction without an owned journal");
    return;
  }
  const bytes = await readRegularFile(committed ? commitPath : journalPath, MAX_JOURNAL_BYTES);
  const journal = parseJournal(bytes, repositoryRoot, registeredHosts);
  if (hasJournal && !(await readRegularFile(journalPath, MAX_JOURNAL_BYTES)).equals(bytes))
    throw new Error("Journal and commit marker disagree");
  const paths = locations(workspace, journal);
  await verifyArtifacts(workspace, journal, committed);
  if (committed) {
    assertReceipt(await directoryReceipt(paths.host), journal.new_host, paths.host);
    assertReceipt(await fileReceipt(paths.list), journal.new_list, paths.list);
  } else {
    const actions: Array<() => Promise<void>> = [];
    for (const [current, backup, stage, oldReceipt, newReceipt, readReceipt] of [
      [paths.host, paths.oldHost, paths.newHost, journal.old_host, journal.new_host, directoryReceipt],
      [paths.list, paths.oldList, paths.newList, journal.old_list, journal.new_list, fileReceipt],
    ] as const) {
      const saved = await readReceipt(backup);
      const installed = await readReceipt(current);
      if (saved) {
        assertReceipt(saved, oldReceipt, backup);
        if (installed) {
          assertReceipt(installed, newReceipt, current);
          if (await maybeLstat(stage)) throw new Error("Ambiguous duplicated publication stage");
          actions.push(() => atomicRename(current, stage));
        }
        actions.push(() => atomicRename(backup, current));
      } else if (oldReceipt) {
        assertReceipt(installed, oldReceipt, current);
      } else if (installed) {
        assertReceipt(installed, newReceipt, current);
        if (await maybeLstat(stage)) throw new Error("Ambiguous duplicated publication stage");
        actions.push(() => atomicRename(current, stage));
      }
    }
    // Validate both resources before changing either; unrecognized bytes are never discarded.
    for (const action of actions) await action();
    for (const [path, oldMode] of [
      [paths.documents, journal.documents_mode],
      [paths.data, journal.data_mode],
    ] as const) {
      if (oldMode === null && (await maybeLstat(path))) {
        await requireDirectory(path);
        if (((await maybeLstat(path))!.mode & 0o7777) !== 0o755 || (await readdir(path)).length)
          throw new Error("Unrecognized created publication parent");
        await rmdir(path);
        await syncDirectory(dirname(path));
      }
    }
  }
  await validatePublishedHosts({
    repositoryRoot,
    registeredHosts,
    allowAbsent: !committed,
    documentHostnames: incremental ? [journal.hostname] : undefined,
  });
  await cleanup(workspace, journal, committed);
}

async function publicReceipt(repositoryRoot: string, hosts: readonly VettedHost[]) {
  return {
    list: await fileReceipt(join(repositoryRoot, HOST_LIST_PATH)),
    dataMode: (await maybeLstat(join(repositoryRoot, "data")))?.mode ?? null,
    documentsMode: (await maybeLstat(join(repositoryRoot, "data/documents")))?.mode ?? null,
    hosts: await Promise.all(
      hosts.map(async (host) => ({
        hostname: host.hostname,
        receipt: await directoryReceipt(join(repositoryRoot, host.document_root)),
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
  if (completed.host.document_count !== completed.documents.length)
    throw new Error("Completed host document count mismatch");
  const host = structuredClone(completed.host);
  const output = completed.documents
    .map((doc) => {
      const bytes = formatDocument(doc);
      const parsed = parseDocument(bytes, { hostname: host.hostname, filename: documentFilename(doc.id) });
      return { name: documentFilename(parsed.id), bytes, document: parsed };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
  const validation = {
    repositoryRoot,
    registeredHosts,
    documentHostnames: incremental ? [host.hostname] : undefined,
  };
  const readPublicReceipt = (hosts: readonly VettedHost[]) =>
    publicReceipt(repositoryRoot, incremental ? hosts.filter((entry) => entry.hostname === host.hostname) : hosts);
  const workspace = await prepareExternalRoot(repositoryRoot, externalRoot);
  const database = await lockWorkspace(workspace, repositoryRoot);
  try {
    await testHook?.("locked");
    await recover(workspace, repositoryRoot, registeredHosts, incremental);
    const existing = await validatePublishedHosts({ ...validation, allowAbsent: true });
    const baseline = await readPublicReceipt(existing);
    const hosts = [...existing.filter((entry) => entry.hostname !== host.hostname), host].sort((a, b) =>
      a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0,
    );
    const list = formatHostList(hosts, registeredHosts);
    const oldHost = await directoryReceipt(join(repositoryRoot, host.document_root));
    const oldList = await fileReceipt(join(repositoryRoot, HOST_LIST_PATH));
    const journal: Journal = {
      format_version: 1,
      repository_root: repositoryRoot,
      hostname: host.hostname,
      data_mode: baseline.dataMode === null ? null : baseline.dataMode & 0o7777,
      documents_mode: baseline.documentsMode === null ? null : baseline.documentsMode & 0o7777,
      old_host: oldHost,
      new_host: {
        mode: oldHost?.mode ?? 0o755,
        files: output.map((item) => ({
          name: item.name,
          sha256: sha256(item.bytes),
          size: item.bytes.length,
          mode: oldHost?.files.find((file) => file.name === item.name)?.mode ?? 0o644,
        })),
      },
      old_list: oldList,
      new_list: { sha256: sha256(list), size: list.length, mode: oldList?.mode ?? 0o644 },
    };
    if (same(journal.old_host, journal.new_host) && same(oldList, journal.new_list)) {
      await verifyInputs();
      await validatePublishedHosts(validation);
      assertReceipt(await readPublicReceipt(existing), baseline, "public output changed during input verification");
      return { changed: false, hosts };
    }
    if (oldHost && (oldHost.mode & 0o222) === 0) throw new Error("Host directory mode forbids writable publication");
    const paths = locations(workspace, journal);
    for (const parent of [join(repositoryRoot, "data"), join(repositoryRoot, "data/documents")]) {
      await assertNoSymlinkPath(parent);
      const info = await maybeLstat(parent);
      if (info && info.dev !== (await maybeLstat(workspace))!.dev)
        throw new Error("Cross-device publication is forbidden");
    }
    await writeExclusive(join(workspace, "journal.json"), journalBytes(journal), 0o600);
    try {
      await testHook?.("journal-written");
      await mkdir(paths.transaction, { mode: 0o700 });
      await syncDirectory(workspace);
      await mkdir(paths.newHost, { mode: journal.new_host.mode | 0o700 });
      await chmod(paths.newHost, journal.new_host.mode | 0o700);
      for (const item of output)
        await writeExclusive(
          join(paths.newHost, item.name),
          item.bytes,
          journal.new_host.files.find((file) => file.name === item.name)!.mode,
        );
      await chmod(paths.newHost, journal.new_host.mode);
      await syncDirectory(paths.newHost);
      await writeExclusive(paths.newList, list, journal.new_list.mode);
      assertReceipt(await directoryReceipt(paths.newHost), journal.new_host, "prepared host");
      assertReceipt(await fileReceipt(paths.newList), journal.new_list, "prepared host list");
      for (const item of output) {
        if (!(await readRegularFile(join(paths.newHost, item.name))).equals(item.bytes))
          throw new Error("Prepared document bytes differ");
      }
      if (!(await readRegularFile(paths.newList, MAX_JOURNAL_BYTES)).equals(list))
        throw new Error("Prepared host list bytes differ");
      await testHook?.("prepared");
      await verifyInputs();
      await testHook?.("inputs-verified");
      await validatePublishedHosts({ ...validation, allowAbsent: true });
      assertReceipt(await readPublicReceipt(existing), baseline, "public output changed before installation");
      assertReceipt(
        await directoryReceipt(paths.newHost),
        journal.new_host,
        "prepared host changed before installation",
      );
      assertReceipt(await fileReceipt(paths.newList), journal.new_list, "prepared list changed before installation");
      await knownEntries(workspace, EXTERNAL_NAMES);
      await knownEntries(paths.transaction, TRANSACTION_NAMES);
      if (!(await readRegularFile(join(workspace, "journal.json"), MAX_JOURNAL_BYTES)).equals(journalBytes(journal)))
        throw new Error("Journal changed before installation");
      await ensureParent(paths.data);
      await ensureParent(paths.documents);
      await testHook?.("parents-created");
      if (oldHost) await atomicRename(paths.host, paths.oldHost);
      await testHook?.("old-host-moved");
      await atomicRename(paths.newHost, paths.host);
      await testHook?.("new-host-installed");
      if (oldList) await atomicRename(paths.list, paths.oldList);
      await testHook?.("old-list-moved");
      await atomicRename(paths.newList, paths.list);
      await testHook?.("new-list-installed");
      await validatePublishedHosts(validation);
      assertReceipt(await directoryReceipt(paths.host), journal.new_host, "installed host");
      assertReceipt(await fileReceipt(paths.list), journal.new_list, "installed list");
      const installed = await readPublicReceipt(hosts);
      assertReceipt(installed.dataMode, baseline.dataMode ?? 0o40755, "data directory mode changed");
      assertReceipt(installed.documentsMode, baseline.documentsMode ?? 0o40755, "documents directory mode changed");
      for (const previous of baseline.hosts) {
        if (previous.hostname !== host.hostname)
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
