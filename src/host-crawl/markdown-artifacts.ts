import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import type { ProducerContext } from "./contracts.ts";
import { inspectMarkdownElf, type MarkdownElf } from "./markdown-elf.ts";
import {
  createMarkdownGuardPolicy,
  createMarkdownProfile,
  MARKDOWN_ARTIFACT_LIMITS,
  MARKDOWN_RUNTIME_CONTRACT,
  type MarkdownArtifact,
  type MarkdownExternalSelection,
  type MarkdownPackage,
  type MarkdownProfileEvidence,
} from "./markdown-profile.ts";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { assertSameProducer, captureProducer } from "./provenance.ts";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(MODULE_DIRECTORY, "../..");
const ARTIFACT_PARENT = join(DEFAULT_EXTERNAL_ROOT, "markdown-artifacts");
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const HASH = /^[0-9a-f]{64}$/;
const PORTABLE_COMPONENT = /^[A-Za-z0-9._@+-]+$/;
const PACKAGE_FIELDS_FORBIDDEN = [
  "imports",
  "optionalDependencies",
  "dependenciesMeta",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
  "bundleDependencies",
] as const;
const SOURCE_FILES = [
  "markdown-bootstrap.mjs",
  "markdown-contract.mjs",
  "markdown-inspection.mjs",
  "markdown-protocol.mjs",
  "markdown-worker.mjs",
] as const;
const APP_PACKAGE_BYTES = Buffer.from(
  '{"name":"ubc-markdown-runtime","version":"1.0.0","type":"module","dependencies":{"markdown-it":"15.0.2"}}',
  "utf8",
);

const PACKAGE_RECIPES = Object.freeze({
  "markdown-it": Object.freeze({
    version: "15.0.2",
    type: "commonjs" as const,
    dependencies: Object.freeze({
      argparse: "^3.0.0",
      entities: "^8.0.0",
      "linkify-it": "^6.0.0",
      mdurl: "^2.1.0",
      "punycode.js": "^2.3.1",
      "uc.micro": "^3.0.0",
    }),
  }),
  argparse: Object.freeze({ version: "3.0.2", type: "commonjs" as const, dependencies: Object.freeze({}) }),
  entities: Object.freeze({ version: "8.1.0", type: "module" as const, dependencies: Object.freeze({}) }),
  "linkify-it": Object.freeze({
    version: "6.1.0",
    type: "commonjs" as const,
    dependencies: Object.freeze({ "uc.micro": "^3.0.0" }),
  }),
  mdurl: Object.freeze({ version: "2.1.0", type: "commonjs" as const, dependencies: Object.freeze({}) }),
  "punycode.js": Object.freeze({ version: "2.3.1", type: "commonjs" as const, dependencies: Object.freeze({}) }),
  "uc.micro": Object.freeze({ version: "3.0.0", type: "commonjs" as const, dependencies: Object.freeze({}) }),
});

type PackageName = keyof typeof PACKAGE_RECIPES;

type Stamp = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  gid: bigint;
  rdev: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type PathFact = Readonly<{
  path: string;
  stamp: Stamp;
  kind: "directory" | "file" | "symlink" | "character";
  target: string | null;
}>;

type RetainedDirectory = {
  path: string;
  handle: FileHandle;
  stamp: Stamp;
  ancestors: readonly PathFact[];
};

type SourceFileBinding = Readonly<{
  path: string;
  parent: RetainedDirectory;
  name: string;
  stamp: Stamp;
  bytes: number;
  sha256: string;
}>;

type PackageFileBinding = Readonly<{
  relative: string;
  stamp: Stamp;
  bytes: number;
  sha256: string;
}>;

type PackageDirectoryBinding = Readonly<{
  relative: string;
  stamp: Stamp;
  entries: readonly string[];
}>;

type PackageBinding = {
  name: PackageName;
  root: string;
  virtualRoot: string;
  resolution: string;
  directory: RetainedDirectory;
  manifestSha256: string;
  files: readonly PackageFileBinding[];
  directories: readonly PackageDirectoryBinding[];
  skippedEntityRoot: Stamp | null;
};

type StageFileBinding = Readonly<{
  artifact: MarkdownArtifact;
  relative: string;
  parentRelative: string;
  name: string;
  stamp: Stamp;
}>;

type StageDirectoryBinding = {
  relative: string;
  path: string;
  handle: FileHandle;
  stamp: Stamp;
  entries: readonly string[];
};

type AliasBinding = Readonly<{
  alias: string;
  real: string;
  facts: readonly PathFact[];
}>;

type AbsentBinding = Readonly<{
  path: string;
  parent: RetainedDirectory;
  name: string;
}>;

type DeviceBinding = Readonly<{
  path: string;
  parent: RetainedDirectory;
  name: string;
  stamp: Stamp;
}>;

type CaptureCounters = {
  files: number;
  directories: Set<string>;
  appBytes: number;
  totalBytes: number;
};

type CandidateState = {
  profile: MarkdownProfileEvidence;
  producer: Readonly<ProducerContext>;
  containerPath: string;
  container: StageDirectoryBinding;
  containerAncestors: readonly PathFact[];
  stageDirectories: Map<string, StageDirectoryBinding>;
  stageFiles: Map<string, StageFileBinding>;
  sourceDirectories: Map<string, RetainedDirectory>;
  sourceFiles: readonly SourceFileBinding[];
  packages: readonly PackageBinding[];
  packageEvidence: readonly MarkdownPackage[];
  aliases: readonly AliasBinding[];
  absent: readonly AbsentBinding[];
  device: DeviceBinding;
  launcherArtifactId: string;
  handles: Set<FileHandle>;
  revoked: boolean;
  disposed: boolean;
  busy: boolean;
  lease: Promise<void> | null;
  disposePromise: Promise<void> | null;
};

declare const MARKDOWN_ARTIFACT_CANDIDATE: unique symbol;

/** Inert, immutable evidence. Physical authority is held only in this module. */
export interface MarkdownArtifactCandidate {
  readonly profile: MarkdownProfileEvidence;
  readonly [MARKDOWN_ARTIFACT_CANDIDATE]: never;
}

/** Callback-scoped authenticated descriptors. Every descriptor is closed before the callback promise settles. */
export interface MarkdownArtifactBindings {
  readonly launcher_fd: number;
  readonly mounts: readonly Readonly<{ source_fd: number; virtual_path: string }>[];
}

const states = new WeakMap<MarkdownArtifactCandidate, CandidateState>();

function fail(message = "invalid Markdown artifact candidate"): never {
  throw new Error(message);
}

function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stamp(value: Awaited<ReturnType<FileHandle["stat"]>>): Stamp {
  const s = value as Awaited<ReturnType<FileHandle["stat"]>> & {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    nlink: bigint;
    uid: bigint;
    gid: bigint;
    rdev: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return Object.freeze({
    dev: s.dev,
    ino: s.ino,
    mode: s.mode,
    nlink: s.nlink,
    uid: s.uid,
    gid: s.gid,
    rdev: s.rdev,
    size: s.size,
    mtimeNs: s.mtimeNs,
    ctimeNs: s.ctimeNs,
  });
}

function sameStamp(left: Stamp, right: Stamp): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDirectoryBinding(left: Stamp, right: Stamp): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    isDirectory(left) &&
    isDirectory(right)
  );
}

function identity(stampValue: Stamp): string {
  return `${stampValue.dev}:${stampValue.ino}`;
}

function mode(stampValue: Stamp): number {
  return Number(stampValue.mode & 0o7777n);
}

function trustedOwner(stampValue: Stamp): boolean {
  const uid = BigInt(process.getuid!());
  return stampValue.uid === 0n || stampValue.uid === uid;
}

function assertReadOnlySource(stampValue: Stamp): void {
  if (!trustedOwner(stampValue) || (stampValue.mode & 0o022n) !== 0n || (stampValue.mode & 0o6000n) !== 0n) {
    fail("untrusted artifact source permissions");
  }
}

function fileType(stampValue: Stamp): bigint {
  return stampValue.mode & 0o170000n;
}

function isDirectory(stampValue: Stamp): boolean {
  return fileType(stampValue) === 0o040000n;
}

function isFile(stampValue: Stamp): boolean {
  return fileType(stampValue) === 0o100000n;
}

function isSymlink(stampValue: Stamp): boolean {
  return fileType(stampValue) === 0o120000n;
}

function isCharacter(stampValue: Stamp): boolean {
  return fileType(stampValue) === 0o020000n;
}

function validateComponent(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    !PORTABLE_COMPONENT.test(name) ||
    Buffer.byteLength(name, "utf8") > MARKDOWN_ARTIFACT_LIMITS.componentBytes
  ) {
    fail("non-portable artifact component");
  }
}

function validateVirtualPath(path: string): void {
  if (!path.startsWith("/") || path === "/") fail("invalid artifact path");
  const components = path.slice(1).split("/");
  if (components.length > MARKDOWN_ARTIFACT_LIMITS.depth) fail("artifact path is too deep");
  for (const component of components) validateComponent(component);
}

function procChild(handle: FileHandle, name: string): string {
  validateComponent(name);
  return `/proc/self/fd/${handle.fd}/${name}`;
}

