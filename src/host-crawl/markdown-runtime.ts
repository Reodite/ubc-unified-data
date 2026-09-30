import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { TextDecoder, types } from "node:util";
import {
  captureMarkdownArtifactCandidate,
  disposeMarkdownArtifactCandidate,
  verifyMarkdownArtifactCandidate,
  withVerifiedMarkdownArtifactBindings,
  type MarkdownArtifactBindings,
  type MarkdownArtifactCandidate,
} from "./markdown-artifacts.ts";
import type { MarkdownInspection } from "./markdown-contract.mjs";
import {
  MARKDOWN_RUNTIME_CONTRACT,
  MARKDOWN_RUNTIME_LIMITS,
  type MarkdownProfileEvidence,
} from "./markdown-profile.ts";
import {
  createMarkdownResponseDecoder,
  encodeMarkdownRequest,
  MARKDOWN_PROTOCOL_LIMITS,
  prepareMarkdownRequest,
  type PreparedMarkdownRequest,
} from "./markdown-protocol.mjs";

const OUTER_ENVIRONMENT = Object.freeze({ LC_ALL: "C", LANG: "C", TZ: "UTC", UV_THREADPOOL_SIZE: "1" });
const CHILD_ENVIRONMENT = Object.freeze({ ...OUTER_ENVIRONMENT, PWD: "/app" });
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;
const ABORT_CONTROLLER_ABORT = AbortController.prototype.abort;
const UINT64_MAXIMUM = 18446744073709551615n;
const PROCESS_STATES = /^[RSDZTWtXxKPI]$/;
const PROCESS_OBSERVATION_BYTES = MARKDOWN_RUNTIME_CONTRACT.runtime.processStatBytes;
const PROCESS_OBSERVATION_ATTEMPTS = MARKDOWN_RUNTIME_CONTRACT.runtime.processObservationAttempts;
const PROCESS_OBSERVATION_DELAY_MILLISECONDS = MARKDOWN_RUNTIME_CONTRACT.runtime.processObservationDelayMilliseconds;
const POLICY_ARTIFACT_ID = "app/guard-policy";
const SELF_TEST_BYTES = Buffer.from("Body\r\n", "utf8");
const SELF_TEST_TITLES = Object.freeze([null, "", "  Literal *title*  ", "  Literal *title*  "] as const);
const SELF_TEST_INSPECTION = Object.freeze({
  source_bytes: 6,
  source_bytes_sha256: "c7f37cfe2bd17c6331179ea9f3fbe4ad368794f69d1a28c7456cf4301f3bf169",
  title: "  Literal *title*  ",
  title_origin: Object.freeze({ kind: "advertisement" as const, witness_index: 2 }),
  links: Object.freeze([]),
  stats: Object.freeze({ emitted_tokens: 4, links: 0, max_depth: 1 }),
});

export type MarkdownTerminationEvidence = "observed-pid-absence" | "identity-matched-unreaped-zombie";

export interface MarkdownRuntimeResult {
  readonly inspection: MarkdownInspection;
  readonly profile_sha256: string;
  readonly termination: MarkdownTerminationEvidence;
}

declare const MARKDOWN_RUNTIME: unique symbol;

/** Process-local execution authority exposing immutable evidence but no physical bindings. */
export interface MarkdownRuntime {
  readonly profile: MarkdownProfileEvidence;
  readonly [MARKDOWN_RUNTIME]: never;
}

type ProcessIdentity = Readonly<{ state: string; starttime: string }>;
type ProcessObservation = ProcessIdentity | Readonly<{ absent: true }> | Readonly<{ error: true }>;

type ExecutionOwner = {
  child: ChildProcess | null;
  killSent: boolean;
};

type RuntimeLease = {
  readonly controller: AbortController;
  readonly owner: ExecutionOwner;
  readonly settled: Promise<void>;
  settle(): void;
};

type RuntimeDependencies = Readonly<{
  capture(signal?: AbortSignal): Promise<MarkdownArtifactCandidate>;
  verify(candidate: MarkdownArtifactCandidate): Promise<void>;
  invoke(
    candidate: MarkdownArtifactCandidate,
    request: PreparedMarkdownRequest,
    signal: AbortSignal | undefined,
    owner: ExecutionOwner,
  ): Promise<InvocationSuccess>;
  dispose(candidate: MarkdownArtifactCandidate): Promise<void>;
}>;

