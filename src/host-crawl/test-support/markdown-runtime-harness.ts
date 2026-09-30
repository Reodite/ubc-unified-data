import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MarkdownArtifactBindings, MarkdownArtifactCandidate } from "../markdown-artifacts.ts";
import type { MarkdownInspection } from "../markdown-contract.mjs";
import type { MarkdownProfileEvidence } from "../markdown-profile.ts";
import type { PreparedMarkdownRequest } from "../markdown-protocol.mjs";
import type {
  disposeMarkdownRuntime,
  inspectMarkdownRuntime,
  MarkdownRuntime,
  MarkdownTerminationEvidence,
} from "../markdown-runtime.ts";

const IMPLEMENTATION_PATH = fileURLToPath(new URL("../markdown-runtime.ts", import.meta.url));
const SOURCE_DIRECTORY = new URL("../", import.meta.url);
export const SELF_TEST_BYTES = Buffer.from("Body\r\n", "utf8");
export const SELF_TEST_INSPECTION: MarkdownInspection = Object.freeze({
  source_bytes: 6,
  source_bytes_sha256: "c7f37cfe2bd17c6331179ea9f3fbe4ad368794f69d1a28c7456cf4301f3bf169",
  title: "  Literal *title*  ",
  title_origin: Object.freeze({ kind: "advertisement", witness_index: 2 }),
  links: Object.freeze([]),
  stats: Object.freeze({ emitted_tokens: 4, links: 0, max_depth: 1 }),
});

export type ProcessObservation =
  Readonly<{ state: string; starttime: string }> | Readonly<{ absent: true }> | Readonly<{ error: true }>;

export type ExecutionOwner = { child: FakeChild | null; killSent: boolean };

export type RuntimeDependencies = {
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

export type InvocationDependencies = {
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

export type SupervisionDependencies = {
  spawn(command: string, args: string[], options: Record<string, unknown>): FakeChild;
  observeProcess(pid: number): Promise<ProcessObservation>;
  delay(milliseconds: number): Promise<unknown>;
};

export interface RuntimeInternals {
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

export interface InstrumentedRuntimeModule {
  __runtimeTestInternals: RuntimeInternals;
  inspectMarkdownRuntime: typeof inspectMarkdownRuntime;
  disposeMarkdownRuntime: typeof disposeMarkdownRuntime;
}

export interface FakeScenario {
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

export class FakeChild extends EventEmitter {
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

function defaultStatuses(): readonly Buffer[] {
  return [Buffer.from('{"child-pid":31337}\n'), Buffer.from('{"exit-code":0}\n')];
}

export async function loadInternals(testParent: string): Promise<InstrumentedRuntimeModule> {
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
  const path = `${testParent}/instrumented-${process.pid}.mjs`;
  await writeFile(path, transformed, { mode: 0o600 });
  return (await import(`${pathToFileURL(path).href}?${Date.now()}`)) as InstrumentedRuntimeModule;
}
