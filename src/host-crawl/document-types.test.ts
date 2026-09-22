import { describe, expect, it } from "vitest";
import {
  canonicalDocumentMediaType,
  detectBinaryDocument,
  documentFormatFromMediaType,
  documentFormatFromUrl,
  documentMagic,
} from "./document-types.ts";

const pdf = Buffer.from("%PDF-1.7\n");
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

describe("supported document identity", () => {
  it.each([
    ["https://example.ubc.ca/a.pdf", "pdf"],
    ["https://example.ubc.ca/a.DOCX?download=1", "docx"],
    ["https://example.ubc.ca/a.pptx", "pptx"],
    ["https://example.ubc.ca/article", undefined],
  ])("derives bounded URL format for %s", (url, expected) => {
    expect(documentFormatFromUrl(url)).toBe(expected);
  });

  it("derives canonical media and magic identities", () => {
    expect(documentFormatFromMediaType("application/pdf; charset=binary")).toBe("pdf");
    expect(documentFormatFromMediaType(canonicalDocumentMediaType("docx"))).toBe("docx");
    expect(documentFormatFromMediaType(canonicalDocumentMediaType("pptx"))).toBe("pptx");
    expect(documentMagic(pdf)).toBe("pdf");
    expect(documentMagic(zip)).toBe("zip");
    expect(documentMagic(Buffer.from("html"))).toBeUndefined();
  });

  it.each([
    ["https://example.ubc.ca/a.pdf", "application/pdf", pdf, "pdf"],
    ["https://example.ubc.ca/a.docx", canonicalDocumentMediaType("docx"), zip, "docx"],
    ["https://example.ubc.ca/a.pptx", "application/octet-stream", zip, "pptx"],
    ["https://example.ubc.ca/download", canonicalDocumentMediaType("pptx"), zip, "pptx"],
  ])("admits matching URL media and magic for %s", (url, media, bytes, expected) => {
    expect(detectBinaryDocument(url, media, bytes, ["pdf", "docx", "pptx"])).toBe(expected);
  });

  it.each([
    ["https://example.ubc.ca/a.pdf", canonicalDocumentMediaType("docx"), zip],
    ["https://example.ubc.ca/a.pdf", "application/pdf", zip],
    ["https://example.ubc.ca/a.docx", canonicalDocumentMediaType("docx"), pdf],
    ["https://example.ubc.ca/a.pptx", "text/html", zip],
  ])("rejects contradictory evidence for %s", (url, media, bytes) => {
    expect(() => detectBinaryDocument(url, media, bytes, ["pdf", "docx", "pptx"])).toThrow(
      /disagree|lacks|Unsupported/,
    );
  });

  it("does not select undeclared formats", () => {
    expect(
      detectBinaryDocument("https://example.ubc.ca/a.docx", canonicalDocumentMediaType("docx"), zip, ["pdf"]),
    ).toBeUndefined();
  });
});
