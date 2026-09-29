import { spawn } from "node:child_process";
import { chmodSync, constants } from "node:fs";
import { mkdir, open, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  captureMarkdownArtifactCandidate,
  disposeMarkdownArtifactCandidate,
  verifyMarkdownArtifactCandidate,
  withVerifiedMarkdownArtifactBindings,
} from "./markdown-artifacts.ts";
import type { MarkdownInspection } from "./markdown-contract.mjs";
import { inspectMarkdownSource } from "./markdown-inspection.mjs";
import { MARKDOWN_RUNTIME_CONTRACT } from "./markdown-profile.ts";
import {
  createMarkdownResponseDecoder,
  encodeMarkdownResponse,
  prepareMarkdownRequest,
  type PreparedMarkdownRequest,
} from "./markdown-protocol.mjs";
import {
  disposeMarkdownRuntime,
  inspectMarkdownRuntime,
  prepareMarkdownRuntime,
  type MarkdownRuntime,
} from "./markdown-runtime.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import {
  FakeChild,
  loadInternals,
  SELF_TEST_INSPECTION,
  type ExecutionOwner,
  type InvocationDependencies,
  type RuntimeInternals,
} from "./test-support/markdown-runtime-harness.ts";

const TEST_PARENT = `${DEFAULT_EXTERNAL_ROOT}/tests/markdown-runtime-native-${process.pid}`;
const fetchGuard = vi.fn(() => {
  throw new Error("Network forbidden in runtime tests");
});

let internals: RuntimeInternals;
let realRuntime: MarkdownRuntime;

function maximumMetadataFixture(): Readonly<{
  request: PreparedMarkdownRequest;
  inspection: MarkdownInspection;
}> {
  const make = (extra: number) =>
    Buffer.from(
      Array.from(
        { length: 33 },
        (_, index) => `[${"x".repeat(index < 32 ? 7900 : extra)}](https://example.org/${index})`,
      ).join("\n\n"),
    );
  const titles = ["Advertisement"];
  const baseline = inspectMarkdownSource(make(1), titles);
  const extra = 1 + 262144 - Buffer.byteLength(JSON.stringify(baseline));
  const bytes = make(extra);
  return Object.freeze({
    request: prepareMarkdownRequest(bytes, titles),
    inspection: inspectMarkdownSource(bytes, titles),
  });
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchGuard);
  await mkdir(TEST_PARENT, { recursive: true, mode: 0o700 });
  internals = (await loadInternals(TEST_PARENT)).__runtimeTestInternals;
  realRuntime = await prepareMarkdownRuntime();
}, 180_000);

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    if (realRuntime !== undefined) await disposeMarkdownRuntime(realRuntime);
  } catch (error) {
    errors.push(error);
  }
  try {
    expect(fetchGuard).not.toHaveBeenCalled();
  } catch (error) {
    errors.push(error);
  }
  vi.unstubAllGlobals();
  try {
    await rm(TEST_PARENT, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "runtime test teardown failed");
}, 180_000);

