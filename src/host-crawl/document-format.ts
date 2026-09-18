import { createHash } from "node:crypto";
import { basename } from "node:path";
import { assertSafeMarkdown } from "../prose/markdown.ts";
import type { SearchDocument } from "./contracts.ts";
import { hostUrl, normalizeHost } from "./urls.ts";

export const DOCUMENT_FORMAT_VERSION = 1;
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
const DOCUMENT_KEYS = [
  "id",
  "hostname",
  "title",
  "source_url",
  "retrieved_at",
  "source_modified_at",
  "snapshot_sha256",
  "input_sha256",
  "body_sha256",
  "content_sha256",
  "content_markdown",
  "warnings",
  "alternate_urls",
  "producer",
] as const;
const RUNTIME_KEYS = ["node", "icu", "unicode", "platform", "arch"] as const;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`Invalid ${label} object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key) || !("value" in descriptors[key]!))
  )
    throw new Error(`Unknown or missing ${label} fields`);
}

export function safeText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || !value.isWellFormed() || /[\p{Cc}\p{Cf}\uFFFD<>]/u.test(value))
    throw new Error(`Invalid ${label} text`);
}

export function timestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error(`Invalid ${label} timestamp`);
  if (new Date(value).toISOString() !== (value.includes(".") ? value : value.replace("Z", ".000Z")))
    throw new Error(`Invalid ${label} calendar timestamp`);
}

export function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label} SHA256`);
}

export function exactHostUrl(value: unknown, hostname: string): asserts value is string {
  safeText(value, "URL");
  if (hostUrl(value, hostname) !== value || /%(?:00|0[1-9a-f]|1[0-9a-f]|7f)/i.test(value))
    throw new Error("Noncanonical or unsafe exact-host URL");
}

function sortedStrings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error(`Invalid ${label} array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(descriptors, index) || !("value" in descriptors[index]!))
      throw new Error(`Invalid ${label} array item`);
  }
  for (const [index, item] of value.entries()) {
    safeText(item, label);
    if (index > 0 && value[index - 1]! >= item) throw new Error(`${label} must be unique and sorted`);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error(`Unexpected ${label} array fields`);
}

export function validateSearchDocument(value: unknown): asserts value is SearchDocument {
  exactObject(value, DOCUMENT_KEYS, "document");
  const doc = value as unknown as SearchDocument;
  safeText(doc.hostname, "hostname");
  if (normalizeHost(doc.hostname) !== doc.hostname) throw new Error("Noncanonical hostname");
  safeText(doc.id, "document ID");
  safeText(doc.title, "title");
  exactHostUrl(doc.source_url, doc.hostname);
  if (doc.id !== `documents:official-web:${sha256(doc.source_url).slice(0, 24)}`)
    throw new Error("Document ID must match its exact physical source URL");
  timestamp(doc.retrieved_at, "retrieved_at");
  if (doc.source_modified_at !== null) timestamp(doc.source_modified_at, "source_modified_at");
  for (const key of ["snapshot_sha256", "input_sha256", "body_sha256", "content_sha256"] as const)
    digest(doc[key], key);
  const body = doc.content_markdown;
  if (typeof body !== "string" || !body.trim() || !body.isWellFormed() || /(?![\t\r\n])[\p{Cc}\uFFFD]/u.test(body))
    throw new Error("Invalid UTF-8 Markdown body");
  if (body.startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error("LFS pointer is not a document");
  if (Buffer.byteLength(body) > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds 1 MiB");
  assertSafeMarkdown(body);
  if (sha256(body) !== doc.body_sha256 || sha256(`${doc.title}\n${body}`) !== doc.content_sha256)
    throw new Error("Document body/content digest mismatch");
  sortedStrings(doc.warnings, "warnings");
  sortedStrings(doc.alternate_urls, "alternate_urls");
  for (const url of doc.alternate_urls) {
    exactHostUrl(url, doc.hostname);
    if (url === doc.source_url) throw new Error("Source URL cannot also be an alternate URL");
  }
  exactObject(doc.producer, ["inputs_sha256", "runtime"], "producer");
  digest(doc.producer.inputs_sha256, "producer inputs");
  exactObject(doc.producer.runtime, RUNTIME_KEYS, "producer runtime");
  for (const key of RUNTIME_KEYS) {
    safeText(doc.producer.runtime[key], `runtime ${key}`);
    if (!/^[A-Za-z0-9._+-]+$/.test(doc.producer.runtime[key])) throw new Error(`Invalid runtime ${key}`);
  }
  if (
    !/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(doc.producer.runtime.node) ||
    !/^\d+(?:\.\d+)+$/.test(doc.producer.runtime.icu) ||
    !/^\d+(?:\.\d+)+$/.test(doc.producer.runtime.unicode)
  )
    throw new Error("Invalid runtime version shape");
  if (
    ![
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
      "netbsd",
    ].includes(doc.producer.runtime.platform) ||
    !["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64"].includes(
      doc.producer.runtime.arch,
    )
  )
    throw new Error("Invalid runtime platform or architecture");
}

export function documentFilename(id: string): string {
  safeText(id, "document ID");
  return `${sha256(id)}.md`;
}

/** Encode canonical JSON metadata and preserve the body without adding even a final newline. */
export function formatDocument(document: SearchDocument): Buffer {
  validateSearchDocument(document);
  const metadata: Record<string, unknown> = { format_version: DOCUMENT_FORMAT_VERSION };
  for (const key of DOCUMENT_KEYS) {
    if (key === "content_markdown") continue;
    metadata[key] =
      key === "producer"
        ? {
            inputs_sha256: document.producer.inputs_sha256,
            runtime: Object.fromEntries(RUNTIME_KEYS.map((name) => [name, document.producer.runtime[name]])),
          }
        : document[key];
  }
  const bytes = Buffer.from(`---\n${JSON.stringify(metadata, null, 2)}\n---\n${document.content_markdown}`, "utf8");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Whole document exceeds 1 MiB");
  return bytes;
}

/** Parse only the canonical UTF-8 wire format; filename, when supplied, is a bare filename. */
export function parseDocument(
  bytes: Uint8Array | string,
  expected: { hostname?: string; filename?: string } = {},
): SearchDocument {
  if (typeof bytes === "string" && !bytes.isWellFormed()) throw new Error("Invalid UTF-8 document");
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error("Whole document exceeds 1 MiB");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  if (!text.startsWith("---\n")) throw new Error("Missing document frontmatter (or LFS pointer)");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Missing document frontmatter delimiter");
  const metadata: unknown = JSON.parse(text.slice(4, end));
  exactObject(metadata, ["format_version", ...DOCUMENT_KEYS.filter((key) => key !== "content_markdown")], "metadata");
  if (metadata.format_version !== DOCUMENT_FORMAT_VERSION) throw new Error("Unknown document format version");
  const { format_version: _, ...fields } = metadata;
  const document = { ...fields, content_markdown: text.slice(end + 5) };
  validateSearchDocument(document);
  if (expected.hostname !== undefined && document.hostname !== expected.hostname)
    throw new Error("Document hostname mismatch");
  if (
    expected.filename !== undefined &&
    (basename(expected.filename) !== expected.filename || expected.filename !== documentFilename(document.id))
  )
    throw new Error("Document filename mismatch");
  if (!formatDocument(document).equals(buffer)) throw new Error("Noncanonical document metadata encoding");
  return document;
}