async function pathFact(path: string): Promise<PathFact> {
  const value = stamp(await lstat(path, { bigint: true }));
  let kind: PathFact["kind"];
  if (isDirectory(value)) kind = "directory";
  else if (isFile(value)) kind = "file";
  else if (isSymlink(value)) kind = "symlink";
  else if (isCharacter(value)) kind = "character";
  else fail("unsupported filesystem object");
  const target = kind === "symlink" ? await readlink(path) : null;
  return Object.freeze({ path, stamp: value, kind, target });
}

async function verifyPathFact(fact: PathFact): Promise<void> {
  const current = await pathFact(fact.path);
  if (current.kind !== fact.kind || current.target !== fact.target || !sameStamp(current.stamp, fact.stamp)) {
    fail(`filesystem binding changed: ${fact.path}`);
  }
}

async function openAbsoluteDirectory(path: string): Promise<RetainedDirectory> {
  if (!isAbsolute(path) || resolve(path) !== path) fail("directory must be normalized and absolute");
  const components = path.slice(1).split("/").filter(Boolean);
  let handle = await open("/", DIRECTORY_FLAGS);
  const ancestors: PathFact[] = [];
  try {
    const rootFact = await pathFact("/");
    const rootStamp = stamp(await handle.stat({ bigint: true }));
    if (rootFact.kind !== "directory" || !sameDirectoryBinding(rootFact.stamp, rootStamp))
      fail("root identity mismatch");
    assertReadOnlySource(rootStamp);
    ancestors.push(rootFact);
    let lexical = "";
    for (const component of components) {
      validateComponent(component);
      lexical += `/${component}`;
      const before = stamp(await handle.stat({ bigint: true }));
      const next = await open(procChild(handle, component), DIRECTORY_FLAGS);
      const fact = await pathFact(lexical);
      const opened = stamp(await next.stat({ bigint: true }));
      const after = stamp(await handle.stat({ bigint: true }));
      if (
        fact.kind !== "directory" ||
        !sameDirectoryBinding(fact.stamp, opened) ||
        !sameDirectoryBinding(before, after)
      ) {
        await next.close();
        fail("directory traversal changed");
      }
      assertReadOnlySource(opened);
      await handle.close();
      handle = next;
      ancestors.push(fact);
    }
    return { path, handle, stamp: stamp(await handle.stat({ bigint: true })), ancestors: Object.freeze(ancestors) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function verifyPathIdentity(fact: PathFact): Promise<void> {
  const current = await pathFact(fact.path);
  if (current.kind !== fact.kind || current.target !== fact.target || !sameIdentity(current.stamp, fact.stamp)) {
    fail(`filesystem path identity changed: ${fact.path}`);
  }
  if (current.kind === "directory") assertReadOnlySource(current.stamp);
}

async function verifyPathBinding(fact: PathFact): Promise<void> {
  if (fact.kind !== "directory") {
    await verifyPathFact(fact);
    return;
  }
  const current = await pathFact(fact.path);
  if (
    current.kind !== "directory" ||
    !sameIdentity(current.stamp, fact.stamp) ||
    mode(current.stamp) !== mode(fact.stamp)
  ) {
    fail(`filesystem binding changed: ${fact.path}`);
  }
  assertReadOnlySource(current.stamp);
}

async function verifyRetainedDirectory(directory: RetainedDirectory): Promise<void> {
  for (const fact of directory.ancestors.slice(0, -1)) await verifyPathBinding(fact);
  const descriptor = stamp(await directory.handle.stat({ bigint: true }));
  const lexical = await pathFact(directory.path);
  if (
    lexical.kind !== "directory" ||
    !sameStamp(descriptor, directory.stamp) ||
    !sameStamp(lexical.stamp, directory.stamp)
  ) {
    fail("retained directory changed");
  }
}

async function getSourceDirectory(state: CandidateState, path: string): Promise<RetainedDirectory> {
  const existing = state.sourceDirectories.get(path);
  if (existing !== undefined) return existing;
  const directory = await openAbsoluteDirectory(path);
  state.sourceDirectories.set(path, directory);
  state.handles.add(directory.handle);
  return directory;
}

async function openRegularAt(parent: RetainedDirectory, name: string): Promise<{ handle: FileHandle; stamp: Stamp }> {
  await verifyRetainedDirectory(parent);
  const parentBefore = stamp(await parent.handle.stat({ bigint: true }));
  const lexicalPath = join(parent.path, name);
  const lexical = await pathFact(lexicalPath);
  if (lexical.kind !== "file") fail("artifact source is not a regular file");
  const handle = await open(procChild(parent.handle, name), FILE_FLAGS);
  try {
    const descriptor = stamp(await handle.stat({ bigint: true }));
    const parentAfter = stamp(await parent.handle.stat({ bigint: true }));
    if (!sameStamp(lexical.stamp, descriptor) || !sameStamp(parentBefore, parentAfter)) fail("artifact source changed");
    if (descriptor.nlink !== 1n) fail("artifact source has multiple links");
    assertReadOnlySource(descriptor);
    return { handle, stamp: descriptor };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function hashHandle(handle: FileHandle, expected: Stamp, signal?: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  const size = Number(expected.size);
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
  let offset = 0;
  while (offset < size) {
    abort(signal);
    const length = Math.min(buffer.length, size - offset);
    const result = await handle.read(buffer, 0, length, offset);
    if (result.bytesRead !== length) fail("short artifact read");
    digest.update(buffer.subarray(0, length));
    offset += length;
  }
  if (!sameStamp(stamp(await handle.stat({ bigint: true })), expected)) fail("artifact changed while hashing");
  return digest.digest("hex");
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (result.bytesWritten < 1) fail("short artifact write");
    offset += result.bytesWritten;
  }
}

function registerVirtualDirectory(counters: CaptureCounters, path: string): void {
  if (path !== "/") validateVirtualPath(`${path}/x`);
  if (!counters.directories.has(path)) {
    counters.directories.add(path);
    if (counters.directories.size > MARKDOWN_ARTIFACT_LIMITS.directories) fail("too many artifact directories");
  }
}

function registerVirtualParents(counters: CaptureCounters, path: string): void {
  validateVirtualPath(path);
  let parent = dirname(path);
  while (true) {
    registerVirtualDirectory(counters, parent);
    if (parent === "/") break;
    parent = dirname(parent);
  }
}

function registerArtifact(
  counters: CaptureCounters,
  bytes: number,
  role: MarkdownArtifact["role"],
  virtualPath: string | null,
): void {
  counters.files += 1;
  counters.totalBytes += bytes;
  if (counters.files > MARKDOWN_ARTIFACT_LIMITS.files) fail("too many artifact files");
  if (counters.totalBytes > MARKDOWN_ARTIFACT_LIMITS.totalBytes) fail("artifact bytes exceed limit");
  if (virtualPath !== null) {
    registerVirtualParents(counters, virtualPath);
    if (role === "source" || role === "package" || role === "app-metadata" || role === "policy") {
      counters.appBytes += bytes;
      if (counters.appBytes > MARKDOWN_ARTIFACT_LIMITS.appBytes) fail("application bytes exceed limit");
    }
  }
}

async function ensureDestinationParent(containerPath: string, relativePath: string): Promise<void> {
  const path = join(containerPath, dirname(relativePath));
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function copyOpenedFile(
  containerPath: string,
  relativePath: string,
  source: FileHandle,
  sourceStamp: Stamp,
  destinationMode: number,
  signal?: AbortSignal,
): Promise<string> {
  await ensureDestinationParent(containerPath, relativePath);
  const destinationPath = join(containerPath, relativePath);
  const destination = await open(
    destinationPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const digest = createHash("sha256");
  try {
    const size = Number(sourceStamp.size);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
    let offset = 0;
    while (offset < size) {
      abort(signal);
      const length = Math.min(buffer.length, size - offset);
      const result = await source.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) fail("short artifact copy read");
      const chunk = buffer.subarray(0, length);
      digest.update(chunk);
      await writeAll(destination, chunk, offset);
      offset += length;
    }
    await destination.sync();
    await destination.chmod(destinationMode);
  } finally {
    await destination.close();
  }
  if (!sameStamp(stamp(await source.stat({ bigint: true })), sourceStamp)) fail("artifact changed while copying");
  return digest.digest("hex");
}

async function writeGeneratedFile(
  containerPath: string,
  relativePath: string,
  bytes: Uint8Array,
  destinationMode: number,
): Promise<string> {
  await ensureDestinationParent(containerPath, relativePath);
  const destination = await open(
    join(containerPath, relativePath),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await writeAll(destination, bytes, 0);
    await destination.sync();
    await destination.chmod(destinationMode);
  } finally {
    await destination.close();
  }
  return sha256(bytes);
}

async function inspectElf(handle: FileHandle, size: number): Promise<MarkdownElf> {
  return inspectMarkdownElf(async (offset, length) => {
    const bytes = Buffer.allocUnsafe(length);
    const result = await handle.read(bytes, 0, length, offset);
    if (result.bytesRead !== length) fail("short ELF read");
    return bytes;
  }, size);
}

function assertElf(actual: MarkdownElf, expected: MarkdownElf): void {
  if (!isDeepStrictEqual(actual, expected)) fail("ELF recipe mismatch");
}

function major(device: bigint): number {
  return Number(((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n));
}

function minor(device: bigint): number {
  return Number((device & 0xffn) | ((device >> 12n) & 0xffffff00n));
}

const ELF = Object.freeze({
  node: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 2 as const,
    interpreter: "/lib64/ld-linux-x86-64.so.2",
    soname: null,
    needed: Object.freeze([
      "libatomic.so.1",
      "libdl.so.2",
      "libm.so.6",
      "libstdc++.so.6",
      "libgcc_s.so.1",
      "libpthread.so.0",
      "libc.so.6",
      "ld-linux-x86-64.so.2",
    ]),
    bind_now: true,
  }),
  prlimit: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: "/lib64/ld-linux-x86-64.so.2",
    soname: null,
    needed: Object.freeze(["libsmartcols.so.1", "libc.so.6"]),
    bind_now: true,
  }),
  loader: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: null,
    soname: "ld-linux-x86-64.so.2",
    needed: Object.freeze([]),
    bind_now: true,
  }),
  libc: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: "/usr/lib/ld-linux-x86-64.so.2",
    soname: "libc.so.6",
    needed: Object.freeze(["ld-linux-x86-64.so.2"]),
    bind_now: true,
  }),
  libm: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: null,
    soname: "libm.so.6",
    needed: Object.freeze(["libc.so.6", "ld-linux-x86-64.so.2"]),
    bind_now: true,
  }),
  libstdcpp: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: null,
    soname: "libstdc++.so.6",
    needed: Object.freeze(["libm.so.6", "libc.so.6", "ld-linux-x86-64.so.2", "libgcc_s.so.1"]),
    bind_now: true,
  }),
  libgcc: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: null,
    soname: "libgcc_s.so.1",
    needed: Object.freeze(["libc.so.6", "ld-linux-x86-64.so.2"]),
    bind_now: true,
  }),
  libatomic: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: null,
    soname: "libatomic.so.1",
    needed: Object.freeze(["libc.so.6"]),
    bind_now: true,
  }),
  libdl: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: null,
    soname: "libdl.so.2",
    needed: Object.freeze(["libc.so.6"]),
    bind_now: true,
  }),
  libpthread: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: null,
    soname: "libpthread.so.0",
    needed: Object.freeze(["libc.so.6"]),
    bind_now: true,
  }),
  libsmartcols: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: null,
    soname: "libsmartcols.so.1",
    needed: Object.freeze(["libc.so.6"]),
    bind_now: true,
  }),
  bwrap: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: "/lib64/ld-linux-x86-64.so.2",
    soname: null,
    needed: Object.freeze(["libcap.so.2", "libgcc_s.so.1", "libc.so.6"]),
    bind_now: true,
  }),
  libcap: Object.freeze({
    class: 64 as const,
    data: "little" as const,
    machine: 62,
    type: 3 as const,
    interpreter: "/lib64/ld-linux-x86-64.so.2",
    soname: "libcap.so.2",
    needed: Object.freeze(["libc.so.6"]),
    bind_now: true,
  }),
});