type RuntimeState = {
  readonly candidate: MarkdownArtifactCandidate;
  readonly dependencies: RuntimeDependencies;
  ready: boolean;
  busy: boolean;
  revoked: boolean;
  disposing: boolean;
  disposed: boolean;
  active: RuntimeLease | null;
  disposePromise: Promise<void> | null;
};

type CanonicalArtifactBindings = Readonly<{
  launcher_fd: number;
  mounts: readonly Readonly<{ source_fd: number; virtual_path: string }>[];
}>;

type InvocationSuccess = Readonly<{
  ok: true;
  inspection: MarkdownInspection;
  termination: MarkdownTerminationEvidence;
}>;

type InvocationFailure = Readonly<{ ok: false; error: unknown }>;
type InvocationOutcome = InvocationSuccess | InvocationFailure;

type SupervisionDependencies = Readonly<{
  spawn: typeof spawn;
  observeProcess(pid: number): Promise<ProcessObservation>;
  delay(milliseconds: number): Promise<unknown>;
}>;

const LIVE_SUPERVISION: SupervisionDependencies = Object.freeze({
  spawn,
  observeProcess: processState,
  delay: (milliseconds) => delay(milliseconds),
});
const LIVE_RUNTIME: RuntimeDependencies = Object.freeze({
  capture: captureMarkdownArtifactCandidate,
  verify: verifyMarkdownArtifactCandidate,
  invoke: invokeCandidate,
  dispose: disposeMarkdownArtifactCandidate,
});
const states = new WeakMap<MarkdownRuntime, RuntimeState>();

function runtimeError(reason: string): Error {
  return new Error(`Markdown runtime: ${reason}.`);
}

function abort(signal?: AbortSignal): void {
  if (signal !== undefined) AbortSignal.prototype.throwIfAborted.call(signal);
}

function isAborted(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (getter === undefined) throw runtimeError("AbortSignal support is unavailable");
  return getter.call(signal) as boolean;
}

function abortReason(signal: AbortSignal): unknown {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")?.get;
  if (getter === undefined) return runtimeError("operation cancelled");
  return getter.call(signal);
}

function authenticateSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || types.isProxy(value)) {
    throw runtimeError("invalid options");
  }
  try {
    isAborted(value as AbortSignal);
  } catch {
    throw runtimeError("invalid options");
  }
  return value as AbortSignal;
}

function optionsSignal(options: unknown): AbortSignal | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== "object" || types.isProxy(options)) {
    throw runtimeError("invalid options");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) throw runtimeError("invalid options");
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => key !== "signal") || keys.length > 1) throw runtimeError("invalid options");
  if (!Object.hasOwn(options, "signal")) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options, "signal");
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
    throw runtimeError("invalid options");
  }
  return authenticateSignal(descriptor.value);
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(ADD_EVENT_LISTENER, signal, ["abort", listener, { once: true }]);
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
}

function abortController(controller: AbortController, reason: unknown): void {
  Reflect.apply(ABORT_CONTROLLER_ABORT, controller, [reason]);
}

function composeSignals(signals: readonly (AbortSignal | undefined)[]): Readonly<{
  signal: AbortSignal | undefined;
  cleanup(): void;
}> {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return Object.freeze({ signal: undefined, cleanup() {} });
  if (present.length === 1) return Object.freeze({ signal: present[0], cleanup() {} });
  const controller = new AbortController();
  const listeners: { signal: AbortSignal; listener: () => void }[] = [];
  try {
    for (const signal of present) {
      const listener = () => {
        if (!isAborted(controller.signal)) abortController(controller, abortReason(signal));
      };
      addAbortListener(signal, listener);
      listeners.push({ signal, listener });
      if (isAborted(signal)) listener();
    }
  } catch (error) {
    for (const entry of listeners) removeAbortListener(entry.signal, entry.listener);
    throw error;
  }
  return Object.freeze({
    signal: controller.signal,
    cleanup() {
      for (const entry of listeners) removeAbortListener(entry.signal, entry.listener);
    },
  });
}

function profilePolicyDigest(profile: MarkdownProfileEvidence): string {
  const policies = profile.manifest.artifacts.filter(
    (artifact) =>
      artifact.id === POLICY_ARTIFACT_ID &&
      artifact.role === "policy" &&
      artifact.virtual_path === MARKDOWN_RUNTIME_CONTRACT.invocation.policy,
  );
  if (policies.length !== 1 || !/^[a-f0-9]{64}$/.test(policies[0]!.sha256)) {
    throw runtimeError("invalid fixed policy binding");
  }
  return policies[0]!.sha256;
}

