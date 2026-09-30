import { createHash } from "node:crypto";
import {
  createMarkdownGuardPolicy,
  createMarkdownProfile,
  type MarkdownArtifact,
  type MarkdownPackage,
  type MarkdownProfileEvidence,
} from "../markdown-profile.ts";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const root = (name: string) =>
  name === "entities" ? "/app/node_modules/markdown-it/node_modules/entities" : `/app/node_modules/${name}`;

/** Builds validated synthetic evidence from the profile-test fixture, not captured runtime authority. */
export function createSyntheticMarkdownRuntimeProfile(): MarkdownProfileEvidence {
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
  const policy = createMarkdownGuardPolicy(artifacts, packages);
  artifacts.push({
    id: "app/guard-policy",
    role: "policy",
    virtual_path: "/app/markdown-guard-policy.json",
    bytes: policy.bytes.length,
    sha256: policy.sha256,
    mode: 0o400,
    elf: null,
  });
  // Non-app and outside-host evidence keep mount and read-grant filtering observable without real capture.
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
  artifacts.push(
    native,
    {
      ...native,
      id: "native/prlimit",
      virtual_path: "/runtime/prlimit",
      bytes: 64,
      sha256: hash("native/prlimit"),
    },
    {
      ...native,
      id: "launcher/bubblewrap",
      role: "launcher",
      virtual_path: null,
      bytes: 64,
      sha256: hash("launcher/bubblewrap"),
    },
    {
      id: "host/loader-cache",
      role: "host",
      virtual_path: null,
      bytes: 64,
      sha256: "e".repeat(64),
      mode: 0o644,
      elf: null,
    },
  );
  const directories = new Set(["/", "/app", "/dev", `${root("markdown-it")}/empty`]);
  for (const a of artifacts) {
    if (a.virtual_path === null) continue;
    let path = a.virtual_path.slice(0, a.virtual_path.lastIndexOf("/"));
    while (path) {
      directories.add(path);
      path = path.slice(0, path.lastIndexOf("/"));
    }
  }
  const runtime = { node: "24.18.0", icu: "77.1", unicode: "16.0", platform: "linux", arch: "x64" };
  return createMarkdownProfile({
    producer: { inputs_sha256: "a".repeat(64), runtime },
    runtime,
    artifacts,
    packages,
    directories: [...directories],
    external_selection: [
      { role: "node", artifact_id: native.id, aliases: ["runtime/node"], absent: ["usr/lib/glibc-hwcaps/node"] },
      { role: "prlimit", artifact_id: "native/prlimit", aliases: ["runtime/prlimit"], absent: [] },
      { role: "launcher", artifact_id: "launcher/bubblewrap", aliases: ["usr/bin/bwrap"], absent: [] },
      { role: "preload", artifact_id: null, aliases: [], absent: ["etc/ld.so.preload"] },
    ],
  });
}
