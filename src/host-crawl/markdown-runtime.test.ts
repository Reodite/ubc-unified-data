import type { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { MarkdownArtifactBindings, MarkdownArtifactCandidate } from "./markdown-artifacts.ts";
import { inspectMarkdownSource } from "./markdown-inspection.mjs";
import { MARKDOWN_RUNTIME_CONTRACT, type MarkdownProfileEvidence } from "./markdown-profile.ts";
import {
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
} from "./markdown-runtime.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import {
  FakeChild,
  loadInternals,
  SELF_TEST_BYTES,
  SELF_TEST_INSPECTION,
  type ExecutionOwner,
  type FakeScenario,
  type InstrumentedRuntimeModule,
  type ProcessObservation,
  type RuntimeDependencies,
  type RuntimeInternals,
  type SupervisionDependencies,
} from "./test-support/markdown-runtime-harness.ts";
import { createSyntheticMarkdownRuntimeProfile } from "./test-support/markdown-runtime-synthetic-profile.ts";

const TEST_PARENT = `${DEFAULT_EXTERNAL_ROOT}/tests/markdown-runtime-portable-${process.pid}`;
const syntheticProfile = createSyntheticMarkdownRuntimeProfile();
const fetchGuard = vi.fn(() => {
  throw new Error("Network forbidden in runtime tests");
});

let internals: RuntimeInternals;
let instrumented: InstrumentedRuntimeModule;

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

function candidateFor(profile = syntheticProfile): MarkdownArtifactCandidate {
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
    syntheticProfile,
    fakeBindings(syntheticProfile),
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
  instrumented = await loadInternals(TEST_PARENT);
  internals = instrumented.__runtimeTestInternals;
}, 180_000);

afterAll(async () => {
  const errors: unknown[] = [];
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
});

describe("fixed descriptor invocation", () => {
  it("constructs the sole descriptor launch, canonical mounts, environments, and grants", async () => {
    const { fake } = await supervise();
    const call = fake.spawnCall();
    const bindings = fakeBindings(syntheticProfile);
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
      syntheticProfile.manifest.artifacts.find((artifact) => artifact.id === "app/guard-policy")!.sha256,
    );
    expect(call.args).not.toContain(syntheticProfile.sha256);
    const nodeFlags = MARKDOWN_RUNTIME_CONTRACT.invocation.node.flags;
    const permissionIndex = nodeFlags.indexOf("--permission");
    const expectedArguments = [
      ...MARKDOWN_RUNTIME_CONTRACT.invocation.launcher.flags,
      ...Object.entries({ LC_ALL: "C", LANG: "C", TZ: "UTC", UV_THREADPOOL_SIZE: "1", PWD: "/app" }).flatMap(
        ([key, value]) => ["--setenv", key, value],
      ),
      ...syntheticProfile.manifest.directories.filter((path) => path !== "/").flatMap((path) => ["--dir", path]),
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
      syntheticProfile.manifest.artifacts.find((artifact) => artifact.id === "app/guard-policy")!.sha256,
    ];
    expect(call.args).toEqual(expectedArguments);
  });

  it("rejects mutable, incomplete, reordered, duplicate, and noninteger bindings before spawn", () => {
    const valid = fakeBindings(syntheticProfile);
    const expected = syntheticProfile.manifest.artifacts.filter((artifact) => artifact.virtual_path !== null);
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
      expect(() => internals.invocationArguments(syntheticProfile, bindings as MarkdownArtifactBindings)).toThrow();
    }
  });

  it("rejects proxy, accessor, unusual-prototype, nonarray, and unsafe bindings without invoking hooks", () => {
    const valid = fakeBindings(syntheticProfile);
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
    expect(() => internals.invocationArguments(syntheticProfile, proxy)).toThrow(/invalid artifact bindings/i);
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
      internals.invocationArguments(syntheticProfile, accessorBindings as unknown as MarkdownArtifactBindings),
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
        internals.invocationArguments(syntheticProfile, bindings as unknown as MarkdownArtifactBindings),
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
        syntheticProfile,
        fakeBindings(syntheticProfile),
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
