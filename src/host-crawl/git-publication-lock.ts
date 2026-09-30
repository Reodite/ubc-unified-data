import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exactObject, sha256 } from "./document-format.ts";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { readRegularFile } from "./public-validation.ts";
import { normalizeHost } from "./urls.ts";

const SCHEMA = "CREATE TABLE owner(repository_identity TEXT NOT NULL, version INTEGER NOT NULL)";
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

interface PublicationOwner {
  batch_directory: string;
  hostname: string;
  token: string;
}
interface PublicationMarker extends PublicationOwner {
  version: 1;
  repository_identity: string;
}

function privatePath(path: string, repositoryRoot: string): string {
  path = assertExternalPath(path, repositoryRoot);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Git publication file must be regular and unaliased");
    chmodSync(path, 0o600);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  return path;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Persist owner-only receipts before Git effects, including across a process crash. */
export async function saveGitPublication(path: string, value: unknown, repositoryRoot: string): Promise<void> {
  privatePath(path, repositoryRoot);
  const temporary = privatePath(`${path}.${randomUUID()}.new`, repositoryRoot);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  privatePath(path, repositoryRoot);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

/**
 * Serialize the whole Git publication using the physical Git common directory identity.
 * Contention fails immediately: a synchronous SQLite wait would block an awaiting in-process owner.
 * This lock is distinct from the public-output transaction lock in publication.ts.
 * Cooperating publishers must use this protocol and the same configured external root.
 * Older frozen producers and publishers with a different UBC_TMP_ROOT do not share this fence.
 */
export function lockGitPublication(repositoryRoot: string, commonDirectory: string) {
  const repositoryIdentity = realpathSync(commonDirectory);
  if (!lstatSync(repositoryIdentity).isDirectory()) throw new Error("Invalid Git repository identity");
  const workspace = assertExternalPath(
    join(DEFAULT_EXTERNAL_ROOT, `git-publication-${sha256(repositoryIdentity)}`),
    repositoryRoot,
  );
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  chmodSync(workspace, 0o700);
  const path = join(workspace, "lock.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) privatePath(`${path}${suffix}`, repositoryRoot);
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    const schema = database.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (!schema.length) {
      database.exec(SCHEMA);
      database.prepare("INSERT INTO owner VALUES (?, 1)").run(repositoryIdentity);
    } else if (schema.length !== 1 || schema[0]!.name !== "owner" || schema[0]!.sql !== SCHEMA) {
      throw new Error("Unrecognized Git publication lock schema");
    }
    const owners = database.prepare("SELECT repository_identity, version FROM owner").all();
    if (owners.length !== 1 || owners[0]!.repository_identity !== repositoryIdentity || owners[0]!.version !== 1)
      throw new Error("Git publication lock belongs to another repository");
    database.exec("COMMIT; BEGIN IMMEDIATE");
  } catch (error) {
    database.close();
    throw new Error("Git publication lock is held or unavailable", { cause: error });
  }

  const markerPath = join(workspace, "active-publication.json");
  let owner: PublicationMarker | undefined;
  let legacyPath: string | undefined;
  async function read(path: string): Promise<unknown | undefined> {
    privatePath(path, repositoryRoot);
    try {
      return JSON.parse((await readRegularFile(path, 64 * 1024)).toString("utf8"));
    } catch (error) {
      if (!absent(error)) throw error;
      return undefined;
    }
  }
  function assertOwner(value: unknown, expected: PublicationMarker): void {
    exactObject(
      value,
      ["version", "repository_identity", "batch_directory", "hostname", "token"],
      "Git publication marker",
    );
    for (const key of Object.keys(expected) as Array<keyof PublicationMarker>)
      if (value[key] !== expected[key]) throw new Error("Another batch or claim has an unfinished Git publication");
  }
  async function checkLegacy(path: string, hostname: string): Promise<boolean> {
    const legacy = await read(path);
    if (legacy === undefined) return false;
    // Unknown fields can carry an owner pause; never replace them or a different hostname's fence.
    exactObject(legacy, ["hostname"], "legacy publication marker");
    if (legacy.hostname !== hostname) throw new Error("Another hostname has an unfinished legacy publication");
    return true;
  }
  return {
    async claim(request: PublicationOwner, requireExisting = false): Promise<void> {
      const batch = assertExternalPath(request.batch_directory, repositoryRoot);
      if (batch !== request.batch_directory || normalizeHost(request.hostname) !== request.hostname || !request.token)
        throw new Error("Invalid Git publication owner");
      const expected: PublicationMarker = { version: 1, repository_identity: repositoryIdentity, ...request };
      const previous = await read(markerPath);
      if (previous !== undefined) assertOwner(previous, expected);
      const legacy = join(batch, "state", "active-publication.json");
      const hasLegacy = await checkLegacy(legacy, request.hostname);
      if (requireExisting && previous === undefined && !hasLegacy)
        throw new Error("Published claim has no unfinished publication fence");
      if (previous === undefined) await saveGitPublication(markerPath, expected, repositoryRoot);
      owner = expected;
      legacyPath = legacy;
    },
    async finish(): Promise<void> {
      if (!owner || !legacyPath) throw new Error("Git publication fence is not owned");
      assertOwner(await read(markerPath), owner);
      if (await checkLegacy(legacyPath, owner.hostname)) {
        await unlink(legacyPath);
        await syncDirectory(dirname(legacyPath));
      }
      await unlink(markerPath);
      await syncDirectory(workspace);
    },
    close(): void {
      database.close();
    },
  };
}