function exactOwnData(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
    throw runtimeError("invalid status record");
  }
  return descriptor.value;
}

function frozenData(value: object, key: PropertyKey, enumerable: boolean): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    descriptor.enumerable !== enumerable ||
    descriptor.configurable ||
    descriptor.writable
  ) {
    throw runtimeError("invalid artifact bindings");
  }
  return descriptor.value;
}

function canonicalBindings(
  profile: MarkdownProfileEvidence,
  bindings: MarkdownArtifactBindings,
): CanonicalArtifactBindings {
  if (
    types.isProxy(bindings) ||
    (Object.getPrototypeOf(bindings) !== Object.prototype && Object.getPrototypeOf(bindings) !== null)
  ) {
    throw runtimeError("invalid artifact bindings");
  }
  if (!Object.isFrozen(bindings)) throw runtimeError("mutable artifact bindings");
  const keys = Reflect.ownKeys(bindings);
  if (keys.length !== 2 || keys[0] !== "launcher_fd" || keys[1] !== "mounts") {
    throw runtimeError("invalid artifact bindings");
  }
  const launcher = frozenData(bindings, "launcher_fd", true);
  const mountsValue = frozenData(bindings, "mounts", true);
  if (!Number.isSafeInteger(launcher) || (launcher as number) < 0 || Object.is(launcher, -0)) {
    throw runtimeError("invalid launcher descriptor");
  }
  if (
    !Array.isArray(mountsValue) ||
    types.isProxy(mountsValue) ||
    Object.getPrototypeOf(mountsValue) !== Array.prototype ||
    !Object.isFrozen(mountsValue)
  ) {
    throw runtimeError("invalid artifact mounts");
  }
  const length = frozenData(mountsValue, "length", false);
  const expected = profile.manifest.artifacts.filter((artifact) => artifact.virtual_path !== null);
  if (length !== expected.length) throw runtimeError("incomplete artifact bindings");
  const mountKeys = Reflect.ownKeys(mountsValue);
  const expectedMountKeys: PropertyKey[] = [...expected.map((_artifact, index) => String(index)), "length"];
  if (
    mountKeys.length !== expectedMountKeys.length ||
    mountKeys.some((key, index) => key !== expectedMountKeys[index])
  ) {
    throw runtimeError("invalid artifact mounts");
  }
  const descriptors = [launcher as number];
  const mounts = expected.map((artifact, index) => {
    const mount = frozenData(mountsValue, String(index), true);
    if (
      mount === null ||
      typeof mount !== "object" ||
      types.isProxy(mount) ||
      (Object.getPrototypeOf(mount) !== Object.prototype && Object.getPrototypeOf(mount) !== null) ||
      !Object.isFrozen(mount)
    ) {
      throw runtimeError("invalid artifact mount");
    }
    const keys = Reflect.ownKeys(mount);
    if (keys.length !== 2 || keys[0] !== "source_fd" || keys[1] !== "virtual_path") {
      throw runtimeError("invalid artifact mount");
    }
    const source = frozenData(mount, "source_fd", true);
    const virtualPath = frozenData(mount, "virtual_path", true);
    if (
      !Number.isSafeInteger(source) ||
      (source as number) < 0 ||
      Object.is(source, -0) ||
      virtualPath !== artifact.virtual_path
    ) {
      throw runtimeError("noncanonical artifact mount");
    }
    descriptors.push(source as number);
    return Object.freeze({ source_fd: source as number, virtual_path: virtualPath as string });
  });
  if (new Set(descriptors).size !== descriptors.length) throw runtimeError("duplicate artifact descriptor");
  return Object.freeze({ launcher_fd: launcher as number, mounts: Object.freeze(mounts) });
}

