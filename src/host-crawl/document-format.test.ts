import { describe, expect, it } from "vitest";
import type { SearchDocument } from "./contracts.ts";
import {
  DOCUMENT_FORMAT_VERSION,
  documentFilename,
  formatDocument,
  MAX_DOCUMENT_BYTES,
  parseDocument,
  sha256,
} from "./document-format.ts";

function fixtureDocument(
  hostname = "example.ubc.ca",
  route = "/page",
  body = "Original **source** prose.\n\nSecond paragraph.\n",
): SearchDocument {
  const source_url = `https://${hostname}${route}`;
  const title = "Source title";
  return {
    id: `documents:official-web:${sha256(source_url).slice(0, 24)}`,
    hostname,
    title,
    source_url,
    retrieved_at: "2026-01-02T03:04:05.000Z",
    source_modified_at: null,
    snapshot_sha256: sha256("snapshot"),
    input_sha256: sha256("input"),
    body_sha256: sha256(body),
    content_sha256: sha256(`${title}\n${body}`),
    content_markdown: body,
    warnings: [],
    alternate_urls: [],
    producer: {
      inputs_sha256: sha256("producer"),
      runtime: { node: "v26.8.1", icu: "78.2", unicode: "17.0", platform: "linux", arch: "x64" },
    },
  };
}

function replaceMetadata(bytes: Buffer, change: (metadata: Record<string, unknown>) => void): Buffer {
  const text = bytes.toString();
  const end = text.indexOf("\n---\n", 4);
  const metadata = JSON.parse(text.slice(4, end));
  change(metadata);
  return Buffer.from(`---\n${JSON.stringify(metadata, null, 2)}${text.slice(end)}`);
}