type NativeSpec = Readonly<{
  id: string;
  role: "native" | "launcher" | "host";
  virtualPath: string | null;
  alias: string;
  real: string;
  destinationMode: number;
  elf: MarkdownElf;
  systemOwned: boolean;
}>;

function nativeSpecs(): readonly NativeSpec[] {
  return Object.freeze([
    {
      id: "native/node",
      role: "native",
      virtualPath: "/runtime/node",
      alias: process.execPath,
      real: process.execPath,
      destinationMode: 0o500,
      elf: ELF.node,
      systemOwned: false,
    },
    {
      id: "native/prlimit",
      role: "native",
      virtualPath: "/runtime/prlimit",
      alias: "/usr/bin/prlimit",
      real: "/usr/bin/prlimit",
      destinationMode: 0o500,
      elf: ELF.prlimit,
      systemOwned: true,
    },
    {
      id: "native/loader",
      role: "native",
      virtualPath: "/lib64/ld-linux-x86-64.so.2",
      alias: "/lib64/ld-linux-x86-64.so.2",
      real: "/usr/lib/ld-linux-x86-64.so.2",
      destinationMode: 0o500,
      elf: ELF.loader,
      systemOwned: true,
    },
    {
      id: "native/loader-usr-lib",
      role: "native",
      virtualPath: "/usr/lib/ld-linux-x86-64.so.2",
      alias: "/lib64/ld-linux-x86-64.so.2",
      real: "/usr/lib/ld-linux-x86-64.so.2",
      destinationMode: 0o500,
      elf: ELF.loader,
      systemOwned: true,
    },
    {
      id: "native/libc",
      role: "native",
      virtualPath: "/usr/lib/libc.so.6",
      alias: "/usr/lib/libc.so.6",
      real: "/usr/lib/libc.so.6",
      destinationMode: 0o400,
      elf: ELF.libc,
      systemOwned: true,
    },
    {
      id: "native/libm",
      role: "native",
      virtualPath: "/usr/lib/libm.so.6",
      alias: "/usr/lib/libm.so.6",
      real: "/usr/lib/libm.so.6",
      destinationMode: 0o400,
      elf: ELF.libm,
      systemOwned: true,
    },
    {
      id: "native/libstdcpp",
      role: "native",
      virtualPath: "/usr/lib/libstdc++.so.6",
      alias: "/usr/lib/libstdc++.so.6",
      real: "/usr/lib/libstdc++.so.6.0.36",
      destinationMode: 0o400,
      elf: ELF.libstdcpp,
      systemOwned: true,
    },
    {
      id: "native/libgcc",
      role: "native",
      virtualPath: "/usr/lib/libgcc_s.so.1",
      alias: "/usr/lib/libgcc_s.so.1",
      real: "/usr/lib/libgcc_s.so.1",
      destinationMode: 0o400,
      elf: ELF.libgcc,
      systemOwned: true,
    },
    {
      id: "native/libatomic",
      role: "native",
      virtualPath: "/usr/lib/libatomic.so.1",
      alias: "/usr/lib/libatomic.so.1",
      real: "/usr/lib/libatomic.so.1.2.0",
      destinationMode: 0o400,
      elf: ELF.libatomic,
      systemOwned: true,
    },
    {
      id: "native/libdl",
      role: "native",
      virtualPath: "/usr/lib/libdl.so.2",
      alias: "/usr/lib/libdl.so.2",
      real: "/usr/lib/libdl.so.2",
      destinationMode: 0o400,
      elf: ELF.libdl,
      systemOwned: true,
    },
    {
      id: "native/libpthread",
      role: "native",
      virtualPath: "/usr/lib/libpthread.so.0",
      alias: "/usr/lib/libpthread.so.0",
      real: "/usr/lib/libpthread.so.0",
      destinationMode: 0o400,
      elf: ELF.libpthread,
      systemOwned: true,
    },
    {
      id: "native/libsmartcols",
      role: "native",
      virtualPath: "/usr/lib/libsmartcols.so.1",
      alias: "/usr/lib/libsmartcols.so.1",
      real: "/usr/lib/libsmartcols.so.1.1.0",
      destinationMode: 0o400,
      elf: ELF.libsmartcols,
      systemOwned: true,
    },
    {
      id: "launcher/bwrap",
      role: "launcher",
      virtualPath: null,
      alias: "/usr/bin/bwrap",
      real: "/usr/bin/bwrap",
      destinationMode: 0o500,
      elf: ELF.bwrap,
      systemOwned: true,
    },
    {
      id: "host/libcap",
      role: "host",
      virtualPath: null,
      alias: "/usr/lib/libcap.so.2",
      real: "/usr/lib/libcap.so.2.78",
      destinationMode: 0o400,
      elf: ELF.libcap,
      systemOwned: true,
    },
  ]);
}

function destinationForArtifact(id: string, virtualPath: string | null): string {
  return virtualPath === null ? `owned/${id}` : `root${virtualPath}`;
}

async function captureAlias(alias: string, expectedReal: string): Promise<AliasBinding> {
  if (resolve(await realpath(alias)) !== expectedReal) fail("native alias target mismatch");
  const facts: PathFact[] = [];
  let lexical = "/";
  facts.push(await pathFact(lexical));
  for (const component of alias.slice(1).split("/")) {
    validateComponent(component);
    lexical = lexical === "/" ? `/${component}` : `${lexical}/${component}`;
    facts.push(await pathFact(lexical));
  }
  return Object.freeze({ alias, real: expectedReal, facts: Object.freeze(facts) });
}

async function verifyAlias(binding: AliasBinding): Promise<void> {
  if (resolve(await realpath(binding.alias)) !== binding.real) fail("native alias changed");
  for (const fact of binding.facts) await verifyPathBinding(fact);
}

async function captureAbsent(state: CandidateState, path: string): Promise<AbsentBinding> {
  const parent = await getSourceDirectory(state, dirname(path));
  const name = path.slice(path.lastIndexOf("/") + 1);
  validateComponent(name);
  try {
    await lstat(procChild(parent.handle, name), { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ path, parent, name });
    throw error;
  }
  fail("expected absent host resource exists");
}

