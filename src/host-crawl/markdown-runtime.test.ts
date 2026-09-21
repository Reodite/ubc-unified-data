import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, constants } from "node:fs";
import { mkdir, open, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  captureMarkdownArtifactCandidate,
  disposeMarkdownArtifactCandidate,
  verifyMarkdownArtifactCandidate,
  withVerifiedMarkdownArtifactBindings,
  type MarkdownArtifactBindings,
  type MarkdownArtifactCandidate,
} from "./markdown-artifacts.ts";
import type { MarkdownInspection } from "./markdown-contract.mjs";
import { inspectMarkdownSource } from "./markdown-inspection.mjs";
import { MARKDOWN_RUNTIME_CONTRACT, type MarkdownProfileEvidence } from "./markdown-profile.ts";
import {
  createMarkdownResponseDecoder,
  encodeMarkdownRequest,
  encodeMarkdownResponse,
  prepareMarkdownRequest,
  type PreparedMarkdownRequest,
} from "./markdown-protocol.mjs";
import * as runtimeApi from "./markdown-runtime.ts";
import {
  disposeMarkdownRuntime,
  inspectMarkdownRuntime,
  prepareMarkdownRuntime,
  type MarkdownRuntime,
  type MarkdownRuntimeResult,
  type MarkdownTerminationEvidence,
} from "./markdown-runtime.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";

const TEST_PARENT = `${DEFAULT_EXTERNAL_ROOT}/tests/markdown-runtime-${process.pid}`;
const IMPLEMENTATION_PATH = fileURLToPath(new URL("./markdown-runtime.ts", import.meta.url));
const SOURCE_DIRECTORY = new URL("./", import.meta.url);
const SELF_TEST_BYTES = Buffer.from("Body\r\n", "utf8");
const SELF_TEST_INSPECTION: MarkdownInspection = Object.freeze({
  source_bytes: 6,
  source_bytes_sha256: "c7f37cfe2bd17c6331179ea9f3fbe4ad368794f69d1a28c7456cf4301f3bf169",
  title: "  Literal *title*  ",
  title_origin: Object.freeze({ kind: "advertisement", witness_index: 2 }),
  links: Object.freeze([]),
  stats: Object.freeze({ emitted_tokens: 4, links: 0, max_depth: 1 }),
});
const fetchGuard = vi.fn(() => {
  throw new Error("Network forbidden in runtime tests");
});

type ProcessObservation =
  Readonly<{ state: string; starttime: string }> | Readonly<{ absent: true }> | Readonly<{ error: true }>;

type ExecutionOwner = { child: FakeChild | null; killSent: boolean };

type RuntimeDependencies = {
  capture(signal?: AbortSignal): Promise<MarkdownArtifactCandidate>;
  verify(candidate: MarkdownArtifactCandidate): Promise<void>;
  invoke(
    candidate: MarkdownArtifactCandidate,
    request: PreparedMarkdownRequest,
    signal: AbortSignal | undefined,
    owner: ExecutionOwner,
  ): Promise<Readonly<{ ok: true; inspection: MarkdownInspection; termination: MarkdownTerminationEvidence }>>;
  dispose(candidate: MarkdownArtifactCandidate): Promise<void>;
};

type InvocationDependencies = {
  withBindings<T>(
    candidate: MarkdownArtifactCandidate,
    callback: (bindings: MarkdownArtifactBindings) => T | Promise<T>,
  ): Promise<T>;
  supervise(
    profile: MarkdownProfileEvidence,
    bindings: MarkdownArtifactBindings,
    request: PreparedMarkdownRequest,
    wire: Uint8Array,
    owner: ExecutionOwner,
  ): Promise<Readonly<{ ok: true; inspection: MarkdownInspection; termination: MarkdownTerminationEvidence }>>;
};

type SupervisionDependencies = {
  spawn(command: string, args: string[], options: Record<string, unknown>): FakeChild;
  observeProcess(pid: number): Promise<ProcessObservation>;
  delay(milliseconds: number): Promise<unknown>;
};

interface RuntimeInternals {
  invocationArguments(profile: MarkdownProfileEvidence, bindings: MarkdownArtifactBindings): readonly string[];
  parseProcessStat(pid: number, stat: string): Readonly<{ state: string; starttime: string }> | null;
  terminationEvidence(
    initial: ProcessObservation | undefined,
    final: ProcessObservation,
  ): MarkdownTerminationEvidence | null;
  superviseInvocation(
    profile: MarkdownProfileEvidence,
    bindings: MarkdownArtifactBindings,
    request: PreparedMarkdownRequest,
    wire: Uint8Array,
    owner: ExecutionOwner,
    dependencies?: SupervisionDependencies,
  ): Promise<Readonly<{ ok: true; inspection: MarkdownInspection; termination: MarkdownTerminationEvidence }>>;
  prepareMarkdownRuntimeWithDependencies(
    options: { signal?: AbortSignal } | undefined,
    dependencies: RuntimeDependencies,
  ): Promise<MarkdownRuntime>;
  invokeCandidate(
    candidate: MarkdownArtifactCandidate,
    request: PreparedMarkdownRequest,
    signal: AbortSignal | undefined,
    owner: ExecutionOwner,
    dependencies?: InvocationDependencies,
  ): Promise<Readonly<{ ok: true; inspection: MarkdownInspection; termination: MarkdownTerminationEvidence }>>;
}

interface InstrumentedRuntimeModule {
  __runtimeTestInternals: RuntimeInternals;
  inspectMarkdownRuntime: typeof inspectMarkdownRuntime;
  disposeMarkdownRuntime: typeof disposeMarkdownRuntime;
}

