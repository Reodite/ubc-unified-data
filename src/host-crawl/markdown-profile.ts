import { createHash } from "node:crypto";
import { types } from "node:util";
import type { ProducerContext } from "./contracts.ts";
import { MARKDOWN_INSPECTION_DIALECT, MARKDOWN_INSPECTION_LIMITS } from "./markdown-contract.mjs";
import { MARKDOWN_ELF_LIMITS, type MarkdownElf } from "./markdown-elf.ts";
import { MARKDOWN_PROTOCOL_LIMITS } from "./markdown-protocol.mjs";

export { MARKDOWN_ELF_LIMITS } from "./markdown-elf.ts";

export const MARKDOWN_ARTIFACT_LIMITS = Object.freeze({
  files: 512,
  directories: 128,
  depth: 16,
  componentBytes: 255,
  sourceFileBytes: 8388608,
  appBytes: 33554432,
  elfBytes: 268435456,
  totalBytes: 536870912,
  encodingBytes: 1048576,
} as const);

export const MARKDOWN_RUNTIME_LIMITS = Object.freeze({
  cpuSeconds: 3,
  wallMilliseconds: 5000,
  fileDescriptors: 64,
  fileSizeBytes: 0,
  coreBytes: 0,
  stackBytes: 8388608,
  oldSpaceMiB: 128,
  semiSpaceMiB: 4,
  v8Pool: 1,
  stderrBytes: 16384,
  statusBytes: 8192,
} as const);

export interface MarkdownArtifact {
  readonly id: string;
  readonly role: "source" | "package" | "app-metadata" | "policy" | "native" | "launcher" | "host";
  readonly virtual_path: string | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
  readonly elf: MarkdownElf | null;
}

export interface MarkdownPackageDependency {
  readonly name: string;
  readonly range: string;
  readonly root: string;
}

export interface MarkdownPackage {
  readonly root: string;
  readonly name: string;
  readonly version: string;
  readonly type: "module" | "commonjs";
  readonly dependencies: readonly MarkdownPackageDependency[];
}

export interface MarkdownExternalSelection {
  readonly role: string;
  readonly artifact_id: string | null;
  readonly aliases: readonly string[];
  readonly absent: readonly string[];
}

export type MarkdownRuntimeVersions = Readonly<ProducerContext["runtime"]>;
export type MarkdownProducer = Readonly<{
  inputs_sha256: ProducerContext["inputs_sha256"];
  runtime: MarkdownRuntimeVersions;
}>;

export interface MarkdownProfileInput {
  readonly producer: MarkdownProducer;
  readonly runtime: MarkdownRuntimeVersions;
  readonly artifacts: readonly MarkdownArtifact[];
  readonly directories: readonly string[];
  readonly packages: readonly MarkdownPackage[];
  readonly external_selection: readonly MarkdownExternalSelection[];
}

export interface MarkdownGuardFile {
  readonly path: string;
  readonly sha256: string;
  readonly format: "module" | "commonjs" | "json" | "data";
}

export interface MarkdownBuiltinPolicy {
  readonly parent: string;
  readonly allowed: readonly string[];
}

export interface MarkdownGuardPolicy {
  readonly version: 1;
  readonly files: readonly MarkdownGuardFile[];
  readonly packages: readonly MarkdownPackage[];
  readonly builtins: readonly MarkdownBuiltinPolicy[];
}