describe("real fixed runtime", () => {
  it("issues only a frozen null-prototype evidence handle after the real self-test", () => {
    expect(Object.getPrototypeOf(realRuntime)).toBeNull();
    expect(Object.keys(realRuntime)).toEqual(["profile"]);
    expect(Object.isFrozen(realRuntime)).toBe(true);
    expect(Object.isFrozen(realRuntime.profile)).toBe(true);
    expect(JSON.stringify(realRuntime)).not.toContain("/home/admin");
    expect(JSON.stringify(realRuntime)).not.toContain(DEFAULT_EXTERNAL_ROOT);
  });

  it("executes an ordinary prepared request through the real worker", async () => {
    const bytes = Buffer.from("# Guide\n\nOwned [link](https://example.test/runtime).\n");
    const request = prepareMarkdownRequest(bytes, []);
    const result = await inspectMarkdownRuntime(realRuntime, request);
    expect(result.inspection).toEqual(inspectMarkdownSource(bytes, []));
    expect(result.profile_sha256).toBe(realRuntime.profile.sha256);
    expect(["observed-pid-absence", "identity-matched-unreaped-zombie"]).toContain(result.termination);
    expect(Reflect.ownKeys(result)).toEqual(["inspection", "profile_sha256", "termination"]);
    expect(Object.isFrozen(result)).toBe(true);
  }, 180_000);

  it("executes the exact maximum honest metadata request through the real worker", async () => {
    const fixture = maximumMetadataFixture();
    expect(Buffer.byteLength(JSON.stringify(fixture.inspection))).toBe(262144);
    const result = await inspectMarkdownRuntime(realRuntime, fixture.request);
    expect(result.inspection).toEqual(fixture.inspection);
    const decoder = createMarkdownResponseDecoder(fixture.request);
    decoder.push(encodeMarkdownResponse(result.inspection, fixture.request));
    expect(decoder.finish()).toEqual(fixture.inspection);
  }, 180_000);

  it("restores the exact descriptor table after every repeated real invocation", async () => {
    const descriptors = async () => {
      const result: string[] = [];
      for (const entry of (await readdir("/proc/self/fd")).sort((left, right) => Number(left) - Number(right))) {
        try {
          result.push(`${entry}:${await readlink(`/proc/self/fd/${entry}`)}`);
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      return result;
    };
    const request = prepareMarkdownRequest(Buffer.from("# Guide\n\nDescriptor stability\n"), []);
    await inspectMarkdownRuntime(realRuntime, request);
    const baseline = await descriptors();
    for (let index = 0; index < 3; index += 1) {
      await inspectMarkdownRuntime(realRuntime, request);
      expect(await descriptors()).toEqual(baseline);
    }
  }, 180_000);

  it("enforces CPU exhaustion for an owned fixed synthetic entry through real Bubblewrap and prlimit", async () => {
    const scriptPath = `${TEST_PARENT}/cpu-spin.mjs`;
    await writeFile(
      scriptPath,
      'import { writeSync } from "node:fs";\nwriteSync(1, "CPU-SPIN-READY\\n");\nfor (;;) { Math.imul(123, 456); }\n',
      { mode: 0o400 },
    );
    const script = await open(scriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const candidate = await captureMarkdownArtifactCandidate();
    try {
      const evidence = await withVerifiedMarkdownArtifactBindings(candidate, async (bindings) => {
        const scriptDescriptor = 5 + bindings.mounts.length;
        const nodeFlags = MARKDOWN_RUNTIME_CONTRACT.invocation.node.flags;
        const permissionIndex = nodeFlags.indexOf("--permission");
        const args = [
          ...MARKDOWN_RUNTIME_CONTRACT.invocation.launcher.flags,
          ...Object.entries({ LC_ALL: "C", LANG: "C", TZ: "UTC", UV_THREADPOOL_SIZE: "1", PWD: "/app" }).flatMap(
            ([key, value]) => ["--setenv", key, value],
          ),
          ...candidate.profile.manifest.directories.filter((path) => path !== "/").flatMap((path) => ["--dir", path]),
          "--dir",
          "/fixture",
          ...bindings.mounts.flatMap((mount, index) => ["--ro-bind-fd", String(index + 5), mount.virtual_path]),
          "--ro-bind-fd",
          String(scriptDescriptor),
          "/fixture/cpu-spin.mjs",
          "--dev-bind",
          "/dev/null",
          "/dev/null",
          "--remount-ro",
          "/",
          "--",
          MARKDOWN_RUNTIME_CONTRACT.invocation.prlimit.path,
          "--cpu=1:1",
          ...MARKDOWN_RUNTIME_CONTRACT.invocation.prlimit.flags.filter((flag) => !flag.startsWith("--cpu=")),
          "--",
          MARKDOWN_RUNTIME_CONTRACT.invocation.node.path,
          ...nodeFlags.slice(0, permissionIndex + 1),
          "--allow-fs-read=/fixture/cpu-spin.mjs",
          ...nodeFlags.slice(permissionIndex + 1),
          "/fixture/cpu-spin.mjs",
        ];
        const startedAt = process.hrtime.bigint();
        const child = spawn("/proc/self/fd/4", args, {
          cwd: "/",
          env: { LC_ALL: "C", LANG: "C", TZ: "UTC", UV_THREADPOOL_SIZE: "1" },
          shell: false,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
            "pipe",
            bindings.launcher_fd,
            ...bindings.mounts.map((mount) => mount.source_fd),
            script.fd,
          ],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const status: Buffer[] = [];
        child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.stdio[3]!.on("data", (chunk: Buffer) => status.push(chunk));
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 8_000);
        timer.unref();
        try {
          const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolvePromise, rejectPromise) => {
              child.once("error", rejectPromise);
              child.once("close", (code, signal) => resolvePromise({ code, signal }));
            },
          );
          return Object.freeze({
            ...closed,
            timedOut,
            elapsedMilliseconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            status: Buffer.concat(status).toString("utf8"),
          });
        } finally {
          clearTimeout(timer);
        }
      });
      expect(evidence.timedOut).toBe(false);
      expect(evidence.elapsedMilliseconds).toBeGreaterThanOrEqual(500);
      expect(evidence.elapsedMilliseconds).toBeLessThan(8_000);
      expect(evidence.code).toBe(137);
      expect(evidence.signal).toBeNull();
      expect(evidence.stdout.toString("utf8")).toBe("CPU-SPIN-READY\n");
      expect(evidence.stderr).toHaveLength(0);
      expect(evidence.status).toMatch(/"child-pid"\s*:\s*[0-9]+/);
      expect(evidence.status).toMatch(/"exit-code"\s*:\s*137/);
    } finally {
      await disposeMarkdownArtifactCandidate(candidate);
      await script.close();
      await rm(scriptPath, { force: true });
    }
  }, 180_000);

  it("refuses forged requests and invalid option records without using the runtime", async () => {
    const request = prepareMarkdownRequest(Buffer.from("# Guide"), []);
    for (const forged of [{ ...request }, structuredClone(request), JSON.parse(JSON.stringify(request))]) {
      await expect(inspectMarkdownRuntime(realRuntime, forged as PreparedMarkdownRequest)).rejects.toThrow();
    }
    for (const options of [
      null,
      { unknown: true },
      Object.create({}),
      {
        get signal() {
          return undefined;
        },
      },
    ]) {
      await expect(inspectMarkdownRuntime(realRuntime, request, options as never)).rejects.toThrow(/invalid options/i);
    }
    await expect(inspectMarkdownRuntime(realRuntime, request)).resolves.toMatchObject({
      profile_sha256: realRuntime.profile.sha256,
    });
  }, 180_000);

  it("suppresses real invocation when cancellation arrives during artifact preverification", async () => {
    const controller = new AbortController();
    const request = prepareMarkdownRequest(Buffer.from("# Guide\n\nCancellation gate\n"), []);
    const active = inspectMarkdownRuntime(realRuntime, request, { signal: controller.signal });
    controller.abort(new Error("cancelled real precheck"));
    await expect(active).rejects.toThrow(/cancelled real precheck/i);
    await expect(inspectMarkdownRuntime(realRuntime, request)).resolves.toMatchObject({
      profile_sha256: realRuntime.profile.sha256,
    });
  }, 180_000);

  it("refuses forged, cloned, inherited, and serialized runtime handles", async () => {
    const request = prepareMarkdownRequest(Buffer.from("# Guide"), []);
    const handles = [
      Object.freeze(Object.assign(Object.create(null), { profile: realRuntime.profile })),
      structuredClone(realRuntime),
      Object.create(realRuntime),
      JSON.parse(JSON.stringify(realRuntime)),
    ] as MarkdownRuntime[];
    for (const handle of handles) {
      await expect(inspectMarkdownRuntime(handle, request)).rejects.toThrow(/forged/i);
      await expect(disposeMarkdownRuntime(handle)).rejects.toThrow(/forged/i);
    }
  });
});

describe("authority, cancellation, revocation, and disposal", () => {
  it("suppresses valid worker output and revokes the artifact after real postverification mutation", async () => {
    const candidate = await captureMarkdownArtifactCandidate();
    try {
      const request = prepareMarkdownRequest(Buffer.from("# Guide\n\nPostcheck mutation\n"), []);
      const owner: ExecutionOwner = { child: null, killSent: false };
      const dependencies: InvocationDependencies = {
        async withBindings(value, callback) {
          return withVerifiedMarkdownArtifactBindings(value, async (bindings) => {
            const result = await callback(bindings);
            chmodSync(`/proc/self/fd/${bindings.mounts[0]!.source_fd}`, 0o600);
            return result;
          });
        },
        supervise: internals.superviseInvocation,
      };
      await expect(internals.invokeCandidate(candidate, request, undefined, owner, dependencies)).rejects.toThrow(
        /binding verification failed/i,
      );
      await expect(verifyMarkdownArtifactCandidate(candidate)).rejects.toThrow(/revoked|unavailable/i);
      expect(owner.child).toBeNull();
    } finally {
      await disposeMarkdownArtifactCandidate(candidate);
    }
  }, 180_000);

  it("refuses missing and wrongly mapped real resource descriptors without metadata", async () => {
    for (const mode of ["missing", "wrong"] as const) {
      const candidate = await captureMarkdownArtifactCandidate();
      try {
        const request = prepareMarkdownRequest(Buffer.from(`# Guide\n\n${mode} resource\n`), []);
        const dependencies: InvocationDependencies = {
          async withBindings(value, callback) {
            return withVerifiedMarkdownArtifactBindings(value, async (bindings) => {
              const mounts = bindings.mounts.map((mount, index) =>
                Object.freeze({
                  source_fd:
                    mode === "missing" && index === 0
                      ? 2_147_483_647
                      : index === 0
                        ? bindings.mounts[1]!.source_fd
                        : index === 1
                          ? bindings.mounts[0]!.source_fd
                          : mount.source_fd,
                  virtual_path: mount.virtual_path,
                }),
              );
              return callback(Object.freeze({ launcher_fd: bindings.launcher_fd, mounts: Object.freeze(mounts) }));
            });
          },
          supervise: internals.superviseInvocation,
        };
        await expect(
          internals.invokeCandidate(candidate, request, undefined, { child: null, killSent: false }, dependencies),
        ).rejects.toThrow();
        await expect(verifyMarkdownArtifactCandidate(candidate)).resolves.toBeUndefined();
      } finally {
        await disposeMarkdownArtifactCandidate(candidate);
      }
    }
  }, 180_000);

  it("runs invokeCandidate cancellation checks before bindings and after supervision", async () => {
    const candidate = await captureMarkdownArtifactCandidate();
    try {
      const request = prepareMarkdownRequest(Buffer.from("# Guide\n\nCancellation phases\n"), []);
      const owner: ExecutionOwner = { child: null, killSent: false };
      const precheck = new AbortController();
      precheck.abort(new Error("cancelled before bindings"));
      await expect(internals.invokeCandidate(candidate, request, precheck.signal, owner)).rejects.toThrow(
        /cancelled before bindings/i,
      );
      await expect(verifyMarkdownArtifactCandidate(candidate)).resolves.toBeUndefined();

      const postcheck = new AbortController();
      const dependencies: InvocationDependencies = {
        withBindings: withVerifiedMarkdownArtifactBindings,
        async supervise() {
          postcheck.abort(new Error("cancelled after supervision"));
          return Object.freeze({
            ok: true as const,
            inspection: SELF_TEST_INSPECTION,
            termination: "observed-pid-absence" as const,
          });
        },
      };
      await expect(
        internals.invokeCandidate(candidate, request, postcheck.signal, owner, dependencies),
      ).rejects.toThrow(/cancelled after supervision/i);
      await expect(verifyMarkdownArtifactCandidate(candidate)).resolves.toBeUndefined();

      const activeController = new AbortController();
      let activeStarted!: () => void;
      const started = new Promise<void>((resolvePromise) => {
        activeStarted = resolvePromise;
      });
      let activeChild: FakeChild | undefined;
      const activeOwner: ExecutionOwner = { child: null, killSent: false };
      const activeDependencies: InvocationDependencies = {
        withBindings: withVerifiedMarkdownArtifactBindings,
        async supervise(_profile, _bindings, _request, _wire, executionOwner) {
          activeChild = new FakeChild({ automatic: false, closeOnKill: true });
          executionOwner.child = activeChild;
          activeStarted();
          return new Promise((_resolve, reject) => {
            activeChild!.once("close", () => {
              executionOwner.child = null;
              reject(new Error("cancelled active child"));
            });
          });
        },
      };
      const active = internals.invokeCandidate(
        candidate,
        request,
        activeController.signal,
        activeOwner,
        activeDependencies,
      );
      await started;
      activeController.abort(new Error("cancelled active child"));
      await expect(active).rejects.toThrow(/cancelled active child/i);
      expect(activeChild!.kills).toEqual(["SIGKILL"]);
      await expect(verifyMarkdownArtifactCandidate(candidate)).resolves.toBeUndefined();

      const wrapperController = new AbortController();
      const wrapperDependencies: InvocationDependencies = {
        async withBindings(value, callback) {
          return withVerifiedMarkdownArtifactBindings(value, async (bindings) => {
            const result = await callback(bindings);
            wrapperController.abort(new Error("cancelled after bindings"));
            return result;
          });
        },
        async supervise() {
          return Object.freeze({
            ok: true as const,
            inspection: SELF_TEST_INSPECTION,
            termination: "observed-pid-absence" as const,
          });
        },
      };
      await expect(
        internals.invokeCandidate(
          candidate,
          request,
          wrapperController.signal,
          { child: null, killSent: false },
          wrapperDependencies,
        ),
      ).rejects.toThrow(/cancelled after bindings/i);
      await expect(verifyMarkdownArtifactCandidate(candidate)).resolves.toBeUndefined();
    } finally {
      await disposeMarkdownArtifactCandidate(candidate);
    }
  }, 180_000);
});
