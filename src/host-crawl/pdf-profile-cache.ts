import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, readlink, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import type { PdfProfile, PdfResource } from "./pdf-profile.ts";
import { assertNoSymlinkPath } from "./public-validation.ts";

export { loadCachedPdfProfile } from "./pdf-profile.ts";

const SCHEMA = "host-pdf-profile-cache-v1";
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const LOCK_WAIT_MS = 300_000;
const LOCK_FILE = "creation.sqlite";
const LOCK_FILES = new Set([LOCK_FILE, `${LOCK_FILE}-journal`, `${LOCK_FILE}-wal`, `${LOCK_FILE}-shm`]);

// Reads can update atime; identity guards deliberately exclude it, and never substitute for content hashing.
const IDENTITY_FIELDS = [
  "dev",
  "ino",
  "mode",
  "nlink",
  "uid",
  "gid",
  "rdev",
  "size",
  "blksize",
  "blocks",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs",
] as const;
type Signature = Record<(typeof IDENTITY_FIELDS)[number], string>;
interface Identity {
  path: string;
  lstat: Signature | null;
  stat: Signature | null;
  resolvedPath: string | null;
  target: string | null;
  entries: string[] | null;
}
interface CachedProfile {
  schema: typeof SCHEMA;
  profile: PdfProfile;
  identities: Identity[];
}
type Capture = (workspace: string, observe: (path: string) => Promise<() => Promise<void>>) => Promise<PdfProfile>;