/** Bytes are a fresh owned copy; the digest and wrapper are immutable evidence only. */
export interface MarkdownGuardPolicyEvidence {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const environment = { LC_ALL: "C", LANG: "C", TZ: "UTC", UV_THREADPOOL_SIZE: "1" } as const;
export const MARKDOWN_RUNTIME_CONTRACT = freeze({
  dialect: MARKDOWN_INSPECTION_DIALECT,
  inspection: MARKDOWN_INSPECTION_LIMITS,
  protocol: MARKDOWN_PROTOCOL_LIMITS,
  artifacts: MARKDOWN_ARTIFACT_LIMITS,
  elf: MARKDOWN_ELF_LIMITS,
  runtime: MARKDOWN_RUNTIME_LIMITS,
  environment: { outer: environment, child: { ...environment, PWD: "/app" } },
  namespaces: ["user", "pid", "net", "ipc", "uts"],
  device: { path: "/dev/null", type: "character", major: 1, minor: 3, symlink: false },
  invocation: {
    cwd: "/app",
    entry: "/app/markdown-worker.mjs",
    bootstrap: "/app/markdown-bootstrap.mjs",
    policy: "/app/markdown-guard-policy.json",
    policy_argument: "lowercase-sha256",
    launcher: {
      execution: "retained-descriptor",
      flags: [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-uts",
        "--disable-userns",
        "--assert-userns-disabled",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--clearenv",
        "--chdir",
        "/app",
        "--json-status-fd",
        "3",
      ],
      projection: "individual-ro-bind-fd-files-explicit-directories-null-device-remount-ro-root",
      inherited_directory_descriptors: false,
    },
    prlimit: {
      path: "/runtime/prlimit",
      flags: ["--cpu=3:3", "--nofile=64:64", "--fsize=0:0", "--core=0:0", "--stack=8388608:8388608"],
    },
    node: {
      path: "/runtime/node",
      minimum_major: 24,
      flags: [
        "--max-old-space-size=128",
        "--max-semi-space-size=4",
        "--v8-pool-size=1",
        "--permission",
        "--no-addons",
        "--no-global-search-paths",
        "--disable-proto=throw",
        "--disallow-code-generation-from-strings",
        "--openssl-config=/dev/null",
      ],
      read_grants: "individual-inventoried-app-files",
      write_process_worker_addon_network_grants: false,
    },
    before_guard_builtins: ["node:module", "node:fs", "node:url", "node:crypto"],
  },
  assumptions: [
    "linux-x64-glibc-usr-lib",
    "kernel-cpu-dispatch-entropy-scheduling",
    "no-hostile-privileged-or-owning-account-mutation",
    "no-total-rss-or-unconditional-termination-guarantee",
  ],
} as const);

export type MarkdownRuntimeContract = typeof MARKDOWN_RUNTIME_CONTRACT;
export interface MarkdownProfileManifest extends MarkdownProfileInput {
  readonly format: "host-markdown-runtime-v1";
  readonly version: 1;
  readonly recipe: "linux-x64-glibc-usr-lib-v1";
  readonly contract: MarkdownRuntimeContract;
}
export interface MarkdownProfileEvidence {
  readonly manifest: MarkdownProfileManifest;
  readonly sha256: string;
}

const LIMITS = MARKDOWN_ARTIFACT_LIMITS;
const SOURCES = ["bootstrap", "contract", "inspection", "protocol", "worker"].map(
  (name) => `/app/markdown-${name}.mjs`,
);
const POLICY_PATH = "/app/markdown-guard-policy.json";
const BUILTINS: readonly MarkdownBuiltinPolicy[] = freeze([
  { parent: SOURCES[0]!, allowed: ["node:crypto", "node:fs", "node:module", "node:url", "node:util"] },
  { parent: SOURCES[1]!, allowed: [] },
  { parent: SOURCES[2]!, allowed: ["node:crypto", "node:util"] },
  { parent: SOURCES[3]!, allowed: ["node:buffer", "node:crypto", "node:util"] },
  { parent: SOURCES[4]!, allowed: [] },
]);
const TOP_PACKAGES = ["argparse", "linkify-it", "markdown-it", "mdurl", "punycode.js", "uc.micro"];
const PACKAGE_ROOTS = new Map([
  ["ubc-markdown-runtime", "/app"],
  ...TOP_PACKAGES.map((name): [string, string] => [name, `/app/node_modules/${name}`]),
  ["entities", "/app/node_modules/markdown-it/node_modules/entities"],
]);
const INPUT_FIELDS = ["producer", "runtime", "artifacts", "directories", "packages", "external_selection"];
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")!.get!;
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;

function fail(): never {
  throw new Error("Markdown profile: invalid evidence.");
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > maximum)
    fail();
  return value;
}
function own(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || (key !== "length" && !descriptor.enumerable)) fail();
  return descriptor.value;
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) fail();
  return Object.fromEntries(fields.map((key) => [key, own(value, key)]));
}
function array(value: unknown, maximum: number): unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  const length = integer(own(value, "length"), maximum);
  if (Reflect.ownKeys(value).length !== length + 1) fail();
  return Array.from({ length }, (_, index) => own(value, String(index)));
}
function text(value: unknown, maximum: number, pattern: RegExp): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) fail();
  return value;
}
function hash(value: unknown): string {
  return text(value, 64, /^[a-f0-9]{64}$/);
}
function path(value: unknown, absolute: boolean, root = false): string {
  const result = text(value, LIMITS.depth * (LIMITS.componentBytes + 1), /^[A-Za-z0-9_@+./-]+$/);
  if (root && result === "/") return result;
  if (result.startsWith("/") !== absolute) fail();
  const parts = (absolute ? result.slice(1) : result).split("/");
  if (
    parts.length > LIMITS.depth ||
    parts.some((part) => !part || part === "." || part === ".." || part.length > LIMITS.componentBytes)
  )
    fail();
  return result;
}
function sortedUnique(values: string[]): string[] {
  values.sort(compare);
  if (values.some((value, index) => index > 0 && value === values[index - 1])) fail();
  return values;
}
function parent(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
function runtime(value: unknown): MarkdownRuntimeVersions {
  const r = record(value, ["node", "icu", "unicode", "platform", "arch"]);
  const node = text(r.node, 64, /^\d+\.\d+\.\d+$/);
  if (Number(node.split(".")[0]) < 24 || r.platform !== "linux" || r.arch !== "x64") fail();
  return {
    node,
    icu: text(r.icu, 64, /^(?:\d+(?:\.\d+){0,3}|unavailable)$/),
    unicode: text(r.unicode, 64, /^(?:\d+(?:\.\d+){0,3}|unavailable)$/),
    platform: "linux",
    arch: "x64",
  };
}
function elf(value: unknown): MarkdownElf {
  const e = record(value, ["class", "data", "machine", "type", "interpreter", "soname", "needed", "bind_now"]);
  if (
    e.class !== 64 ||
    e.data !== "little" ||
    e.machine !== 62 ||
    (e.type !== 2 && e.type !== 3) ||
    typeof e.bind_now !== "boolean"
  )
    fail();
  const label = (value: unknown) => {
    const result = text(value, MARKDOWN_ELF_LIMITS.nameBytes, /^[A-Za-z0-9_+.-]+$/);
    if (result === "." || result === "..") fail();
    return result;
  };
  const needed = array(e.needed, MARKDOWN_ELF_LIMITS.neededNames).map(label);
  if (new Set(needed).size !== needed.length) fail();
  const interpreter =
    e.interpreter === null
      ? null
      : text(e.interpreter, MARKDOWN_ELF_LIMITS.interpreterBytes - 1, /^\/[A-Za-z0-9_+./-]+$/);
  if (
    interpreter
      ?.slice(1)
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.length > 255)
  )
    fail();
  return {
    class: 64,
    data: "little",
    machine: 62,
    type: e.type,
    interpreter,
    soname: e.soname === null ? null : label(e.soname),
    needed,
    bind_now: e.bind_now,
  };
}
function dependencyRange(value: unknown): string {
  const result = text(value, 255, /^[0-9A-Za-z.*+~^<>=| -]+$/);
  const version = /^(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  for (const alternative of result.split("||")) {
    const set = alternative.trim();
    const interval = set.split(" - ");
    if (interval.length === 2) {
      if (!interval.every((part) => version.test(part))) fail();
    } else {
      if (
        !set
          .replace(/([~^<>=]+) +/g, "$1")
          .split(/ +/)
          .every((part) => version.test(part.replace(/^(?:[~^=]|[<>]=?)/, "")))
      )
        fail();
    }
  }
  return result;
}
function packages(value: unknown): MarkdownPackage[] {
  const result = array(value, PACKAGE_ROOTS.size)
    .map((value): MarkdownPackage => {
      const p = record(value, ["root", "name", "version", "type", "dependencies"]);
      const name = text(p.name, 255, /^[a-z0-9][a-z0-9._-]*$/);
      const root = path(p.root, true);
      if (PACKAGE_ROOTS.get(name) !== root || (p.type !== "module" && p.type !== "commonjs")) fail();
      const version = text(p.version, 128, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
      const dependencies = array(p.dependencies, PACKAGE_ROOTS.size)
        .map((value): MarkdownPackageDependency => {
          const d = record(value, ["name", "range", "root"]);
          return {
            name: text(d.name, 255, /^[a-z0-9][a-z0-9._-]*$/),
            range: dependencyRange(d.range),
            root: path(d.root, true),
          };
        })
        .sort((a, b) => compare(a.name, b.name));
      sortedUnique(dependencies.map((d) => d.name));
      return { root, name, version, type: p.type, dependencies };
    })
    .sort((a, b) => compare(a.root, b.root));
  if (result.length !== PACKAGE_ROOTS.size) fail();
  sortedUnique(result.map((p) => p.name));
  sortedUnique(result.map((p) => p.root));
  const byRoot = new Map(result.map((p) => [p.root, p]));
  for (const p of result) {
    const required =
      p.name === "ubc-markdown-runtime"
        ? ["markdown-it"]
        : p.name === "markdown-it"
          ? ["argparse", "entities", "linkify-it", "mdurl", "punycode.js", "uc.micro"]
          : p.name === "linkify-it"
            ? ["uc.micro"]
            : [];
    if (p.dependencies.length !== required.length || p.dependencies.some((d, index) => d.name !== required[index]))
      fail();
    if (
      p.name === "ubc-markdown-runtime" &&
      (p.version !== "1.0.0" || p.type !== "module" || p.dependencies[0]!.range !== "15.0.2")
    )
      fail();
    if (p.name === "markdown-it" && p.version !== "15.0.2") fail();
    for (const d of p.dependencies) {
      let directory = p.root;
      let nearest: MarkdownPackage | undefined;
      while (!nearest && directory !== "/") {
        nearest = byRoot.get(`${directory}/node_modules/${d.name}`);
        directory = parent(directory);
      }
      if (!nearest || nearest.root !== d.root || nearest.name !== d.name) fail();
    }
  }
  return result;
}
function owner(path: string, packages: readonly MarkdownPackage[]): MarkdownPackage {
  const found = packages.filter((p) => path.startsWith(`${p.root}/`)).sort((a, b) => b.root.length - a.root.length)[0];
  if (!found) fail();
  return found;
}
function artifacts(value: unknown, packages: readonly MarkdownPackage[], policy: boolean): MarkdownArtifact[] {
  let total = 0;
  let app = 0;
  const result = array(value, LIMITS.files)
    .map((value): MarkdownArtifact => {
      const a = record(value, ["id", "role", "virtual_path", "bytes", "sha256", "mode", "elf"]);
      const id = path(a.id, false);
      const role = a.role as MarkdownArtifact["role"];
      if (!["source", "package", "app-metadata", "policy", "native", "launcher", "host"].includes(role)) fail();
      const virtual = a.virtual_path === null ? null : path(a.virtual_path, true);
      if ((role === "launcher" || role === "host") !== (virtual === null)) fail();
      const bytes = integer(
        a.bytes,
        role === "policy"
          ? LIMITS.encodingBytes
          : ["source", "package", "app-metadata"].includes(role)
            ? LIMITS.sourceFileBytes
            : a.elf === null
              ? LIMITS.totalBytes
              : LIMITS.elfBytes,
      );
      const sha256 = hash(a.sha256);
      const mode = integer(a.mode, 0o777);
      if (!(mode & 0o400) || (role !== "host" && (mode & 0o222) !== 0)) fail();
      const metadata = a.elf === null ? null : elf(a.elf);
      if ((role === "native" || role === "launcher") && (!metadata || bytes < 64)) fail();
      if (["source", "package", "app-metadata", "policy"].includes(role)) {
        if (mode !== 0o400 || metadata !== null || !virtual?.startsWith("/app/")) fail();
        if (role === "policy") {
          if (!policy || virtual !== POLICY_PATH) fail();
        } else {
          app += bytes;
          if (app > LIMITS.appBytes) fail();
        }
        if (role === "source" && !SOURCES.includes(virtual!)) fail();
        if (role === "app-metadata" && virtual !== "/app/package.json") fail();
        if (role === "package") {
          const p = owner(virtual!, packages);
          const relative = virtual!.slice(p.root.length + 1);
          if (p.root === "/app" || relative.split("/").includes("node_modules") || relative.endsWith("/package.json"))
            fail();
        }
      } else if (
        virtual !== null &&
        !virtual.startsWith("/runtime/") &&
        !virtual.startsWith("/lib64/") &&
        !virtual.startsWith("/usr/lib/")
      )
        fail();
      total += bytes;
      if (total > LIMITS.totalBytes) fail();
      return { id, role, virtual_path: virtual, bytes, sha256, mode, elf: metadata };
    })
    .sort((a, b) => compare(a.id, b.id));
  sortedUnique(result.map((a) => a.id));
  const files = new Set(sortedUnique(result.flatMap((a) => (a.virtual_path === null ? [] : [a.virtual_path]))));
  for (const file of files) {
    let directory = parent(file);
    while (directory !== "/") {
      if (files.has(directory)) fail();
      directory = parent(directory);
    }
  }
  if (result.filter((a) => a.role === "policy").length !== Number(policy)) fail();
  if (result.filter((a) => a.role === "launcher").length > 1) fail();
  for (const source of SOURCES) if (!result.some((a) => a.role === "source" && a.virtual_path === source)) fail();
  for (const p of packages) {
    if (
      !result.some(
        (a) =>
          a.virtual_path === `${p.root}/package.json` && a.role === (p.root === "/app" ? "app-metadata" : "package"),
      )
    )
      fail();
  }
  return result;
}

// Only fresh schema-owned records and bounded primitive fragments reach this printer.
function canonical<T>(value: T, preserveFieldOrder = false): { value: T; bytes: Uint8Array } {
  let size = 0;
  const parts: string[] = [];
  function emit(fragment: string): void {
    const bytes = Buffer.byteLength(fragment, "utf8");
    if (bytes > LIMITS.encodingBytes - size) fail();
    size += bytes;
    parts.push(fragment);
  }
  function visit(value: unknown): unknown {
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      emit(String(value));
      return value;
    }
    if (typeof value === "string") {
      // Schema strings are bounded ASCII, so JSON escaping cannot exceed this remaining budget.
      if (value.length + 2 > LIMITS.encodingBytes - size) fail();
      emit(JSON.stringify(value));
      return value;
    }
    if (Array.isArray(value)) {
      emit("[");
      const result = value.map((item, index) => {
        if (index) emit(",");
        return visit(item);
      });
      emit("]");
      return result;
    }
    if (!value || typeof value !== "object") fail();
    emit("{");
    const result: Record<string, unknown> = {};
    const keys = Object.keys(value);
    if (!preserveFieldOrder) keys.sort(compare);
    for (const [index, key] of keys.entries()) {
      if (index) emit(",");
      emit(JSON.stringify(key));
      emit(":");
      result[key] = visit((value as Record<string, unknown>)[key]);
    }
    emit("}");
    return result;
  }
  const result = visit(value) as T;
  return { value: freeze(result), bytes: Buffer.from(parts.join(""), "utf8") };
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function guard(
  artifacts: readonly MarkdownArtifact[],
  packages: readonly MarkdownPackage[],
): MarkdownGuardPolicyEvidence {
  const files = artifacts
    .filter((a) => ["source", "package", "app-metadata"].includes(a.role))
    .map((a): MarkdownGuardFile => {
      const path = a.virtual_path!;
      const format = path.endsWith(".mjs")
        ? "module"
        : path.endsWith(".cjs")
          ? "commonjs"
          : path.endsWith(".json")
            ? "json"
            : path.endsWith(".js")
              ? owner(path, packages).type
              : "data";
      return { path, sha256: a.sha256, format };
    })
    .sort((a, b) => compare(a.path, b.path));
  const policy: MarkdownGuardPolicy = { version: 1, files, packages, builtins: BUILTINS };
  const { bytes } = canonical(policy, true);
  return Object.freeze({ bytes, sha256: sha256(bytes) });
}

/** Construct the pre-policy byte identity; passing the policy itself is a circular input error. */
export function createMarkdownGuardPolicy(
  inputArtifacts: readonly MarkdownArtifact[],
  inputPackages: readonly MarkdownPackage[],
): MarkdownGuardPolicyEvidence {
  const validatedPackages = packages(inputPackages);
  return guard(artifacts(inputArtifacts, validatedPackages, false), validatedPackages);
}

function directories(
  value: unknown,
  artifacts: readonly MarkdownArtifact[],
  packages: readonly MarkdownPackage[],
): string[] {
  const result = sortedUnique(array(value, LIMITS.directories).map((value) => path(value, true, true)));
  const paths = new Set(result);
  if (!paths.has("/") || !paths.has("/app") || !paths.has("/dev")) fail();
  const files = new Set(artifacts.flatMap((a) => (a.virtual_path === null ? [] : [a.virtual_path])));
  const packageAncestors = new Set<string>();
  for (const p of packages) {
    let directory = p.root;
    while (directory !== "/") {
      packageAncestors.add(directory);
      directory = parent(directory);
    }
    if (!paths.has(p.root)) fail();
  }
  for (const directory of result) {
    if (files.has(directory) || (directory !== "/" && !paths.has(parent(directory)))) fail();
    if (["/", "/dev", "/runtime", "/lib64", "/usr", "/usr/lib"].includes(directory) || packageAncestors.has(directory))
      continue;
    const p = owner(`${directory}/`, packages);
    if (
      p.root === "/app" ||
      directory
        .slice(p.root.length + 1)
        .split("/")
        .includes("node_modules")
    )
      fail();
  }
  for (const file of files) if (!paths.has(parent(file))) fail();
  return result;
}
function externalSelection(value: unknown, artifacts: readonly MarkdownArtifact[]): MarkdownExternalSelection[] {
  const result = array(value, LIMITS.files)
    .map((value): MarkdownExternalSelection => {
      const e = record(value, ["role", "artifact_id", "aliases", "absent"]);
      const role = path(e.role, false);
      const artifact_id = e.artifact_id === null ? null : path(e.artifact_id, false);
      const aliases = sortedUnique(array(e.aliases, LIMITS.files).map((value) => path(value, false)));
      const absent = sortedUnique(array(e.absent, LIMITS.files).map((value) => path(value, false)));
      if (aliases.some((alias) => absent.includes(alias))) fail();
      if (artifact_id === null) {
        if (aliases.length || !absent.length) fail();
      } else if (!artifacts.some((a) => a.id === artifact_id && ["native", "launcher", "host"].includes(a.role)))
        fail();
      return { role, artifact_id, aliases, absent };
    })
    .sort((a, b) => compare(a.role, b.role));
  sortedUnique(result.map((e) => e.role));
  const present = new Map<string, string | null>();
  for (const entry of result) {
    for (const alias of entry.aliases) {
      if (present.has(alias) && present.get(alias) !== entry.artifact_id) fail();
      present.set(alias, entry.artifact_id);
    }
  }
  if (result.some((e) => e.absent.some((id) => present.has(id)))) fail();
  return result;
}

/** Validate deterministic evidence only; the returned object cannot authorize execution. */
export function createMarkdownProfile(input: MarkdownProfileInput): MarkdownProfileEvidence {
  const i = record(input, INPUT_FIELDS);
  const p = record(i.producer, ["inputs_sha256", "runtime"]);
  const producer: MarkdownProducer = { inputs_sha256: hash(p.inputs_sha256), runtime: runtime(p.runtime) };
  const versions = runtime(i.runtime);
  if (
    Object.keys(versions).some(
      (key) =>
        versions[key as keyof MarkdownRuntimeVersions] !== producer.runtime[key as keyof MarkdownRuntimeVersions],
    )
  )
    fail();
  const validatedPackages = packages(i.packages);
  const validatedArtifacts = artifacts(i.artifacts, validatedPackages, true);
  const policy = guard(validatedArtifacts, validatedPackages);
  const policyArtifact = validatedArtifacts.find((a) => a.role === "policy")!;
  if (policyArtifact.sha256 !== policy.sha256 || policyArtifact.bytes !== policy.bytes.length) fail();
  const manifest: MarkdownProfileManifest = {
    format: "host-markdown-runtime-v1",
    version: 1,
    recipe: "linux-x64-glibc-usr-lib-v1",
    producer,
    runtime: versions,
    artifacts: validatedArtifacts,
    directories: directories(i.directories, validatedArtifacts, validatedPackages),
    packages: validatedPackages,
    external_selection: externalSelection(i.external_selection, validatedArtifacts),
    contract: MARKDOWN_RUNTIME_CONTRACT,
  };
  const canonicalized = canonical(manifest);
  return Object.freeze({ manifest: canonicalized.value, sha256: sha256(canonicalized.bytes) });
}

/** Decode strictly canonical UTF8 evidence; no capability, cache authorization or filesystem effects occur. */
export function decodeMarkdownProfile(input: Uint8Array): MarkdownProfileEvidence {
  if (types.isProxy(input) || !types.isUint8Array(input)) fail();
  const buffer: ArrayBuffer = bufferOf.call(input);
  const length: number = lengthOf.call(input);
  if (types.isSharedArrayBuffer(buffer) || length < 1 || length > LIMITS.encodingBytes) fail();
  const bytes = new Uint8Array(new Uint8Array(buffer, offsetOf.call(input), length));
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  const r = record(decoded, [...INPUT_FIELDS, "format", "version", "recipe", "contract"]);
  if (r.format !== "host-markdown-runtime-v1" || r.version !== 1 || r.recipe !== "linux-x64-glibc-usr-lib-v1") fail();
  const profile = createMarkdownProfile(
    Object.fromEntries(INPUT_FIELDS.map((field) => [field, r[field]])) as unknown as MarkdownProfileInput,
  );
  const encoded = canonical(profile.manifest).bytes;
  if (bytes.length !== encoded.length || !bytes.every((value, index) => value === encoded[index])) fail();
  return profile;
}
