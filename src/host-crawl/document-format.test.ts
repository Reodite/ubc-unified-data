import { describe, expect, it } from "vitest";
import type { MarkdownDocumentExtraction, SearchDocument } from "./contracts.ts";
import {
  CATEGORIZED_DOCUMENT_FORMAT_VERSION,
  DOCUMENT_FORMAT_VERSION,
  documentFilename,
  formatDocument,
  MARKDOWN_DOCUMENT_FORMAT_VERSION,
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

function markdownExtraction(document: SearchDocument): MarkdownDocumentExtraction {
  if (document.extraction?.format !== "markdown") throw new Error("Expected Markdown extraction fixture");
  return document.extraction;
}

function replaceMetadata(bytes: Buffer, change: (metadata: Record<string, unknown>) => void): Buffer {
  const text = bytes.toString();
  const end = text.indexOf("\n---\n", 4);
  const metadata = JSON.parse(text.slice(4, end));
  change(metadata);
  return Buffer.from(`---\n${JSON.stringify(metadata, null, 2)}${text.slice(end)}`);
}

describe("document Markdown wire format", () => {
  it("round-trips PDF provenance as v2 without changing ordinary v1 serialization", () => {
    const original = fixtureDocument();
    const oldBytes = formatDocument(original);
    const pdf = {
      ...fixtureDocument("example.ubc.ca", "/guide.pdf"),
      extraction: {
        format: "pdf" as const,
        source_bytes_sha256: sha256("raw PDF"),
        source_bytes: 1234,
        pages: 2,
        profile_sha256: sha256("native profile"),
      },
    };
    const bytes = formatDocument(pdf);
    expect(bytes.toString()).toContain('"format_version": 2');
    expect(parseDocument(bytes)).toEqual(pdf);
    expect(formatDocument(parseDocument(bytes))).toEqual(bytes);
    expect(formatDocument(original)).toEqual(oldBytes);
    expect(() =>
      parseDocument(
        replaceMetadata(bytes, (meta) => {
          meta.format_version = 1;
        }),
      ),
    ).toThrow();
    for (const change of [
      { pages: 0 },
      { pages: 501 },
      { source_bytes: -1 },
      { source_bytes_sha256: "bad" },
      { profile_sha256: "bad" },
      { format: "docx" },
      { extra: true },
    ])
      expect(() =>
        formatDocument({ ...pdf, extraction: { ...pdf.extraction, ...change } } as SearchDocument),
      ).toThrow();
  });
  it("round-trips verbatim Markdown provenance as v4, including categorized output", () => {
    const markdown = fixtureDocument(
      "example.ubc.ca",
      "/node/1.md",
      "# Source title\r\n\r\nExact body without final newline",
    );
    markdown.extraction = {
      format: "markdown",
      source_bytes_sha256: markdown.body_sha256,
      source_bytes: Buffer.byteLength(markdown.content_markdown),
      profile_sha256: sha256("closed runtime profile"),
      termination: "observed-pid-absence",
      title_origin: { kind: "advertisement", witness_index: 0 },
      witnesses: [
        {
          source_url: "https://example.ubc.ca/",
          snapshot_sha256: sha256("HTML witness"),
          target_url: markdown.source_url,
          channel: "html-head",
          title: markdown.title,
        },
        {
          source_url: "https://example.ubc.ca/",
          snapshot_sha256: sha256("HTML witness"),
          target_url: markdown.source_url,
          channel: "http-link",
          title: markdown.title,
        },
      ],
    };
    const bytes = formatDocument(markdown);
    const end = bytes.indexOf(Buffer.from("\n---\n"), 4);
    const metadata = JSON.parse(bytes.subarray(4, end).toString()) as Record<string, unknown>;
    expect(metadata.format_version).toBe(MARKDOWN_DOCUMENT_FORMAT_VERSION);
    expect(Object.keys(metadata.extraction as object)).toEqual([
      "format",
      "source_bytes_sha256",
      "source_bytes",
      "profile_sha256",
      "termination",
      "title_origin",
      "witnesses",
    ]);
    expect(bytes.subarray(end + 5)).toEqual(Buffer.from(markdown.content_markdown));
    expect(parseDocument(bytes)).toEqual(markdown);
    expect(formatDocument(parseDocument(bytes))).toEqual(bytes);

    const categorized: SearchDocument = {
      ...structuredClone(markdown),
      category: "academics",
      routing: { rule_id: "fixture", policy_sha256: sha256("routing") },
    };
    const categorizedBytes = formatDocument(categorized);
    expect(
      JSON.parse(categorizedBytes.subarray(4, categorizedBytes.indexOf(Buffer.from("\n---\n"), 4)).toString()),
    ).toMatchObject({ format_version: MARKDOWN_DOCUMENT_FORMAT_VERSION, category: "academics" });
    expect(parseDocument(categorizedBytes)).toEqual(categorized);

    const bodyTitle = structuredClone(markdown);
    const bodyExtraction = markdownExtraction(bodyTitle);
    bodyExtraction.title_origin = { kind: "markdown-body" };
    expect(parseDocument(formatDocument(bodyTitle))).toEqual(bodyTitle);
    bodyExtraction.witnesses = [
      { ...bodyExtraction.witnesses[0]!, title: null },
      { ...bodyExtraction.witnesses[0]!, title: "" },
    ];
    expect(parseDocument(formatDocument(bodyTitle))).toEqual(bodyTitle);

    const maximumWitnesses = structuredClone(markdown);
    const maximumExtraction = markdownExtraction(maximumWitnesses);
    maximumExtraction.title_origin = { kind: "advertisement", witness_index: 2 };
    maximumExtraction.witnesses = (["html-head", "http-link"] as const).flatMap((channel) =>
      [null, "", maximumWitnesses.title].map((title) => ({
        ...maximumExtraction.witnesses[0]!,
        channel,
        title,
      })),
    );
    expect(parseDocument(formatDocument(maximumWitnesses))).toEqual(maximumWitnesses);
    maximumExtraction.witnesses.push({ ...maximumExtraction.witnesses.at(-1)! });
    expect(() => formatDocument(maximumWitnesses)).toThrow(/witness array/);
  });

  it("rejects malformed or contradictory Markdown provenance", () => {
    const base = fixtureDocument("example.ubc.ca", "/node/1.md", "# Source title\n\nBody");
    base.extraction = {
      format: "markdown",
      source_bytes_sha256: base.body_sha256,
      source_bytes: Buffer.byteLength(base.content_markdown),
      profile_sha256: sha256("closed runtime profile"),
      termination: "observed-pid-absence",
      title_origin: { kind: "advertisement", witness_index: 0 },
      witnesses: [
        {
          source_url: "https://example.ubc.ca/",
          snapshot_sha256: sha256("HTML witness"),
          target_url: base.source_url,
          channel: "html-head",
          title: base.title,
        },
      ],
    };
    const corruptions: Array<(document: SearchDocument) => void> = [
      (document) => {
        markdownExtraction(document).source_bytes += 1;
      },
      (document) => {
        markdownExtraction(document).source_bytes_sha256 = sha256("different bytes");
      },
      (document) => {
        markdownExtraction(document).profile_sha256 = "bad";
      },
      (document) => {
        markdownExtraction(document).termination = "unknown" as never;
      },
      (document) => {
        markdownExtraction(document).title_origin = { kind: "advertisement", witness_index: 1 };
      },
      (document) => {
        markdownExtraction(document).witnesses = [];
      },
      (document) => {
        document.alternate_urls = ["https://example.ubc.ca/alias"];
      },
      (document) => {
        markdownExtraction(document).witnesses[0]!.source_url = document.source_url;
      },
      (document) => {
        markdownExtraction(document).witnesses[0]!.target_url = "https://example.ubc.ca/node/2.md";
      },
      (document) => {
        markdownExtraction(document).witnesses[0]!.snapshot_sha256 = "bad";
      },
      (document) => {
        markdownExtraction(document).witnesses[0]!.channel = "body" as never;
      },
      (document) => {
        markdownExtraction(document).witnesses[0]!.title = "Different title";
      },
      (document) => {
        const extraction = markdownExtraction(document);
        extraction.witnesses = [
          { ...extraction.witnesses[0]!, channel: "http-link" },
          { ...extraction.witnesses[0]!, channel: "html-head" },
        ];
      },
      (document) => {
        const extraction = markdownExtraction(document);
        extraction.witnesses = [extraction.witnesses[0]!, { ...extraction.witnesses[0]! }];
      },
      (document) => {
        (markdownExtraction(document) as unknown as Record<string, unknown>).extra = true;
      },
      (document) => {
        (markdownExtraction(document).witnesses[0] as unknown as Record<string, unknown>).extra = true;
      },
      (document) => {
        (markdownExtraction(document).title_origin as unknown as Record<string, unknown>).extra = true;
      },
    ];
    for (const corrupt of corruptions) {
      const document = structuredClone(base);
      corrupt(document);
      expect(() => formatDocument(document)).toThrow();
    }
    const oversizedTitle = structuredClone(base);
    oversizedTitle.title = "🍁".repeat(1025);
    markdownExtraction(oversizedTitle).witnesses[0]!.title = oversizedTitle.title;
    oversizedTitle.content_sha256 = sha256(`${oversizedTitle.title}\n${oversizedTitle.content_markdown}`);
    expect(() => formatDocument(oversizedTitle)).toThrow(/title exceeds/);
    expect(() =>
      parseDocument(
        replaceMetadata(formatDocument(base), (metadata) => {
          metadata.format_version = CATEGORIZED_DOCUMENT_FORMAT_VERSION;
        }),
      ),
    ).toThrow(/version/);
    for (const reorder of [
      (extraction: Record<string, unknown>) => {
        extraction.title_origin = { witness_index: 0, kind: "advertisement" };
      },
      (extraction: Record<string, unknown>) => {
        const witness = (extraction.witnesses as Record<string, unknown>[])[0]!;
        (extraction.witnesses as Record<string, unknown>[])[0] = {
          title: witness.title,
          channel: witness.channel,
          target_url: witness.target_url,
          snapshot_sha256: witness.snapshot_sha256,
          source_url: witness.source_url,
        };
      },
    ])
      expect(() =>
        parseDocument(
          replaceMetadata(formatDocument(base), (metadata) => {
            reorder(metadata.extraction as Record<string, unknown>);
          }),
        ),
      ).toThrow(/Noncanonical/);
  });

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
