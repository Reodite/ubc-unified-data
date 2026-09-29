import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MARKDOWN_INSPECTION_DIALECT, MARKDOWN_INSPECTION_LIMITS } from "./markdown-contract.mjs";
import {
  createMarkdownGuardPolicy,
  createMarkdownProfile,
  decodeMarkdownProfile,
  MARKDOWN_ARTIFACT_LIMITS,
  MARKDOWN_RUNTIME_LIMITS,
  type MarkdownArtifact,
  type MarkdownPackage,
  type MarkdownProfileInput,
} from "./markdown-profile.ts";
import { MARKDOWN_PROTOCOL_LIMITS } from "./markdown-protocol.mjs";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const root = (name: string) =>
  name === "entities" ? "/app/node_modules/markdown-it/node_modules/entities" : `/app/node_modules/${name}`;
function prePolicy() {
  const packages: MarkdownPackage[] = [
    {
      root: "/app",
      name: "ubc-markdown-runtime",
      version: "1.0.0",
      type: "module",
      dependencies: [{ name: "markdown-it", range: "15.0.2", root: root("markdown-it") }],
    },
    ...["markdown-it", "argparse", "linkify-it", "mdurl", "punycode.js", "uc.micro", "entities"].map(
      (name): MarkdownPackage => ({
        root: root(name),
        name,
        version: name === "markdown-it" ? "15.0.2" : "1.0.0",
        type: name === "argparse" ? "commonjs" : "module",
        dependencies: (name === "markdown-it"
          ? ["argparse", "entities", "linkify-it", "mdurl", "punycode.js", "uc.micro"]
          : name === "linkify-it"
            ? ["uc.micro"]
            : []
        ).map((name) => ({ name, range: "^1.0.0", root: root(name) })),
      }),
    ),
  ];
  const artifact = (path: string, role: MarkdownArtifact["role"]): MarkdownArtifact => ({
    id: path.slice(1),
    role,
    virtual_path: path,
    bytes: 1,
    sha256: hash(path),
    mode: 0o400,
    elf: null,
  });
  const artifacts = [
    ...["bootstrap", "worker", "contract", "inspection", "protocol"].map((name) =>
      artifact(`/app/markdown-${name}.mjs`, "source"),
    ),
    ...packages.map((p) => artifact(`${p.root}/package.json`, p.root === "/app" ? "app-metadata" : "package")),
    artifact(`${root("argparse")}/index.js`, "package"),
    artifact(`${root("markdown-it")}/index.js`, "package"),
    artifact(`${root("markdown-it")}/README.md`, "package"),
    artifact(`${root("markdown-it")}/test.cjs`, "package"),
  ];
  return { artifacts, packages };
}
function fixture(): MarkdownProfileInput {
  const { artifacts, packages } = prePolicy();
  const policy = createMarkdownGuardPolicy(artifacts, packages);
  artifacts.push({
    id: "app/markdown-guard-policy.json",
    role: "policy",
    virtual_path: "/app/markdown-guard-policy.json",
    bytes: policy.bytes.length,
    sha256: policy.sha256,
    mode: 0o400,
    elf: null,
  });
  const directories = new Set(["/", "/app", "/dev", `${root("markdown-it")}/empty`]);
  for (const a of artifacts) {
    let path = a.virtual_path!.slice(0, a.virtual_path!.lastIndexOf("/"));
    while (path) {
      directories.add(path);
      path = path.slice(0, path.lastIndexOf("/"));
    }
  }
  const runtime = { node: "24.18.0", icu: "77.1", unicode: "16.0", platform: "linux", arch: "x64" };
  return {
    producer: { inputs_sha256: "a".repeat(64), runtime },
    runtime,
    artifacts,
    packages,
    directories: [...directories],
    external_selection: [],
  };
}
function rebindPolicy(input: MarkdownProfileInput): MarkdownProfileInput {
  const artifacts = input.artifacts.filter((a) => a.role !== "policy");
  const policy = createMarkdownGuardPolicy(artifacts, input.packages);
  return {
    ...input,
    artifacts: [
      ...artifacts,
      {
        id: "app/markdown-guard-policy.json",
        role: "policy",
        virtual_path: "/app/markdown-guard-policy.json",
        bytes: policy.bytes.length,
        sha256: policy.sha256,
        mode: 0o400,
        elf: null,
      },
    ],
  };
}
function checkFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) checkFrozen(child);
}

