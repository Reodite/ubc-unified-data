import type { MarkdownInspection } from "./markdown-contract.mjs";

export {
  MARKDOWN_INSPECTION_DIALECT,
  MARKDOWN_INSPECTION_LIMITS,
  type MarkdownInspection,
  type MarkdownTitleOrigin,
} from "./markdown-contract.mjs";

/** Inspect copied UTF-8 bytes without returning a body or establishing process resource isolation. */
export declare function inspectMarkdownSource(
  bytes: Uint8Array,
  advertisedTitles: readonly (string | null)[],
): MarkdownInspection;
