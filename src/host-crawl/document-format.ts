import { createHash } from "node:crypto";
import { basename } from "node:path";
import { assertSafeMarkdown } from "../prose/markdown.ts";
import { assertDocumentCategory, type DocumentCategory } from "./categories.ts";
import type { MarkdownDocumentExtraction, PdfDocumentExtraction, SearchDocument } from "./contracts.ts";
import { MARKDOWN_INSPECTION_LIMITS } from "./markdown-contract.mjs";
import { hostUrl, normalizeHost } from "./urls.ts";

export const DOCUMENT_FORMAT_VERSION = 1;
export const PDF_DOCUMENT_FORMAT_VERSION = 2;
export const CATEGORIZED_DOCUMENT_FORMAT_VERSION = 3;
export const MARKDOWN_DOCUMENT_FORMAT_VERSION = 4;
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
const PDF_EXTRACTION_KEYS = ["format", "source_bytes_sha256", "source_bytes", "pages", "profile_sha256"] as const;
const MARKDOWN_EXTRACTION_KEYS = [
  "format",
  "source_bytes_sha256",
  "source_bytes",
  "profile_sha256",
  "termination",
  "title_origin",
  "witnesses",
] as const;
const MARKDOWN_WITNESS_KEYS = ["source_url", "snapshot_sha256", "target_url", "channel", "title"] as const;

