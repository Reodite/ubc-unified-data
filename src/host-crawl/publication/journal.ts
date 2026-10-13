import { dirname, join } from "node:path";
import { DOCUMENT_CATEGORIES as CATEGORIES } from "../categories.ts";
import { digest, exactObject } from "../document-format.ts";
import { HOST_LIST_PATH, registeredHostSet, type RegisteredHosts } from "../public-validation.ts";
import { normalizeHost } from "../urls.ts";
import { MAX_JOURNAL_BYTES, same } from "./files.ts";

export interface FileReceipt {
  sha256: string;
  size: number;
  mode: number;
}
export interface DirectoryReceipt {
  mode: number;
  files: Array<FileReceipt & { name: string }>;
}
export interface LegacyJournal {
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

export interface OwnedDirectory {
  path: string;
  old: DirectoryReceipt | null;
  new: DirectoryReceipt | null;
}
export interface MultiDirectoryJournal {
  format_version: 2;
  repository_root: string;
  hostname: string;
  parents: Array<{ path: string; mode: number | null }>;
  directories: OwnedDirectory[];
  old_list: FileReceipt | null;
  new_list: FileReceipt;
}
export type Journal = LegacyJournal | MultiDirectoryJournal;

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

export function journalBytes(journal: Journal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
}

function parseLegacyJournal(bytes: Buffer, repositoryRoot: string, registeredHosts: RegisteredHosts): LegacyJournal {
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
  const journal = value as unknown as LegacyJournal;
  if (!journalBytes(journal).equals(bytes)) throw new Error("Noncanonical publication journal");
  return journal;
}

export function parentPaths(directories: readonly { path: string }[]): string[] {
  return ["data", "data/documents", ...new Set(directories.map((item) => dirname(item.path)))]
    .filter((path, index, all) => all.indexOf(path) === index)
    .sort();
}

export function parseJournal(bytes: Buffer, repositoryRoot: string, registeredHosts: RegisteredHosts): Journal {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  if (value !== null && typeof value === "object" && "format_version" in value && value.format_version === 1)
    return parseLegacyJournal(bytes, repositoryRoot, registeredHosts);
  exactObject(
    value,
    ["format_version", "repository_root", "hostname", "parents", "directories", "old_list", "new_list"],
    "publication journal",
  );
  if (
    value.format_version !== 2 ||
    value.repository_root !== repositoryRoot ||
    typeof value.hostname !== "string" ||
    normalizeHost(value.hostname) !== value.hostname ||
    !registeredHostSet(registeredHosts).has(value.hostname)
  )
    throw new Error("Publication journal owner mismatch");
  if (
    !Array.isArray(value.directories) ||
    !value.directories.length ||
    value.directories.length > CATEGORIES.length + 1
  )
    throw new Error("Invalid owned directory census");
  const flat = `data/documents/${value.hostname}`;
  const allowed = new Set([flat, ...CATEGORIES.map((category) => `data/documents/${category}/${value.hostname}`)]);
  let previous = "";
  for (const item of value.directories) {
    exactObject(item, ["path", "old", "new"], "owned directory");
    if (
      typeof item.path !== "string" ||
      !allowed.has(item.path) ||
      item.path <= previous ||
      (item.old === null && item.new === null)
    )
      throw new Error("Invalid owned directory path or receipts");
    previous = item.path;
    if (item.old !== null) validateDirectoryReceipt(item.old);
    if (item.new !== null) validateDirectoryReceipt(item.new);
  }
  const directories = value.directories as OwnedDirectory[];
  for (const side of ["old", "new"] as const) {
    const populated = directories.filter((item) => item[side] !== null);
    if (populated.length > 1 && populated.some((item) => item.path === flat))
      throw new Error("Mixed legacy and category ownership");
  }
  if (!Array.isArray(value.parents)) throw new Error("Invalid publication parents");
  for (const parent of value.parents) {
    exactObject(parent, ["path", "mode"], "publication parent");
    if (parent.mode !== null) validateMode(parent.mode);
  }
  const parents = value.parents as MultiDirectoryJournal["parents"];
  if (
    !same(
      parents.map((item) => item.path),
      parentPaths(directories),
    )
  )
    throw new Error("Invalid publication parent paths");
  for (const parent of parents) {
    const ancestor = parents.find((item) => item.path === dirname(parent.path));
    if (parent.mode !== null && ancestor?.mode === null) throw new Error("Impossible journal parent state");
  }
  for (const item of directories)
    if (item.old !== null && parents.find((parent) => parent.path === dirname(item.path))!.mode === null)
      throw new Error("Missing owned directory parent");
  if (value.old_list !== null) validateFileReceipt(value.old_list);
  validateFileReceipt(value.new_list);
  const journal = value as unknown as MultiDirectoryJournal;
  if (!journalBytes(journal).equals(bytes)) throw new Error("Noncanonical publication journal");
  return journal;
}

function ownedDirectories(journal: Journal): OwnedDirectory[] {
  return journal.format_version === 2
    ? journal.directories
    : [
        {
          path: `data/documents/${journal.hostname}`,
          old: journal.old_host,
          new: journal.new_host,
        },
      ];
}

function ownedParents(journal: Journal): MultiDirectoryJournal["parents"] {
  return journal.format_version === 2
    ? journal.parents
    : [
        { path: "data", mode: journal.data_mode },
        { path: "data/documents", mode: journal.documents_mode },
      ];
}

export function locations(workspace: string, journal: Journal) {
  const transaction = join(workspace, "transaction");
  const directories = ownedDirectories(journal).map((item, index) => ({
    ...item,
    current: join(journal.repository_root, item.path),
    backup: join(transaction, journal.format_version === 1 ? "old-host" : `old-host-${index}`),
    stage: join(transaction, journal.format_version === 1 ? "new-host" : `new-host-${index}`),
  }));
  return {
    transaction,
    directories,
    parents: ownedParents(journal).map((item) => ({ ...item, current: join(journal.repository_root, item.path) })),
    list: join(journal.repository_root, HOST_LIST_PATH),
    oldList: join(transaction, "old-list"),
    newList: join(transaction, "new-list"),
    names: new Set([
      "old-list",
      "new-list",
      ...directories.flatMap((_, index) =>
        journal.format_version === 1 ? ["old-host", "new-host"] : [`old-host-${index}`, `new-host-${index}`],
      ),
    ]),
  };
}
