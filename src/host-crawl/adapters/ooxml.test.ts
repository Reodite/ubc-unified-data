import { describe, expect, it } from "vitest";
import { CONTENT_TYPES, makeZip, rootRelationships } from "./ooxml-test-helper.ts";
import {
  captureOoxmlProfile,
  OOXML_LIMITS,
  OOXML_PROFILE_MANIFEST,
  OOXML_PROFILE_SHA256,
  parseOoxmlXml,
  readOoxml,
} from "./ooxml.ts";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function docx(
  extra: Array<{
    name: string;
    body: string;
    flags?: number;
    compression?: number;
    compressedSize?: number;
    uncompressedSize?: number;
  }> = [],
): Buffer {
  return makeZip([
    { name: "[Content_Types].xml", body: CONTENT_TYPES },
    { name: "_rels/.rels", body: rootRelationships("word/document.xml") },
    {
      name: "word/document.xml",
      body: `<w:document xmlns:w="${WORD_NS}"><w:body><w:p><w:r><w:t>Source</w:t></w:r></w:p></w:body></w:document>`,
    },
    ...extra,
  ]);
}

describe("bounded OOXML package reading", () => {
  it("reads entries lazily and identifies DOCX structure with a deterministic profile", async () => {
    const bytes = docx([
      {
        name: "word/_rels/document.xml.rels",
        body: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/private" TargetMode="External"/></Relationships>`,
      },
    ]);
    const first = await readOoxml({ bytes });
    const second = await readOoxml({ bytes });
    expect(first.kind).toBe("docx");
    expect(first.mainPart).toBe("word/document.xml");
    expect(first.profileSha256).toBe(OOXML_PROFILE_SHA256);
    expect(first.profileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sourceSha256).toBe(second.sourceSha256);
    expect(captureOoxmlProfile()).toEqual({ manifest: OOXML_PROFILE_MANIFEST, sha256: OOXML_PROFILE_SHA256 });
    expect(Object.values(OOXML_PROFILE_MANIFEST.implementation)).toHaveLength(3);
    for (const value of Object.values(OOXML_PROFILE_MANIFEST.implementation)) expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(OOXML_PROFILE_MANIFEST.dependencies)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^saxes@/),
        expect.stringMatching(/^yauzl@/),
        expect.stringMatching(/^xmlchars@/),
      ]),
    );
    for (const value of Object.values(OOXML_PROFILE_MANIFEST.dependencies)) {
      expect(value.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(value.tree_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(first.relationships(first.mainPart)[0]).toMatchObject({
      external: true,
      target: "https://example.invalid/private",
    });
  });

  it.each([
    [{ name: "word/DOCUMENT.xml", body: "<duplicate/>" }],
    [{ name: "word/../evil.xml", body: "<evil/>" }],
    [{ name: "word\\evil.xml", body: "<evil/>" }],
    [{ name: "/evil.xml", body: "<evil/>" }],
    [{ name: "word/vbaProject.bin", body: "active" }],
    [{ name: "word/embeddings/object.bin", body: "ole" }],
    [{ name: "word/run.exe", body: "executable" }],
    [{ name: "word/unsupported.xml", body: "data", compression: 12 }],
    [{ name: "word/encrypted.xml", body: "data", flags: 0x801 }],
  ])("rejects unsafe, colliding, active, encrypted, or unsupported entries %#", async (extra) => {
    await expect(readOoxml({ bytes: docx([extra]) })).rejects.toThrow();
  });

  it("enforces expanded, per-XML, compression-ratio, and entry-count limits before extraction", async () => {
    await expect(
      readOoxml({
        bytes: docx([
          {
            name: "large.dat",
            body: "x",
            compressedSize: OOXML_LIMITS.expandedBytes + 1,
            uncompressedSize: OOXML_LIMITS.expandedBytes + 1,
          },
        ]),
      }),
    ).rejects.toThrow("expanded byte limit");
    await expect(
      readOoxml({
        bytes: docx([
          {
            name: "word/large.xml",
            body: "x",
            compressedSize: OOXML_LIMITS.xmlBytes + 1,
            uncompressedSize: OOXML_LIMITS.xmlBytes + 1,
          },
        ]),
      }),
    ).rejects.toThrow("XML part");
    await expect(
      readOoxml({
        bytes: docx([{ name: "ratio.dat", body: "x", compression: 8, compressedSize: 1, uncompressedSize: 101 }]),
      }),
    ).rejects.toThrow("compression ratio");
    const entries = Array.from({ length: OOXML_LIMITS.entries - 2 }, (_, index) => ({
      name: `parts/${index}.dat`,
      body: "",
    }));
    await expect(readOoxml({ bytes: docx(entries) })).rejects.toThrow("entry limit");
  });

  it("requires package declarations and one valid office document structure", async () => {
    await expect(readOoxml({ bytes: makeZip([]) })).rejects.toThrow("Content_Types");
    await expect(readOoxml({ bytes: makeZip([{ name: "[Content_Types].xml", body: CONTENT_TYPES }]) })).rejects.toThrow(
      "officeDocument",
    );
    const activeTypes = CONTENT_TYPES.replace(
      "</Types>",
      '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
    );
    await expect(
      readOoxml({
        bytes: makeZip([
          { name: "[Content_Types].xml", body: activeTypes },
          { name: "_rels/.rels", body: rootRelationships("word/document.xml") },
          { name: "word/document.xml", body: `<w:document xmlns:w="${WORD_NS}"/>` },
        ]),
      }),
    ).rejects.toThrow("active");
  });

  it("bounds source, XML syntax, depth, cancellation, and wall time", async () => {
    await expect(readOoxml({ bytes: Buffer.alloc(0) })).rejects.toThrow("source");
    await expect(readOoxml({ bytes: Buffer.alloc(OOXML_LIMITS.sourceBytes + 1) })).rejects.toThrow("source");
    expect(() => parseOoxmlXml(Buffer.from("<!DOCTYPE x><x/>"))).toThrow("document type");
    expect(() =>
      parseOoxmlXml(
        Buffer.from(`${"<x>".repeat(OOXML_LIMITS.xmlDepth + 1)}${"</x>".repeat(OOXML_LIMITS.xmlDepth + 1)}`),
      ),
    ).toThrow("depth");
    const controller = new AbortController();
    controller.abort(new Error("stop fixture"));
    await expect(readOoxml({ bytes: docx(), signal: controller.signal })).rejects.toThrow("stop fixture");
    await expect(readOoxml({ bytes: docx(), timeoutMs: 0 })).rejects.toThrow("wall-clock");
  });
});
