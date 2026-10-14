import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { MarkdownInspection } from "../markdown-contract.mjs";

export const SELF_TEST_BYTES = Buffer.from("Body\r\n", "utf8");
export const SELF_TEST_INSPECTION: MarkdownInspection = Object.freeze({
  source_bytes: 6,
  source_bytes_sha256: "c7f37cfe2bd17c6331179ea9f3fbe4ad368794f69d1a28c7456cf4301f3bf169",
  title: "  Literal *title*  ",
  title_origin: Object.freeze({ kind: "advertisement", witness_index: 2 }),
  links: Object.freeze([]),
  stats: Object.freeze({ emitted_tokens: 4, links: 0, max_depth: 1 }),
});

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

  get process(): ChildProcess {
    return this as unknown as ChildProcess;
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
