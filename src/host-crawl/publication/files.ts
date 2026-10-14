import { constants } from "node:fs";
import { mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../document-format.ts";
import { EXTERNAL_BOUNDARY } from "../paths.ts";
import { assertNoSymlinkPath, maybeLstat, readRegularFile, requireDirectory } from "../public-validation.ts";
import type { DirectoryReceipt, FileReceipt } from "./journal.ts";

const LOCK_SCHEMA = "CREATE TABLE owner(repository_root TEXT NOT NULL, format_version INTEGER NOT NULL)";
const EXTERNAL_NAMES = new Set(["lock.sqlite", "journal.json", "commit-ready.json", "committed.json", "transaction"]);
export const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;

export function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
}

export async function prepareExternalRoot(repositoryRoot: string, externalRoot: string): Promise<string> {
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
  await knownWorkspaceEntries(workspace);
  return workspace;
}

export async function knownEntries(directory: string, allowed: ReadonlySet<string>): Promise<void> {
  if (!(await maybeLstat(directory))) return;
  await requireDirectory(directory);
  for (const name of await readdir(directory)) {
    if (!allowed.has(name)) throw new Error(`Unrecognized publication artifact: ${join(directory, name)}`);
    await assertNoSymlinkPath(join(directory, name));
  }
}

export async function knownWorkspaceEntries(workspace: string): Promise<void> {
  await knownEntries(workspace, EXTERNAL_NAMES);
}

export async function lockWorkspace(workspace: string, repositoryRoot: string): Promise<DatabaseSync> {
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

export async function syncDirectory(path: string): Promise<void> {
  await requireDirectory(path);
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeExclusive(path: string, bytes: Buffer, mode: number): Promise<void> {
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

export async function atomicRename(source: string, destination: string): Promise<void> {
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

export async function fileReceipt(path: string): Promise<FileReceipt | null> {
  const info = await maybeLstat(path);
  if (!info) return null;
  const bytes = await readRegularFile(path, MAX_JOURNAL_BYTES);
  return { sha256: sha256(bytes), size: bytes.length, mode: info.mode & 0o7777 };
}

export async function directoryReceipt(path: string): Promise<DirectoryReceipt | null> {
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

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function assertReceipt(actual: unknown, expected: unknown, label: string): void {
  if (!same(actual, expected)) throw new Error(`Owned receipt mismatch: ${label}`);
}