describe("pure Markdown guard policy", () => {
  it("includes all child files, exact formats and fixed per-source builtin lists", () => {
    const input = prePolicy();
    const result = createMarkdownGuardPolicy(input.artifacts, input.packages);
    const policy = JSON.parse(Buffer.from(result.bytes).toString("utf8"));
    expect(Object.keys(policy).sort()).toEqual(["builtins", "files", "packages", "version"]);
    expect(policy.files).toHaveLength(input.artifacts.length);
    expect(policy.files.find((file: { path: string }) => file.path.endsWith("README.md")).format).toBe("data");
    expect(policy.files.find((file: { path: string }) => file.path.endsWith("argparse/index.js")).format).toBe(
      "commonjs",
    );
    expect(policy.files.find((file: { path: string }) => file.path.endsWith("markdown-it/index.js")).format).toBe(
      "module",
    );
    expect(policy.files.find((file: { path: string }) => file.path.endsWith("test.cjs")).format).toBe("commonjs");
    expect(policy.builtins).toEqual([
      {
        parent: "/app/markdown-bootstrap.mjs",
        allowed: ["node:crypto", "node:fs", "node:module", "node:url", "node:util"],
      },
      { parent: "/app/markdown-contract.mjs", allowed: [] },
      { parent: "/app/markdown-inspection.mjs", allowed: ["node:crypto", "node:util"] },
      { parent: "/app/markdown-protocol.mjs", allowed: ["node:buffer", "node:crypto", "node:util"] },
      { parent: "/app/markdown-worker.mjs", allowed: [] },
    ]);
    expect(result.sha256).toBe(hash(result.bytes));
    expect(Buffer.from(result.bytes)).toEqual(
      Buffer.from(
        JSON.stringify({
          version: 1,
          files: policy.files,
          packages: policy.packages,
          builtins: policy.builtins,
        }),
      ),
    );
    expect(Buffer.from(result.bytes).toString()).not.toContain("markdown-guard-policy.json");
    expect(createMarkdownGuardPolicy([...input.artifacts].reverse(), [...input.packages].reverse())).toEqual(result);
  });

  it.each(["\n", "\r", "\u2028", "\u2029"])(
    "rejects trailing line terminators on generic package paths %j",
    (suffix) => {
      const pre = prePolicy();
      pre.artifacts.push({
        ...pre.artifacts[0]!,
        id: `package/data${suffix}`,
        role: "package",
        virtual_path: `${root("markdown-it")}/data${suffix}`,
      });
      expect(() => createMarkdownGuardPolicy(pre.artifacts, pre.packages)).toThrow();
    },
  );

  it("rejects conflicting file and directory topology before policy construction", () => {
    const pre = prePolicy();
    pre.artifacts.push({
      ...pre.artifacts[0]!,
      id: "extra",
      role: "package",
      virtual_path: `${root("markdown-it")}/README.md/child.txt`,
    });
    expect(() => createMarkdownGuardPolicy(pre.artifacts, pre.packages)).toThrow();
  });

  it.each([
    "",
    " ",
    "latest",
    "nonsense",
    "^",
    "1.0.0 ||",
    "file:../package",
    "npm:alias@1",
    "https://example.invalid",
  ])("refuses unsupported dependency range %s", (range) => {
    const pre = prePolicy();
    pre.packages[1] = {
      ...pre.packages[1]!,
      dependencies: pre.packages[1]!.dependencies.map((d) => ({ ...d, range })),
    };
    expect(() => createMarkdownGuardPolicy(pre.artifacts, pre.packages)).toThrow();
  });

  it.each([255, 256])("bounds dependency ranges at the worker's %i-character boundary", (length) => {
    const pre = prePolicy();
    pre.packages[1] = {
      ...pre.packages[1]!,
      dependencies: pre.packages[1]!.dependencies.map((d) => ({ ...d, range: "^1.0.0".padEnd(length, " ") })),
    };
    if (length === 255) expect(() => createMarkdownGuardPolicy(pre.artifacts, pre.packages)).not.toThrow();
    else expect(() => createMarkdownGuardPolicy(pre.artifacts, pre.packages)).toThrow();
  });

  it("refuses policy self-inclusion and unsupported nested scopes", () => {
    const input = fixture();
    expect(() => createMarkdownGuardPolicy(input.artifacts, input.packages)).toThrow();
    const pre = prePolicy();
    pre.artifacts.push({
      ...pre.artifacts[0]!,
      id: "extra",
      role: "package",
      virtual_path: `${root("mdurl")}/sub/package.json`,
    });
    expect(() => createMarkdownGuardPolicy(pre.artifacts, pre.packages)).toThrow();
  });
});

