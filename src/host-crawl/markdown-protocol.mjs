import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder, types } from "node:util";
import {
  hasUnsafeMarkdownCharacter,
  MARKDOWN_INSPECTION_LIMITS as INSPECTION,
  validateAdvertisements,
  validateDestination,
  validateTitle,
} from "./markdown-contract.mjs";

const REQUEST_PREFIX_BYTES = 16;
const REQUEST_HEADER_BYTES = 163840;
const RESPONSE_PREFIX_BYTES = 12;
const RESPONSE_ENVELOPE_HEADROOM = 1024;
export const MARKDOWN_PROTOCOL_LIMITS = Object.freeze({
  requestPrefixBytes: REQUEST_PREFIX_BYTES,
  requestHeaderBytes: REQUEST_HEADER_BYTES,
  requestSourceBytes: INSPECTION.inputBytes,
  requestFrameBytes: REQUEST_PREFIX_BYTES + REQUEST_HEADER_BYTES + INSPECTION.inputBytes,
  responsePrefixBytes: RESPONSE_PREFIX_BYTES,
  responseMetadataBytes: INSPECTION.metadataBytes,
  responseEnvelopeHeadroom: RESPONSE_ENVELOPE_HEADROOM,
  responseEnvelopeBytes: INSPECTION.metadataBytes + RESPONSE_ENVELOPE_HEADROOM,
  responseFrameBytes: RESPONSE_PREFIX_BYTES + INSPECTION.metadataBytes + RESPONSE_ENVELOPE_HEADROOM,
});
const LIMITS = MARKDOWN_PROTOCOL_LIMITS;
const REQUEST_MAGIC = Buffer.from("UBCMDQ01", "ascii");
const RESPONSE_MAGIC = Buffer.from("UBCMDR01", "ascii");
const requests = new WeakMap();
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, "buffer").get;
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, "byteOffset").get;
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, "byteLength").get;

function fail() {
  throw new Error("Markdown protocol: invalid input.");
}

function guarded(operation) {
  try {
    return operation();
  } catch {
    fail();
  }
}

// Intrinsic accessors avoid reading caller-defined byte-view getters or methods.
function byteView(value) {
  if (!types.isUint8Array(value)) fail();
  const buffer = bufferOf.call(value);
  if (types.isSharedArrayBuffer(buffer)) fail();
  return new Uint8Array(buffer, offsetOf.call(value), lengthOf.call(value));
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) fail();
  return value;
}

function ownValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
  return descriptor.value;
}

function record(value, fields) {
  if (value === null || typeof value !== "object") fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) fail();
  return fields.map((key) => ownValue(value, key));
}

function arrayLength(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  const length = integer(ownValue(value, "length"), 0, maximum);
  if (Reflect.ownKeys(value).length !== length + 1) fail();
  for (let index = 0; index < length; index++) ownValue(value, String(index));
  return length;
}

// Only bounded primitive fragments reach JSON.stringify; caller records never do.
class Printer {
  constructor(limit) {
    this.limit = limit;
    this.size = 0;
    this.parts = [];
  }

  literal(value) {
    if (this.size + value.length > this.limit) fail();
    this.size += value.length;
    this.parts.push(value);
  }