function documentKeys(value: unknown): readonly (keyof SearchDocument)[] {
  const keys: (keyof SearchDocument)[] = [...DOCUMENT_KEYS];
  if (value !== null && typeof value === "object") {
    if (Object.hasOwn(value, "extraction")) keys.push("extraction");
    if (Object.hasOwn(value, "category")) keys.push("category", "routing");
  }
  return keys;
}

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
  exactObject(value, documentKeys(value), "document");
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
  if (Object.hasOwn(doc, "extraction")) {
    const extraction = doc.extraction;
    if (!extraction) throw new Error("Missing document extraction");
    const formatProperty = Object.getOwnPropertyDescriptor(extraction, "format");
    if (!formatProperty || !("value" in formatProperty)) throw new Error("Invalid document extraction format");
    if (formatProperty.value === "pdf") {
      exactObject(extraction as unknown, PDF_EXTRACTION_KEYS, "PDF extraction");
      const pdf = extraction as PdfDocumentExtraction;
      digest(pdf.source_bytes_sha256, "source bytes");
      digest(pdf.profile_sha256, "extraction profile");
      if (
        !Number.isSafeInteger(pdf.source_bytes) ||
        pdf.source_bytes < 1 ||
        !Number.isSafeInteger(pdf.pages) ||
        pdf.pages < 1 ||
        pdf.pages > 500
      )
        throw new Error("Invalid PDF extraction bounds");
    } else if (formatProperty.value === "markdown") {
      exactObject(extraction as unknown, MARKDOWN_EXTRACTION_KEYS, "Markdown extraction");
      const markdown = extraction as MarkdownDocumentExtraction;
      digest(markdown.source_bytes_sha256, "source bytes");
      digest(markdown.profile_sha256, "extraction profile");
      if (
        !Number.isSafeInteger(markdown.source_bytes) ||
        markdown.source_bytes < 1 ||
        markdown.source_bytes !== Buffer.byteLength(doc.content_markdown) ||
        markdown.source_bytes_sha256 !== doc.body_sha256
      )
        throw new Error("Markdown extraction bytes differ from the verbatim body");
      if (Buffer.byteLength(doc.title) > MARKDOWN_INSPECTION_LIMITS.titleBytes)
        throw new Error("Markdown title exceeds its inspected byte limit");
      if (!["observed-pid-absence", "identity-matched-unreaped-zombie"].includes(markdown.termination))
        throw new Error("Invalid Markdown termination evidence");
      if (
        !Array.isArray(markdown.witnesses) ||
        Object.getPrototypeOf(markdown.witnesses) !== Array.prototype ||
        markdown.witnesses.length < 1 ||
        markdown.witnesses.length > MARKDOWN_INSPECTION_LIMITS.advertisedTitles ||
        Reflect.ownKeys(markdown.witnesses).length !== markdown.witnesses.length + 1
      )
        throw new Error("Invalid Markdown witness array");
      let firstAdvertisement = -1;
      const witnessDescriptors = Object.getOwnPropertyDescriptors(markdown.witnesses);
      for (let index = 0; index < markdown.witnesses.length; index++)
        if (!Object.hasOwn(witnessDescriptors, index) || !("value" in witnessDescriptors[index]!))
          throw new Error("Invalid Markdown witness array item");
      for (const [index, witness] of markdown.witnesses.entries()) {
        exactObject(witness as unknown, MARKDOWN_WITNESS_KEYS, "Markdown witness");
        exactHostUrl(witness.source_url, doc.hostname);
        exactHostUrl(witness.target_url, doc.hostname);
        digest(witness.snapshot_sha256, "Markdown witness snapshot");
        if (witness.source_url === witness.target_url || witness.target_url !== doc.source_url)
          throw new Error("Markdown witness source or target differs");
        if (!(["html-head", "http-link"] as const).includes(witness.channel))
          throw new Error("Invalid Markdown witness channel");
        if (witness.title !== null) {
          if (
            typeof witness.title !== "string" ||
            witness.title.length > MARKDOWN_INSPECTION_LIMITS.advertisedTitleCodeUnits ||
            !witness.title.isWellFormed() ||
            /[\p{Cc}\p{Cf}\uFFFD]/u.test(witness.title)
          )
            throw new Error("Invalid Markdown witness title");
          if (witness.title !== "" && firstAdvertisement === -1) firstAdvertisement = index;
        }
        if (index > 0) {
          const previous = markdown.witnesses[index - 1]!;
          const order =
            witness.channel === previous.channel
              ? compareNullable(previous.title, witness.title)
              : previous.channel < witness.channel
                ? -1
                : 1;
          if (order >= 0) throw new Error("Markdown witnesses must be unique and canonically ordered");
          if (
            witness.source_url !== previous.source_url ||
            witness.snapshot_sha256 !== previous.snapshot_sha256 ||
            witness.target_url !== previous.target_url
          )
            throw new Error("Markdown witnesses do not share one exact source context");
        }
      }
      const titleOrigin = markdown.title_origin;
      const titleKind =
        titleOrigin && typeof titleOrigin === "object"
          ? Object.getOwnPropertyDescriptor(titleOrigin, "kind")
          : undefined;
      if (!titleKind || !("value" in titleKind)) throw new Error("Invalid Markdown title origin");
      if (titleKind.value === "markdown-body") {
        exactObject(titleOrigin as unknown, ["kind"], "Markdown title origin");
        if (firstAdvertisement !== -1) throw new Error("Markdown body title conflicts with an advertised title");
      } else if (titleKind.value === "advertisement") {
        exactObject(titleOrigin as unknown, ["kind", "witness_index"], "Markdown title origin");
        const advertisement = titleOrigin as { kind: "advertisement"; witness_index: number };
        if (
          !Number.isSafeInteger(advertisement.witness_index) ||
          advertisement.witness_index !== firstAdvertisement ||
          markdown.witnesses[firstAdvertisement]?.title !== doc.title
        )
          throw new Error("Markdown advertisement title provenance differs");
        for (const witness of markdown.witnesses)
          if (witness.title !== null && witness.title !== "" && witness.title !== doc.title)
            throw new Error("Conflicting Markdown advertisement titles");
      } else {
        throw new Error("Invalid Markdown title origin");
      }
    } else {
      throw new Error("Unknown document extraction format");
    }
  }
  if (Object.hasOwn(doc, "category")) {
    assertDocumentCategory(doc.category);
    exactObject(doc.routing, ["rule_id", "policy_sha256"], "routing");
    safeText(doc.routing.rule_id, "routing rule");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(doc.routing.rule_id)) throw new Error("Invalid routing rule ID");
    digest(doc.routing.policy_sha256, "routing policy");
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

function compareNullable(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : 1;
}

