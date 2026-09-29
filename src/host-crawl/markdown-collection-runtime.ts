import type { CollectionFormats } from "./collect.ts";
import { prepareMarkdownRequest } from "./markdown-protocol.mjs";
import {
  disposeMarkdownRuntime,
  inspectMarkdownRuntime,
  prepareMarkdownRuntime,
  type MarkdownRuntime,
} from "./markdown-runtime.ts";

export interface MarkdownCollectionRuntimeResult<T> {
  readonly value: T;
  readonly profile_sha256: string | null;
}

export async function withMarkdownCollectionRuntime<T>(
  enabled: boolean,
  callback: (format: CollectionFormats["markdown"]) => Promise<T>,
  options?: { readonly signal?: AbortSignal },
): Promise<MarkdownCollectionRuntimeResult<T>> {
  if (!enabled) return Object.freeze({ value: await callback(undefined), profile_sha256: null });
  let runtime: MarkdownRuntime | undefined;
  let profileSha256: string | null = null;
  let value!: T;
  let primary: unknown;
  let primarySet = false;
  try {
    runtime = await prepareMarkdownRuntime(options);
    profileSha256 = runtime.profile.sha256;
    const format = Object.freeze({
      profile_sha256: profileSha256,
      inspect: async (bytes: Uint8Array, advertisedTitles: readonly (string | null)[]) =>
        inspectMarkdownRuntime(runtime!, prepareMarkdownRequest(bytes, advertisedTitles), options),
    });
    try {
      value = await callback(format);
    } catch (error) {
      primary = error;
      primarySet = true;
    }
  } catch (error) {
    primary = error;
    primarySet = true;
  }
  let cleanup: unknown;
  let cleanupSet = false;
  if (runtime)
    try {
      await disposeMarkdownRuntime(runtime);
    } catch (error) {
      cleanup = error;
      cleanupSet = true;
    }
  if (primarySet && cleanupSet)
    throw new AggregateError([primary, cleanup], "Markdown collection runtime and cleanup failed");
  if (primarySet) throw primary;
  if (cleanupSet) throw cleanup;
  return Object.freeze({ value, profile_sha256: profileSha256 });
}