interface FakeScenario {
  stdout?: Uint8Array;
  stdoutExtra?: Uint8Array;
  stderr?: Uint8Array;
  statuses?: readonly Uint8Array[];
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  closeCode?: number | null;
  closeSignal?: NodeJS.Signals | null;
  endStdout?: boolean;
  endStderr?: boolean;
  endStatus?: boolean;
  inputFinish?: boolean;
  inputCallback?: boolean;
  inputCallbackError?: boolean;
  closeOnKill?: boolean;
  automatic?: boolean;
  statusTerminalAfterEnd?: boolean;
  requiredEventsAfterClose?: boolean;
  inputCallbackAfterClose?: boolean;
}

class FakeInput extends EventEmitter {
  readonly bytes: Buffer[] = [];
  private deferredCallback: ((error?: Error | null) => void) | null = null;

  constructor(private readonly scenario: FakeScenario) {
    super();
  }

  end(value: Uint8Array, callback: (error?: Error | null) => void): void {
    this.bytes.push(Buffer.from(value));
    queueMicrotask(() => {
      if (this.scenario.inputFinish !== false) this.emit("finish");
      if (this.scenario.inputCallback !== false) {
        if (this.scenario.inputCallbackAfterClose === true) this.deferredCallback = callback;
        else
          callback(
            this.scenario.inputCallbackError === true ? new Error("injected stdin callback failure") : undefined,
          );
      }
      this.emit("close");
    });
  }

  completeDeferredCallback(): void {
    const callback = this.deferredCallback;
    this.deferredCallback = null;
    callback?.(this.scenario.inputCallbackError === true ? new Error("injected stdin callback failure") : undefined);
  }
}

class FakeChild extends EventEmitter {
  readonly stdin: FakeInput;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly status = new PassThrough();
  readonly stdio: readonly unknown[];
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: NodeJS.Signals[] = [];

  constructor(readonly scenario: FakeScenario) {
    super();
    this.stdin = new FakeInput(scenario);
    this.stdio = [this.stdin, this.stdout, this.stderr, this.status];
    if (scenario.automatic !== false) setImmediate(() => this.complete());
  }

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (this.scenario.closeOnKill === true) setImmediate(() => this.complete(null, signal));
    return true;
  }

  complete(forcedCode?: number | null, forcedSignal?: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    if (this.scenario.stdout !== undefined) this.stdout.write(this.scenario.stdout);
    if (this.scenario.stdoutExtra !== undefined) this.stdout.write(this.scenario.stdoutExtra);
    if (this.scenario.stderr !== undefined) this.stderr.write(this.scenario.stderr);
    const statuses = this.scenario.statuses ?? defaultStatuses();
    if (this.scenario.statusTerminalAfterEnd === true) {
      this.status.emit("data", statuses[0] ?? Buffer.from('{"child-pid":31337}\n'));
      this.status.emit("end");
      setImmediate(() => this.status.emit("data", statuses[1] ?? Buffer.from('{"exit-code":0}\n')));
    } else {
      for (const status of statuses) this.status.write(status);
    }
    const exitCode = forcedCode === undefined ? (this.scenario.exitCode ?? 0) : forcedCode;
    const exitSignal = forcedSignal === undefined ? (this.scenario.exitSignal ?? null) : forcedSignal;
    const closeCode = forcedCode === undefined ? (this.scenario.closeCode ?? exitCode) : forcedCode;
    const closeSignal = forcedSignal === undefined ? (this.scenario.closeSignal ?? exitSignal) : forcedSignal;
    if (this.scenario.requiredEventsAfterClose === true) {
      this.emit("close", closeCode, closeSignal);
      setImmediate(() => {
        if (this.scenario.endStdout !== false) this.stdout.emit("end");
        if (this.scenario.endStderr !== false) this.stderr.emit("end");
        if (this.scenario.endStatus !== false) this.status.emit("end");
        this.exitCode = exitCode;
        this.signalCode = exitSignal;
        this.emit("exit", exitCode, exitSignal);
      });
      return;
    }
    if (this.scenario.endStdout !== false) this.stdout.end();
    if (this.scenario.endStderr !== false) this.stderr.end();
    if (this.scenario.endStatus !== false && this.scenario.statusTerminalAfterEnd !== true) this.status.end();
    this.exitCode = exitCode;
    this.signalCode = exitSignal;
    this.emit("exit", exitCode, exitSignal);
    setImmediate(() => {
      this.emit("close", closeCode, closeSignal);
      setImmediate(() => this.stdin.completeDeferredCallback());
    });
  }
}

let internals: RuntimeInternals;
let instrumented: InstrumentedRuntimeModule;
let realRuntime: MarkdownRuntime;

function defaultStatuses(): readonly Buffer[] {
  return [Buffer.from('{"child-pid":31337}\n'), Buffer.from('{"exit-code":0}\n')];
}

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

async function loadInternals(): Promise<InstrumentedRuntimeModule> {
  const source = (await readFile(IMPLEMENTATION_PATH, "utf8")).replace(
    /(from\s+["'])(\.[^"']+)(["'])/g,
    (_match, prefix: string, specifier: string, suffix: string) =>
      `${prefix}${new URL(specifier, SOURCE_DIRECTORY).href}${suffix}`,
  );
  const instrumentedSource = `${source}\nexport const __runtimeTestInternals = Object.freeze({ invocationArguments: _invocationArguments, parseProcessStat, terminationEvidence, superviseInvocation, prepareMarkdownRuntimeWithDependencies, invokeCandidate });\n`;
  const transformed = stripTypeScriptTypes(instrumentedSource, {
    mode: "strip",
    sourceUrl: pathToFileURL(IMPLEMENTATION_PATH).href,
  });
  const path = `${TEST_PARENT}/instrumented-${process.pid}.mjs`;
  await writeFile(path, transformed, { mode: 0o600 });
  return (await import(`${pathToFileURL(path).href}?${Date.now()}`)) as InstrumentedRuntimeModule;
}

