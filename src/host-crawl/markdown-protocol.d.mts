import type { MarkdownInspection } from "./markdown-contract.mjs";

export declare const MARKDOWN_PROTOCOL_LIMITS: Readonly<{
  requestPrefixBytes: 16;
  requestHeaderBytes: 163840;
  requestSourceBytes: 1048576;
  requestFrameBytes: 1212432;
  responsePrefixBytes: 12;
  responseMetadataBytes: 262144;
  responseEnvelopeHeadroom: 1024;
  responseEnvelopeBytes: 263168;
  responseFrameBytes: 263180;
}>;

declare const preparedRequest: unique symbol;

/** Process-local input ownership, not runtime-profile or execution authority. */
export interface PreparedMarkdownRequest {
  readonly [preparedRequest]: true;
  readonly source_bytes: number;
  readonly source_bytes_sha256: string;
  readonly advertised_titles: readonly (string | null)[];
}

export interface MarkdownFrameDecoder<Result> {
  /** Copy an admitted chunk without returning a result; shared backing memory is rejected. */
  push(chunk: Uint8Array): void;
  /** Assert exact EOF. Both success and failure permanently close this decoder. */
  finish(): Result;
}

export declare function prepareMarkdownRequest(
  bytes: Uint8Array,
  titles: readonly (string | null)[],
): PreparedMarkdownRequest;

/** The record and title evidence are frozen; bytes are a fresh mutable copy. */
export declare function getMarkdownRequestInput(request: PreparedMarkdownRequest): Readonly<{
  bytes: Uint8Array;
  advertised_titles: readonly (string | null)[];
}>;

export declare function encodeMarkdownRequest(request: PreparedMarkdownRequest): Uint8Array;

export declare function createMarkdownRequestDecoder(): MarkdownFrameDecoder<PreparedMarkdownRequest>;

export declare function encodeMarkdownResponse(
  metadata: MarkdownInspection,
  request: PreparedMarkdownRequest,
): Uint8Array;

export declare function createMarkdownResponseDecoder(
  request: PreparedMarkdownRequest,
): MarkdownFrameDecoder<MarkdownInspection>;