async function verifyAbsent(binding: AbsentBinding): Promise<void> {
  await verifyRetainedDirectory(binding.parent);
  try {
    await lstat(procChild(binding.parent.handle, binding.name), { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fail("absent host resource appeared");
}

async function captureDevice(state: CandidateState): Promise<DeviceBinding> {
  const parent = await getSourceDirectory(state, "/dev");
  const value = await pathFact("/dev/null");
  if (
    value.kind !== "character" ||
    isSymlink(value.stamp) ||
    major(value.stamp.rdev) !== MARKDOWN_RUNTIME_CONTRACT.device.major ||
    minor(value.stamp.rdev) !== MARKDOWN_RUNTIME_CONTRACT.device.minor
  ) {
    fail("unexpected /dev/null identity");
  }
  return Object.freeze({ path: "/dev/null", parent, name: "null", stamp: value.stamp });
}

async function verifyDevice(binding: DeviceBinding): Promise<void> {
  await verifyRetainedDirectory(binding.parent);
  const value = await pathFact(binding.path);
  if (
    value.kind !== "character" ||
    !sameStamp(value.stamp, binding.stamp) ||
    major(value.stamp.rdev) !== 1 ||
    minor(value.stamp.rdev) !== 3
  ) {
    fail("/dev/null changed");
  }
}

async function locatePackageRoot(entry: string, expectedName: PackageName): Promise<string> {
  let directory = dirname(entry);
  for (let depth = 0; depth <= MARKDOWN_ARTIFACT_LIMITS.depth; depth += 1) {
    const manifestPath = join(directory, "package.json");
    try {
      const bytes = await readFile(manifestPath);
      if (bytes.length > MARKDOWN_ARTIFACT_LIMITS.sourceFileBytes) fail("package manifest exceeds limit");
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (
        value !== null &&
        typeof value === "object" &&
        Object.getPrototypeOf(value) === Object.prototype &&
        (value as Record<string, unknown>).name === expectedName
      ) {
        if (relative(directory, entry).startsWith(`..${sep}`) || relative(directory, entry) === "..") {
          fail("package resolution escaped root");
        }
        return resolve(directory);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  fail("unable to locate installed package root");
}

type ResolvedPackage = Readonly<{ name: PackageName; root: string; resolution: string; virtualRoot: string }>;

async function resolveInstalledPackages(): Promise<readonly ResolvedPackage[]> {
  const moduleRequire = createRequire(import.meta.url);
  const markdownManifest = moduleRequire.resolve("markdown-it/package.json");
  const markdownRoot = dirname(markdownManifest);
  const markdownRequire = createRequire(markdownManifest);
  const resolved = new Map<PackageName, ResolvedPackage>();
  resolved.set(
    "markdown-it",
    Object.freeze({
      name: "markdown-it",
      root: markdownRoot,
      resolution: markdownManifest,
      virtualRoot: "/app/node_modules/markdown-it",
    }),
  );
  for (const name of Object.keys(PACKAGE_RECIPES).sort() as PackageName[]) {
    if (name === "markdown-it") continue;
    const resolution = markdownRequire.resolve(name);
    const root = await locatePackageRoot(resolution, name);
    const virtualRoot =
      name === "entities" ? "/app/node_modules/markdown-it/node_modules/entities" : `/app/node_modules/${name}`;
    resolved.set(name, Object.freeze({ name, root, resolution, virtualRoot }));
  }
  const packages = [...resolved.values()].sort((left, right) => left.virtualRoot.localeCompare(right.virtualRoot));
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  for (const entry of packages) {
    const requireFromPackage = createRequire(join(entry.root, "package.json"));
    for (const dependency of Object.keys(PACKAGE_RECIPES[entry.name].dependencies) as PackageName[]) {
      const resolution = requireFromPackage.resolve(dependency);
      const selectedRoot = await locatePackageRoot(resolution, dependency);
      if (selectedRoot !== byName.get(dependency)?.root) fail("dependency did not resolve from genuine parent context");
    }
  }
  return Object.freeze(packages);
}

async function readHandleBytes(handle: FileHandle, expected: Stamp, maximum: number): Promise<Buffer> {
  const size = Number(expected.size);
  if (size > maximum) fail("bounded file exceeds limit");
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead < 1) fail("short bounded file read");
    offset += result.bytesRead;
  }
  if (!sameStamp(stamp(await handle.stat({ bigint: true })), expected)) fail("bounded file changed");
  return bytes;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("invalid package manifest");
  }
  return value as Record<string, unknown>;
}

function validateManifest(
  name: PackageName,
  bytes: Uint8Array,
  roots: ReadonlyMap<PackageName, ResolvedPackage>,
): MarkdownPackage {
  const manifest = plainRecord(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown);
  const recipe = PACKAGE_RECIPES[name];
  if (manifest.name !== name || manifest.version !== recipe.version) fail("package identity mismatch");
  if (Object.hasOwn(manifest, "type") && manifest.type !== recipe.type) fail("package type mismatch");
  if (!Object.hasOwn(manifest, "type") && recipe.type !== "commonjs") fail("missing package type");
  for (const field of PACKAGE_FIELDS_FORBIDDEN)
    if (Object.hasOwn(manifest, field)) fail("unsupported package dependency field");
  const actualDependencies = Object.hasOwn(manifest, "dependencies") ? plainRecord(manifest.dependencies) : {};
  const expectedDependencies = recipe.dependencies as Readonly<Record<string, string>>;
  const actualNames = Object.keys(actualDependencies).sort();
  const expectedNames = Object.keys(expectedDependencies).sort();
  if (!isDeepStrictEqual(actualNames, expectedNames)) fail("package dependency set mismatch");
  const dependencies = expectedNames.map((dependencyName) => {
    if (actualDependencies[dependencyName] !== expectedDependencies[dependencyName]) {
      fail("package dependency range mismatch");
    }
    const dependency = roots.get(dependencyName as PackageName);
    if (dependency === undefined) fail("package dependency root missing");
    return Object.freeze({
      name: dependencyName,
      range: expectedDependencies[dependencyName]!,
      root: dependency.virtualRoot,
    });
  });
  const resolved = roots.get(name)!;
  return Object.freeze({
    root: resolved.virtualRoot,
    name,
    version: recipe.version,
    type: recipe.type,
    dependencies: Object.freeze(dependencies),
  });
}

type PackageScanContext = {
  state: CandidateState;
  resolved: ResolvedPackage;
  root: RetainedDirectory;
  entityRootStamp: Stamp | null;
  capture: boolean;
  counters?: CaptureCounters;
  artifacts?: MarkdownArtifact[];
  signal?: AbortSignal;
  seenDirectories: Set<string>;
};

type PackageScanResult = Readonly<{
  files: readonly PackageFileBinding[];
  directories: readonly PackageDirectoryBinding[];
  manifestBytes: Uint8Array;
  skippedEntityRoot: Stamp | null;
}>;

async function scanPackageTree(context: PackageScanContext): Promise<PackageScanResult> {
  const files: PackageFileBinding[] = [];
  const directories: PackageDirectoryBinding[] = [];
  let manifestBytes: Uint8Array | null = null;
  let skippedEntityRoot: Stamp | null = null;

  async function visit(directory: FileHandle, relativeDirectory: string, lexicalDirectory: string): Promise<void> {
    abort(context.signal);
    const before = stamp(await directory.stat({ bigint: true }));
    if (!isDirectory(before)) fail("package directory became non-directory");
    assertReadOnlySource(before);
    const key = identity(before);
    if (context.seenDirectories.has(key)) fail("duplicate package directory identity");
    context.seenDirectories.add(key);
    const names = (await readdir(`/proc/self/fd/${directory.fd}`)).sort();
    for (const name of names) validateComponent(name);
    const entries: string[] = [];
    for (const name of names) {
      abort(context.signal);
      const childRelative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const lexical = join(lexicalDirectory, name);
      const lexicalFact = await pathFact(lexical);
      entries.push(name);
      if (lexicalFact.kind === "directory") {
        if (name === "node_modules" && !(context.resolved.name === "markdown-it" && childRelative === "node_modules")) {
          fail("unsupported nested node_modules scope");
        }
        const child = await open(procChild(directory, name), DIRECTORY_FLAGS);
        try {
          const opened = stamp(await child.stat({ bigint: true }));
          if (!sameStamp(opened, lexicalFact.stamp)) fail("package directory identity mismatch");
          assertReadOnlySource(opened);
          if (context.resolved.name === "markdown-it" && childRelative === "node_modules/entities") {
            if (context.entityRootStamp === null || !sameStamp(opened, context.entityRootStamp)) {
              fail("nested entities package identity mismatch");
            }
            skippedEntityRoot = opened;
            continue;
          }
          const virtualDirectory = `${context.resolved.virtualRoot}/${childRelative}`;
          if (context.capture) {
            registerVirtualDirectory(context.counters!, virtualDirectory);
            await mkdir(join(context.state.containerPath, `root${virtualDirectory}`), { mode: 0o700 });
          }
          await visit(child, childRelative, lexical);
        } finally {
          await child.close();
        }
      } else if (lexicalFact.kind === "file") {
        if (name === "package.json" && childRelative !== "package.json") fail("unsupported nested package scope");
        const opened = await open(procChild(directory, name), FILE_FLAGS);
        try {
          const openedStamp = stamp(await opened.stat({ bigint: true }));
          if (!sameStamp(openedStamp, lexicalFact.stamp) || openedStamp.nlink !== 1n) {
            fail("invalid package file identity");
          }
          assertReadOnlySource(openedStamp);
          const bytes = Number(openedStamp.size);
          if (!Number.isSafeInteger(bytes) || bytes > MARKDOWN_ARTIFACT_LIMITS.sourceFileBytes) {
            fail("package file exceeds limit");
          }
          let digest: string;
          if (context.capture) {
            const virtualPath = `${context.resolved.virtualRoot}/${childRelative}`;
            const id = `package/${context.resolved.name}/${childRelative}`;
            const destination = destinationForArtifact(id, virtualPath);
            digest = await copyOpenedFile(
              context.state.containerPath,
              destination,
              opened,
              openedStamp,
              0o400,
              context.signal,
            );
            registerArtifact(context.counters!, bytes, "package", virtualPath);
            context.artifacts!.push(
              Object.freeze({
                id,
                role: "package" as const,
                virtual_path: virtualPath,
                bytes,
                sha256: digest,
                mode: 0o400,
                elf: null,
              }),
            );
          } else {
            digest = await hashHandle(opened, openedStamp, context.signal);
          }
          if (childRelative === "package.json")
            manifestBytes = await readHandleBytes(opened, openedStamp, MARKDOWN_ARTIFACT_LIMITS.sourceFileBytes);
          files.push(Object.freeze({ relative: childRelative, stamp: openedStamp, bytes, sha256: digest }));
        } finally {
          await opened.close();
        }
      } else {
        fail("package tree contains a symlink or special file");
      }
    }
    const after = stamp(await directory.stat({ bigint: true }));
    if (!sameStamp(before, after)) fail("package directory changed during traversal");
    directories.push(Object.freeze({ relative: relativeDirectory, stamp: before, entries: Object.freeze(entries) }));
  }

  await verifyRetainedDirectory(context.root);
  if (context.capture) {
    registerVirtualDirectory(context.counters!, context.resolved.virtualRoot);
    await mkdir(join(context.state.containerPath, `root${context.resolved.virtualRoot}`), {
      recursive: true,
      mode: 0o700,
    });
  }
  await visit(context.root.handle, "", context.root.path);
  if (manifestBytes === null) fail("package manifest missing");
  return Object.freeze({
    files: Object.freeze(files.sort((left, right) => left.relative.localeCompare(right.relative))),
    directories: Object.freeze(directories.sort((left, right) => left.relative.localeCompare(right.relative))),
    manifestBytes,
    skippedEntityRoot,
  });
}

async function captureStandaloneFile(
  state: CandidateState,
  counters: CaptureCounters,
  artifacts: MarkdownArtifact[],
  input: Readonly<{
    id: string;
    role: MarkdownArtifact["role"];
    virtualPath: string | null;
    sourcePath: string;
    destinationMode: number;
    maximum: number;
    elf: MarkdownElf | null;
    systemOwned?: boolean;
  }>,
  sourceFiles: SourceFileBinding[],
  signal?: AbortSignal,
): Promise<void> {
  abort(signal);
  const parent = await getSourceDirectory(state, dirname(input.sourcePath));
  const opened = await openRegularAt(parent, input.sourcePath.slice(input.sourcePath.lastIndexOf("/") + 1));
  try {
    const bytes = Number(opened.stamp.size);
    if (!Number.isSafeInteger(bytes) || bytes > input.maximum) fail("artifact source exceeds limit");
    if ((mode(opened.stamp) & 0o022) !== 0) fail("artifact source is group- or world-writable");
    if (input.systemOwned === true && (opened.stamp.uid !== 0n || opened.stamp.gid !== 0n)) {
      fail("system artifact owner mismatch");
    }
    let elf: MarkdownElf | null = null;
    if (input.elf !== null) {
      if (bytes < 64) fail("ELF source is too short");
      elf = await inspectElf(opened.handle, bytes);
      assertElf(elf, input.elf);
    }
    const destination = destinationForArtifact(input.id, input.virtualPath);
    const digest = await copyOpenedFile(
      state.containerPath,
      destination,
      opened.handle,
      opened.stamp,
      input.destinationMode,
      signal,
    );
    registerArtifact(counters, bytes, input.role, input.virtualPath);
    const artifact = Object.freeze({
      id: input.id,
      role: input.role,
      virtual_path: input.virtualPath,
      bytes,
      sha256: digest,
      mode: input.destinationMode,
      elf,
    });
    artifacts.push(artifact);
    sourceFiles.push(
      Object.freeze({
        path: input.sourcePath,
        parent,
        name: input.sourcePath.slice(input.sourcePath.lastIndexOf("/") + 1),
        stamp: opened.stamp,
        bytes,
        sha256: digest,
      }),
    );
  } finally {
    await opened.handle.close();
  }
}

async function verifySourceFile(binding: SourceFileBinding): Promise<void> {
  const opened = await openRegularAt(binding.parent, binding.name);
  try {
    if (!sameStamp(opened.stamp, binding.stamp) || Number(opened.stamp.size) !== binding.bytes) {
      fail("artifact source identity changed");
    }
    if ((await hashHandle(opened.handle, opened.stamp)) !== binding.sha256) fail("artifact source bytes changed");
  } finally {
    await opened.handle.close();
  }
}

async function createOwnedContainer(): Promise<{ path: string; directory: RetainedDirectory }> {
  assertExternalPath(ARTIFACT_PARENT);
  await mkdir(ARTIFACT_PARENT, { recursive: true, mode: 0o700 });
  const parent = await openAbsoluteDirectory(ARTIFACT_PARENT);
  let createdPath: string | null = null;
  try {
    if (
      parent.stamp.uid !== BigInt(process.getuid!()) ||
      parent.stamp.gid !== BigInt(process.getgid!()) ||
      (mode(parent.stamp) & 0o077) !== 0
    ) {
      fail("artifact parent is not private and owned");
    }
    createdPath = await mkdtemp(join(ARTIFACT_PARENT, "candidate-"));
    assertExternalPath(createdPath);
    const directory = await openAbsoluteDirectory(createdPath);
    if (
      directory.stamp.uid !== BigInt(process.getuid!()) ||
      directory.stamp.gid !== BigInt(process.getgid!()) ||
      mode(directory.stamp) !== 0o700
    ) {
      await directory.handle.close();
      fail("artifact container is not private and owned");
    }
    const parentAfter = stamp(await parent.handle.stat({ bigint: true }));
    if (!sameIdentity(parentAfter, parent.stamp)) fail("artifact parent identity changed");
    return { path: createdPath, directory };
  } catch (error) {
    if (createdPath !== null) {
      await rm(createdPath, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await parent.handle.close();
  }
}

async function captureStageTopology(state: CandidateState, artifacts: readonly MarkdownArtifact[]): Promise<void> {
  const byRelative = new Map(
    artifacts.map((artifact) => [destinationForArtifact(artifact.id, artifact.virtual_path), artifact]),
  );
  const directories = new Map<string, StageDirectoryBinding>();
  const files = new Map<string, StageFileBinding>();

  async function visit(path: string, relativePath: string, handle: FileHandle): Promise<void> {
    const descriptor = stamp(await handle.stat({ bigint: true }));
    const lexical = await pathFact(path);
    if (lexical.kind !== "directory" || !sameStamp(descriptor, lexical.stamp)) fail("staged directory mismatch");
    const names = (await readdir(`/proc/self/fd/${handle.fd}`)).sort();
    for (const name of names) validateComponent(name);
    const binding: StageDirectoryBinding = {
      relative: relativePath,
      path,
      handle,
      stamp: descriptor,
      entries: Object.freeze(names),
    };
    directories.set(relativePath, binding);
    state.handles.add(handle);
    for (const name of names) {
      const childRelative = relativePath === "" ? name : `${relativePath}/${name}`;
      const childPath = join(path, name);
      const childFact = await pathFact(childPath);
      if (childFact.kind === "directory") {
        const child = await open(procChild(handle, name), DIRECTORY_FLAGS);
        const opened = stamp(await child.stat({ bigint: true }));
        if (!sameStamp(opened, childFact.stamp)) {
          await child.close();
          fail("staged directory changed");
        }
        await visit(childPath, childRelative, child);
      } else if (childFact.kind === "file") {
        const artifact = byRelative.get(childRelative);
        if (artifact === undefined || files.has(artifact.id)) fail("unexpected staged file");
        if (childFact.stamp.nlink !== 1n || mode(childFact.stamp) !== artifact.mode) fail("staged file mode mismatch");
        const opened = await open(procChild(handle, name), FILE_FLAGS);
        try {
          const openedStamp = stamp(await opened.stat({ bigint: true }));
          if (!sameStamp(openedStamp, childFact.stamp)) fail("staged file identity mismatch");
          if ((await hashHandle(opened, openedStamp)) !== artifact.sha256) fail("staged file hash mismatch");
          if (artifact.elf !== null) assertElf(await inspectElf(opened, artifact.bytes), artifact.elf);
        } finally {
          await opened.close();
        }
        files.set(
          artifact.id,
          Object.freeze({
            artifact,
            relative: childRelative,
            parentRelative: relativePath,
            name,
            stamp: childFact.stamp,
          }),
        );
      } else {
        fail("staged tree contains a symlink or special file");
      }
    }
  }

  const retained = await openAbsoluteDirectory(state.containerPath);
  const previousContainer = state.container.handle;
  state.container = {
    relative: "",
    path: state.containerPath,
    handle: retained.handle,
    stamp: retained.stamp,
    entries: Object.freeze([]),
  };
  state.containerAncestors = retained.ancestors;
  state.handles.add(retained.handle);
  await previousContainer.close();
  state.handles.delete(previousContainer);
  await visit(state.containerPath, "", retained.handle);
  if (files.size !== artifacts.length || byRelative.size !== artifacts.length) fail("incomplete staged artifact set");
  if (directories.size > MARKDOWN_ARTIFACT_LIMITS.directories) fail("staged directory count exceeds limit");
  state.container = directories.get("")!;
  state.stageDirectories = directories;
  state.stageFiles = files;
  const orderedDirectories = [...directories.values()].sort(
    (left, right) => right.relative.split("/").length - left.relative.split("/").length,
  );
  for (const directory of orderedDirectories) {
    await directory.handle.chmod(directory.relative === "" ? 0o700 : 0o500);
  }
  for (const directory of directories.values()) {
    const descriptor = stamp(await directory.handle.stat({ bigint: true }));
    const lexical = await pathFact(directory.path);
    if (lexical.kind !== "directory" || !sameStamp(descriptor, lexical.stamp)) fail("staged directory seal mismatch");
    directory.stamp = descriptor;
  }
}

async function verifyStage(state: CandidateState): Promise<void> {
  for (const fact of state.containerAncestors.slice(0, -1)) await verifyPathIdentity(fact);
  if (state.stageDirectories.size > MARKDOWN_ARTIFACT_LIMITS.directories) fail("invalid staged directory count");
  for (const directory of state.stageDirectories.values()) {
    const descriptor = stamp(await directory.handle.stat({ bigint: true }));
    const lexical = await pathFact(directory.path);
    if (
      lexical.kind !== "directory" ||
      !sameStamp(descriptor, directory.stamp) ||
      !sameStamp(lexical.stamp, directory.stamp) ||
      mode(descriptor) !== (directory.relative === "" ? 0o700 : 0o500)
    ) {
      fail("staged directory changed");
    }
    const names = (await readdir(`/proc/self/fd/${directory.handle.fd}`)).sort();
    if (!isDeepStrictEqual(names, directory.entries)) fail("staged directory membership changed");
  }
  for (const binding of state.stageFiles.values()) {
    const parent = state.stageDirectories.get(binding.parentRelative);
    if (parent === undefined) fail("staged file parent missing");
    const lexical = await pathFact(join(parent.path, binding.name));
    if (lexical.kind !== "file" || !sameStamp(lexical.stamp, binding.stamp)) fail("staged file changed");
    const opened = await open(procChild(parent.handle, binding.name), FILE_FLAGS);
    try {
      const descriptor = stamp(await opened.stat({ bigint: true }));
      if (
        !sameStamp(descriptor, binding.stamp) ||
        descriptor.nlink !== 1n ||
        mode(descriptor) !== binding.artifact.mode ||
        Number(descriptor.size) !== binding.artifact.bytes ||
        (await hashHandle(opened, descriptor)) !== binding.artifact.sha256
      ) {
        fail("staged artifact verification failed");
      }
      if (binding.artifact.elf !== null)
        assertElf(await inspectElf(opened, binding.artifact.bytes), binding.artifact.elf);
    } finally {
      await opened.close();
    }
  }
  if (state.stageFiles.size !== state.profile.manifest.artifacts.length) fail("staged artifact set changed");
}

async function openStageArtifact(state: CandidateState, artifactId: string): Promise<FileHandle> {
  const binding = state.stageFiles.get(artifactId);
  if (binding === undefined) fail("staged artifact is unavailable");
  const parent = state.stageDirectories.get(binding.parentRelative);
  if (parent === undefined) fail("staged artifact parent is unavailable");
  const handle = await open(procChild(parent.handle, binding.name), FILE_FLAGS);
  try {
    const descriptor = stamp(await handle.stat({ bigint: true }));
    if (
      !sameStamp(descriptor, binding.stamp) ||
      descriptor.nlink !== 1n ||
      mode(descriptor) !== binding.artifact.mode ||
      Number(descriptor.size) !== binding.artifact.bytes
    ) {
      fail("staged artifact descriptor authentication failed");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function collectBounded(stream: NodeJS.ReadableStream, maximum: number, onOverflow: () => void): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > maximum) {
        onOverflow();
        rejectPromise(new Error("loader diagnostic output exceeds limit"));
        return;
      }
      chunks.push(chunk);
    });
    stream.once("end", () => resolvePromise(Buffer.concat(chunks)));
    stream.once("error", rejectPromise);
  });
}

function validateLauncherSelectionOutput(output: Uint8Array): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
  } catch {
    fail("loader diagnostic is not valid UTF-8");
  }
  if (!text.endsWith("\n")) fail("loader diagnostic is not terminal");
  const expected = new Map([
    ["libcap.so.2", "/usr/lib/libcap.so.2"],
    ["libgcc_s.so.1", "/usr/lib/libgcc_s.so.1"],
    ["libc.so.6", "/usr/lib/libc.so.6"],
    ["/lib64/ld-linux-x86-64.so.2", "/proc/self/fd/3"],
  ]);
  const selected = new Map<string, string>();
  let vdso = false;
  for (const line of text.slice(0, -1).split("\n")) {
    if (/^\tlinux-vdso\.so\.1 \(0x[0-9a-f]+\)$/.test(line)) {
      if (vdso) fail("duplicate loader diagnostic selection");
      vdso = true;
      continue;
    }
    const match = /^\t([^\s]+) => ([^\s]+) \(0x[0-9a-f]+\)$/.exec(line);
    if (match === null) fail("unrecognized loader diagnostic line");
    const name = match[1]!;
    const path = match[2]!;
    if (selected.has(name)) fail("duplicate loader diagnostic selection");
    if (expected.get(name) !== path) fail("launcher dependency selection mismatch");
    selected.set(name, path);
  }
  if (!vdso || !isDeepStrictEqual(selected, expected)) fail("launcher dependency selection mismatch");
}