function invocationArgumentsFromBindings(
  profile: MarkdownProfileEvidence,
  bindings: CanonicalArtifactBindings,
): readonly string[] {
  const appPaths = bindings.mounts.map((mount) => mount.virtual_path).filter((path) => path.startsWith("/app/"));
  const directories = profile.manifest.directories.filter((path) => path !== "/");
  const nodeFlags = MARKDOWN_RUNTIME_CONTRACT.invocation.node.flags;
  const permissionIndex = nodeFlags.indexOf("--permission");
  if (permissionIndex < 0) throw runtimeError("invalid fixed Node invocation");
  const args = [
    ...MARKDOWN_RUNTIME_CONTRACT.invocation.launcher.flags,
    ...Object.entries(CHILD_ENVIRONMENT).flatMap(([key, value]) => ["--setenv", key, value]),
    ...directories.flatMap((path) => ["--dir", path]),
    ...bindings.mounts.flatMap((mount, index) => ["--ro-bind-fd", String(index + 5), mount.virtual_path]),
    "--dev-bind",
    MARKDOWN_RUNTIME_CONTRACT.device.path,
    MARKDOWN_RUNTIME_CONTRACT.device.path,
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
    profilePolicyDigest(profile),
  ];
  return Object.freeze(args);
}

function _invocationArguments(profile: MarkdownProfileEvidence, bindings: MarkdownArtifactBindings): readonly string[] {
  return invocationArgumentsFromBindings(profile, canonicalBindings(profile, bindings));
}

async function boundedProcessStat(pid: number): Promise<string> {
  const handle = await open(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(PROCESS_OBSERVATION_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > PROCESS_OBSERVATION_BYTES) throw runtimeError("process observation overflow");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function validProcessIdentity(value: ProcessObservation): value is ProcessIdentity {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys[0] !== "state" || keys[1] !== "starttime") return false;
  const state = Object.getOwnPropertyDescriptor(value, "state");
  const starttime = Object.getOwnPropertyDescriptor(value, "starttime");
  if (
    state === undefined ||
    starttime === undefined ||
    !Object.hasOwn(state, "value") ||
    !Object.hasOwn(starttime, "value") ||
    !PROCESS_STATES.test(state.value as string) ||
    !/^(?:0|[1-9][0-9]{0,19})$/.test(starttime.value as string)
  ) {
    return false;
  }
  try {
    return BigInt(starttime.value as string) <= UINT64_MAXIMUM;
  } catch {
    return false;
  }
}

function parseProcessStat(pid: number, stat: string): ProcessIdentity | null {
  const closing = stat.lastIndexOf(")");
  if (!stat.startsWith(`${pid} (`) || closing < 0 || stat[closing + 1] !== " ") return null;
  const tail = stat.slice(closing + 2).trimEnd();
  const fields = tail.split(/\s+/);
  if (fields.length < 20) return null;
  const identity = Object.freeze({ state: fields[0]!, starttime: fields[19]! });
  return validProcessIdentity(identity) ? identity : null;
}

async function processState(pid: number): Promise<ProcessObservation> {
  try {
    const parsed = parseProcessStat(pid, await boundedProcessStat(pid));
    return parsed ?? Object.freeze({ error: true as const });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return Object.freeze({ absent: true as const });
    return Object.freeze({ error: true as const });
  }
}

function validProcessAbsence(value: ProcessObservation): value is Readonly<{ absent: true }> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "absent") return false;
  const absent = Object.getOwnPropertyDescriptor(value, "absent");
  return absent !== undefined && Object.hasOwn(absent, "value") && absent.enumerable === true && absent.value === true;
}

function terminationEvidence(
  initial: ProcessObservation | undefined,
  final: ProcessObservation,
): MarkdownTerminationEvidence | null {
  if (validProcessAbsence(final)) {
    return "observed-pid-absence";
  }
  if (
    initial !== undefined &&
    validProcessIdentity(initial) &&
    validProcessIdentity(final) &&
    final.state === "Z" &&
    final.starttime === initial.starttime
  ) {
    return "identity-matched-unreaped-zombie";
  }
  return null;
}

function signalOwnedChild(owner: ExecutionOwner): void {
  const child = owner.child;
  if (owner.killSent || child === null || child.exitCode !== null || child.signalCode !== null) return;
  owner.killSent = true;
  child.kill("SIGKILL");
}