function documentFormatVersion(document: SearchDocument): number {
  if (document.extraction?.format === "markdown") return MARKDOWN_DOCUMENT_FORMAT_VERSION;
  if (document.category) return CATEGORIZED_DOCUMENT_FORMAT_VERSION;
  if (document.extraction) return PDF_DOCUMENT_FORMAT_VERSION;
  return DOCUMENT_FORMAT_VERSION;
}

function canonicalExtraction(extraction: SearchDocument["extraction"]): Record<string, unknown> {
  if (!extraction) throw new Error("Missing document extraction");
  if (extraction.format === "pdf")
    return Object.fromEntries(PDF_EXTRACTION_KEYS.map((name) => [name, extraction[name]]));
  const titleOrigin =
    extraction.title_origin.kind === "markdown-body"
      ? { kind: "markdown-body" }
      : { kind: "advertisement", witness_index: extraction.title_origin.witness_index };
  const witnesses = extraction.witnesses.map((witness) =>
    Object.fromEntries(MARKDOWN_WITNESS_KEYS.map((name) => [name, witness[name]])),
  );
  return {
    format: extraction.format,
    source_bytes_sha256: extraction.source_bytes_sha256,
    source_bytes: extraction.source_bytes,
    profile_sha256: extraction.profile_sha256,
    termination: extraction.termination,
    title_origin: titleOrigin,
    witnesses,
  };
}

export function documentFilename(id: string): string {
  safeText(id, "document ID");
  return `${sha256(id)}.md`;
}

/** Encode canonical JSON metadata and preserve the body without adding even a final newline. */
export function formatDocument(document: SearchDocument): Buffer {
  validateSearchDocument(document);
  const metadata: Record<string, unknown> = { format_version: documentFormatVersion(document) };
  for (const key of documentKeys(document)) {
    if (key === "content_markdown") continue;
    metadata[key] =
      key === "producer"
        ? {
            inputs_sha256: document.producer.inputs_sha256,
            runtime: Object.fromEntries(RUNTIME_KEYS.map((name) => [name, document.producer.runtime[name]])),
          }
        : key === "extraction"
          ? canonicalExtraction(document.extraction)
          : key === "routing"
            ? { rule_id: document.routing!.rule_id, policy_sha256: document.routing!.policy_sha256 }
            : document[key];
  }
  const bytes = Buffer.from(`---\n${JSON.stringify(metadata, null, 2)}\n---\n${document.content_markdown}`, "utf8");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Whole document exceeds 1 MiB");
  return bytes;
}

/** Parse only the canonical UTF-8 wire format; filename, when supplied, is a bare filename. */
export function parseDocument(
  bytes: Uint8Array | string,
  expected: { hostname?: string; filename?: string; category?: DocumentCategory } = {},
): SearchDocument {
  if (typeof bytes === "string" && !bytes.isWellFormed()) throw new Error("Invalid UTF-8 document");
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error("Whole document exceeds 1 MiB");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  if (!text.startsWith("---\n")) throw new Error("Missing document frontmatter (or LFS pointer)");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Missing document frontmatter delimiter");
  const metadata: unknown = JSON.parse(text.slice(4, end));
  exactObject(
    metadata,
    ["format_version", ...documentKeys(metadata).filter((key) => key !== "content_markdown")],
    "metadata",
  );
  const { format_version: _, ...fields } = metadata;
  const document = { ...fields, content_markdown: text.slice(end + 5) };
  validateSearchDocument(document);
  if (metadata.format_version !== documentFormatVersion(document))
    throw new Error("Unknown or inconsistent document format version");
  if (expected.hostname !== undefined && document.hostname !== expected.hostname)
    throw new Error("Document hostname mismatch");
  if (expected.category !== undefined && document.category !== expected.category)
    throw new Error("Document category mismatch");
  if (
    expected.filename !== undefined &&
    (basename(expected.filename) !== expected.filename || expected.filename !== documentFilename(document.id))
  )
    throw new Error("Document filename mismatch");
  if (!formatDocument(document).equals(buffer)) throw new Error("Noncanonical document metadata encoding");
  return document;
}