async function verifyLauncherSelection(state: CandidateState, signal?: AbortSignal): Promise<void> {
  abort(signal);
  const loader = await openStageArtifact(state, "native/loader");
  const launcher = await openStageArtifact(state, state.launcherArtifactId);
  let verificationError: unknown;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn("/proc/self/fd/3", ["--list", "/proc/self/fd/4"], {
        env: { LC_ALL: "C", LANG: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "pipe", loader.fd, launcher.fd],
      });
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      };
      const cancel = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted === true) cancel();
      const timer = setTimeout(cancel, 2_000);
      timer.unref();
      const stdout = collectBounded(child.stdout!, 8_192, cancel);
      const stderr = collectBounded(child.stderr!, 4_096, cancel);
      child.once("error", finish);
      child.once("close", async (code, closeSignal) => {
        try {
          const [output, errors] = await Promise.all([stdout, stderr]);
          abort(signal);
          if (code !== 0 || closeSignal !== null || errors.length !== 0) fail("loader diagnostic failed");
          validateLauncherSelectionOutput(output);
          finish();
        } catch (error) {
          finish(error);
        }
      });
    });
  } catch (error) {
    verificationError = error;
  }
  const closeResults = await Promise.allSettled([loader.close(), launcher.close()]);
  const closeErrors = closeResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  const errors = [verificationError, ...closeErrors].filter((error) => error !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "launcher verification failed");
}