function parseStatusLine(
  line: string,
  state: {
    phase: number;
    ownedPid: number | undefined;
    initialObservation: Promise<ProcessObservation> | undefined;
  },
  dependencies: SupervisionDependencies,
): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw runtimeError("invalid status record");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw runtimeError("invalid status record");
  }
  const startup = Object.hasOwn(value, "child-pid");
  const terminal = Object.hasOwn(value, "exit-code");
  if (startup && terminal) throw runtimeError("combined status record");
  if (startup) {
    const pid = exactOwnData(value, "child-pid");
    if (state.phase !== 0 || !Number.isSafeInteger(pid) || (pid as number) <= 1) {
      throw runtimeError("invalid startup status");
    }
    state.phase = 1;
    state.ownedPid = pid as number;
    state.initialObservation = dependencies.observeProcess(pid as number);
  }
  if (terminal) {
    const code = exactOwnData(value, "exit-code");
    if (
      state.phase !== 1 ||
      !Number.isSafeInteger(code) ||
      Object.is(code, -0) ||
      (code as number) < 0 ||
      (code as number) > 255
    ) {
      throw runtimeError("invalid terminal status");
    }
    state.phase = 2;
    return code as number;
  }
  return undefined;
}

async function superviseInvocation(
  profile: MarkdownProfileEvidence,
  bindings: MarkdownArtifactBindings,
  request: PreparedMarkdownRequest,
  wire: Uint8Array,
  owner: ExecutionOwner,
  dependencies: SupervisionDependencies = LIVE_SUPERVISION,
): Promise<InvocationSuccess> {
  const canonical = canonicalBindings(profile, bindings);
  const args = invocationArgumentsFromBindings(profile, canonical);
  const stdio = [
    "pipe",
    "pipe",
    "pipe",
    "pipe",
    canonical.launcher_fd,
    ...canonical.mounts.map((mount) => mount.source_fd),
  ] as const;
  const child = dependencies.spawn("/proc/self/fd/4", [...args], {
    cwd: "/",
    env: OUTER_ENVIRONMENT,
    shell: false,
    stdio: [...stdio],
  });
  owner.child = child;

  let firstFailure: Error | null = null;
  let inputFinished = false;
  let inputCallback = false;
  let outputEnded = false;
  let stderrEnded = false;
  let statusEnded = false;
  let exitSeen = false;
  let closeSeen = false;
  let exitCode: number | null | undefined;
  let exitSignal: NodeJS.Signals | null | undefined;
  let closeCode: number | null | undefined;
  let closeSignal: NodeJS.Signals | null | undefined;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let statusBytes = 0;
  let responseDecoderFailed = false;
  let inspection: MarkdownInspection | undefined;
  let statusPending = "";
  const statusDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const statusState: {
    phase: number;
    ownedPid: number | undefined;
    initialObservation: Promise<ProcessObservation> | undefined;
  } = { phase: 0, ownedPid: undefined, initialObservation: undefined };
  const responseDecoder = createMarkdownResponseDecoder(request);

  const refuse = (reason: string, shouldSignal = true) => {
    firstFailure ??= runtimeError(reason);
    if (shouldSignal) signalOwnedChild(owner);
  };

  const status = child.stdio[3];
  if (child.stdin === null || child.stdout === null || child.stderr === null || status == null) {
    refuse("missing child stream");
    throw firstFailure;
  }
  const input = child.stdin;
  const output = child.stdout;
  const errors = child.stderr;

  const onChildError = () => refuse("child process error");
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exitSeen || closeSeen) refuse("invalid exit event order", false);
    exitSeen = true;
    exitCode = code;
    exitSignal = signal;
    if (code !== 0 || signal !== null) refuse("unsuccessful child exit", false);
  };
  let closeResolve!: () => void;
  const closed = new Promise<void>((resolvePromise) => {
    closeResolve = resolvePromise;
  });
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    if (closeSeen) refuse("duplicate child close", false);
    closeSeen = true;
    closeCode = code;
    closeSignal = signal;
    if (
      !inputFinished ||
      !inputCallback ||
      !outputEnded ||
      !stderrEnded ||
      !statusEnded ||
      !exitSeen ||
      statusState.phase !== 2 ||
      statusState.ownedPid === undefined
    ) {
      refuse("incomplete lifecycle at child close", false);
    }
    owner.child = null;
    closeResolve();
  };
  const onInputError = () => refuse("stdin error");
  const onInputFinish = () => {
    if (inputFinished || closeSeen) refuse("invalid stdin finish order", false);
    inputFinished = true;
  };
  const onInputClose = () => {
    if (!inputFinished) refuse("stdin closed before finish");
  };
  const onOutputError = () => refuse("stdout error");
  const onOutputData = (chunk: Buffer | string) => {
    if (outputEnded) refuse("stdout data after EOF", false);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += bytes.length;
    if (stdoutBytes > MARKDOWN_PROTOCOL_LIMITS.responseFrameBytes) {
      refuse("stdout overflow");
      return;
    }
    if (!responseDecoderFailed) {
      try {
        responseDecoder.push(bytes);
      } catch {
        responseDecoderFailed = true;
        refuse("invalid response frame");
      }
    }
  };
  const onOutputEnd = () => {
    if (outputEnded || closeSeen) refuse("invalid stdout EOF order", false);
    outputEnded = true;
    if (responseDecoderFailed) return;
    try {
      inspection = responseDecoder.finish();
    } catch {
      responseDecoderFailed = true;
      refuse("invalid response EOF");
    }
  };
  const onStderrError = () => refuse("stderr stream error");
  const onStderrData = (chunk: Buffer | string) => {
    if (stderrEnded) refuse("stderr data after EOF", false);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBytes += bytes.length;
    refuse(stderrBytes > MARKDOWN_RUNTIME_LIMITS.stderrBytes ? "stderr overflow" : "nonempty stderr");
  };
  const onStderrEnd = () => {
    if (stderrEnded || closeSeen) refuse("invalid stderr EOF order", false);
    stderrEnded = true;
  };
  const onStatusError = () => refuse("status stream error");
  const consumeStatusText = (text: string) => {
    statusPending += text;
    let newline = statusPending.indexOf("\n");
    while (newline >= 0) {
      const line = statusPending.slice(0, newline);
      statusPending = statusPending.slice(newline + 1);
      try {
        const terminalCode = parseStatusLine(line, statusState, dependencies);
        if (terminalCode !== undefined && terminalCode !== 0) refuse("unsuccessful namespace exit", false);
      } catch {
        refuse("invalid status record");
      }
      newline = statusPending.indexOf("\n");
    }
  };
  const onStatusData = (chunk: Buffer | string) => {
    if (statusEnded) refuse("status data after EOF", false);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    statusBytes += bytes.length;
    if (statusBytes > MARKDOWN_RUNTIME_LIMITS.statusBytes) {
      refuse("status overflow");
      return;
    }
    try {
      consumeStatusText(statusDecoder.decode(bytes, { stream: true }));
    } catch {
      refuse("invalid status UTF-8");
    }
  };
  const onStatusEnd = () => {
    if (statusEnded || closeSeen) refuse("invalid status EOF order", false);
    statusEnded = true;
    try {
      consumeStatusText(statusDecoder.decode());
      if (statusPending.length !== 0) refuse("partial status record");
    } catch {
      refuse("invalid status UTF-8");
    }
  };

  child.on("error", onChildError);
  child.once("exit", onExit);
  child.once("close", onClose);
  input.on("error", onInputError);
  input.on("finish", onInputFinish);
  input.on("close", onInputClose);
  output.on("error", onOutputError);
  output.on("data", onOutputData);
  output.on("end", onOutputEnd);
  errors.on("error", onStderrError);
  errors.on("data", onStderrData);
  errors.on("end", onStderrEnd);
  status.on("error", onStatusError);
  status.on("data", onStatusData);
  status.on("end", onStatusEnd);

  const wall = setTimeout(() => refuse("wall timeout"), MARKDOWN_RUNTIME_LIMITS.wallMilliseconds);
  wall.unref();
  try {
    try {
      input.end(wire, (error?: Error | null) => {
        if (inputCallback || closeSeen) refuse("invalid stdin callback order", false);
        if (error) refuse("stdin callback error");
        else inputCallback = true;
      });
    } catch {
      refuse("stdin write error");
    }
    await closed;
    const initialObservation = await statusState.initialObservation;
    if (!inputFinished || !inputCallback || !outputEnded || !stderrEnded || !statusEnded || !exitSeen || !closeSeen) {
      refuse("incomplete child lifecycle", false);
    }
    if (statusState.phase !== 2 || statusState.ownedPid === undefined) {
      refuse("incomplete namespace status", false);
    }
    let termination: MarkdownTerminationEvidence | null = null;
    if (statusState.ownedPid !== undefined) {
      for (let attempt = 0; attempt < PROCESS_OBSERVATION_ATTEMPTS; attempt += 1) {
        const finalObservation = await dependencies.observeProcess(statusState.ownedPid);
        termination = terminationEvidence(initialObservation, finalObservation);
        if (termination !== null) break;
        if (
          !validProcessIdentity(finalObservation) ||
          finalObservation.state === "Z" ||
          (initialObservation !== undefined &&
            validProcessIdentity(initialObservation) &&
            finalObservation.starttime !== initialObservation.starttime)
        ) {
          break;
        }
        if (attempt + 1 < PROCESS_OBSERVATION_ATTEMPTS) {
          await dependencies.delay(PROCESS_OBSERVATION_DELAY_MILLISECONDS);
        }
      }
    }
    if (termination === null) refuse("termination unverified", false);
    if (
      exitCode !== 0 ||
      exitSignal !== null ||
      closeCode !== 0 ||
      closeSignal !== null ||
      stderrBytes !== 0 ||
      inspection === undefined
    ) {
      refuse("failed completion gate", false);
    }
    if (firstFailure !== null) throw firstFailure;
    return Object.freeze({ ok: true as const, inspection: inspection!, termination: termination! });
  } finally {
    clearTimeout(wall);
    owner.child = null;
    child.removeListener("error", onChildError);
    child.removeListener("exit", onExit);
    child.removeListener("close", onClose);
    input.removeListener("error", onInputError);
    input.removeListener("finish", onInputFinish);
    input.removeListener("close", onInputClose);
    output.removeListener("error", onOutputError);
    output.removeListener("data", onOutputData);
    output.removeListener("end", onOutputEnd);
    errors.removeListener("error", onStderrError);
    errors.removeListener("data", onStderrData);
    errors.removeListener("end", onStderrEnd);
    status.removeListener("error", onStatusError);
    status.removeListener("data", onStatusData);
    status.removeListener("end", onStatusEnd);
  }
}