function fakeBindings(profile: MarkdownProfileEvidence): MarkdownArtifactBindings {
  const artifacts = profile.manifest.artifacts.filter((artifact) => artifact.virtual_path !== null);
  return Object.freeze({
    launcher_fd: 100,
    mounts: Object.freeze(
      artifacts.map((artifact, index) =>
        Object.freeze({ source_fd: 101 + index, virtual_path: artifact.virtual_path! }),
      ),
    ),
  });
}

function candidateFor(profile = realRuntime.profile): MarkdownArtifactCandidate {
  return Object.freeze({ profile }) as MarkdownArtifactCandidate;
}

function fakeRuntimeDependencies(
  overrides: Partial<RuntimeDependencies> = {},
): RuntimeDependencies & { calls: { capture: number; verify: number; invoke: number; dispose: number } } {
  const calls = { capture: 0, verify: 0, invoke: 0, dispose: 0 };
  const candidate = candidateFor();
  return Object.assign(
    {
      calls,
      async capture() {
        calls.capture += 1;
        return candidate;
      },
      async verify() {
        calls.verify += 1;
      },
      async invoke() {
        calls.invoke += 1;
        return Object.freeze({
          ok: true as const,
          inspection: SELF_TEST_INSPECTION,
          termination: "observed-pid-absence" as const,
        });
      },
      async dispose() {
        calls.dispose += 1;
      },
    },
    overrides,
  );
}

function fakeSupervision(
  request: PreparedMarkdownRequest,
  scenario: FakeScenario = {},
  observations: ProcessObservation[] = [
    Object.freeze({ state: "R", starttime: "123" }),
    Object.freeze({ absent: true }),
  ],
): Readonly<{
  dependencies: SupervisionDependencies;
  child(): FakeChild;
  spawnCall(): Readonly<{ command: string; args: string[]; options: Record<string, unknown> }>;
}> {
  let activeChild: FakeChild | undefined;
  let call: { command: string; args: string[]; options: Record<string, unknown> } | undefined;
  let observation = 0;
  const stdout =
    scenario.stdout ?? encodeMarkdownResponse(inspectMarkdownSource(Buffer.from("# Guide\n\nBody\n"), []), request);
  return Object.freeze({
    dependencies: {
      spawn(command, args, options) {
        call = { command, args, options };
        activeChild = new FakeChild({ ...scenario, stdout });
        return activeChild;
      },
      async observeProcess() {
        if (scenario.requiredEventsAfterClose === true || scenario.inputCallbackAfterClose === true) {
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
        }
        return observations[Math.min(observation++, observations.length - 1)]!;
      },
      async delay() {},
    },
    child() {
      if (activeChild === undefined) throw new Error("fake child not spawned");
      return activeChild;
    },
    spawnCall() {
      if (call === undefined) throw new Error("spawn not called");
      return call;
    },
  });
}

async function supervise(
  scenario: FakeScenario = {},
  observations?: ProcessObservation[],
): Promise<
  Readonly<{
    result: Awaited<ReturnType<RuntimeInternals["superviseInvocation"]>>;
    fake: ReturnType<typeof fakeSupervision>;
    owner: ExecutionOwner;
  }>
> {
  const bytes = Buffer.from("# Guide\n\nBody\n");
  const request = prepareMarkdownRequest(bytes, []);
  const wire = encodeMarkdownRequest(request);
  const fake = fakeSupervision(request, scenario, observations);
  const owner: ExecutionOwner = { child: null, killSent: false };
  const result = await internals.superviseInvocation(
    realRuntime.profile,
    fakeBindings(realRuntime.profile),
    request,
    wire,
    owner,
    fake.dependencies,
  );
  return Object.freeze({ result, fake, owner });
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchGuard);
  await mkdir(TEST_PARENT, { recursive: true, mode: 0o700 });
  instrumented = await loadInternals();
  internals = instrumented.__runtimeTestInternals;
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
  it("exports only the three exact runtime authority values and signatures", () => {
    expect(Object.keys(runtimeApi).sort()).toEqual([
      "disposeMarkdownRuntime",
      "inspectMarkdownRuntime",
      "prepareMarkdownRuntime",
    ]);
    expectTypeOf(prepareMarkdownRuntime).toEqualTypeOf<
      (options?: { readonly signal?: AbortSignal }) => Promise<MarkdownRuntime>
    >();
    expectTypeOf(inspectMarkdownRuntime).toEqualTypeOf<
      (
        runtime: MarkdownRuntime,
        request: PreparedMarkdownRequest,
        options?: { readonly signal?: AbortSignal },
      ) => Promise<MarkdownRuntimeResult>
    >();
    expectTypeOf(disposeMarkdownRuntime).toEqualTypeOf<(runtime: MarkdownRuntime) => Promise<void>>();
  });

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