function externalSelections(): readonly MarkdownExternalSelection[] {
  const hwcaps = ["x86-64-v2", "x86-64-v3", "x86-64-v4"];
  const absentHwcaps = [
    "usr/lib/glibc-hwcaps",
    ...hwcaps.flatMap((level) =>
      ["libcap.so.2", "libgcc_s.so.1", "libc.so.6"].map((name) => `usr/lib/glibc-hwcaps/${level}/${name}`),
    ),
  ];
  return Object.freeze([
    Object.freeze({
      role: "inner-node",
      artifact_id: "native/node",
      aliases: Object.freeze(["runtime/node"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-prlimit",
      artifact_id: "native/prlimit",
      aliases: Object.freeze(["runtime/prlimit"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-loader-lib64",
      artifact_id: "native/loader",
      aliases: Object.freeze(["lib64/ld-linux-x86-64.so.2"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-loader-usr-lib",
      artifact_id: "native/loader-usr-lib",
      aliases: Object.freeze(["usr/lib/ld-linux-x86-64.so.2"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-libatomic",
      artifact_id: "native/libatomic",
      aliases: Object.freeze(["usr/lib/libatomic.so.1", "usr/lib/libatomic.so.1.2.0"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-libdl",
      artifact_id: "native/libdl",
      aliases: Object.freeze(["usr/lib/libdl.so.2"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-libm",
      artifact_id: "native/libm",
      aliases: Object.freeze(["usr/lib/libm.so.6"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-libstdcpp",
      artifact_id: "native/libstdcpp",
      aliases: Object.freeze(["usr/lib/libstdc++.so.6", "usr/lib/libstdc++.so.6.0.36"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-launcher-libgcc",
      artifact_id: "native/libgcc",
      aliases: Object.freeze(["usr/lib/libgcc_s.so.1"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-libpthread",
      artifact_id: "native/libpthread",
      aliases: Object.freeze(["usr/lib/libpthread.so.0"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-launcher-libc",
      artifact_id: "native/libc",
      aliases: Object.freeze(["usr/lib/libc.so.6"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "inner-libsmartcols",
      artifact_id: "native/libsmartcols",
      aliases: Object.freeze(["usr/lib/libsmartcols.so.1", "usr/lib/libsmartcols.so.1.1.0"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "launcher-bwrap",
      artifact_id: "launcher/bwrap",
      aliases: Object.freeze(["usr/bin/bwrap"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "launcher-libcap",
      artifact_id: "host/libcap",
      aliases: Object.freeze(["usr/lib/libcap.so.2", "usr/lib/libcap.so.2.78"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "launcher-loader-cache",
      artifact_id: "host/loader-cache",
      aliases: Object.freeze(["etc/ld.so.cache"]),
      absent: Object.freeze([]),
    }),
    Object.freeze({
      role: "launcher-preload",
      artifact_id: null,
      aliases: Object.freeze([]),
      absent: Object.freeze(["etc/ld.so.preload"]),
    }),
    Object.freeze({
      role: "launcher-hwcaps",
      artifact_id: null,
      aliases: Object.freeze([]),
      absent: Object.freeze(absentHwcaps),
    }),
  ]);
}

async function verifyPackageGraph(state: CandidateState): Promise<void> {
  const resolved = await resolveInstalledPackages();
  const roots = new Map(resolved.map((entry) => [entry.name, entry]));
  const bindings = new Map(state.packages.map((entry) => [entry.name, entry]));
  const entity = bindings.get("entities");
  if (entity === undefined) fail("entities binding missing");
  const seenDirectories = new Set<string>();
  const evidence: MarkdownPackage[] = [];
  for (const entry of resolved) {
    const expected = bindings.get(entry.name);
    if (
      expected === undefined ||
      expected.root !== entry.root ||
      expected.virtualRoot !== entry.virtualRoot ||
      expected.resolution !== entry.resolution
    ) {
      fail("package resolution changed");
    }
    const scan = await scanPackageTree({
      state,
      resolved: entry,
      root: expected.directory,
      entityRootStamp: entry.name === "markdown-it" ? entity.directory.stamp : null,
      capture: false,
      signal: undefined,
      seenDirectories,
    });
    if (
      !isDeepStrictEqual(scan.files, expected.files) ||
      !isDeepStrictEqual(scan.directories, expected.directories) ||
      !isDeepStrictEqual(scan.skippedEntityRoot, expected.skippedEntityRoot) ||
      sha256(scan.manifestBytes) !== expected.manifestSha256
    ) {
      fail("package topology changed");
    }
    evidence.push(validateManifest(entry.name, scan.manifestBytes, roots));
  }
  const expectedEvidence = state.packageEvidence.filter((entry) => entry.name !== "ubc-markdown-runtime");
  if (!isDeepStrictEqual(evidence, expectedEvidence)) fail("package graph changed");
}

async function verifyState(state: CandidateState, signal?: AbortSignal): Promise<void> {
  abort(signal);
  if (process.platform !== "linux" || process.arch !== "x64" || Number(process.versions.node.split(".")[0]) < 24) {
    fail("unsupported Markdown runtime platform");
  }
  if (resolve(await realpath("/proc/self/exe")) !== resolve(await realpath(process.execPath))) {
    fail("current Node executable changed");
  }
  for (const alias of state.aliases) {
    abort(signal);
    await verifyAlias(alias);
  }
  for (const binding of state.absent) {
    abort(signal);
    await verifyAbsent(binding);
  }
  await verifyDevice(state.device);
  for (const binding of state.sourceFiles) {
    abort(signal);
    await verifySourceFile(binding);
  }
  await verifyPackageGraph(state);
  abort(signal);
  await verifyStage(state);
  const producer = await captureProducer(REPOSITORY_ROOT);
  assertSameProducer(state.producer, producer);
  await verifyLauncherSelection(state, signal);
  abort(signal);
}

function initialState(path: string, directory: RetainedDirectory): CandidateState {
  const container: StageDirectoryBinding = {
    relative: "",
    path,
    handle: directory.handle,
    stamp: directory.stamp,
    entries: Object.freeze([]),
  };
  return {
    profile: null as unknown as MarkdownProfileEvidence,
    producer: null as unknown as Readonly<ProducerContext>,
    containerPath: path,
    container,
    containerAncestors: directory.ancestors,
    stageDirectories: new Map(),
    stageFiles: new Map(),
    sourceDirectories: new Map(),
    sourceFiles: Object.freeze([]),
    packages: Object.freeze([]),
    packageEvidence: Object.freeze([]),
    aliases: Object.freeze([]),
    absent: Object.freeze([]),
    device: null as unknown as DeviceBinding,
    launcherArtifactId: "launcher/bwrap",
    handles: new Set([directory.handle]),
    revoked: false,
    disposed: false,
    busy: false,
    lease: null,
    disposePromise: null,
  };
}

function appPackageEvidence(): MarkdownPackage {
  return Object.freeze({
    root: "/app",
    name: "ubc-markdown-runtime",
    version: "1.0.0",
    type: "module",
    dependencies: Object.freeze([
      Object.freeze({ name: "markdown-it", range: "15.0.2", root: "/app/node_modules/markdown-it" }),
    ]),
  });
}

/** Capture one inert, bounded candidate without executing package or Markdown worker code. */
export async function captureMarkdownArtifactCandidate(signal?: AbortSignal): Promise<MarkdownArtifactCandidate> {
  abort(signal);
  if (process.platform !== "linux" || process.arch !== "x64" || Number(process.versions.node.split(".")[0]) < 24) {
    fail("unsupported Markdown runtime platform");
  }
  const owned = await createOwnedContainer();
  const state = initialState(owned.path, owned.directory);
  const artifacts: MarkdownArtifact[] = [];
  const sourceFiles: SourceFileBinding[] = [];
  const aliases: AliasBinding[] = [];
  const absent: AbsentBinding[] = [];
  const counters: CaptureCounters = { files: 0, directories: new Set(), appBytes: 0, totalBytes: 0 };
  try {
    registerVirtualDirectory(counters, "/");
    registerVirtualDirectory(counters, "/app");
    registerVirtualDirectory(counters, "/dev");
    await mkdir(join(state.containerPath, "root/app"), { recursive: true, mode: 0o700 });
    await mkdir(join(state.containerPath, "owned"), { mode: 0o700 });

    const appPackagePath = "root/app/package.json";
    const appPackageHash = await writeGeneratedFile(state.containerPath, appPackagePath, APP_PACKAGE_BYTES, 0o400);
    registerArtifact(counters, APP_PACKAGE_BYTES.length, "app-metadata", "/app/package.json");
    artifacts.push(
      Object.freeze({
        id: "app/package-json",
        role: "app-metadata",
        virtual_path: "/app/package.json",
        bytes: APP_PACKAGE_BYTES.length,
        sha256: appPackageHash,
        mode: 0o400,
        elf: null,
      }),
    );

    for (const name of SOURCE_FILES) {
      await captureStandaloneFile(
        state,
        counters,
        artifacts,
        {
          id: `source/${name}`,
          role: "source",
          virtualPath: `/app/${name}`,
          sourcePath: join(MODULE_DIRECTORY, name),
          destinationMode: 0o400,
          maximum: MARKDOWN_ARTIFACT_LIMITS.sourceFileBytes,
          elf: null,
        },
        sourceFiles,
        signal,
      );
    }

    const resolvedPackages = await resolveInstalledPackages();
    const resolvedByName = new Map(resolvedPackages.map((entry) => [entry.name, entry]));
    const packageRoots = new Map<PackageName, RetainedDirectory>();
    for (const entry of resolvedPackages) packageRoots.set(entry.name, await getSourceDirectory(state, entry.root));
    const entityRoot = packageRoots.get("entities");
    if (entityRoot === undefined) fail("entities root missing");
    const packageBindings: PackageBinding[] = [];
    const packageEvidence: MarkdownPackage[] = [appPackageEvidence()];
    const seenPackageDirectories = new Set<string>();
    for (const entry of resolvedPackages) {
      abort(signal);
      const root = packageRoots.get(entry.name)!;
      const scan = await scanPackageTree({
        state,
        resolved: entry,
        root,
        entityRootStamp: entry.name === "markdown-it" ? entityRoot.stamp : null,
        capture: true,
        counters,
        artifacts,
        signal,
        seenDirectories: seenPackageDirectories,
      });
      const evidence = validateManifest(entry.name, scan.manifestBytes, resolvedByName);
      packageEvidence.push(evidence);
      packageBindings.push({
        name: entry.name,
        root: entry.root,
        virtualRoot: entry.virtualRoot,
        resolution: entry.resolution,
        directory: root,
        manifestSha256: sha256(scan.manifestBytes),
        files: scan.files,
        directories: scan.directories,
        skippedEntityRoot: scan.skippedEntityRoot,
      });
    }

    for (const spec of nativeSpecs()) {
      abort(signal);
      aliases.push(await captureAlias(spec.alias, spec.real));
      await captureStandaloneFile(
        state,
        counters,
        artifacts,
        {
          id: spec.id,
          role: spec.role,
          virtualPath: spec.virtualPath,
          sourcePath: spec.real,
          destinationMode: spec.destinationMode,
          maximum: MARKDOWN_ARTIFACT_LIMITS.elfBytes,
          elf: spec.elf,
          systemOwned: spec.systemOwned,
        },
        sourceFiles,
        signal,
      );
    }
    await captureStandaloneFile(
      state,
      counters,
      artifacts,
      {
        id: "host/loader-cache",
        role: "host",
        virtualPath: null,
        sourcePath: "/etc/ld.so.cache",
        destinationMode: 0o400,
        maximum: MARKDOWN_ARTIFACT_LIMITS.totalBytes,
        elf: null,
        systemOwned: true,
      },
      sourceFiles,
      signal,
    );

    absent.push(await captureAbsent(state, "/etc/ld.so.preload"));
    absent.push(await captureAbsent(state, "/usr/lib/glibc-hwcaps"));
    state.device = await captureDevice(state);

    const guard = createMarkdownGuardPolicy(artifacts, packageEvidence);
    if (guard.bytes.length > MARKDOWN_ARTIFACT_LIMITS.encodingBytes || !HASH.test(guard.sha256))
      fail("invalid guard policy");
    const policyPath = "root/app/markdown-guard-policy.json";
    const writtenPolicyHash = await writeGeneratedFile(state.containerPath, policyPath, guard.bytes, 0o400);
    if (writtenPolicyHash !== guard.sha256) fail("guard policy write mismatch");
    registerArtifact(counters, guard.bytes.length, "policy", "/app/markdown-guard-policy.json");
    artifacts.push(
      Object.freeze({
        id: "app/guard-policy",
        role: "policy",
        virtual_path: "/app/markdown-guard-policy.json",
        bytes: guard.bytes.length,
        sha256: guard.sha256,
        mode: 0o400,
        elf: null,
      }),
    );

    state.producer = await captureProducer(REPOSITORY_ROOT);
    state.sourceFiles = Object.freeze(sourceFiles);
    state.packages = Object.freeze(packageBindings);
    state.packageEvidence = Object.freeze(packageEvidence);
    state.aliases = Object.freeze(aliases);
    state.absent = Object.freeze(absent);
    state.profile = createMarkdownProfile({
      producer: state.producer,
      runtime: state.producer.runtime,
      artifacts,
      directories: [...counters.directories],
      packages: packageEvidence,
      external_selection: externalSelections(),
    });
    await captureStageTopology(state, state.profile.manifest.artifacts);
    await verifyState(state, signal);
    abort(signal);
    const candidate = Object.freeze({ profile: state.profile }) as MarkdownArtifactCandidate;
    states.set(candidate, state);
    return candidate;
  } catch (error) {
    state.revoked = true;
    let cleanupError: unknown;
    try {
      await cleanupState(state, true);
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure;
    }
    if (cleanupError !== undefined) {
      throw new AggregateError([error, cleanupError], "artifact capture and cleanup failed");
    }
    throw error;
  }
}

function beginLease(state: CandidateState): () => void {
  if (state.busy) fail("Markdown artifact candidate already has an active lease");
  state.busy = true;
  let release!: () => void;
  state.lease = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return () => {
    state.busy = false;
    state.lease = null;
    release();
  };
}

/** Reverify all source, staged, package, native and ownership evidence. */
export async function verifyMarkdownArtifactCandidate(candidate: MarkdownArtifactCandidate): Promise<void> {
  const state = states.get(candidate);
  if (state === undefined) fail("forged Markdown artifact candidate");
  if (state.revoked || state.disposed) fail("Markdown artifact candidate is unavailable");
  const release = beginLease(state);
  try {
    await verifyState(state);
    if (state.revoked || state.disposed) {
      fail("Markdown artifact candidate was disposed during verification");
    }
  } catch (error) {
    state.revoked = true;
    throw error;
  } finally {
    release();
  }
}

function sameIdentity(left: Stamp, right: Stamp): boolean {
  const type = fileType(left);
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    (isDirectory(left) || left.nlink === right.nlink) &&
    type === fileType(right)
  );
}

async function authenticateOwnedTopology(state: CandidateState): Promise<void> {
  for (const fact of state.containerAncestors.slice(0, -1)) await verifyPathIdentity(fact);
  if (state.stageDirectories.size === 0) {
    const descriptor = stamp(await state.container.handle.stat({ bigint: true }));
    const lexical = await pathFact(state.containerPath);
    if (
      lexical.kind !== "directory" ||
      !sameIdentity(descriptor, state.container.stamp) ||
      !sameIdentity(lexical.stamp, state.container.stamp)
    ) {
      fail("artifact container ownership changed");
    }
    return;
  }
  for (const directory of state.stageDirectories.values()) {
    const descriptor = stamp(await directory.handle.stat({ bigint: true }));
    const lexical = await pathFact(directory.path);
    const names = (await readdir(`/proc/self/fd/${directory.handle.fd}`)).sort();
    if (
      lexical.kind !== "directory" ||
      !sameIdentity(descriptor, directory.stamp) ||
      !sameIdentity(lexical.stamp, directory.stamp) ||
      !isDeepStrictEqual(names, directory.entries)
    ) {
      fail("artifact directory ownership changed");
    }
  }
  for (const binding of state.stageFiles.values()) {
    const parent = state.stageDirectories.get(binding.parentRelative)!;
    const lexical = await pathFact(join(parent.path, binding.name));
    if (lexical.kind !== "file" || !sameIdentity(lexical.stamp, binding.stamp)) {
      fail("artifact file ownership changed");
    }
  }
}

async function closeRetainedHandles(state: CandidateState): Promise<void> {
  const results = await Promise.allSettled([...state.handles].map((handle) => handle.close()));
  state.handles.clear();
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length !== 0)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "artifact descriptor close failed",
    );
}

async function cleanupState(state: CandidateState, captureFailure = false): Promise<void> {
  let authenticationError: unknown;
  try {
    await authenticateOwnedTopology(state);
  } catch (error) {
    authenticationError = error;
  }
  let closeError: unknown;
  try {
    await closeRetainedHandles(state);
  } catch (error) {
    closeError = error;
  }
  let removalError: unknown;
  if (authenticationError === undefined) {
    try {
      const ordered = [...state.stageDirectories.values()].sort(
        (left, right) => right.relative.split("/").length - left.relative.split("/").length,
      );
      for (const directory of ordered) await chmod(directory.path, 0o700);
      await rm(state.containerPath, { recursive: true, force: false, maxRetries: 0 });
    } catch (error) {
      removalError = error;
    }
  } else if (captureFailure && state.stageDirectories.size === 0) {
    removalError = authenticationError;
  }
  const errors = [authenticationError, closeError, removalError].filter((error) => error !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "artifact disposal failed");
}

/** Supply fresh descriptor bindings for exactly one awaited callback and reverify before return. */
export async function withVerifiedMarkdownArtifactBindings<T>(
  candidate: MarkdownArtifactCandidate,
  callback: (bindings: MarkdownArtifactBindings) => T | PromiseLike<T>,
): Promise<T> {
  const state = states.get(candidate);
  if (state === undefined) fail("forged Markdown artifact candidate");
  if (state.revoked || state.disposed) fail("Markdown artifact candidate is revoked");
  if (typeof callback !== "function") fail("artifact binding callback is required");
  const releaseLease = beginLease(state);
  const opened: FileHandle[] = [];
  let callbackValue: T | undefined;
  let callbackError: unknown;
  let bindingError: unknown;
  let closeError: unknown;
  let postverifyError: unknown;
  try {
    await verifyState(state);
    const launcher = await openStageArtifact(state, state.launcherArtifactId);
    opened.push(launcher);
    const mounts: { source_fd: number; virtual_path: string }[] = [];
    for (const artifact of state.profile.manifest.artifacts) {
      if (artifact.virtual_path === null) continue;
      const handle = await openStageArtifact(state, artifact.id);
      opened.push(handle);
      mounts.push(Object.freeze({ source_fd: handle.fd, virtual_path: artifact.virtual_path }));
    }
    const descriptors = opened.map((handle) => handle.fd);
    if (new Set(descriptors).size !== descriptors.length) fail("artifact binding descriptors are not distinct");
    const bindings = Object.freeze({ launcher_fd: launcher.fd, mounts: Object.freeze(mounts) });
    try {
      callbackValue = await callback(bindings);
    } catch (error) {
      callbackError = error;
    }
  } catch (error) {
    bindingError = error;
  } finally {
    const closes = await Promise.allSettled(opened.map((handle) => handle.close()));
    const failures = closes.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length !== 0)
      closeError = new AggregateError(
        failures.map((result) => result.reason),
        "binding close failed",
      );
    try {
      await verifyState(state);
      if (state.disposed) fail("Markdown artifact candidate was disposed during its lease");
    } catch (error) {
      postverifyError = error;
    }
    if (bindingError !== undefined || closeError !== undefined || postverifyError !== undefined) state.revoked = true;
    releaseLease();
  }
  const errors = [bindingError, callbackError, closeError, postverifyError].filter((error) => error !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "artifact binding callback failed");
  return callbackValue as T;
}

/** Revoke first, await an active lease, close retained descriptors, then remove only the authenticated owned container. */
export async function disposeMarkdownArtifactCandidate(candidate: MarkdownArtifactCandidate): Promise<void> {
  const state = states.get(candidate);
  if (state === undefined) fail("forged Markdown artifact candidate");
  if (state.disposePromise !== null) return state.disposePromise;
  state.revoked = true;
  state.disposed = true;
  state.disposePromise = (async () => {
    const lease = state.lease;
    if (lease !== null) await lease;
    await cleanupState(state);
  })();
  return state.disposePromise;
}