type InvocationDependencies = Readonly<{
  withBindings: typeof withVerifiedMarkdownArtifactBindings;
  supervise: typeof superviseInvocation;
}>;

const LIVE_INVOCATION: InvocationDependencies = Object.freeze({
  withBindings: withVerifiedMarkdownArtifactBindings,
  supervise: superviseInvocation,
});

async function invokeCandidate(
  candidate: MarkdownArtifactCandidate,
  request: PreparedMarkdownRequest,
  signal: AbortSignal | undefined,
  owner: ExecutionOwner,
  dependencies: InvocationDependencies = LIVE_INVOCATION,
): Promise<InvocationSuccess> {
  const wire = encodeMarkdownRequest(request);
  if (wire.byteLength > MARKDOWN_PROTOCOL_LIMITS.requestFrameBytes) throw runtimeError("request frame overflow");
  const onAbort = () => signalOwnedChild(owner);
  if (signal !== undefined) addAbortListener(signal, onAbort);
  try {
    abort(signal);
    let outcome: InvocationOutcome;
    try {
      outcome = await dependencies.withBindings(candidate, async (bindings) => {
        try {
          abort(signal);
          const result = await dependencies.supervise(candidate.profile, bindings, request, wire, owner);
          abort(signal);
          return result;
        } catch (error) {
          return Object.freeze({ ok: false as const, error });
        }
      });
    } catch (error) {
      throw new AggregateError([error], "Markdown runtime binding verification failed");
    }
    abort(signal);
    if (!outcome.ok) throw outcome.error;
    return outcome;
  } finally {
    if (signal !== undefined) removeAbortListener(signal, onAbort);
  }
}

