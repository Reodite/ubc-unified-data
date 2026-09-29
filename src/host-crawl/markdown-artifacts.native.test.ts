import { createHash } from "node:crypto";
import { chmodSync, closeSync, fstatSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureMarkdownArtifactCandidate,
  disposeMarkdownArtifactCandidate,
  verifyMarkdownArtifactCandidate,
  withVerifiedMarkdownArtifactBindings,
  type MarkdownArtifactCandidate,
} from "./markdown-artifacts.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";

const ARTIFACT_PARENT = join(DEFAULT_EXTERNAL_ROOT, "markdown-artifacts");
const SOURCE_DIRECTORY = import.meta.dirname;
let shared: MarkdownArtifactCandidate;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  shared = await captureMarkdownArtifactCandidate();
}, 120_000);

afterAll(async () => {
  if (shared !== undefined) await disposeMarkdownArtifactCandidate(shared);
}, 120_000);

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