describe("document Markdown wire format", () => {
  it.each([
    "Exact body without final newline",
    "\n\nOriginal café 🍁.\r\n\n---\n\n",
    "```html\n<script>inert</script>\n```\n",
  ])("preserves original bytes: %s", (body) => {
    const doc = fixtureDocument("example.ubc.ca", "/page?p=3", body);
    const before = structuredClone(doc);
    const bytes = formatDocument(doc);
    const end = bytes.indexOf(Buffer.from("\n---\n"), 4);
    expect(bytes.subarray(end + 5)).toEqual(Buffer.from(body));
    const metadata = JSON.parse(bytes.subarray(4, end).toString());
    expect(metadata.format_version).toBe(DOCUMENT_FORMAT_VERSION);
    expect(metadata).not.toHaveProperty("content_markdown");
    expect(parseDocument(bytes, { hostname: doc.hostname, filename: documentFilename(doc.id) })).toEqual(doc);
    expect(formatDocument(parseDocument(bytes))).toEqual(bytes);
    expect(doc).toEqual(before);
    expect(
      formatDocument({
        ...doc,
        producer: {
          runtime: { arch: "x64", platform: "linux", unicode: "17.0", icu: "78.2", node: "v26.8.1" },
          inputs_sha256: doc.producer.inputs_sha256,
        },
      }),
    ).toEqual(bytes);
  });

  it.each([
    ["wrong ID", { id: "documents:official-web:aaaaaaaaaaaaaaaaaaaaaaaa" }],
    ["wrong source host", { source_url: "https://different.ubc.ca/page" }],
    ["HTTP source", { source_url: "http://example.ubc.ca/page" }],
    ["fragment", { source_url: "https://example.ubc.ca/page#part" }],
    ["unsafe title", { title: "<script>" }],
    ["unsafe warning", { warnings: ["<script>"] }],
    ["unsorted warnings", { warnings: ["b", "a"] }],
    ["duplicate warnings", { warnings: ["a", "a"] }],
    ["duplicate alternate", { alternate_urls: ["https://example.ubc.ca/a", "https://example.ubc.ca/a"] }],
    ["source alternate", { alternate_urls: ["https://example.ubc.ca/page"] }],
    ["cross host alternate", { alternate_urls: ["https://else.ubc.ca/a"] }],
    ["bad retrieval", { retrieved_at: "yesterday" }],
    ["nonexistent date", { source_modified_at: "2026-02-30T00:00:00.000Z" }],
    ["bad snapshot digest", { snapshot_sha256: "a" }],
    ["bad input digest", { input_sha256: "A".repeat(64) }],
    ["wrong body digest", { body_sha256: "a".repeat(64) }],
    ["wrong content digest", { content_sha256: "a".repeat(64) }],
    ["unknown field", { extra: true }],
  ])("rejects %s", (_name, change) => {
    expect(() => formatDocument({ ...fixtureDocument(), ...change } as SearchDocument)).toThrow();
  });

  it.each([
    "<script>alert(1)</script>",
    "![image](https://example.ubc.ca/a.png)",
    "[link](javascript:alert(1))",
    "Binary\u0000",
    "Bad\ud800",
    "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 5\n",
  ])("rejects unsafe body", (body) => {
    expect(() => formatDocument(fixtureDocument("example.ubc.ca", "/page", body))).toThrow();
  });

  it("keeps physical query and trailing-slash identities distinct", () => {
    const docs = ["/page", "/page/", "/page?p=3"].map((route) => fixtureDocument("example.ubc.ca", route));
    expect(new Set(docs.map((doc) => doc.id)).size).toBe(3);
    for (const doc of docs) expect(parseDocument(formatDocument(doc)).source_url).toBe(doc.source_url);
  });

  it("rejects getters and invalid runtime platform/architecture", () => {
    const doc = fixtureDocument();
    const getter = Object.defineProperty(["warning"], 0, {
      get: () => {
        throw new Error("getter executed");
      },
    });
    expect(() => formatDocument({ ...doc, warnings: getter })).toThrow(/Invalid warnings array item/);
    for (const runtime of [
      { ...doc.producer.runtime, platform: "unknown" },
      { ...doc.producer.runtime, arch: "not-cpu" },
    ])
      expect(() => formatDocument({ ...doc, producer: { ...doc.producer, runtime } })).toThrow(
        /platform or architecture/,
      );
    expect(() => formatDocument(fixtureDocument("example.ubc.ca", "/page", "Control \x80"))).toThrow(/UTF-8/);
  });

  it("rejects malformed producer metadata, unknown and duplicate JSON keys", () => {
    const bytes = formatDocument(fixtureDocument());
    for (const change of [
      (meta: Record<string, unknown>) => {
        meta.extra = "bad";
      },
      (meta: Record<string, unknown>) => {
        meta.format_version = 2;
      },
      (meta: Record<string, unknown>) => {
        meta.producer = { inputs_sha256: "bad", runtime: {} };
      },
      (meta: Record<string, unknown>) => {
        (meta.producer as Record<string, unknown>).extra = true;
      },
      (meta: Record<string, unknown>) => {
        ((meta.producer as Record<string, unknown>).runtime as Record<string, unknown>).node = "shell command";
      },
    ])
      expect(() => parseDocument(replaceMetadata(bytes, change))).toThrow();
    expect(() =>
      parseDocument(bytes.toString().replace('"format_version": 1,', '"format_version": 1,\n  "format_version": 1,')),
    ).toThrow(/Noncanonical/);
  });

  it("rejects non-UTF8, BOM, pointers and mismatched paths", () => {
    const bytes = formatDocument(fixtureDocument());
    for (const invalid of [
      Buffer.concat([bytes, Buffer.from([0xff])]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      Buffer.from("version https://git-lfs.github.com/spec/v1\n"),
    ])
      expect(() => parseDocument(invalid)).toThrow();
    expect(() => parseDocument(bytes, { hostname: "different.ubc.ca" })).toThrow(/hostname/);
    expect(() => parseDocument(bytes, { filename: "a.md" })).toThrow(/filename/);
    expect(() => parseDocument(bytes, { filename: `../${documentFilename(fixtureDocument().id)}` })).toThrow(
      /filename/,
    );
  });

  it("blocks whole-file overflow without truncation", () => {
    const overhead = formatDocument(fixtureDocument("example.ubc.ca", "/page", "x")).length - 1;
    const exact = fixtureDocument("example.ubc.ca", "/page", "x".repeat(MAX_DOCUMENT_BYTES - overhead));
    expect(formatDocument(exact).length).toBe(MAX_DOCUMENT_BYTES);
    expect(() => formatDocument(fixtureDocument("example.ubc.ca", "/page", `${exact.content_markdown}x`))).toThrow(
      /1 MiB/,
    );
  });
});
