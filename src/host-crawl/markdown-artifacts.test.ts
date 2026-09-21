import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fstatSync, linkSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureMarkdownArtifactCandidate,
  disposeMarkdownArtifactCandidate,
  verifyMarkdownArtifactCandidate,
  withVerifiedMarkdownArtifactBindings,
  type MarkdownArtifactCandidate,
} from "./markdown-artifacts.ts";
import { MARKDOWN_ARTIFACT_LIMITS, type MarkdownArtifact } from "./markdown-profile.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";

const execFileAsync = promisify(execFile);
const TEST_PARENT = join(DEFAULT_EXTERNAL_ROOT, "tests", `markdown-artifacts-${process.pid}`);
const ARTIFACT_PARENT = join(DEFAULT_EXTERNAL_ROOT, "markdown-artifacts");
const IMPLEMENTATION_PATH = fileURLToPath(new URL("./markdown-artifacts.ts", import.meta.url));
const SOURCE_DIRECTORY = dirname(IMPLEMENTATION_PATH);

interface InternalDirectory {
  readonly path: string;
  readonly handle: FileHandle;
  readonly stamp: unknown;
  readonly ancestors: readonly unknown[];
}

interface InternalState {
  readonly handles: Set<FileHandle>;
  containerPath: string;
}

interface InternalScan {
  readonly files: readonly unknown[];
  readonly directories: readonly unknown[];
  readonly manifestBytes: Uint8Array;
}

interface Internals {
  openAbsoluteDirectory(path: string): Promise<InternalDirectory>;
  verifyRetainedDirectory(directory: InternalDirectory): Promise<void>;
  initialState(path: string, directory: InternalDirectory): InternalState;
  validateManifest(name: "argparse", bytes: Uint8Array, roots: ReadonlyMap<string, unknown>): unknown;
  validateLauncherSelectionOutput(output: Uint8Array): void;
  scanPackageTree(input: {
    state: InternalState;
    resolved: {
      name: "argparse";
      root: string;
      resolution: string;
      virtualRoot: "/app/node_modules/argparse";
    };
    root: InternalDirectory;
    entityRootStamp: null;
    capture: true;
    counters: { files: number; directories: Set<string>; appBytes: number; totalBytes: number };
    artifacts: MarkdownArtifact[];
    signal?: AbortSignal;
    seenDirectories: Set<string>;
  }): Promise<InternalScan>;
  captureStageTopology(state: InternalState, artifacts: readonly MarkdownArtifact[]): Promise<void>;
  cleanupState(state: InternalState, captureFailure?: boolean): Promise<void>;
}

interface SyntheticFixture {
  readonly root: string;
  readonly packageRoot: string;
  readonly container: string;
  readonly state: InternalState;
  packageDirectory: InternalDirectory;
  readonly artifacts: MarkdownArtifact[];
  readonly counters: { files: number; directories: Set<string>; appBytes: number; totalBytes: number };
  cleanup(): Promise<void>;
}

let internals: Internals;
let shared: MarkdownArtifactCandidate;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadInternals(): Promise<Internals> {
  const source = (await readFile(IMPLEMENTATION_PATH, "utf8")).replace(
    /(from\s+["'])(\.[^"']+)(["'])/g,
    (_match, prefix: string, specifier: string, suffix: string) =>
      `${prefix}${pathToFileURL(resolve(SOURCE_DIRECTORY, specifier)).href}${suffix}`,
  );
  const instrumented = `${source}\nexport const __artifactTestInternals = Object.freeze({ openAbsoluteDirectory, verifyRetainedDirectory, initialState, validateManifest, validateLauncherSelectionOutput, scanPackageTree, captureStageTopology, cleanupState });\n`;
  const transformed = stripTypeScriptTypes(instrumented, {
    mode: "strip",
    sourceUrl: pathToFileURL(IMPLEMENTATION_PATH).href,
  });
  const path = join(TEST_PARENT, `instrumented-${process.pid}.mjs`);
  await writeFile(path, transformed, { mode: 0o600 });
  const loaded = (await import(`${pathToFileURL(path).href}?${Date.now()}`)) as {
    __artifactTestInternals: Internals;
  };
  return loaded.__artifactTestInternals;
}

