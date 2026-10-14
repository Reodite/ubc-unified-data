import type { ChildProcess } from "node:child_process";
import { types } from "node:util";
import type { MarkdownArtifactCandidate } from "./markdown-artifacts.ts";
import type { MarkdownInspection } from "./markdown-contract.mjs";
import type { MarkdownProfileEvidence } from "./markdown-profile.ts";
import { encodeMarkdownRequest, prepareMarkdownRequest, type PreparedMarkdownRequest } from "./markdown-protocol.mjs";

const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;
const ABORT_CONTROLLER_ABORT = AbortController.prototype.abort;
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

export type ExecutionOwner = {
  child: ChildProcess | null;
  killSent: boolean;
};

type RuntimeLease = {
  readonly controller: AbortController;
  readonly owner: ExecutionOwner;
  readonly settled: Promise<void>;
  settle(): void;
};

export type RuntimeDependencies = Readonly<{
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
  ready: boolean;
  busy: boolean;
  revoked: boolean;
  disposing: boolean;
  disposed: boolean;
  active: RuntimeLease | null;
  disposePromise: Promise<void> | null;
};

export type InvocationSuccess = Readonly<{
  ok: true;
  inspection: MarkdownInspection;
  termination: MarkdownTerminationEvidence;
}>;

export function runtimeError(reason: string): Error {
  return new Error(`Markdown runtime: ${reason}.`);
}

export function abort(signal?: AbortSignal): void {
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

export function addAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(ADD_EVENT_LISTENER, signal, ["abort", listener, { once: true }]);
}

export function removeAbortListener(signal: AbortSignal, listener: () => void): void {
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

/** Create an isolated runtime authority bound to one captured set of operations. */
export function createMarkdownRuntimeController(dependencies: RuntimeDependencies) {
  const { capture, verify, invoke, dispose: disposeCandidate } = dependencies;
  const states = new WeakMap<MarkdownRuntime, RuntimeState>();

  async function prepare(options?: { readonly signal?: AbortSignal }): Promise<MarkdownRuntime> {
    const signal = optionsSignal(options);
    abort(signal);
    let candidate: MarkdownArtifactCandidate | undefined;
    try {
      candidate = await capture(signal);
      abort(signal);
      await verify(candidate);
      abort(signal);
      const request = prepareMarkdownRequest(SELF_TEST_BYTES, SELF_TEST_TITLES);
      const owner: ExecutionOwner = { child: null, killSent: false };
      const result = await invoke(candidate, request, signal, owner);
      if (!sameInspection(result.inspection, SELF_TEST_INSPECTION)) throw runtimeError("fixed self-test mismatch");
      abort(signal);
      await verify(candidate);
      abort(signal);
      const runtime = createHandle(candidate);
      states.set(runtime, {
        candidate,
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
        await disposeCandidate(candidate);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Markdown runtime preparation and cleanup failed");
      }
      throw error;
    }
  }

  /** Execute one prepared request through the authenticated fixed worker and complete every lifecycle gate. */
  async function inspect(
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
      const invocation = await invoke(state.candidate, request, composed.signal, lease.owner);
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
  function dispose(runtime: MarkdownRuntime): Promise<void> {
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
        await disposeCandidate(state.candidate);
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

  return Object.freeze({ prepare, inspect, dispose });
}