describe("fixed descriptor invocation", () => {
  it("constructs the sole descriptor launch, canonical mounts, environments, and grants", async () => {
    const { fake } = await supervise();
    const call = fake.spawnCall();
    const bindings = fakeBindings(realRuntime.profile);
    expect(call.command).toBe("/proc/self/fd/4");
    expect(call.options).toMatchObject({
      cwd: "/",
      shell: false,
      env: { LC_ALL: "C", LANG: "C", TZ: "UTC", UV_THREADPOOL_SIZE: "1" },
    });
    expect(call.options.stdio).toEqual([
      "pipe",
      "pipe",
      "pipe",
      "pipe",
      bindings.launcher_fd,
      ...bindings.mounts.map((mount) => mount.source_fd),
    ]);
    expect(call.args.slice(0, 21)).toEqual([
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
      "--setenv",
      "LC_ALL",
      "C",
      "--setenv",
      "LANG",
    ]);
    for (const [key, value] of Object.entries({
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC",
      UV_THREADPOOL_SIZE: "1",
      PWD: "/app",
    })) {
      const at = call.args.findIndex((value, index) => value === "--setenv" && call.args[index + 1] === key);
      expect(call.args.slice(at, at + 3)).toEqual(["--setenv", key, value]);
    }
    const bindIndexes = call.args.flatMap((value, index) => (value === "--ro-bind-fd" ? [index] : []));
    expect(bindIndexes).toHaveLength(bindings.mounts.length);
    for (const [mountIndex, argumentIndex] of bindIndexes.entries()) {
      expect(call.args.slice(argumentIndex, argumentIndex + 3)).toEqual([
        "--ro-bind-fd",
        String(mountIndex + 5),
        bindings.mounts[mountIndex]!.virtual_path,
      ]);
    }
    const appPaths = bindings.mounts.map((mount) => mount.virtual_path).filter((path) => path.startsWith("/app/"));
    expect(call.args.filter((value) => value.startsWith("--allow-fs-read="))).toEqual(
      appPaths.map((path) => `--allow-fs-read=${path}`),
    );
    expect(call.args).toContain("--dev-bind");
    expect(call.args).toContain("--remount-ro");
    expect(call.args).toContain("--cpu=3:3");
    expect(call.args).toContain("--nofile=64:64");
    expect(call.args).toContain("--permission");
    expect(call.args).toContain("--no-addons");
    expect(call.args.at(-2)).toBe("/app/markdown-worker.mjs");
    expect(call.args.at(-1)).toBe(
      realRuntime.profile.manifest.artifacts.find((artifact) => artifact.id === "app/guard-policy")!.sha256,
    );
    expect(call.args).not.toContain(realRuntime.profile.sha256);
    const nodeFlags = MARKDOWN_RUNTIME_CONTRACT.invocation.node.flags;
    const permissionIndex = nodeFlags.indexOf("--permission");
    const expectedArguments = [
      ...MARKDOWN_RUNTIME_CONTRACT.invocation.launcher.flags,
      ...Object.entries({ LC_ALL: "C", LANG: "C", TZ: "UTC", UV_THREADPOOL_SIZE: "1", PWD: "/app" }).flatMap(
        ([key, value]) => ["--setenv", key, value],
      ),
      ...realRuntime.profile.manifest.directories.filter((path) => path !== "/").flatMap((path) => ["--dir", path]),
      ...bindings.mounts.flatMap((mount, index) => ["--ro-bind-fd", String(index + 5), mount.virtual_path]),
      "--dev-bind",
      "/dev/null",
      "/dev/null",
      "--remount-ro",
      "/",
      "--",
      MARKDOWN_RUNTIME_CONTRACT.invocation.prlimit.path,
      ...MARKDOWN_RUNTIME_CONTRACT.invocation.prlimit.flags,
      "--",
      MARKDOWN_RUNTIME_CONTRACT.invocation.node.path,
      ...nodeFlags.slice(0, permissionIndex + 1),
      ...appPaths.map((path) => `--allow-fs-read=${path}`),
      ...nodeFlags.slice(permissionIndex + 1),
      MARKDOWN_RUNTIME_CONTRACT.invocation.entry,
      realRuntime.profile.manifest.artifacts.find((artifact) => artifact.id === "app/guard-policy")!.sha256,
    ];
    expect(call.args).toEqual(expectedArguments);
  });

  it("rejects mutable, incomplete, reordered, duplicate, and noninteger bindings before spawn", () => {
    const valid = fakeBindings(realRuntime.profile);
    const expected = realRuntime.profile.manifest.artifacts.filter((artifact) => artifact.virtual_path !== null);
    const cases = [
      { launcher_fd: valid.launcher_fd, mounts: valid.mounts },
      Object.freeze({ launcher_fd: valid.launcher_fd, mounts: valid.mounts.slice(1) }),
      Object.freeze({ launcher_fd: valid.launcher_fd, mounts: Object.freeze([...valid.mounts].reverse()) }),
      Object.freeze({
        launcher_fd: valid.launcher_fd,
        mounts: Object.freeze([
          Object.freeze({ ...valid.mounts[0], source_fd: valid.launcher_fd }),
          ...valid.mounts.slice(1),
        ]),
      }),
      Object.freeze({
        launcher_fd: 1.5,
        mounts: valid.mounts,
      }),
      Object.freeze({
        launcher_fd: valid.launcher_fd,
        mounts: Object.freeze([
          Object.freeze({ source_fd: valid.mounts[0]!.source_fd, virtual_path: expected[1]!.virtual_path! }),
          ...valid.mounts.slice(1),
        ]),
      }),
    ];
    for (const bindings of cases) {
      expect(() => internals.invocationArguments(realRuntime.profile, bindings as MarkdownArtifactBindings)).toThrow();
    }
  });

  it("rejects proxy, accessor, unusual-prototype, nonarray, and unsafe bindings without invoking hooks", () => {
    const valid = fakeBindings(realRuntime.profile);
    let proxyTraps = 0;
    const proxy = new Proxy(valid, {
      get(target, key, receiver) {
        proxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => internals.invocationArguments(realRuntime.profile, proxy)).toThrow(/invalid artifact bindings/i);
    expect(proxyTraps).toBe(0);

    let getterCalls = 0;
    const accessorMount = {} as Record<PropertyKey, unknown>;
    Object.defineProperties(accessorMount, {
      source_fd: {
        get() {
          getterCalls += 1;
          return valid.mounts[0]!.source_fd;
        },
        enumerable: true,
      },
      virtual_path: { value: valid.mounts[0]!.virtual_path, enumerable: true },
    });
    Object.freeze(accessorMount);
    const accessorBindings = Object.freeze({
      launcher_fd: valid.launcher_fd,
      mounts: Object.freeze([accessorMount, ...valid.mounts.slice(1)]),
    });
    expect(() =>
      internals.invocationArguments(realRuntime.profile, accessorBindings as unknown as MarkdownArtifactBindings),
    ).toThrow(/invalid artifact bindings/i);
    expect(getterCalls).toBe(0);

    const unusual = Object.freeze(Object.assign(Object.create({}), valid)) as MarkdownArtifactBindings;
    const nonarray = Object.freeze({ launcher_fd: valid.launcher_fd, mounts: Object.freeze({ ...valid.mounts }) });
    const negativeZero = Object.freeze({ launcher_fd: -0, mounts: valid.mounts });
    const unsafe = Object.freeze({ launcher_fd: Number.MAX_SAFE_INTEGER + 1, mounts: valid.mounts });
    const extra = [...valid.mounts];
    Object.defineProperty(extra, Symbol("hidden"), { value: true });
    Object.freeze(extra);
    const extraBindings = Object.freeze({ launcher_fd: valid.launcher_fd, mounts: extra });
    for (const bindings of [unusual, nonarray, negativeZero, unsafe, extraBindings]) {
      expect(() =>
        internals.invocationArguments(realRuntime.profile, bindings as unknown as MarkdownArtifactBindings),
      ).toThrow();
    }
  });
});

describe("conjunctive child lifecycle", () => {
  it("accepts exact EOF, ordered statuses, stream settlement, close, and observed absence", async () => {
    const { result, fake, owner } = await supervise();
    expect(result.inspection.title).toBe("Guide");
    expect(result.termination).toBe("observed-pid-absence");
    expect(owner.child).toBeNull();
    expect(fake.child().kills).toEqual([]);
    for (const emitter of [
      fake.child(),
      fake.child().stdin,
      fake.child().stdout,
      fake.child().stderr,
      fake.child().status,
    ]) {
      const eventEmitter = emitter as EventEmitter;
      for (const event of ["error", "exit", "close", "finish", "data", "end"]) {
        expect(eventEmitter.listenerCount(event)).toBe(0);
      }
    }
  });

  it.each([
    ["missing startup", [Buffer.from('{"exit-code":0}\n')]],
    ["missing terminal", [Buffer.from('{"child-pid":31337}\n')]],
    ["terminal before startup", [Buffer.from('{"exit-code":0}\n'), Buffer.from('{"child-pid":31337}\n')]],
    [
      "duplicate startup",
      [Buffer.from('{"child-pid":31337}\n'), Buffer.from('{"child-pid":31337}\n'), Buffer.from('{"exit-code":0}\n')],
    ],
    [
      "duplicate terminal",
      [Buffer.from('{"child-pid":31337}\n'), Buffer.from('{"exit-code":0}\n'), Buffer.from('{"exit-code":0}\n')],
    ],
    ["combined status", [Buffer.from('{"child-pid":31337,"exit-code":0}\n')]],
    ["negative zero", [Buffer.from('{"child-pid":31337}\n'), Buffer.from('{"exit-code":-0}\n')]],
    ["partial status", [Buffer.from('{"child-pid":31337}\n'), Buffer.from('{"exit-code":0}')]],
    ["invalid UTF8", [Buffer.from('{"child-pid":31337}\n'), Buffer.from([0xff, 0x0a])]],
  ] as const)("refuses %s", async (_name, statuses) => {
    const promise = supervise({ statuses });
    await expect(promise).rejects.toThrow();
  });

  it.each([
    ["terminal status data after status EOF", { statusTerminalAfterEnd: true }],
    ["required success events after child close", { requiredEventsAfterClose: true }],
    ["successful stdin callback after child close", { inputCallbackAfterClose: true }],
  ] as const)("refuses %s", async (_name, scenario) => {
    await expect(supervise(scenario)).rejects.toThrow();
  });

  it("permits unknown informational status objects without relaxing known ordering", async () => {
    const result = await supervise({
      statuses: [
        Buffer.from('{"info":"before"}\n'),
        Buffer.from('{"child-pid":31337,"namespace":1}\n'),
        Buffer.from('{"info":"middle"}\n'),
        Buffer.from('{"exit-code":0,"detail":true}\n'),
        Buffer.from('{"info":"after"}\n'),
      ],
    });
    expect(result.result.termination).toBe("observed-pid-absence");
  });

  it.each([
    ["trailing stdout", { stdoutExtra: Buffer.from("x") }],
    ["nonempty stderr", { stderr: Buffer.from("fixed refusal") }],
    ["nonzero exit", { exitCode: 1, closeCode: 1 }],
    ["signalled exit", { exitCode: null, exitSignal: "SIGKILL", closeCode: null, closeSignal: "SIGKILL" }],
    ["close mismatch", { closeCode: 1 }],
    ["missing stdout EOF", { endStdout: false }],
    ["missing stderr EOF", { endStderr: false }],
    ["missing status EOF", { endStatus: false }],
    ["missing stdin finish", { inputFinish: false }],
    ["missing stdin callback", { inputCallback: false }],
    ["stdin callback error", { inputCallbackError: true }],
  ] as const)("keeps %s failure sticky through close", async (_name, scenario) => {
    await expect(supervise(scenario as FakeScenario)).rejects.toThrow();
  });

  it("bounds status bytes and signals only the retained child at most once", async () => {
    const promise = supervise({ statuses: [Buffer.alloc(8193, 120)] });
    await expect(promise).rejects.toThrow();
  });

  it("accepts a same-starttime zombie only as explicitly unreaped evidence", async () => {
    const result = await supervise({}, [
      Object.freeze({ state: "R", starttime: "18446744073709551615" }),
      Object.freeze({ state: "Z", starttime: "18446744073709551615" }),
    ]);
    expect(result.result.termination).toBe("identity-matched-unreaped-zombie");
  });

  it.each([
    ["missing initial identity", [{ error: true }, { state: "Z", starttime: "123" }]],
    [
      "PID replacement",
      [
        { state: "R", starttime: "123" },
        { state: "Z", starttime: "124" },
      ],
    ],
    [
      "live final state",
      [
        { state: "R", starttime: "123" },
        { state: "S", starttime: "123" },
      ],
    ],
    [
      "malformed final identity",
      [
        { state: "R", starttime: "123" },
        { state: "Z", starttime: "01" },
      ],
    ],
  ] as const)("does not infer termination from %s", async (_name, observations) => {
    await expect(supervise({}, observations as unknown as ProcessObservation[])).rejects.toThrow(/termination/i);
  });

  it("accepts only an exact own-data absence record", async () => {
    const result = await supervise({}, [Object.freeze({ error: true }), Object.freeze({ absent: true })]);
    expect(result.result.termination).toBe("observed-pid-absence");
    const inherited = Object.create({ absent: true }) as Record<string, unknown>;
    inherited.marker = true;
    const getter = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(getter, "absent", { get: () => true, enumerable: true });
    const extra = Object.freeze({ absent: true, marker: true });
    const customPrototype = Object.freeze(Object.assign(Object.create({}), { absent: true }));
    for (const observation of [inherited, getter, extra, customPrototype]) {
      expect(internals.terminationEvidence(undefined, observation as unknown as ProcessObservation)).toBeNull();
      await expect(
        supervise({}, [Object.freeze({ state: "R", starttime: "123" }), observation as unknown as ProcessObservation]),
      ).rejects.toThrow(/termination/i);
    }
  });

  it("parses exact PID prefixes, final parentheses, recognized state, and canonical uint64 starttime", () => {
    const fields = ["R", ...Array<string>(18).fill("0"), "18446744073709551615", "0", "0"];
    expect(internals.parseProcessStat(42, `42 (name) ${fields.join(" ")}\n`)).toEqual({
      state: "R",
      starttime: "18446744073709551615",
    });
    for (const stat of [
      `41 (name) ${fields.join(" ")}\n`,
      `42 name) ${fields.join(" ")}\n`,
      `42 (name) Q ${fields.slice(1).join(" ")}\n`,
      `42 (name) R ${[...fields.slice(1, 19), "01", "0"].join(" ")}\n`,
      `42 (name) R ${[...fields.slice(1, 19), "18446744073709551616", "0"].join(" ")}\n`,
    ]) {
      expect(internals.parseProcessStat(42, stat)).toBeNull();
    }
  });

  it("enforces wall exhaustion and clears the timer after owned-child close", async () => {
    vi.useFakeTimers();
    try {
      const bytes = Buffer.from("# Guide\n\nBody\n");
      const request = prepareMarkdownRequest(bytes, []);
      const fake = fakeSupervision(request, { automatic: false, closeOnKill: true });
      const owner: ExecutionOwner = { child: null, killSent: false };
      const promise = internals.superviseInvocation(
        realRuntime.profile,
        fakeBindings(realRuntime.profile),
        request,
        encodeMarkdownRequest(request),
        owner,
        fake.dependencies,
      );
      const refusal = expect(promise).rejects.toThrow(/wall timeout/i);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.runAllTimersAsync();
      await refusal;
      expect(fake.child().kills).toEqual(["SIGKILL"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});

describe("authority, cancellation, revocation, and disposal", () => {
  it("withholds authority until the exact self-test sequence and final verification complete", async () => {
    const expectedRequest = prepareMarkdownRequest(SELF_TEST_BYTES, [
      null,
      "",
      "  Literal *title*  ",
      "  Literal *title*  ",
    ]);
    const candidate = candidateFor();
    const phases: string[] = [];
    let verifyCalls = 0;
    let releaseFinalVerify!: () => void;
    let enterFinalVerify!: () => void;
    const finalVerifyEntered = new Promise<void>((resolvePromise) => {
      enterFinalVerify = resolvePromise;
    });
    const finalVerifyGate = new Promise<void>((resolvePromise) => {
      releaseFinalVerify = resolvePromise;
    });
    const dependencies = fakeRuntimeDependencies({
      async capture() {
        dependencies.calls.capture += 1;
        phases.push("capture");
        return candidate;
      },
      async verify(value) {
        dependencies.calls.verify += 1;
        expect(value).toBe(candidate);
        verifyCalls += 1;
        phases.push(`verify-${verifyCalls}`);
        if (verifyCalls === 2) {
          enterFinalVerify();
          await finalVerifyGate;
        }
      },
      async invoke(value, request) {
        dependencies.calls.invoke += 1;
        expect(value).toBe(candidate);
        expect(encodeMarkdownRequest(request)).toEqual(encodeMarkdownRequest(expectedRequest));
        phases.push("invoke");
        return Object.freeze({
          ok: true as const,
          inspection: SELF_TEST_INSPECTION,
          termination: "observed-pid-absence" as const,
        });
      },
      async dispose(value) {
        dependencies.calls.dispose += 1;
        expect(value).toBe(candidate);
        phases.push("dispose");
      },
    });
    let issued = false;
    const preparation = internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies).then((runtime) => {
      issued = true;
      return runtime;
    });
    await finalVerifyEntered;
    await Promise.resolve();
    expect(issued).toBe(false);
    expect(phases).toEqual(["capture", "verify-1", "invoke", "verify-2"]);
    releaseFinalVerify();
    const runtime = await preparation;
    expect(issued).toBe(true);
    await instrumented.disposeMarkdownRuntime(runtime);
    expect(phases).toEqual(["capture", "verify-1", "invoke", "verify-2", "dispose"]);
  });

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

  it("returns no handle and disposes the candidate when the self-test mismatches", async () => {
    const dependencies = fakeRuntimeDependencies({
      async invoke() {
        dependencies.calls.invoke += 1;
        return Object.freeze({
          ok: true as const,
          inspection: Object.freeze({ ...SELF_TEST_INSPECTION, title: "Mismatch" }),
          termination: "observed-pid-absence" as const,
        });
      },
    });
    await expect(internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies)).rejects.toThrow(
      /self-test mismatch/i,
    );
    expect(dependencies.calls).toMatchObject({ capture: 1, verify: 1, invoke: 1, dispose: 1 });
  });

  it("cancels every preparation checkpoint without issuing authority", async () => {
    for (const phase of ["capture", "first-verify", "invoke", "postcheck"] as const) {
      const controller = new AbortController();
      let verifyCalls = 0;
      const dependencies = fakeRuntimeDependencies({
        async capture() {
          dependencies.calls.capture += 1;
          if (phase === "capture") controller.abort(new Error("cancelled capture"));
          return candidateFor();
        },
        async verify() {
          dependencies.calls.verify += 1;
          verifyCalls += 1;
          if (phase === "first-verify" && verifyCalls === 1) controller.abort(new Error("cancelled first verify"));
          if (phase === "postcheck" && verifyCalls === 2) controller.abort(new Error("cancelled postcheck"));
        },
        async invoke() {
          dependencies.calls.invoke += 1;
          if (phase === "invoke") controller.abort(new Error("cancelled self-test"));
          return Object.freeze({
            ok: true as const,
            inspection: SELF_TEST_INSPECTION,
            termination: "observed-pid-absence" as const,
          });
        },
      });
      await expect(
        internals.prepareMarkdownRuntimeWithDependencies({ signal: controller.signal }, dependencies),
      ).rejects.toThrow(/cancelled/);
      expect(dependencies.calls.dispose).toBe(1);
    }
  });

  it("uses intrinsic AbortSignal listeners and cannot strand disposal through own event methods", async () => {
    const controller = new AbortController();
    const hooks = { add: 0, remove: 0 };
    Object.defineProperties(controller.signal, {
      addEventListener: {
        get() {
          hooks.add += 1;
          throw new Error("caller add hook");
        },
      },
      removeEventListener: {
        get() {
          hooks.remove += 1;
          throw new Error("caller remove hook");
        },
      },
    });
    let activeStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      activeStarted = resolvePromise;
    });
    const dependencies = fakeRuntimeDependencies({
      async invoke(_candidate, _request, signal) {
        dependencies.calls.invoke += 1;
        if (dependencies.calls.invoke === 1 || dependencies.calls.invoke > 2) {
          return Object.freeze({
            ok: true as const,
            inspection: SELF_TEST_INSPECTION,
            termination: "observed-pid-absence" as const,
          });
        }
        activeStarted();
        return new Promise((_resolve, reject) => {
          Reflect.apply(EventTarget.prototype.addEventListener, signal!, [
            "abort",
            () => reject(new Error("intrinsic cancellation")),
            { once: true },
          ]);
        });
      },
    });
    const runtime = await internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies);
    const request = prepareMarkdownRequest(Buffer.from("# Guide"), []);
    const active = instrumented.inspectMarkdownRuntime(runtime, request, { signal: controller.signal });
    await started;
    controller.abort(new Error("cancelled by caller"));
    await expect(active).rejects.toThrow(/intrinsic cancellation/i);
    expect(hooks).toEqual({ add: 0, remove: 0 });
    await expect(instrumented.inspectMarkdownRuntime(runtime, request)).resolves.toBeDefined();
    const first = instrumented.disposeMarkdownRuntime(runtime);
    expect(instrumented.disposeMarkdownRuntime(runtime)).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(dependencies.calls.dispose).toBe(1);
  });

  it("refuses concurrent use and returns to ready after an ordinary child refusal", async () => {
    let activeResolve!: () => void;
    let activeReject!: (error: Error) => void;
    let inspectionCalls = 0;
    const dependencies = fakeRuntimeDependencies({
      async invoke(_candidate, _request, signal) {
        dependencies.calls.invoke += 1;
        if (dependencies.calls.invoke === 1) {
          return Object.freeze({
            ok: true as const,
            inspection: SELF_TEST_INSPECTION,
            termination: "observed-pid-absence" as const,
          });
        }
        inspectionCalls += 1;
        if (inspectionCalls === 1) {
          return new Promise((resolvePromise, rejectPromise) => {
            activeResolve = () =>
              resolvePromise(
                Object.freeze({
                  ok: true as const,
                  inspection: SELF_TEST_INSPECTION,
                  termination: "observed-pid-absence" as const,
                }),
              );
            activeReject = rejectPromise;
            signal?.addEventListener("abort", () => activeReject(new Error("cancelled")), { once: true });
          });
        }
        if (inspectionCalls === 2) throw new Error("ordinary child refusal");
        return Object.freeze({
          ok: true as const,
          inspection: SELF_TEST_INSPECTION,
          termination: "observed-pid-absence" as const,
        });
      },
    });
    const runtime = await internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies);
    const request = prepareMarkdownRequest(Buffer.from("# Guide"), []);
    const active = instrumented.inspectMarkdownRuntime(runtime, request);
    await Promise.resolve();
    await expect(instrumented.inspectMarkdownRuntime(runtime, request)).rejects.toThrow(/already in use/i);
    activeResolve();
    await expect(active).resolves.toMatchObject({ profile_sha256: runtime.profile.sha256 });
    await expect(instrumented.inspectMarkdownRuntime(runtime, request)).rejects.toThrow("ordinary child refusal");
    await expect(instrumented.inspectMarkdownRuntime(runtime, request)).resolves.toMatchObject({
      profile_sha256: runtime.profile.sha256,
    });
    await instrumented.disposeMarkdownRuntime(runtime);
  });

  it.each(["missing resource", "wrong resource", "mutated resource", "postcheck failure"])(
    "sticky-revokes after %s binding failure and suppresses metadata",
    async (reason) => {
      const dependencies = fakeRuntimeDependencies({
        async invoke() {
          dependencies.calls.invoke += 1;
          if (dependencies.calls.invoke === 1) {
            return Object.freeze({
              ok: true as const,
              inspection: SELF_TEST_INSPECTION,
              termination: "observed-pid-absence" as const,
            });
          }
          throw new AggregateError([new Error(reason)], "Markdown runtime binding verification failed");
        },
      });
      const runtime = await internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies);
      const request = prepareMarkdownRequest(Buffer.from("# Guide"), []);
      await expect(instrumented.inspectMarkdownRuntime(runtime, request)).rejects.toThrow(/binding verification/i);
      await expect(instrumented.inspectMarkdownRuntime(runtime, request)).rejects.toThrow(/unavailable/i);
      await instrumented.disposeMarkdownRuntime(runtime);
    },
  );

  it("cancellation during work signals only the retained owner and does not publish stale output", async () => {
    const controller = new AbortController();
    let inspection = 0;
    const dependencies = fakeRuntimeDependencies({
      async invoke(_candidate, _request, signal, owner) {
        dependencies.calls.invoke += 1;
        if (dependencies.calls.invoke === 1) {
          return Object.freeze({
            ok: true as const,
            inspection: SELF_TEST_INSPECTION,
            termination: "observed-pid-absence" as const,
          });
        }
        inspection += 1;
        if (inspection > 1) {
          return Object.freeze({
            ok: true as const,
            inspection: SELF_TEST_INSPECTION,
            termination: "observed-pid-absence" as const,
          });
        }
        const child = new FakeChild({ automatic: false, closeOnKill: true });
        owner.child = child;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              if (!owner.killSent) {
                owner.killSent = true;
                child.kill("SIGKILL");
              }
              reject(new Error("cancelled work"));
            },
            { once: true },
          );
        });
      },
    });
    const runtime = await internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies);
    const request = prepareMarkdownRequest(Buffer.from("# Guide"), []);
    const active = instrumented.inspectMarkdownRuntime(runtime, request, { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("cancelled work"));
    await expect(active).rejects.toThrow(/cancelled work/i);
    await expect(instrumented.inspectMarkdownRuntime(runtime, request)).resolves.toBeDefined();
    await instrumented.disposeMarkdownRuntime(runtime);
  });

  it("suppresses a successful invocation when cancellation arrives before the final state check", async () => {
    const controller = new AbortController();
    const dependencies = fakeRuntimeDependencies({
      async invoke() {
        dependencies.calls.invoke += 1;
        if (dependencies.calls.invoke > 1) controller.abort(new Error("cancelled postcheck"));
        return Object.freeze({
          ok: true as const,
          inspection: SELF_TEST_INSPECTION,
          termination: "observed-pid-absence" as const,
        });
      },
    });
    const runtime = await internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies);
    await expect(
      instrumented.inspectMarkdownRuntime(runtime, prepareMarkdownRequest(Buffer.from("# Guide"), []), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled postcheck/i);
    await instrumented.disposeMarkdownRuntime(runtime);
  });

  it("revokes first, cancels active work, waits its settlement, and disposes idempotently", async () => {
    let activeStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      activeStarted = resolvePromise;
    });
    const dependencies = fakeRuntimeDependencies({
      async invoke(_candidate, _request, signal) {
        dependencies.calls.invoke += 1;
        if (dependencies.calls.invoke === 1) {
          return Object.freeze({
            ok: true as const,
            inspection: SELF_TEST_INSPECTION,
            termination: "observed-pid-absence" as const,
          });
        }
        activeStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("disposed active work")), { once: true });
        });
      },
    });
    const runtime = await internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies);
    const request = prepareMarkdownRequest(Buffer.from("# Guide"), []);
    const active = instrumented.inspectMarkdownRuntime(runtime, request);
    const activeRefusal = expect(active).rejects.toThrow(/disposed active work/i);
    await started;
    const first = instrumented.disposeMarkdownRuntime(runtime);
    const second = instrumented.disposeMarkdownRuntime(runtime);
    expect(second).toBe(first);
    await expect(instrumented.inspectMarkdownRuntime(runtime, request)).rejects.toThrow(/unavailable/i);
    await activeRefusal;
    await expect(first).resolves.toBeUndefined();
    expect(dependencies.calls.dispose).toBe(1);
    await expect(instrumented.disposeMarkdownRuntime(runtime)).resolves.toBeUndefined();
  });

  it("keeps the same settled disposal failure and leaves authority disposed", async () => {
    const dependencies = fakeRuntimeDependencies({
      async dispose() {
        dependencies.calls.dispose += 1;
        throw new Error("authenticated cleanup failed");
      },
    });
    const runtime = await internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies);
    const first = instrumented.disposeMarkdownRuntime(runtime);
    const second = instrumented.disposeMarkdownRuntime(runtime);
    expect(second).toBe(first);
    await expect(first).rejects.toThrow(/cleanup failed/i);
    await expect(instrumented.disposeMarkdownRuntime(runtime)).rejects.toThrow(/cleanup failed/i);
    await expect(
      instrumented.inspectMarkdownRuntime(runtime, prepareMarkdownRequest(Buffer.from("# Guide"), [])),
    ).rejects.toThrow(/unavailable/i);
  });

  it("authenticates fake-runtime handles against the private WeakMap", async () => {
    const dependencies = fakeRuntimeDependencies();
    const runtime = await internals.prepareMarkdownRuntimeWithDependencies(undefined, dependencies);
    const request = prepareMarkdownRequest(Buffer.from("# Guide"), []);
    const forged = [
      Object.freeze(Object.assign(Object.create(null), { profile: runtime.profile })),
      structuredClone(runtime),
      Object.create(runtime),
      JSON.parse(JSON.stringify(runtime)),
    ] as MarkdownRuntime[];
    for (const handle of forged) {
      await expect(instrumented.inspectMarkdownRuntime(handle, request)).rejects.toThrow(/forged/i);
      await expect(instrumented.disposeMarkdownRuntime(handle)).rejects.toThrow(/forged/i);
    }
    await instrumented.disposeMarkdownRuntime(runtime);
  });
});