  string(value, maximum = this.limit) {
    if (typeof value !== "string" || value.length > maximum || value.length > this.limit - this.size - 2) fail();
    let size = 2;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || [8, 9, 10, 12, 13].includes(code)) size += 2;
      else if (code < 0x20) size += 6;
      else if (code < 0x80) size++;
      else if (code < 0x800) size += 2;
      else if (code >= 0xd800 && code <= 0xdfff) {
        const next = value.charCodeAt(index + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          size += 4;
          index++;
        } else size += 6;
      } else size += 3;
      if (this.size + size > this.limit) fail();
    }
    if (this.size + size > this.limit) fail();
    this.size += size;
    this.parts.push(JSON.stringify(value));
    return value;
  }

  number(value, minimum, maximum) {
    this.literal(String(integer(value, minimum, maximum)));
    return value;
  }

  finish() {
    return this.parts.join("");
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashField(printer, value) {
  printer.string(value, 64);
  if (!/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}

function titleArray(printer, input) {
  const length = arrayLength(input, INSPECTION.advertisedTitles);
  const titles = [];
  printer.literal("[");
  for (let index = 0; index < length; index++) {
    if (index) printer.literal(",");
    const value = ownValue(input, String(index));
    if (value === null) printer.literal("null");
    else printer.string(value, INSPECTION.advertisedTitleCodeUnits);
    titles.push(value);
  }
  printer.literal("]");
  validateAdvertisements(titles);
  return Object.freeze(titles);
}

function requestHeader(input) {
  const [version, sourceBytes, sourceHash, titles] = record(input, [
    "version",
    "source_bytes",
    "source_bytes_sha256",
    "advertised_titles",
  ]);
  const printer = new Printer(LIMITS.requestHeaderBytes);
  printer.literal('{"version":');
  printer.number(version, 1, 1);
  printer.literal(',"source_bytes":');
  printer.number(sourceBytes, 1, LIMITS.requestSourceBytes);
  printer.literal(',"source_bytes_sha256":');
  hashField(printer, sourceHash);
  printer.literal(',"advertised_titles":');
  const advertisedTitles = titleArray(printer, titles);
  printer.literal("}");
  return { json: printer.finish(), sourceBytes, sourceHash, advertisedTitles };
}

function issueRequest(bytes, sourceHash, advertisedTitles) {
  const request = Object.freeze({
    source_bytes: bytes.byteLength,
    source_bytes_sha256: sourceHash,
    advertised_titles: advertisedTitles,
  });
  requests.set(request, { bytes, sourceHash, advertisedTitles });
  return request;
}

function retained(request) {
  const value = requests.get(request);
  if (!value) fail();
  return value;
}

/** Snapshot raw bytes and evidence; the handle is not runtime-profile authority. */
export function prepareMarkdownRequest(bytes, titles) {
  return guarded(() => {
    const view = byteView(bytes);
    integer(view.byteLength, 1, LIMITS.requestSourceBytes);
    const copy = new Uint8Array(view);
    const sourceHash = digest(copy);
    const { advertisedTitles } = requestHeader({
      version: 1,
      source_bytes: copy.byteLength,
      source_bytes_sha256: sourceHash,
      advertised_titles: titles,
    });
    return issueRequest(copy, sourceHash, advertisedTitles);
  });
}

/** Return mutable owned bytes and frozen title evidence, without exposing retained bytes. */
export function getMarkdownRequestInput(request) {
  return guarded(() => {
    const { bytes, advertisedTitles } = retained(request);
    return Object.freeze({ bytes: new Uint8Array(bytes), advertised_titles: advertisedTitles });
  });
}

export function encodeMarkdownRequest(request) {
  return guarded(() => {
    const { bytes, sourceHash, advertisedTitles } = retained(request);
    const { json } = requestHeader({
      version: 1,
      source_bytes: bytes.byteLength,
      source_bytes_sha256: sourceHash,
      advertised_titles: advertisedTitles,
    });
    const header = Buffer.from(json, "utf8");
    const frame = Buffer.alloc(REQUEST_PREFIX_BYTES + header.byteLength + bytes.byteLength);
    REQUEST_MAGIC.copy(frame);
    frame.writeUInt32BE(header.byteLength, 8);
    frame.writeUInt32BE(bytes.byteLength, 12);
    frame.set(header, REQUEST_PREFIX_BYTES);
    frame.set(bytes, REQUEST_PREFIX_BYTES + header.byteLength);
    return frame;
  });
}

function inspectionRecord(input, request) {
  const authority = retained(request);
  const [sourceBytes, sourceHash, title, origin, inputLinks, inputStats] = record(input, [
    "source_bytes",
    "source_bytes_sha256",
    "title",
    "title_origin",
    "links",
    "stats",
  ]);
  const printer = new Printer(LIMITS.responseMetadataBytes);
  printer.literal('{"source_bytes":');
  printer.number(sourceBytes, 1, LIMITS.requestSourceBytes);
  printer.literal(',"source_bytes_sha256":');
  hashField(printer, sourceHash);
  if (sourceBytes !== authority.bytes.byteLength || sourceHash !== authority.sourceHash) fail();
  printer.literal(',"title":');
  printer.string(title, INSPECTION.titleBytes);
  validateTitle(title);
  printer.literal(',"title_origin":');
  // Read kind through a descriptor before selecting the exact union member's keys.
  if (origin === null || typeof origin !== "object") fail();
  const kind = ownValue(origin, "kind");
  let titleOrigin;
  if (kind === "markdown-body") {
    record(origin, ["kind"]);
    if (title.startsWith(" ") || title.endsWith(" ")) fail();
    printer.literal('{"kind":"markdown-body"}');
    titleOrigin = Object.freeze({ kind });
  } else if (kind === "advertisement") {
    const [, index] = record(origin, ["kind", "witness_index"]);
    printer.literal('{"kind":"advertisement","witness_index":');
    printer.number(index, 0, INSPECTION.advertisedTitles - 1);
    printer.literal("}");
    const selected = validateAdvertisements(authority.advertisedTitles);
    if (!selected || selected.title !== title || selected.title_origin.witness_index !== index) fail();
    titleOrigin = Object.freeze({ kind, witness_index: index });
  } else fail();

  printer.literal(',"links":[');
  const length = arrayLength(inputLinks, INSPECTION.links);
  const links = [];
  const seen = new Map();
  for (let index = 0; index < length; index++) {
    if (index) printer.literal(",");
    const [text, url] = record(ownValue(inputLinks, String(index)), ["text", "url"]);
    printer.literal('{"text":');
    printer.string(text);
    // Mask allowed HT without joining otherwise unpaired surrogate code units.
    if (hasUnsafeMarkdownCharacter(text.replace(/\t/g, " "))) fail();
    printer.literal(',"url":');
    printer.string(url);
    validateDestination(url, false);
    printer.literal("}");
    let urls = seen.get(text);
    if (urls?.has(url)) fail();
    if (!urls) {
      urls = new Set();
      seen.set(text, urls);
    }
    urls.add(url);
    links.push(Object.freeze({ text, url }));
  }
  printer.literal('],"stats":');
  const [tokens, rawLinks, depth] = record(inputStats, ["emitted_tokens", "links", "max_depth"]);
  printer.literal('{"emitted_tokens":');
  printer.number(tokens, 1, INSPECTION.tokens);
  printer.literal(',"links":');
  printer.number(rawLinks, 0, INSPECTION.links);
  printer.literal(',"max_depth":');
  printer.number(depth, 1, INSPECTION.nesting);
  printer.literal("}}");
  if (length > rawLinks || tokens < 2 * rawLinks) fail();
  const metadata = Object.freeze({
    source_bytes: sourceBytes,
    source_bytes_sha256: sourceHash,
    title,
    title_origin: titleOrigin,
    links: Object.freeze(links),
    stats: Object.freeze({ emitted_tokens: tokens, links: rawLinks, max_depth: depth }),
  });
  return { metadata, json: printer.finish() };
}

function responseEnvelope(metadata, request) {
  const { json, metadata: validated } = inspectionRecord(metadata, request);
  const envelope = Buffer.from(`{"version":1,"inspection":${json}}`, "utf8");
  if (envelope.byteLength > LIMITS.responseEnvelopeBytes) fail();
  return { envelope, metadata: validated };
}

export function encodeMarkdownResponse(metadata, request) {
  return guarded(() => {
    const { envelope } = responseEnvelope(metadata, request);
    const frame = Buffer.alloc(RESPONSE_PREFIX_BYTES + envelope.byteLength);
    RESPONSE_MAGIC.copy(frame);
    frame.writeUInt32BE(envelope.byteLength, 8);
    frame.set(envelope, RESPONSE_PREFIX_BYTES);
    return frame;
  });
}

function parseJson(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}

function canonical(bytes, json) {
  if (!bytes.equals(Buffer.from(json, "utf8"))) fail();
}

// Prefix admission precedes payload allocation; push never copies an unadmitted chunk wholesale.
function decoder(prefixBytes, magic, admit, decode) {
  let prefix = Buffer.alloc(prefixBytes);
  let frame;
  let offset = 0;
  let terminal = false;
  const run = (operation) => {
    if (terminal) fail();
    try {
      return operation();
    } catch {
      terminal = true;
      prefix = undefined;
      frame = undefined;
      fail();
    }
  };
  return Object.freeze({
    push(chunk) {
      return run(() => {
        const view = byteView(chunk);
        let consumed = 0;
        if (!frame) {
          const count = Math.min(prefixBytes - offset, view.byteLength);
          prefix.set(view.subarray(0, count), offset);
          offset += count;
          consumed += count;
          if (offset < prefixBytes) return;
          if (!prefix.subarray(0, magic.byteLength).equals(magic)) fail();
          const size = admit(prefix);
          if (view.byteLength - consumed > size - prefixBytes) fail();
          frame = Buffer.alloc(size);
          frame.set(prefix);
          prefix = undefined;
        }
        const remaining = view.byteLength - consumed;
        if (remaining > frame.byteLength - offset) fail();
        frame.set(view.subarray(consumed), offset);
        offset += remaining;
      });
    },
    finish() {
      return run(() => {
        if (!frame || offset !== frame.byteLength) fail();
        const result = decode(frame);
        terminal = true;
        frame = undefined;
        return result;
      });
    },
  });
}

export function createMarkdownRequestDecoder() {
  return decoder(
    REQUEST_PREFIX_BYTES,
    REQUEST_MAGIC,
    (prefix) => {
      const headerSize = integer(prefix.readUInt32BE(8), 1, LIMITS.requestHeaderBytes);
      const sourceSize = integer(prefix.readUInt32BE(12), 1, LIMITS.requestSourceBytes);
      return integer(REQUEST_PREFIX_BYTES + headerSize + sourceSize, 1, LIMITS.requestFrameBytes);
    },
    (frame) => {
      const headerEnd = REQUEST_PREFIX_BYTES + frame.readUInt32BE(8);
      const encoded = frame.subarray(REQUEST_PREFIX_BYTES, headerEnd);
      const header = requestHeader(parseJson(encoded));
      canonical(encoded, header.json);
      const bytes = new Uint8Array(frame.subarray(headerEnd));
      if (header.sourceBytes !== bytes.byteLength || header.sourceHash !== digest(bytes)) fail();
      return issueRequest(bytes, header.sourceHash, header.advertisedTitles);
    },
  );
}

export function createMarkdownResponseDecoder(request) {
  return guarded(() => {
    retained(request);
    return decoder(
      RESPONSE_PREFIX_BYTES,
      RESPONSE_MAGIC,
      (prefix) => {
        const size = integer(prefix.readUInt32BE(8), 1, LIMITS.responseEnvelopeBytes);
        return integer(RESPONSE_PREFIX_BYTES + size, 1, LIMITS.responseFrameBytes);
      },
      (frame) => {
        const encoded = frame.subarray(RESPONSE_PREFIX_BYTES);
        const [version, inspection] = record(parseJson(encoded), ["version", "inspection"]);
        integer(version, 1, 1);
        const { envelope, metadata } = responseEnvelope(inspection, request);
        if (!encoded.equals(envelope)) fail();
        return metadata;
      },
    );
  });
}
