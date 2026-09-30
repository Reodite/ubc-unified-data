import { describe, expect, it } from "vitest";
import { documentPageExclusion, nonDocumentInventoryUrl, pageExclusion, UNSUPPORTED_DOCUMENT } from "./urls.ts";

describe("explicit screensaver resources", () => {
  const host = "fixture.ubc.ca";
  const url = (path: string) => `https://${host}${path}`;

  it.each([
    "/files/2021/08/UBCFOM.sCr",
    "/files/UBCFOM.SCR?download=1",
    "/files/guide.pdf.scr",
    "/files/UBCFOM%2EsCr",
    "/files/UBCFOM.%73%43%72?page=1",
    "/files/UBCFOM%2e%53c%52?download=1#instructions",
  ])("excludes the decoded file suffix before inventory fetching: %s", (path) => {
    expect(pageExclusion(url(path), host)).toBe("Static asset or machine-readable resource");
    expect(nonDocumentInventoryUrl(url(path), host)).toBe(true);
    expect(documentPageExclusion(url(path), host, ["pdf"])).toBe("Static asset or machine-readable resource");
  });

  it.each([
    "/page/how-to-install-the-screensaver-on-windows-machines/",
    "/screensaver/",
    "/screensaver-installation/",
    "/files/UBCFOM.src",
    "/files/UBCFOM.scr-name/",
    "/files/UBCFOM.scr/",
    "/files/UBCFOM.scr/instructions/",
    "/files/UBCFOM.scr.html",
    "/guidance/#UBCFOM.scr",
    "/?page_id=7",
  ])("keeps semantic pages and non-file suffixes eligible: %s", (path) => {
    expect(pageExclusion(url(path), host)).toBeNull();
    expect(nonDocumentInventoryUrl(url(path), host)).toBe(false);
    expect(documentPageExclusion(url(path), host, ["pdf"])).toBeNull();
  });

  it.each([
    "/files/UBCFOM.scr.pdf",
    "/files/UBCFOM%2esCr.PDF",
    "/files/UBCFOM.scr.pdf.pdf",
    "/files/UBCFOM.scr/guide.pdf",
    "/wp-content/uploads/2021/UBCFOM.scr.pdf",
  ])("preserves declared PDFs with nested screensaver-like names: %s", (path) => {
    expect(pageExclusion(url(path), host)).toBe(UNSUPPORTED_DOCUMENT);
    expect(nonDocumentInventoryUrl(url(path), host)).toBe(false);
    expect(documentPageExclusion(url(path), host, ["pdf"])).toBeNull();
    expect(documentPageExclusion(url(path), host, [])).toBe(UNSUPPORTED_DOCUMENT);
  });

  it.each([
    "/files/guide.pdf",
    "/files/guide.txt",
    "/files/guide.docx",
    "/files/guide.md",
    "/files/guide.pdf/UBCFOM.scr",
  ])("does not exempt required or unsupported text inventory: %s", (path) => {
    expect(nonDocumentInventoryUrl(url(path), host)).toBe(false);
  });

  it.each([
    "/files/UBCFOM%ZZ.scr",
    "/files/UBCFOM%C3.scr",
    "/files/UBCFOM%252Escr",
    "/files/%5CUBCFOM.scr",
    "/files//UBCFOM.scr",
    "/files/%2FUBCFOM.scr",
  ])("keeps malformed paths excluded rather than classifying them as resources: %s", (path) => {
    expect(pageExclusion(url(path), host)).toMatch(/^Ambiguous/);
    expect(documentPageExclusion(url(path), host, ["pdf"])).not.toBeNull();
    if (/%ZZ|%C3/.test(path)) expect(() => nonDocumentInventoryUrl(url(path), host)).toThrow(URIError);
    else expect(nonDocumentInventoryUrl(url(path), host)).toBe(false);
  });
});

describe("article-only public URL boundary", () => {
  const home = "https://fixture.ubc.ca/";

  it.each([
    "guide.pdf",
    "guide.doc",
    "guide.docx",
    "slides.ppt",
    "slides.pptx",
    "source.md",
    "source.markdown",
    "book.epub",
    "book.mobi",
    "bundle.zip",
    "bundle.tar.gz",
    "bundle.7z",
    "bundle.rar",
  ])("excludes obvious download %s", (path) => {
    expect(pageExclusion(home + path, "fixture.ubc.ca")).not.toBeNull();
  });

  it.each(["article/", "news/guide-pdf-accessibility/", "stories/archive-research/"])(
    "keeps semantic HTML article path %s eligible",
    (path) => {
      expect(pageExclusion(home + path, "fixture.ubc.ca")).toBeNull();
    },
  );

  it.each(["feed/", "wp-login.php", "guide.pdf?download=1", "archive.zip?token=one"])(
    "does not widen machine private or query-bearing download %s",
    (path) => {
      expect(pageExclusion(home + path, "fixture.ubc.ca")).not.toBeNull();
    },
  );
});

describe("declared public document routes", () => {
  it.each(["/", "/guidance/", "/files/policy.pdf", "/wp-content/uploads/2025/guide.PDF", "/files/guide%2Epdf"])(
    "permits %s",
    (path) => {
      expect(documentPageExclusion(`https://fixture.ubc.ca${path}`, "fixture.ubc.ca", ["pdf"])).toBeNull();
    },
  );
  it.each([
    "https://outside.example/guide.pdf",
    "https://fixture.ubc.ca/admin/guide.pdf",
    "https://fixture.ubc.ca/wp-admin/guide.pdf",
    "https://fixture.ubc.ca/wp-content/themes/guide.pdf",
    "https://fixture.ubc.ca/guide.pdf?token=one",
    "https://fixture.ubc.ca/guide.docx",
    "https://fixture.ubc.ca/wp-content/uploads/%2fadmin/guide.pdf",
    "https://fixture.ubc.ca/wp-content/uploads/../themes/guide.pdf",
    "https://fixture.ubc.ca/files/style.css.pdf",
    "https://fixture.ubc.ca/files/style.css/guide.pdf",
    "https://fixture.ubc.ca/files/guide.docx.pdf",
    "https://fixture.ubc.ca/files/guide.pdf.scr",
    "https://fixture.ubc.ca/wp-admin/UBCFOM.scr.pdf",
    "https://fixture.ubc.ca/files/UBCFOM.scr.pdf?download=1",
  ])("rejects %s", (url) => {
    expect(documentPageExclusion(url, "fixture.ubc.ca", ["pdf"])).not.toBeNull();
  });
  it("requires an explicit PDF adapter", () => {
    expect(documentPageExclusion("https://fixture.ubc.ca/files/guide.pdf", "fixture.ubc.ca", [])).not.toBeNull();
  });
});