describe("Markdown profile evidence", () => {
  it("round trips frozen evidence with fixed derived contract and no authority", () => {
    const result = createMarkdownProfile(fixture());
    const encoded = Buffer.from(JSON.stringify(result.manifest));
    expect(decodeMarkdownProfile(encoded)).toEqual(result);
    expect(result.sha256).toBe(hash(encoded));
    checkFrozen(result);
    expect(Object.keys(result).sort()).toEqual(["manifest", "sha256"]);
    expect(result.manifest).toMatchObject({
      format: "host-markdown-runtime-v1",
      version: 1,
      recipe: "linux-x64-glibc-usr-lib-v1",
    });
    expect(result.manifest.contract).toMatchObject({
      dialect: MARKDOWN_INSPECTION_DIALECT,
      inspection: MARKDOWN_INSPECTION_LIMITS,
      protocol: MARKDOWN_PROTOCOL_LIMITS,
      artifacts: MARKDOWN_ARTIFACT_LIMITS,
      runtime: MARKDOWN_RUNTIME_LIMITS,
    });
    expect(Object.isFrozen(MARKDOWN_ARTIFACT_LIMITS)).toBe(true);
    expect(Object.isFrozen(MARKDOWN_RUNTIME_LIMITS)).toBe(true);
  });

  it("round trips bounded evidence mutations with a fixed property seed", () => {
    const baseline = fixture();
    const original = createMarkdownProfile(baseline);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 2, max: 8388608 }), (index, bytes) => {
        const input = {
          ...baseline,
          artifacts: baseline.artifacts.map((artifact, at) => (at === index ? { ...artifact, bytes } : artifact)),
        };
        const evidence = createMarkdownProfile(input);
        expect(evidence.sha256).not.toBe(original.sha256);
        expect(decodeMarkdownProfile(Buffer.from(JSON.stringify(evidence.manifest)))).toEqual(evidence);
        expect(createMarkdownProfile({ ...input, artifacts: [...input.artifacts].reverse() })).toEqual(evidence);
      }),
      { seed: 0x4d445031, numRuns: 100 },
    );
  });

  it("sorts logical records and never binds caller object identity", () => {
    const input = fixture();
    const first = createMarkdownProfile(input);
    const reordered = {
      ...input,
      artifacts: [...input.artifacts].reverse(),
      packages: [...input.packages].reverse().map((p) => ({ ...p, dependencies: [...p.dependencies].reverse() })),
      directories: [...input.directories].reverse(),
    };
    expect(createMarkdownProfile(reordered)).toEqual(first);
    expect(createMarkdownProfile(structuredClone(input))).toEqual(first);
  });

  it.each(["producer", "runtime", "artifacts", "directories", "packages", "external_selection"])(
    "requires exact top-level %s field",
    (key) => {
      const input = fixture() as unknown as Record<string, unknown>;
      delete input[key];
      expect(() => createMarkdownProfile(input as unknown as MarkdownProfileInput)).toThrow();
    },
  );

  it.each(["unknown", "contract", "source_path", "stage_path", "pid", "time"])(
    "rejects extraneous %s fields",
    (key) => {
      expect(() => createMarkdownProfile({ ...fixture(), [key]: "not evidence" } as MarkdownProfileInput)).toThrow();
    },
  );

  it.each([
    "/app/../bad",
    "app/relative",
    "/app//bad",
    "/app/%bad",
    "/app/a,b",
    "/app/*",
    "/app/雪",
    "/app/a\\b",
    "/app/a\n",
    `/app/${"x".repeat(256)}`,
  ])("rejects unsafe child path %s", (path) => {
    const input = fixture();
    const artifacts = [...input.artifacts];
    artifacts[0] = { ...artifacts[0]!, virtual_path: path };
    expect(() => createMarkdownProfile({ ...input, artifacts })).toThrow();
  });

  it.each([
    "duplicate-id",
    "duplicate-path",
    "duplicate-directory",
    "file-directory",
    "missing-parent",
    "missing-package-manifest",
    "unknown-root",
    "unknown-dependency",
    "missing-policy",
    "wrong-policy-sha",
    "wrong-policy-size",
    "wrong-runtime",
    "null-elf",
    "bad-external-reference",
  ])("rejects %s", (mutation) => {
    const input = structuredClone(fixture());
    const artifacts = [...input.artifacts];
    const packages = [...input.packages];
    let directories = [...input.directories];
    if (mutation === "duplicate-id") artifacts[1] = { ...artifacts[1]!, id: artifacts[0]!.id };
    if (mutation === "duplicate-path") artifacts[1] = { ...artifacts[1]!, virtual_path: artifacts[0]!.virtual_path };
    if (mutation === "duplicate-directory") directories.push("/app");
    if (mutation === "file-directory") directories.push(artifacts[0]!.virtual_path!);
    if (mutation === "missing-parent") directories = directories.filter((p) => p !== "/app/node_modules");
    if (mutation === "missing-package-manifest") artifacts.splice(5, 1);
    if (mutation === "unknown-root") packages[1] = { ...packages[1]!, root: "/other" };
    if (mutation === "unknown-dependency")
      packages[0] = { ...packages[0]!, dependencies: [{ name: "markdown-it", range: "15.0.2", root: root("mdurl") }] };
    if (mutation === "missing-policy") artifacts.pop();
    if (mutation === "wrong-policy-sha")
      artifacts[artifacts.length - 1] = { ...artifacts.at(-1)!, sha256: "b".repeat(64) };
    if (mutation === "wrong-policy-size") artifacts[artifacts.length - 1] = { ...artifacts.at(-1)!, bytes: 1 };
    const runtime = mutation === "wrong-runtime" ? { ...input.runtime, platform: "darwin" } : input.runtime;
    if (mutation === "null-elf")
      artifacts.push({
        id: "native/node",
        role: "native",
        virtual_path: "/runtime/node",
        bytes: 10,
        sha256: "c".repeat(64),
        mode: 0o500,
        elf: null,
      });
    const external_selection =
      mutation === "bad-external-reference"
        ? [{ role: "loader", artifact_id: "missing", aliases: ["usr/lib/loader"], absent: [] }]
        : input.external_selection;
    expect(() =>
      createMarkdownProfile({ ...input, artifacts, packages, directories, runtime, external_selection }),
    ).toThrow();
  });

  it("refuses getter, hook, proxy, sparse array and unsupported prototype inputs without invocation", () => {
    let called = 0;
    const getter = fixture();
    Object.defineProperty(getter, "artifacts", {
      get() {
        called++;
        throw new Error();
      },
    });
    const hook = {
      ...fixture(),
      toJSON() {
        called++;
        throw new Error();
      },
    };
    const proxy = new Proxy(fixture(), {
      ownKeys() {
        called++;
        throw new Error();
      },
    });
    const inherited = Object.create(fixture());
    const sparse = { ...fixture(), directories: Array(3) };
    const symbol = { ...fixture(), [Symbol("bad")]: 1 };
    for (const input of [getter, hook, proxy, inherited, sparse, symbol])
      expect(() => createMarkdownProfile(input)).toThrow();
    expect(called).toBe(0);
    const cycle = fixture();
    (cycle as unknown as Record<string, unknown>).producer = cycle;
    expect(() => createMarkdownProfile(cycle)).toThrow();
  });

  it.each([NaN, Infinity, -0, -1, 1.5, 8 * 1024 * 1024 + 1])("rejects artifact byte count %s", (bytes) => {
    const input = fixture();
    const artifacts = [...input.artifacts];
    artifacts[0] = { ...artifacts[0]!, bytes };
    expect(() => createMarkdownProfile({ ...input, artifacts })).toThrow();
  });

  it("binds actual byte facts and producer identity without circular policy hashes", () => {
    const input = fixture();
    const before = createMarkdownProfile(input);
    const changed = rebindPolicy({
      ...input,
      artifacts: input.artifacts.map((a) => (a.role === "source" ? { ...a, sha256: "b".repeat(64) } : a)),
    });
    const after = createMarkdownProfile(changed);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.manifest.artifacts.find((a) => a.role === "policy")!.sha256).not.toBe(
      before.manifest.artifacts.find((a) => a.role === "policy")!.sha256,
    );
    const producer = { ...input.producer, inputs_sha256: "f".repeat(64) };
    const producerChange = createMarkdownProfile({ ...input, producer });
    expect(producerChange.sha256).not.toBe(before.sha256);
    expect(producerChange.manifest.artifacts).toEqual(before.manifest.artifacts);
    const sourceSizeChange = createMarkdownProfile({
      ...input,
      artifacts: input.artifacts.map((a, index) => (index === 0 ? { ...a, bytes: 2 } : a)),
    });
    expect(sourceSizeChange.sha256).not.toBe(before.sha256);
    expect(sourceSizeChange.manifest.artifacts.find((a) => a.role === "policy")).toEqual(
      before.manifest.artifacts.find((a) => a.role === "policy"),
    );
  });

  it("validates every nested record as exact enumerable own-data fields", () => {
    for (let index = 0; index < 7; index++) {
      const input = fixture();
      const targets = [
        input.producer,
        input.producer.runtime,
        input.runtime,
        input.artifacts[0],
        input.packages[0],
        input.packages[0]!.dependencies[0],
        input,
      ];
      const target = targets[index] as unknown as Record<string, unknown>;
      const key = Object.keys(target)[0]!;
      const value = target[key];
      for (const mutation of ["extra", "missing", "getter", "non-enumerable", "prototype"]) {
        let touched = 0;
        if (mutation === "extra") target["unknown"] = 1;
        if (mutation === "missing") delete target[key];
        if (mutation === "getter")
          Object.defineProperty(target, key, {
            get() {
              touched++;
              return value;
            },
            configurable: true,
          });
        if (mutation === "non-enumerable")
          Object.defineProperty(target, key, { value, enumerable: false, configurable: true });
        if (mutation === "prototype") Object.setPrototypeOf(target, { unexpected: true });
        expect(() => createMarkdownProfile(input)).toThrow();
        expect(touched).toBe(0);
        delete target["unknown"];
        Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
        Object.setPrototypeOf(target, Object.prototype);
      }
    }
  });

  it("accepts null-prototype data records without preserving caller references", () => {
    const input = fixture();
    Object.setPrototypeOf(input, null);
    Object.setPrototypeOf(input.producer, null);
    const result = createMarkdownProfile(input);
    expect(result.manifest.producer).not.toBe(input.producer);
    expect(result.manifest.artifacts[0]).not.toBe(input.artifacts[0]);
    checkFrozen(result);
  });

  it.each(["id", "sha256", "mode", "elf", "virtual_path", "role"])("rejects invalid artifact %s", (field) => {
    const input = fixture();
    const values: Record<string, unknown> = {
      id: "../bad",
      sha256: "A".repeat(64),
      mode: 0o600,
      elf: {},
      virtual_path: null,
      role: "unknown",
    };
    const artifacts = input.artifacts.map((a, index) => (index === 0 ? { ...a, [field]: values[field] } : a));
    expect(() => createMarkdownProfile({ ...input, artifacts })).toThrow();
  });

  it.each([
    "alias",
    "app-version",
    "app-type",
    "parser-version",
    "peer",
    "duplicate",
    "missing",
    "range-hook",
    "data-scope",
  ])("rejects unsupported package %s", (mutation) => {
    const input = fixture();
    const packages = [...input.packages];
    if (mutation === "alias")
      packages[0] = {
        ...packages[0]!,
        dependencies: [{ ...packages[0]!.dependencies[0]!, range: "npm:markdown-it@15.0.2" }],
      };
    if (mutation === "app-version") packages[0] = { ...packages[0]!, version: "2.0.0" };
    if (mutation === "app-type") packages[0] = { ...packages[0]!, type: "commonjs" };
    if (mutation === "parser-version") packages[1] = { ...packages[1]!, version: "14.0.0" };
    if (mutation === "peer") Object.assign(packages[1]!, { peerDependencies: { extra: "*" } });
    if (mutation === "duplicate") packages[1] = packages[0]!;
    if (mutation === "missing") packages.pop();
    if (mutation === "range-hook")
      Object.assign(packages[0]!.dependencies[0]!, {
        range: {
          toJSON() {
            throw new Error();
          },
        },
      });
    if (mutation === "data-scope") packages[1] = { ...packages[1]!, root: "/app/node_modules/renamed" };
    expect(() => createMarkdownProfile({ ...input, packages })).toThrow();
  });

  it("bounds artifact counts and per-file/aggregate app bytes without omission", () => {
    const pre = prePolicy();
    const data = pre.artifacts.find((a) => a.virtual_path!.endsWith("README.md"))!;
    while (pre.artifacts.length < 512) {
      const id = `app/node_modules/markdown-it/data-${pre.artifacts.length}.txt`;
      pre.artifacts.push({ ...data, id, virtual_path: `/${id}` });
    }
    expect(
      JSON.parse(Buffer.from(createMarkdownGuardPolicy(pre.artifacts, pre.packages).bytes).toString()).files,
    ).toHaveLength(512);
    pre.artifacts.push({ ...data, id: "overflow", virtual_path: `${root("markdown-it")}/overflow` });
    expect(() => createMarkdownGuardPolicy(pre.artifacts, pre.packages)).toThrow();
    const bytes = prePolicy();
    bytes.artifacts[0] = { ...bytes.artifacts[0]!, bytes: 8 * 1024 * 1024 };
    expect(() => createMarkdownGuardPolicy(bytes.artifacts, bytes.packages)).not.toThrow();
    bytes.artifacts[0] = { ...bytes.artifacts[0]!, bytes: 8 * 1024 * 1024 + 1 };
    expect(() => createMarkdownGuardPolicy(bytes.artifacts, bytes.packages)).toThrow();
    for (let i = 0; i < 4; i++) bytes.artifacts[i] = { ...bytes.artifacts[i]!, bytes: 8 * 1024 * 1024 };
    bytes.artifacts[3] = { ...bytes.artifacts[3]!, bytes: 8 * 1024 * 1024 - (bytes.artifacts.length - 4) };
    expect(() => createMarkdownGuardPolicy(bytes.artifacts, bytes.packages)).not.toThrow();
    bytes.artifacts[3] = { ...bytes.artifacts[3]!, bytes: bytes.artifacts[3]!.bytes + 1 };
    expect(() => createMarkdownGuardPolicy(bytes.artifacts, bytes.packages)).toThrow();
  });

  it("bounds directories and depth while retaining empty directories", () => {
    const input = fixture();
    const directories = [...input.directories];
    while (directories.length < 128) directories.push(`${root("markdown-it")}/empty-${directories.length}`);
    expect(createMarkdownProfile({ ...input, directories }).manifest.directories).toHaveLength(128);
    expect(() => createMarkdownProfile({ ...input, directories: [...directories, `${root("mdurl")}/over`] })).toThrow();
    const deep = `${root("mdurl")}/${Array.from({ length: 14 }, () => "a").join("/")}`;
    expect(() => createMarkdownProfile({ ...input, directories: [...input.directories, deep] })).toThrow();
  });

  it("bounds manifest assembly before an oversized encoding can escape", () => {
    const input = fixture();
    const artifacts = input.artifacts.filter((a) => a.role !== "policy");
    const data = artifacts.find((a) => a.virtual_path!.endsWith("README.md"))!;
    while (artifacts.length < 511) {
      const n = artifacts.length;
      artifacts.push({
        ...data,
        id: `${Array.from({ length: 15 }, () => "a".repeat(255)).join("/")}/${String(n).padStart(255, "b")}`,
        virtual_path: `${root("markdown-it")}/data-${n}.txt`,
      });
    }
    const rebound = rebindPolicy({ ...input, artifacts });
    expect(() => createMarkdownProfile(rebound)).toThrow();
  });

  it("keeps outside-host mode facts distinct from sealed child files and ELF size bounds", () => {
    const input = fixture();
    const host: MarkdownArtifact = {
      id: "host/loader-cache",
      role: "host",
      virtual_path: null,
      bytes: 300 * 1024 * 1024,
      sha256: "e".repeat(64),
      mode: 0o644,
      elf: null,
    };
    const profile = createMarkdownProfile({ ...input, artifacts: [...input.artifacts, host] });
    expect(profile.manifest.artifacts.find((a) => a.id === host.id)).toEqual(host);
    expect(() =>
      createMarkdownProfile({ ...input, artifacts: [...input.artifacts, { ...host, mode: 0o4644 }] }),
    ).toThrow();
  });

  it("validates native evidence and logical external selection without source paths", () => {
    const input = fixture();
    const native: MarkdownArtifact = {
      id: "native/node",
      role: "native",
      virtual_path: "/runtime/node",
      bytes: 256 * 1024 * 1024,
      sha256: "d".repeat(64),
      mode: 0o500,
      elf: {
        class: 64,
        data: "little",
        machine: 62,
        type: 3,
        interpreter: "/lib64/ld-linux-x86-64.so.2",
        soname: null,
        needed: ["libm.so.6", "libc.so.6"],
        bind_now: true,
      },
    };
    const external_selection = [
      { role: "node", artifact_id: native.id, aliases: ["runtime/node"], absent: ["usr/lib/glibc-hwcaps/node"] },
      { role: "preload", artifact_id: null, aliases: [], absent: ["etc/ld.so.preload"] },
    ];
    const valid = {
      ...input,
      artifacts: [...input.artifacts, native],
      directories: [...input.directories, "/runtime"],
      external_selection,
    };
    const profile = createMarkdownProfile(valid);
    expect(profile.manifest.artifacts.find((a) => a.id === native.id)!.elf!.needed).toEqual(["libm.so.6", "libc.so.6"]);
    for (const elf of [
      { ...native.elf!, class: 32 },
      { ...native.elf!, needed: ["libc.so.6", "libc.so.6"] },
      { ...native.elf!, needed: ["../libc.so.6"] },
      { ...native.elf!, bind_now: 1 },
      { ...native.elf!, extra: true },
    ]) {
      expect(() =>
        createMarkdownProfile({
          ...valid,
          artifacts: [...input.artifacts, { ...native, elf }],
        } as MarkdownProfileInput),
      ).toThrow();
    }
    expect(() =>
      createMarkdownProfile({ ...valid, artifacts: [...input.artifacts, { ...native, bytes: native.bytes + 1 }] }),
    ).toThrow();
    expect(() =>
      createMarkdownProfile({
        ...valid,
        artifacts: [...valid.artifacts, { ...native, id: "host/lib", role: "host", virtual_path: null }],
      }),
    ).toThrow();
    const remaining = MARKDOWN_ARTIFACT_LIMITS.totalBytes - valid.artifacts.reduce((sum, a) => sum + a.bytes, 0);
    expect(() =>
      createMarkdownProfile({
        ...valid,
        artifacts: [
          ...valid.artifacts,
          { ...native, id: "host/lib", role: "host", virtual_path: null, bytes: remaining },
        ],
      }),
    ).not.toThrow();
    for (const entry of [
      { ...external_selection[0]!, aliases: ["/home/admin/node"] },
      { ...external_selection[0]!, aliases: ["same", "same"] },
      { ...external_selection[0]!, aliases: ["same"], absent: ["same"] },
      { ...external_selection[0]!, artifact_id: null },
      { ...external_selection[0]!, artifact_id: input.artifacts[0]!.id },
      { ...external_selection[0]!, unexpected: true },
    ])
      expect(() => createMarkdownProfile({ ...valid, external_selection: [entry] })).toThrow();
    expect(() =>
      createMarkdownProfile({ ...valid, external_selection: [external_selection[0]!, external_selection[0]!] }),
    ).toThrow();
    expect(() =>
      createMarkdownProfile({
        ...valid,
        artifacts: [
          ...valid.artifacts,
          { ...native, id: "host/alternative", role: "host", virtual_path: null, bytes: 64 },
        ],
        external_selection: [
          external_selection[0]!,
          { ...external_selection[0]!, role: "alternative", artifact_id: "host/alternative" },
        ],
      }),
    ).toThrow();
    expect(() =>
      createMarkdownProfile({
        ...valid,
        external_selection: [
          external_selection[0]!,
          { role: "absent", artifact_id: null, aliases: [], absent: ["runtime/node"] },
        ],
      }),
    ).toThrow();
    const changed = {
      ...valid,
      external_selection: [{ ...external_selection[0]!, absent: ["usr/lib/glibc-hwcaps/other"] }],
    };
    expect(createMarkdownProfile(changed).sha256).not.toBe(profile.sha256);
  });

  it("rejects malformed array descriptors without reading getter elements", () => {
    const input = fixture();
    for (const field of ["artifacts", "directories", "packages", "external_selection"] as const) {
      let touched = 0;
      const list = [...input[field]];
      Object.defineProperty(list, 0, {
        get() {
          touched++;
          throw new Error();
        },
        enumerable: true,
      });
      expect(() => createMarkdownProfile({ ...input, [field]: list })).toThrow();
      expect(touched).toBe(0);
      expect(() =>
        createMarkdownProfile({
          ...input,
          [field]: Object.assign([...input[field]], {
            toJSON() {
              touched++;
              throw new Error();
            },
          }),
        }),
      ).toThrow();
      expect(touched).toBe(0);
    }
  });

  it("rejects noncanonical profile bytes and malformed UTF8", () => {
    const result = createMarkdownProfile(fixture());
    const json = JSON.stringify(result.manifest);
    for (const text of [
      ` ${json}`,
      `${json}\n`,
      json.replace('"version":1', '"version":1.0'),
      json.replace('"version":1', '"version":1,"version":1'),
      json.replace('"dialect":', '"unknown":'),
    ]) {
      expect(() => decodeMarkdownProfile(Buffer.from(text))).toThrow();
    }
    for (const bytes of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
      Buffer.from(json.replace("host-markdown-runtime-v1", "host-markdown-runtime-v2")),
      Buffer.from(json.replace('"cpuSeconds":3', '"cpuSeconds":4')),
      Buffer.from(json.replace('"files":512', '"files":513')),
    ])
      expect(() => decodeMarkdownProfile(bytes)).toThrow();
    expect(() => decodeMarkdownProfile(new Uint8Array([255]))).toThrow();
    expect(() => decodeMarkdownProfile(new Uint8Array(1024 * 1024 + 1))).toThrow();
    expect(() => decodeMarkdownProfile(new Uint8Array(new SharedArrayBuffer(100)))).toThrow();
  });
});