async function syntheticFixture(): Promise<SyntheticFixture> {
  const root = await mkdtemp(join(TEST_PARENT, "fixture-"));
  const packageRoot = join(root, "package");
  const container = join(root, "container");
  await mkdir(packageRoot, { mode: 0o700 });
  await mkdir(container, { mode: 0o700 });
  await writeFile(join(packageRoot, "package.json"), '{"name":"argparse","version":"3.0.2"}', { mode: 0o600 });
  const packageDirectory = await internals.openAbsoluteDirectory(packageRoot);
  const containerDirectory = await internals.openAbsoluteDirectory(container);
  const state = internals.initialState(container, containerDirectory);
  state.handles.add(packageDirectory.handle);
  let cleaned = false;
  return {
    root,
    packageRoot,
    container,
    state,
    packageDirectory,
    artifacts: [],
    counters: { files: 0, directories: new Set(["/", "/app", "/dev"]), appBytes: 0, totalBytes: 0 },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await internals.cleanupState(state, true).catch(() => undefined);
      await packageDirectory.handle.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function scanFixture(fixture: SyntheticFixture, signal?: AbortSignal): Promise<InternalScan> {
  fixture.state.handles.delete(fixture.packageDirectory.handle);
  await fixture.packageDirectory.handle.close();
  fixture.packageDirectory = await internals.openAbsoluteDirectory(fixture.packageRoot);
  fixture.state.handles.add(fixture.packageDirectory.handle);
  return internals.scanPackageTree({
    state: fixture.state,
    resolved: {
      name: "argparse",
      root: fixture.packageRoot,
      resolution: join(fixture.packageRoot, "index.js"),
      virtualRoot: "/app/node_modules/argparse",
    },
    root: fixture.packageDirectory,
    entityRootStamp: null,
    capture: true,
    counters: fixture.counters,
    artifacts: fixture.artifacts,
    signal,
    seenDirectories: new Set(),
  });
}

async function candidateNames(): Promise<readonly string[]> {
  try {
    return (await readdir(ARTIFACT_PARENT)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

beforeAll(async () => {
  await mkdir(TEST_PARENT, { recursive: true, mode: 0o700 });
  internals = await loadInternals();
  shared = await captureMarkdownArtifactCandidate();
}, 120_000);

afterAll(async () => {
  if (shared !== undefined) await disposeMarkdownArtifactCandidate(shared);
  await rm(TEST_PARENT, { recursive: true, force: true });
}, 120_000);

describe("descriptor-anchored synthetic capture", () => {
  it("copies complete bytes, preserves empty directories, and seals the owned tree", async () => {
    const fixture = await syntheticFixture();
    try {
      const content = Buffer.from("export default 1;\n", "utf8");
      await writeFile(join(fixture.packageRoot, "index.js"), content, { mode: 0o600 });
      await mkdir(join(fixture.packageRoot, "empty"), { mode: 0o700 });
      const scan = await scanFixture(fixture);
      expect(scan.files).toHaveLength(2);
      expect(scan.directories).toHaveLength(2);
      await internals.captureStageTopology(fixture.state, fixture.artifacts);
      const copied = await readFile(join(fixture.container, "root/app/node_modules/argparse/index.js"));
      expect(copied).toEqual(content);
      expect(statSync(join(fixture.container, "root/app/node_modules/argparse/index.js")).mode & 0o777).toBe(0o400);
      expect(statSync(join(fixture.container, "root/app/node_modules/argparse/empty")).mode & 0o777).toBe(0o500);
      expect(fixture.artifacts.find((artifact) => artifact.virtual_path?.endsWith("/index.js"))?.sha256).toBe(
        digest(content),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("cleans a partially sealed tree when directory sealing fails", async () => {
    const fixture = await syntheticFixture();
    const prototype = Object.getPrototypeOf(fixture.packageDirectory.handle) as { chmod: FileHandle["chmod"] };
    const originalChmod = prototype.chmod;
    let chmodCalls = 0;
    try {
      const directory = join(fixture.container, "root/app/nested");
      const bytes = Buffer.from("owned staged bytes\n", "utf8");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "artifact.txt"), bytes, { mode: 0o400 });
      const artifacts: MarkdownArtifact[] = [
        {
          id: "source/artifact.txt",
          role: "source",
          virtual_path: "/app/nested/artifact.txt",
          bytes: bytes.length,
          sha256: digest(bytes),
          mode: 0o400,
          elf: null,
        },
      ];
      prototype.chmod = async function injectedChmod(this: FileHandle, mode: string | number) {
        chmodCalls += 1;
        if (chmodCalls === 2) throw new Error("injected directory seal failure");
        await originalChmod.call(this, mode);
      };
      await expect(internals.captureStageTopology(fixture.state, artifacts)).rejects.toThrow(
        "injected directory seal failure",
      );
      prototype.chmod = originalChmod;
      await expect(internals.cleanupState(fixture.state, true)).resolves.toBeUndefined();
      expect(() => statSync(fixture.container)).toThrow();
    } finally {
      prototype.chmod = originalChmod;
      await fixture.cleanup();
    }
  });

  it("rejects symlinks without following them", async () => {
    const fixture = await syntheticFixture();
    try {
      await symlink("package.json", join(fixture.packageRoot, "alias"));
      await expect(scanFixture(fixture)).rejects.toThrow(/symlink|special/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects hard-linked files", async () => {
    const fixture = await syntheticFixture();
    try {
      linkSync(join(fixture.packageRoot, "package.json"), join(fixture.packageRoot, "second.json"));
      await expect(scanFixture(fixture)).rejects.toThrow(/identity/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects special files", async () => {
    const fixture = await syntheticFixture();
    try {
      await execFileAsync("/usr/bin/mkfifo", [join(fixture.packageRoot, "pipe")], {
        env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin" },
      });
      await expect(scanFixture(fixture)).rejects.toThrow(/unsupported|special/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects non-portable names", async () => {
    const fixture = await syntheticFixture();
    try {
      await writeFile(join(fixture.packageRoot, "bad name"), "x");
      await expect(scanFixture(fixture)).rejects.toThrow(/portable/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects unsupported nested package scopes", async () => {
    const fixture = await syntheticFixture();
    try {
      await mkdir(join(fixture.packageRoot, "nested"));
      await writeFile(join(fixture.packageRoot, "nested/package.json"), "{}");
      await expect(scanFixture(fixture)).rejects.toThrow(/nested package scope/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects unsupported nested node_modules trees", async () => {
    const fixture = await syntheticFixture();
    try {
      await mkdir(join(fixture.packageRoot, "node_modules"));
      await expect(scanFixture(fixture)).rejects.toThrow(/node_modules/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects files beyond the source-file bound before reading them", async () => {
    const fixture = await syntheticFixture();
    try {
      const path = join(fixture.packageRoot, "large.bin");
      await writeFile(path, "");
      await truncate(path, MARKDOWN_ARTIFACT_LIMITS.sourceFileBytes + 1);
      await expect(scanFixture(fixture)).rejects.toThrow(/exceeds limit/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects excess file membership", async () => {
    const fixture = await syntheticFixture();
    try {
      await Promise.all(
        Array.from({ length: MARKDOWN_ARTIFACT_LIMITS.files }, (_, index) =>
          writeFile(join(fixture.packageRoot, `f-${index.toString().padStart(3, "0")}`), ""),
        ),
      );
      await expect(scanFixture(fixture)).rejects.toThrow(/too many artifact files/i);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("rejects excess directory membership", async () => {
    const fixture = await syntheticFixture();
    try {
      await Promise.all(
        Array.from({ length: MARKDOWN_ARTIFACT_LIMITS.directories - 3 }, (_, index) =>
          mkdir(join(fixture.packageRoot, `d-${index.toString().padStart(3, "0")}`)),
        ),
      );
      await expect(scanFixture(fixture)).rejects.toThrow(/too many artifact directories/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects excess depth", async () => {
    const fixture = await syntheticFixture();
    try {
      let path = fixture.packageRoot;
      for (let index = 0; index < MARKDOWN_ARTIFACT_LIMITS.depth; index += 1) {
        path = join(path, `d${index}`);
        await mkdir(path);
      }
      await expect(scanFixture(fixture)).rejects.toThrow(/deep/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("honors cancellation without publishing partial evidence", async () => {
    const fixture = await syntheticFixture();
    try {
      const controller = new AbortController();
      controller.abort(new Error("cancelled fixture"));
      await expect(scanFixture(fixture, controller.signal)).rejects.toThrow("cancelled fixture");
      expect(fixture.artifacts).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a symlinked traversal ancestor", async () => {
    const root = await mkdtemp(join(TEST_PARENT, "ancestor-"));
    try {
      await mkdir(join(root, "real"));
      await symlink(join(root, "real"), join(root, "alias"));
      await expect(internals.openAbsoluteDirectory(join(root, "alias"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows unrelated ancestor membership but rejects ancestor permission changes", async () => {
    const root = await mkdtemp(join(TEST_PARENT, "ancestor-metadata-"));
    const ancestor = join(root, "ancestor");
    const leaf = join(ancestor, "leaf");
    await mkdir(leaf, { recursive: true, mode: 0o700 });
    const retained = await internals.openAbsoluteDirectory(leaf);
    try {
      await mkdir(join(ancestor, "unrelated"), { mode: 0o700 });
      await expect(internals.verifyRetainedDirectory(retained)).resolves.toBeUndefined();
      chmodSync(ancestor, 0o500);
      await expect(internals.verifyRetainedDirectory(retained)).rejects.toThrow(/binding changed/i);
    } finally {
      await retained.handle.close();
      chmodSync(ancestor, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("fixed package and launcher admission", () => {
  it("rejects optional dependency metadata arrangements", () => {
    for (const field of ["dependenciesMeta", "peerDependenciesMeta"] as const) {
      for (const value of [{ argparse: { optional: true } }, {}, null]) {
        const manifest = Buffer.from(
          JSON.stringify({ name: "argparse", version: "3.0.2", dependencies: {}, [field]: value }),
          "utf8",
        );
        expect(() => internals.validateManifest("argparse", manifest, new Map<string, unknown>())).toThrow(
          /unsupported package dependency field/i,
        );
      }
    }
  });

  it("admits only one exact valid UTF-8 loader selection per expected dependency", () => {
    const lines = [
      "\tlinux-vdso.so.1 (0x1)",
      "\tlibcap.so.2 => /usr/lib/libcap.so.2 (0x2)",
      "\tlibgcc_s.so.1 => /usr/lib/libgcc_s.so.1 (0x3)",
      "\tlibc.so.6 => /usr/lib/libc.so.6 (0x4)",
      "\t/lib64/ld-linux-x86-64.so.2 => /proc/self/fd/3 (0x5)",
    ];
    const encode = (values: readonly string[]) => Buffer.from(`${values.join("\n")}\n`, "utf8");
    expect(() => internals.validateLauncherSelectionOutput(encode(lines))).not.toThrow();
    const rejected = [
      [lines[1]!, ...lines],
      ["\tlibcap.so.2 => /tmp/unreviewed.so (0x0)", ...lines],
      ["UNRECOGNIZED LOADER RECORD", ...lines],
      [lines[0]!, ...lines],
      ["\tlinux-vdso.so.2 (0x1)", ...lines.slice(1)],
      lines.slice(1),
      ["\tlibextra.so.1 => /tmp/libextra.so.1 (0x0)", ...lines],
    ];
    for (const value of rejected) {
      expect(() => internals.validateLauncherSelectionOutput(encode(value))).toThrow();
    }
    expect(() =>
      internals.validateLauncherSelectionOutput(Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), encode(lines)])),
    ).toThrow(/UTF-8/i);
    expect(() => internals.validateLauncherSelectionOutput(Buffer.from(lines.join("\n"), "utf8"))).toThrow(/terminal/i);
  });
});

describe("real Linux-x64 artifact evidence", () => {
  it("publishes only frozen profile evidence", () => {
    expect(Object.keys(shared)).toEqual(["profile"]);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.profile)).toBe(true);
    expect(JSON.stringify(shared)).not.toContain("/home/admin");
    expect(JSON.stringify(shared)).not.toContain(DEFAULT_EXTERNAL_ROOT);
    expect(shared.profile.manifest.runtime).toMatchObject({ platform: "linux", arch: "x64" });
  });

  it("captures the exact package graph and source bytes", async () => {
    const packages = Object.fromEntries(shared.profile.manifest.packages.map((entry) => [entry.name, entry]));
    expect(Object.keys(packages).sort()).toEqual([
      "argparse",
      "entities",
      "linkify-it",
      "markdown-it",
      "mdurl",
      "punycode.js",
      "ubc-markdown-runtime",
      "uc.micro",
    ]);
    expect(packages["markdown-it"]?.version).toBe("15.0.2");
    expect(packages.argparse?.version).toBe("3.0.2");
    expect(packages.entities?.version).toBe("8.1.0");
    expect(packages["linkify-it"]?.version).toBe("6.1.0");
    expect(packages.mdurl?.version).toBe("2.1.0");
    expect(packages["punycode.js"]?.version).toBe("2.3.1");
    expect(packages["uc.micro"]?.version).toBe("3.0.0");
    for (const name of [
      "markdown-bootstrap.mjs",
      "markdown-contract.mjs",
      "markdown-inspection.mjs",
      "markdown-protocol.mjs",
      "markdown-worker.mjs",
    ]) {
      const bytes = await readFile(join(SOURCE_DIRECTORY, name));
      const artifact = shared.profile.manifest.artifacts.find((entry) => entry.virtual_path === `/app/${name}`);
      expect(artifact).toMatchObject({ bytes: bytes.length, sha256: digest(bytes), mode: 0o400, elf: null });
    }
  });

  it("records the reviewed native dependency edges and launcher facts", () => {
    const artifacts = Object.fromEntries(shared.profile.manifest.artifacts.map((entry) => [entry.id, entry]));
    expect(artifacts["native/node"]?.elf).toMatchObject({
      class: 64,
      data: "little",
      machine: 62,
      type: 2,
      interpreter: "/lib64/ld-linux-x86-64.so.2",
      needed: [
        "libatomic.so.1",
        "libdl.so.2",
        "libm.so.6",
        "libstdc++.so.6",
        "libgcc_s.so.1",
        "libpthread.so.0",
        "libc.so.6",
        "ld-linux-x86-64.so.2",
      ],
      bind_now: true,
    });
    expect(artifacts["launcher/bwrap"]?.elf?.needed).toEqual(["libcap.so.2", "libgcc_s.so.1", "libc.so.6"]);
    expect(artifacts["native/prlimit"]?.elf?.needed).toEqual(["libsmartcols.so.1", "libc.so.6"]);
    expect(artifacts["host/loader-cache"]).toMatchObject({ role: "host", virtual_path: null, elf: null });
    expect(shared.profile.manifest.external_selection).toEqual(
      [...shared.profile.manifest.external_selection].sort((left, right) => left.role.localeCompare(right.role)),
    );
    expect(
      shared.profile.manifest.external_selection.find((entry) => entry.role === "launcher-preload")?.absent,
    ).toEqual(["etc/ld.so.preload"]);
  });

  it("reverifies unchanged candidates", async () => {
    await expect(verifyMarkdownArtifactCandidate(shared)).resolves.toBeUndefined();
  }, 120_000);

  it("issues complete canonical fresh bindings and closes them before returning", async () => {
    let descriptors: number[] = [];
    await withVerifiedMarkdownArtifactBindings(shared, async (bindings) => {
      const expectedArtifacts = shared.profile.manifest.artifacts.filter((artifact) => artifact.virtual_path !== null);
      expect(bindings.mounts.map(({ virtual_path }) => virtual_path)).toEqual(
        expectedArtifacts.map((artifact) => artifact.virtual_path),
      );
      descriptors = [bindings.launcher_fd, ...bindings.mounts.map((mount) => mount.source_fd)];
      expect(new Set(descriptors).size).toBe(descriptors.length);
      for (const descriptor of descriptors) expect(fstatSync(descriptor).isFile()).toBe(true);
      const policyIndex = expectedArtifacts.findIndex((artifact) => artifact.id === "app/guard-policy");
      const policyMount = bindings.mounts[policyIndex]!;
      const policyBytes = await readFile(`/proc/self/fd/${policyMount.source_fd}`);
      const policyArtifact = expectedArtifacts[policyIndex]!;
      expect(digest(policyBytes)).toBe(policyArtifact.sha256);
      const policy = JSON.parse(policyBytes.toString("utf8")) as { version: number; files: unknown[] };
      expect(policy.version).toBe(1);
      expect(policy.files.length).toBeGreaterThan(100);
      await Promise.resolve();
      expect(fstatSync(bindings.launcher_fd).isFile()).toBe(true);
    });
    for (const descriptor of descriptors) expect(() => fstatSync(descriptor)).toThrow();
  }, 120_000);

  it("refuses concurrent leases while awaiting the active callback", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolvePromise) => {
      enter = resolvePromise;
    });
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const active = withVerifiedMarkdownArtifactBindings(shared, async () => {
      enter();
      await gate;
      return 7;
    });
    await entered;
    await expect(withVerifiedMarkdownArtifactBindings(shared, () => 8)).rejects.toThrow(/active lease/i);
    release();
    await expect(active).resolves.toBe(7);
  }, 120_000);

  it("closes callback descriptors after a callback error without treating that error as evidence mutation", async () => {
    let descriptor = -1;
    await expect(
      withVerifiedMarkdownArtifactBindings(shared, (bindings) => {
        descriptor = bindings.mounts[0]!.source_fd;
        throw new Error("callback refused");
      }),
    ).rejects.toThrow("callback refused");
    expect(() => fstatSync(descriptor)).toThrow();
    await expect(verifyMarkdownArtifactCandidate(shared)).resolves.toBeUndefined();
  }, 120_000);

  it("refuses forged, cloned, and serialized candidates", async () => {
    const forged = Object.freeze({ profile: shared.profile }) as MarkdownArtifactCandidate;
    const cloned = structuredClone(shared) as MarkdownArtifactCandidate;
    const inherited = Object.create(shared) as MarkdownArtifactCandidate;
    const serialized = JSON.parse(JSON.stringify(shared)) as MarkdownArtifactCandidate;
    for (const candidate of [forged, cloned, inherited, serialized]) {
      await expect(verifyMarkdownArtifactCandidate(candidate)).rejects.toThrow(/forged/i);
      await expect(withVerifiedMarkdownArtifactBindings(candidate, () => undefined)).rejects.toThrow(/forged/i);
      await expect(disposeMarkdownArtifactCandidate(candidate)).rejects.toThrow(/forged/i);
    }
  });
});

describe("revocation, cancellation, and disposal", () => {
  it("cancels before capture without creating an owned container", async () => {
    const before = await candidateNames();
    const controller = new AbortController();
    controller.abort(new Error("capture cancelled"));
    await expect(captureMarkdownArtifactCandidate(controller.signal)).rejects.toThrow("capture cancelled");
    expect(await candidateNames()).toEqual(before);
  });

  it("cancels during capture, cleans partial copies, and returns no candidate", async () => {
    const before = await candidateNames();
    const controller = new AbortController();
    const capture = captureMarkdownArtifactCandidate(controller.signal);
    setTimeout(() => controller.abort(new Error("capture interrupted")), 0);
    await expect(capture).rejects.toThrow("capture interrupted");
    expect(await candidateNames()).toEqual(before);
  }, 120_000);

  it("sticky-revokes after callback-visible staged mutation and still authenticates cleanup", async () => {
    const candidate = await captureMarkdownArtifactCandidate();
    try {
      await expect(
        withVerifiedMarkdownArtifactBindings(candidate, (bindings) => {
          chmodSync(`/proc/self/fd/${bindings.mounts[0]!.source_fd}`, 0o600);
        }),
      ).rejects.toThrow(/staged file changed|verification failed/i);
      await expect(verifyMarkdownArtifactCandidate(candidate)).rejects.toThrow(/revoked|unavailable/i);
      await expect(withVerifiedMarkdownArtifactBindings(candidate, () => undefined)).rejects.toThrow(/revoked/i);
    } finally {
      await disposeMarkdownArtifactCandidate(candidate);
    }
  }, 120_000);

  it("sticky-revokes a callback descriptor close failure", async () => {
    const candidate = await captureMarkdownArtifactCandidate();
    try {
      await expect(
        withVerifiedMarkdownArtifactBindings(candidate, (bindings) => {
          closeSync(bindings.mounts[0]!.source_fd);
        }),
      ).rejects.toThrow(/close|descriptor|binding/i);
      await expect(verifyMarkdownArtifactCandidate(candidate)).rejects.toThrow(/revoked|unavailable/i);
    } finally {
      await disposeMarkdownArtifactCandidate(candidate);
    }
  }, 120_000);

  it("rejects stale verification success when disposal starts during verification", async () => {
    const candidate = await captureMarkdownArtifactCandidate();
    const verification = verifyMarkdownArtifactCandidate(candidate);
    const disposal = disposeMarkdownArtifactCandidate(candidate);
    await expect(verification).rejects.toThrow(/disposed during verification/i);
    await expect(disposal).resolves.toBeUndefined();
    await expect(disposeMarkdownArtifactCandidate(candidate)).resolves.toBeUndefined();
  }, 120_000);

  it("revokes first, waits for an active lease, and disposes idempotently", async () => {
    const candidate = await captureMarkdownArtifactCandidate();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolvePromise) => {
      enter = resolvePromise;
    });
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const active = withVerifiedMarkdownArtifactBindings(candidate, async () => {
      enter();
      await gate;
    });
    await entered;
    let disposed = false;
    const disposal = disposeMarkdownArtifactCandidate(candidate).then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    await expect(verifyMarkdownArtifactCandidate(candidate)).rejects.toThrow(/unavailable|revoked/i);
    release();
    await expect(active).rejects.toThrow(/disposed/i);
    await disposal;
    expect(disposed).toBe(true);
    await expect(disposeMarkdownArtifactCandidate(candidate)).resolves.toBeUndefined();
    await expect(withVerifiedMarkdownArtifactBindings(candidate, () => undefined)).rejects.toThrow(/revoked/i);
  }, 120_000);
});
