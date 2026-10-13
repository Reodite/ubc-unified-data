import {
  captureMarkdownArtifactCandidate,
  disposeMarkdownArtifactCandidate,
  verifyMarkdownArtifactCandidate,
} from "./markdown-artifacts.ts";
import type { PreparedMarkdownRequest } from "./markdown-protocol.mjs";
import {
  createMarkdownRuntimeController,
  type MarkdownRuntime,
  type MarkdownRuntimeResult,
} from "./markdown-runtime-core.ts";
import { invokeCandidate } from "./markdown-runtime-invocation.ts";

export type { MarkdownRuntime, MarkdownRuntimeResult, MarkdownTerminationEvidence } from "./markdown-runtime-core.ts";

const controller = createMarkdownRuntimeController({
  capture: captureMarkdownArtifactCandidate,
  verify: verifyMarkdownArtifactCandidate,
  invoke: invokeCandidate,
  dispose: disposeMarkdownArtifactCandidate,
});

/** Capture and self-test the sole fixed worker before issuing execution authority. */
export function prepareMarkdownRuntime(options?: { readonly signal?: AbortSignal }): Promise<MarkdownRuntime> {
  return controller.prepare(options);
}

/** Execute one prepared request through the authenticated fixed worker and complete every lifecycle gate. */
export function inspectMarkdownRuntime(
  runtime: MarkdownRuntime,
  request: PreparedMarkdownRequest,
  options?: { readonly signal?: AbortSignal },
): Promise<MarkdownRuntimeResult> {
  return controller.inspect(runtime, request, options);
}

/** Revoke authority first, cancel only an owned active child, then dispose authenticated artifacts once. */
export function disposeMarkdownRuntime(runtime: MarkdownRuntime): Promise<void> {
  return controller.dispose(runtime);
}
