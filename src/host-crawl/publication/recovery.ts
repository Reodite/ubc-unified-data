import { chmod, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  assertNoSymlinkPath,
  maybeLstat,
  readRegularFile,
  requireDirectory,
  validatePublishedHosts,
  type RegisteredHosts,
} from "../public-validation.ts";
import {
  assertReceipt,
  atomicRename,
  contained,
  directoryReceipt,
  fileReceipt,
  knownEntries,
  knownWorkspaceEntries,
  MAX_JOURNAL_BYTES,
  syncDirectory,
} from "./files.ts";
import {
  journalBytes,
  locations,
  parseJournal,
  type DirectoryReceipt,
  type FileReceipt,
  type Journal,
} from "./journal.ts";

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
  await knownWorkspaceEntries(workspace);
  const paths = locations(workspace, journal);
  await knownEntries(paths.transaction, paths.names);
  const ready = join(workspace, "commit-ready.json");
  if (cleanupPhase && (await maybeLstat(ready))) {
    if (!(await readRegularFile(ready, MAX_JOURNAL_BYTES)).equals(journalBytes(journal)))
      throw new Error("Unverified prepared commit marker");
  }
  for (const directory of paths.directories) {
    await verifySubset(directory.stage, directory.new, true);
    await verifySubset(directory.backup, directory.old, committed);
  }
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
  for (const directory of paths.directories) {
    await removeOwnedDirectory(directory.backup, directory.old);
    await removeOwnedDirectory(directory.stage, directory.new);
  }
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

export async function recover(
  workspace: string,
  repositoryRoot: string,
  registeredHosts: RegisteredHosts,
  incremental = false,
): Promise<void> {
  await knownWorkspaceEntries(workspace);
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
  await verifyParents(workspace, journal, committed);
  if (committed) {
    for (const directory of paths.directories)
      assertReceipt(await directoryReceipt(directory.current), directory.new, directory.current);
    assertReceipt(await fileReceipt(paths.list), journal.new_list, paths.list);
  } else {
    const actions: Array<() => Promise<void>> = [];
    const resources = [
      ...paths.directories.map(
        (directory) =>
          [
            directory.current,
            directory.backup,
            directory.stage,
            directory.old,
            directory.new,
            directoryReceipt,
          ] as const,
      ),
      [paths.list, paths.oldList, paths.newList, journal.old_list, journal.new_list, fileReceipt] as const,
    ];
    for (const [current, backup, stage, oldReceipt, newReceipt, readReceipt] of resources) {
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
    // Validate every directory, parent and index receipt before changing any public resource.
    for (const action of actions) await action();
    for (const parent of [...paths.parents].reverse()) {
      if (parent.mode === null && (await maybeLstat(parent.current))) {
        await requireDirectory(parent.current);
        if (((await maybeLstat(parent.current))!.mode & 0o7777) !== 0o755 || (await readdir(parent.current)).length)
          throw new Error("Unrecognized created publication parent");
        await rmdir(parent.current);
        await syncDirectory(dirname(parent.current));
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

export async function verifyParents(workspace: string, journal: Journal, committed: boolean): Promise<void> {
  const paths = locations(workspace, journal);
  const device = (await maybeLstat(workspace))!.dev;
  for (const parent of paths.parents) {
    await assertNoSymlinkPath(parent.current);
    const info = await maybeLstat(parent.current);
    if (!info) {
      if (
        parent.mode !== null ||
        (committed && paths.directories.some((item) => item.new && contained(parent.current, item.current)))
      )
        throw new Error(`Missing publication parent: ${parent.current}`);
      continue;
    }
    await requireDirectory(parent.current);
    if (info.dev !== device) throw new Error("Cross-device publication is forbidden");
    assertReceipt(info.mode & 0o7777, parent.mode ?? 0o755, parent.current);
    if (parent.mode === null && !committed) {
      const allowed = new Set([
        ...paths.parents
          .filter((item) => dirname(item.current) === parent.current)
          .map((item) => relative(parent.current, item.current)),
        ...paths.directories
          .filter((item) => dirname(item.current) === parent.current)
          .map((item) => relative(parent.current, item.current)),
        ...(dirname(paths.list) === parent.current ? [relative(parent.current, paths.list)] : []),
      ]);
      await knownEntries(parent.current, allowed);
    }
  }
}