function sameInspection(left: MarkdownInspection, right: MarkdownInspection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createHandle(candidate: MarkdownArtifactCandidate): MarkdownRuntime {
  const handle = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperty(handle, "profile", {
    value: candidate.profile,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return Object.freeze(handle) as unknown as MarkdownRuntime;
}

function createLease(): RuntimeLease {
  const controller = new AbortController();
  const owner: ExecutionOwner = { child: null, killSent: false };
  let settle!: () => void;
  const settled = new Promise<void>((resolvePromise) => {
    settle = resolvePromise;
  });
  return { controller, owner, settled, settle };
}

async function prepareMarkdownRuntimeWithDependencies(
  options: { readonly signal?: AbortSignal } | undefined,
  dependencies: RuntimeDependencies,
): Promise<MarkdownRuntime> {
  const signal = optionsSignal(options);
  abort(signal);
  let candidate: MarkdownArtifactCandidate | undefined;
  try {
    candidate = await dependencies.capture(signal);
    abort(signal);
    await dependencies.verify(candidate);
    abort(signal);
    const request = prepareMarkdownRequest(SELF_TEST_BYTES, SELF_TEST_TITLES);
    const owner: ExecutionOwner = { child: null, killSent: false };
    const result = await dependencies.invoke(candidate, request, signal, owner);
    if (!sameInspection(result.inspection, SELF_TEST_INSPECTION)) throw runtimeError("fixed self-test mismatch");
    abort(signal);
    await dependencies.verify(candidate);
    abort(signal);
    const runtime = createHandle(candidate);
    states.set(runtime, {
      candidate,
      dependencies,
      ready: true,
      busy: false,
      revoked: false,
      disposing: false,
      disposed: false,
      active: null,
      disposePromise: null,
    });
    return runtime;
  } catch (error) {
    if (candidate === undefined) throw error;
    try {
      await dependencies.dispose(candidate);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Markdown runtime preparation and cleanup failed");
    }
    throw error;
  }
}

/** Capture and self-test the sole fixed worker before issuing execution authority. */
export async function prepareMarkdownRuntime(options?: { readonly signal?: AbortSignal }): Promise<MarkdownRuntime> {
  return prepareMarkdownRuntimeWithDependencies(options, LIVE_RUNTIME);
}

/** Execute one prepared request through the authenticated fixed worker and complete every lifecycle gate. */
export async function inspectMarkdownRuntime(
  runtime: MarkdownRuntime,
  request: PreparedMarkdownRequest,
  options?: { readonly signal?: AbortSignal },
): Promise<MarkdownRuntimeResult> {
  const state = states.get(runtime);
  if (state === undefined) throw runtimeError("forged runtime");
  const userSignal = optionsSignal(options);
  encodeMarkdownRequest(request);
  if (state.revoked || state.disposed || state.disposing) throw runtimeError("runtime unavailable");
  if (state.busy) throw runtimeError("runtime already in use");
  if (!state.ready) throw runtimeError("runtime unavailable");
  abort(userSignal);

  state.busy = true;
  state.ready = false;
  const lease = createLease();
  state.active = lease;
  let composed: ReturnType<typeof composeSignals> | undefined;
  let operationError: unknown;
  let operationFailed = false;
  let result: MarkdownRuntimeResult | undefined;
  try {
    composed = composeSignals([userSignal, lease.controller.signal]);
    const invocation = await state.dependencies.invoke(state.candidate, request, composed.signal, lease.owner);
    abort(composed.signal);
    if (state.revoked || state.disposing || state.disposed) throw runtimeError("runtime revoked during inspection");
    result = Object.freeze({
      inspection: invocation.inspection,
      profile_sha256: runtime.profile.sha256,
      termination: invocation.termination,
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
    if (error instanceof AggregateError && error.message === "Markdown runtime binding verification failed") {
      state.revoked = true;
    }
  }
  let cleanupError: unknown;
  try {
    composed?.cleanup();
  } catch (error) {
    cleanupError = error;
    state.revoked = true;
  }
  state.busy = false;
  state.active = null;
  if (!state.revoked && !state.disposing && !state.disposed) state.ready = true;
  lease.settle();
  if (operationFailed) {
    if (cleanupError !== undefined) {
      throw new AggregateError([operationError, cleanupError], "Markdown runtime inspection and cleanup failed");
    }
    throw operationError;
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw runtimeError("inspection produced no result");
  return result;
}

/** Revoke authority first, cancel only an owned active child, then dispose authenticated artifacts once. */
export function disposeMarkdownRuntime(runtime: MarkdownRuntime): Promise<void> {
  const state = states.get(runtime);
  if (state === undefined) return Promise.reject(runtimeError("forged runtime"));
  if (state.disposePromise !== null) return state.disposePromise;
  state.ready = false;
  state.revoked = true;
  state.disposing = true;
  const active = state.active;
  if (active !== null && !isAborted(active.controller.signal)) {
    abortController(active.controller, runtimeError("runtime disposal cancelled active inspection"));
  }
  state.disposePromise = (async () => {
    try {
      if (active !== null) await active.settled;
      await state.dependencies.dispose(state.candidate);
    } finally {
      state.disposing = false;
      state.disposed = true;
      state.ready = false;
      state.busy = false;
      state.active = null;
    }
  })();
  return state.disposePromise;
}