function signature(info: BigIntStats): Signature {
  return Object.fromEntries(IDENTITY_FIELDS.map((key) => [key, info[key].toString()])) as Signature;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function missing(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

function changed(path: string): Error {
  return new Error(`Cached PDF dependency identity changed: ${path}`);
}

async function identity(path: string): Promise<Identity> {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw new Error("Invalid PDF resource path");
  const before = await lstat(path, { bigint: true }).catch(missing);
  const result: Identity = {
    path,
    lstat: null,
    stat: null,
    resolvedPath: null,
    target: null,
    entries: null,
  };
  if (before) {
    if (!before.isFile() && !before.isDirectory() && !before.isSymbolicLink()) throw changed(path);
    const followed = await stat(path, { bigint: true }).catch(missing);
    result.lstat = signature(before);
    result.stat = followed ? signature(followed) : null;
    result.resolvedPath = await realpath(path).catch(missing);
    if (before.isSymbolicLink()) result.target = await readlink(path);
    if (before.isDirectory()) result.entries = (await readdir(path)).sort();
    const followedAfter = await stat(path, { bigint: true }).catch(missing);
    if (!equal(result.stat, followedAfter ? signature(followedAfter) : null)) throw changed(path);
  }
  const after = await lstat(path, { bigint: true }).catch(missing);
  if (!equal(result.lstat, after ? signature(after) : null)) throw changed(path);
  return result;
}

function matchesResource(resource: PdfResource, value: Identity): boolean {
  if (resource.path !== value.path) return false;
  if (resource.kind === "missing") return value.lstat === null && value.stat === null;
  if (!value.lstat || resource.resolvedPath !== value.resolvedPath) return false;
  const kind = Number(BigInt(value.lstat.mode) & BigInt(constants.S_IFMT));
  switch (resource.kind) {
    case "file":
      return kind === constants.S_IFREG && value.stat !== null && value.stat.size === String(resource.bytes);
    case "directory":
      return kind === constants.S_IFDIR && equal(resource.entries, value.entries);
    case "symlink":
      return kind === constants.S_IFLNK && resource.target === value.target;
  }
}

async function verifyIdentities(cached: CachedProfile): Promise<void> {
  const resources = cached.profile.manifest.resources;
  if (
    !Array.isArray(resources) ||
    !resources.length ||
    !Array.isArray(cached.identities) ||
    resources.length !== cached.identities.length
  )
    throw new Error("Incomplete cached PDF dependency identities");
  const seen = new Set<string>();
  for (const [index, resource] of resources.entries()) {
    const expected = cached.identities[index]!;
    if (seen.has(resource.path) || !matchesResource(resource, expected))
      throw new Error("Incomplete cached PDF dependency identities");
    seen.add(resource.path);
    if (!equal(expected, await identity(resource.path))) throw changed(resource.path);
  }
}

async function cacheDirectory(path: string): Promise<void> {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
    throw new Error("PDF cache must be a normalized absolute external directory");
  const part = relative(DEFAULT_EXTERNAL_ROOT, path);
  if (!part || part === ".." || part.startsWith("../") || isAbsolute(part))
    throw new Error("PDF cache is outside the authorized external boundary");
  assertExternalPath(path);
  await assertNoSymlinkPath(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(path);
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || (info.mode & 0o077n) !== 0n || info.uid !== BigInt(process.getuid!()))
    throw new Error("PDF cache requires a private owned directory");
}

async function checkLockFile(path: string): Promise<void> {
  await assertNoSymlinkPath(path);
  const info = await lstat(path, { bigint: true }).catch(missing);
  if (
    info &&
    (!info.isFile() || info.nlink !== 1n || (info.mode & 0o077n) !== 0n || info.uid !== BigInt(process.getuid!()))
  )
    throw new Error("PDF cache lock must be a private regular unaliased file");
}

async function acquireLock(directory: string): Promise<DatabaseSync> {
  const path = join(directory, LOCK_FILE);
  for (const name of LOCK_FILES) await checkLockFile(join(directory, name));
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  await file?.close();
  await checkLockFile(path);
  const database = new DatabaseSync(path);
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    database.exec("PRAGMA busy_timeout=0");
    for (;;) {
      try {
        database.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if ((code !== 5 && code !== 6) || Date.now() >= deadline) throw error;
        // Do not block the event loop: another caller in this process may own the SQLite transaction.
        await delay(25);
      }
    }
    database.exec(
      "CREATE TABLE IF NOT EXISTS profile_cache (id INTEGER PRIMARY KEY CHECK (id = 1), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL)",
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function readCache(path: string, expectedHash: string, expectedBytes: number): Promise<Buffer> {
  await assertNoSymlinkPath(path);
  const beforePath = await lstat(path, { bigint: true });
  const safe = (info: BigIntStats) =>
    info.isFile() &&
    info.nlink === 1n &&
    (info.mode & 0o377n) === 0n &&
    info.uid === BigInt(process.getuid!()) &&
    info.size === BigInt(expectedBytes);
  if (!safe(beforePath)) throw new Error("PDF cache payload is not an immutable private regular file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!safe(before) || !equal(signature(beforePath), signature(before))) throw new Error("PDF cache payload changed");
    const bytes = await file.readFile();
    if (
      bytes.length !== expectedBytes ||
      !equal(signature(before), signature(await file.stat({ bigint: true }))) ||
      !equal(signature(before), signature(await lstat(path, { bigint: true }))) ||
      createHash("sha256").update(bytes).digest("hex") !== expectedHash
    )
      throw new Error("PDF cache payload hash or identity changed");
    return bytes;
  } finally {
    await file.close();
  }
}

async function writeImmutable(directory: string, path: string, bytes: Buffer): Promise<void> {
  const temporary = join(directory, `.cache-${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.chmod(0o400);
    await file.sync();
  } finally {
    await file.close();
  }
  // Hard-link publication is atomic and cannot replace an existing batch payload.
  await link(temporary, path);
  await unlink(temporary);
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Internal cache transport; only the profile module authorizes the validated result for extraction. */
export async function readOrCapturePdfProfileCache(directory: string, capture: Capture): Promise<PdfProfile> {
  await cacheDirectory(directory);
  const database = await acquireLock(directory);
  try {
    const rows = database.prepare("SELECT id, sha256, bytes FROM profile_cache").all();
    let hash: string;
    let size: number;
    if (rows.length) {
      const row = rows[0]!;
      if (
        rows.length !== 1 ||
        row.id !== 1 ||
        typeof row.sha256 !== "string" ||
        !/^[a-f\d]{64}$/.test(row.sha256) ||
        typeof row.bytes !== "number" ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 1 ||
        row.bytes > MAX_CACHE_BYTES
      )
        throw new Error("Invalid PDF cache receipt");
      hash = row.sha256;
      size = row.bytes;
    } else {
      if ((await readdir(directory)).some((name) => !LOCK_FILES.has(name)))
        throw new Error("Incomplete PDF batch cache; use a new batch directory, never recapture in place");
      const identities = new Map<string, Identity>();
      const profile = await capture(join(directory, "capture"), async (path) => {
        const before = await identity(path);
        return async () => {
          if (!equal(before, await identity(path))) throw changed(path);
          identities.set(path, before);
        };
      });
      const cached: CachedProfile = {
        schema: SCHEMA,
        profile,
        identities: profile.manifest.resources.map((resource) => {
          const value = identities.get(resource.path);
          if (!value) throw new Error("Missing capture-time PDF identity");
          return value;
        }),
      };
      await verifyIdentities(cached);
      const bytes = Buffer.from(`${JSON.stringify(cached)}\n`);
      if (bytes.length > MAX_CACHE_BYTES) throw new Error("PDF cache payload exceeds its byte limit");
      hash = createHash("sha256").update(bytes).digest("hex");
      size = bytes.length;
      await writeImmutable(directory, join(directory, `${hash}.json`), bytes);
      database.prepare("INSERT INTO profile_cache (id, sha256, bytes) VALUES (1, ?, ?)").run(hash, size);
    }
    const cached = JSON.parse(
      (await readCache(join(directory, `${hash}.json`), hash, size)).toString("utf8"),
    ) as CachedProfile;
    if (
      cached.schema !== SCHEMA ||
      cached.profile?.manifest?.platform !== process.platform ||
      cached.profile.manifest.architecture !== process.arch
    )
      throw new Error("Incompatible PDF batch cache");
    await verifyIdentities(cached);
    database.exec("COMMIT");
    return cached.profile;
  } finally {
    // Closing releases the transaction even on errors or process death; no stale PID lock can block the batch.
    database.close();
  }
}
