import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { collectRecordedHost, type CollectionFormats } from "./collect.ts";
import {
  NonTextMediaError,
  type HostArchive,
  type HostScraper,
  type Observation,
  type ProducerContext,
} from "./contracts.ts";
import { formatDocument, parseDocument } from "./document-format.ts";
import { pageExclusion } from "./urls.ts";

const hostname = "fixture.ubc.ca",
  origin = `https://${hostname}`;
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const producer: ProducerContext = {
  inputs_sha256: hash("producer"),
  runtime: {
    node: process.versions.node,
    icu: process.versions.icu!,
    unicode: process.versions.unicode!,
    platform: process.platform,
    arch: process.arch,
  },
};
const view = { path: "/faq", parameter: "audience", placeholder: "All", values: ["Employer", "Student"] };
const form =
  '<form action="/faq" method="get"><select name="audience"><option value="All">All</option><option value="Employer">Employer</option><option value="Student">Student</option></select></form>';
function fixture() {
  const values = new Map<string, Observation>();
  function put(path: string, body: string, media = "text/html", status = 200) {
    const url = origin + path,
      snapshot = {
        url,
        requested_url: url,
        status,
        headers: { "content-type": media },
        body,
        bytes: Buffer.byteLength(body),
        retrieved_at: "2026-01-01T00:00:00Z",
      };
    const o: Observation = { snapshot, sha256: hash(JSON.stringify(snapshot)) };
    values.set(url, o);
    return o;
  }
  const home = put("/", '<p>Official public guidance.</p><a href="/guide.pdf">Responsibilities</a>');
  put("/robots.txt", "User-agent: *\n", "text/plain");
  put("/jsonapi", "Not found", "text/html", 404);
  put("/faq", `${form}<p>Select the audience.</p>`);
  for (const value of view.values)
    put(`/faq?audience=${value}`, `${form}<p>${value} questions and complete answers.</p>`);
  const raw = Buffer.from("%PDF-1.7\nsynthetic recording bytes\n%%EOF");
  const pdf = put("/guide.pdf", "", "application/pdf");
  pdf.snapshot.bytes = raw.length;
  (pdf.snapshot as Observation["snapshot"]).binary = { media_type: "application/pdf", sha256: hash(raw) };
  pdf.sha256 = hash(JSON.stringify(pdf.snapshot));
  const scraper: HostScraper = {
    hostname,
    title: "Public guides",
    scope: "Synthetic complete scope",
    adapter: { kind: "html", allowedTypes: [], optionalAbsent: ["/jsonapi"], views: [view] },
    documentFormats: ["pdf"],
    vetHomepage: () => ({ accepted: true, reason: "fixture" }),
    excludeUrl(url) {
      const u = new URL(url);
      return u.pathname === "/guide.pdf" || u.pathname === "/faq" ? null : pageExclusion(url, hostname);
    },
    extract(snapshot) {
      return {
        kind: "document",
        input: {
          url: snapshot.url,
          title: new URL(snapshot.url).search || "Guide",
          html: snapshot.body,
          retrievedAt: snapshot.retrieved_at,
          sourceModifiedAt: null,
        },
      };
    },
  };
  const archive: HostArchive = {
    hostname,
    input_sha256: hash("input"),
    homepage: home,
    retained: [],
    urls: [],
    read: vi.fn(async (url) => {
      const value = values.get(url);
      if (!value) throw new Error(`Missing fixture ${url}`);
      return value;
    }),
    readSnapshot: async (sha) => {
      const value = [...values.values()].find((o) => o.sha256 === sha);
      if (!value) throw new Error("Missing snapshot");
      return value;
    },
    readBytes: async (sha) => {
      if (sha !== pdf.sha256) throw new Error("Unexpected byte source");
      return raw;
    },
    assertUnchanged: async () => {},
    close() {},
  };
  const formats: CollectionFormats = {
    pdf: {
      profile_sha256: hash("PDF profile"),
      extract: vi.fn(async () => ({
        title: "Employer responsibilities",
        markdown: "## Page 1\n\nProvide meaningful work and supervision.",
        warnings: ["PDF text only; no OCR is implied."],
        pageCount: 1,
      })),
    },
  };
  return { values, put, home, raw, pdf, scraper, archive, formats };
}

describe("complete HTML and linked-document collection", () => {
  it.each([
    { final: "/admin/guide.pdf" },
    { final: "/sites/default/private/guide.pdf" },
    { final: "/guide.pdf?download=1" },
    { final: "/final.pdf", intermediate: "/admin/forward" },
  ])("rejects excluded PDF redirect destinations before extraction: %j", async (route) => {
    const f = fixture(),
      original = f.scraper.excludeUrl!;
    f.scraper.excludeUrl = (value) => {
      const url = new URL(value);
      if (/\/(?:admin|private)(?:\/|$)/.test(url.pathname)) return "Private or administrative path";
      if (url.pathname.endsWith(".pdf")) return url.search ? "Unsupported query or form selection" : null;
      return original(value);
    };
    f.pdf.snapshot.url = `${origin}${route.final}`;
    f.pdf.snapshot.redirects = [
      {
        url: `${origin}/guide.pdf`,
        location: `${origin}${route.intermediate ?? route.final}`,
        status: 302,
        snapshot: hash("redirect"),
      },
    ];
    if (route.intermediate)
      f.pdf.snapshot.redirects.push({
        url: `${origin}${route.intermediate}`,
        location: `${origin}${route.final}`,
        status: 302,
        snapshot: hash("second redirect"),
      });
    f.pdf.sha256 = hash(JSON.stringify(f.pdf.snapshot));
    await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow(/document.*policy/i);
    expect(f.formats.pdf!.extract).not.toHaveBeenCalled();
  });
  it.each(["/guide.pdf", "/guide%2Epdf"])(
    "does not silently omit a required PDF classified as non-text media: %s",
    async (path) => {
      const f = fixture(),
        read = f.archive.read,
        exclude = f.scraper.excludeUrl!;
      f.home.snapshot.body = f.home.snapshot.body.replace("/guide.pdf", path);
      f.scraper.excludeUrl = (url) =>
        decodeURIComponent(new URL(url).pathname).endsWith(".pdf") ? null : exclude(url);
      f.archive.read = async (url) => {
        if (url === `${origin}${path}`) throw new NonTextMediaError("image/jpeg");
        return read(url);
      };
      await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow(
        /Required.*non-text/,
      );
      expect(f.formats.pdf!.extract).not.toHaveBeenCalled();
    },
  );
  it("follows links exposed by a declared HTML normalization", async () => {
    const f = fixture();
    f.put("/expanded", "<p>Guidance linked from an expanded source tooltip.</p>");
    const original = f.scraper.extract;
    f.scraper.extract = (snapshot) => {
      const decision = original(snapshot);
      if (snapshot.url === `${origin}/` && decision.kind === "document")
        decision.input.html += '<a href="/expanded">Expanded source link</a>';
      return decision;
    };
    const result = await collectRecordedHost(f.scraper, f.archive, producer, f.formats);
    expect(result.documents.some((document) => document.source_url === `${origin}/expanded`)).toBe(true);
  });
  it("does not silently drop newly linked pagination outside a declared HTML query policy", async () => {
    const f = fixture();
    f.home.snapshot.body += '<a href="/?page=1">Next</a>';
    const original = f.scraper.excludeUrl!;
    f.scraper.excludeUrl = (url) =>
      new URL(url).searchParams.has("page") ? "Unsupported query or form selection" : original(url);
    await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow(/Linked pagination/);
    expect(f.archive.read).not.toHaveBeenCalledWith(`${origin}/?page=1`);
  });
  it("includes both finite views and versioned PDF text through the real serializer", async () => {
    const f = fixture(),
      result = await collectRecordedHost(f.scraper, f.archive, producer, f.formats);
    expect(result.complete).toBe(true);
    expect(result.documents).toHaveLength(5);
    expect(result.documents.filter((d) => d.source_url.includes("?audience="))).toHaveLength(2);
    const pdf = result.documents.find((d) => d.extraction)!;
    expect(pdf.extraction).toEqual({
      format: "pdf",
      source_bytes_sha256: hash(f.raw),
      source_bytes: f.raw.length,
      pages: 1,
      profile_sha256: hash("PDF profile"),
    });
    for (const doc of result.documents) expect(parseDocument(formatDocument(doc))).toEqual(doc);
    expect(f.formats.pdf!.extract).toHaveBeenCalledWith(f.raw, `${origin}/guide.pdf`);
    expect(await collectRecordedHost(f.scraper, f.archive, producer, f.formats)).toEqual(result);
  });
  it("discovers, extracts, and canonically serializes linked PDF, DOCX, and PPTX sources", async () => {
    const f = fixture();
    const binaries = new Map<string, Buffer>([[f.pdf.sha256, f.raw]]);
    const addBinary = (path: string, format: "docx" | "pptx", mediaType: string) => {
      const raw = Buffer.from(`PK\u0003\u0004${format} package`, "latin1");
      const url = `${origin}${path}`;
      const snapshot: Observation["snapshot"] = {
        url,
        requested_url: url,
        status: 200,
        headers: { "content-type": mediaType },
        body: "",
        bytes: raw.length,
        retrieved_at: "2026-01-01T00:00:00Z",
        binary: { format, media_type: mediaType, sha256: hash(raw) },
      };
      const observation = { snapshot, sha256: hash(JSON.stringify(snapshot)) };
      f.values.set(url, observation);
      binaries.set(observation.sha256, raw);
      return { raw, observation };
    };
    const docx = addBinary(
      "/program.docx",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const pptx = addBinary(
      "/orientation.pptx",
      "pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    f.home.snapshot.body += '<a href="/program.docx">Program guide</a><a href="/orientation.pptx">Orientation</a>';
    f.scraper.documentFormats = ["pdf", "docx", "pptx"];
    const originalExclude = f.scraper.excludeUrl!;
    f.scraper.excludeUrl = (url) =>
      ["/program.docx", "/orientation.pptx"].includes(new URL(url).pathname) ? null : originalExclude(url);
    f.archive.readBytes = async (sha) => {
      const bytes = binaries.get(sha);
      if (!bytes) throw new Error("Unexpected byte source");
      return bytes;
    };
    f.formats.pdf!.extract = vi.fn(async () => ({
      title: "Employer responsibilities",
      markdown: "## Page 1\n\nProvide meaningful work and supervision.",
      warnings: [],
      pageCount: 1,
      nativeTextPages: [1],
      ocrPages: [],
    }));
    f.formats.docx = {
      profile_sha256: hash("OOXML profile"),
      extract: vi.fn(async () => ({
        title: "Program guide",
        markdown: "# Program guide\n\nRequired courses and policies.",
        warnings: [],
        paragraphs: 2,
        tables: 0,
      })),
    };
    f.formats.pptx = {
      profile_sha256: hash("OOXML profile"),
      extract: vi.fn(async () => ({
        title: "Orientation",
        markdown: "# Orientation\n\n## Slide 1\n\nWelcome to UBC.",
        warnings: ["Speaker notes included."],
        slides: 1,
        tables: 0,
        slidesWithNotes: 1,
      })),
    };
    const result = await collectRecordedHost(f.scraper, f.archive, producer, f.formats);
    expect(result.complete).toBe(true);
    const extracted = new Map(
      result.documents
        .filter((document) => document.extraction)
        .map((document) => [document.extraction!.format, document]),
    );
    expect(extracted.get("pdf-v2")?.extraction).toMatchObject({
      format: "pdf-v2",
      native_text_pages: [1],
      ocr_pages: [],
    });
    expect(extracted.get("docx")?.extraction).toMatchObject({
      format: "docx",
      source_bytes_sha256: hash(docx.raw),
      source_bytes: docx.raw.length,
      paragraphs: 2,
      tables: 0,
    });
    expect(extracted.get("pptx")?.extraction).toMatchObject({
      format: "pptx",
      source_bytes_sha256: hash(pptx.raw),
      source_bytes: pptx.raw.length,
      slides: 1,
      tables: 0,
      slides_with_notes: 1,
    });
    for (const document of result.documents) expect(parseDocument(formatDocument(document))).toEqual(document);
    expect(f.formats.docx.extract).toHaveBeenCalledWith(docx.raw, docx.observation.snapshot.url);
    expect(f.formats.pptx.extract).toHaveBeenCalledWith(pptx.raw, pptx.observation.snapshot.url);
  });
  it.each(["missing view", "excluded view", "empty view", "missing PDF", "corrupt PDF", "missing extractor"])(
    "blocks %s rather than publishing partial coverage",
    async (kind) => {
      const f = fixture();
      if (kind === "missing view") f.values.get(`${origin}/faq?audience=Employer`)!.snapshot.status = 404;
      if (kind === "excluded view") {
        const old = f.scraper.extract;
        f.scraper.extract = (snapshot) =>
          snapshot.url.includes("?audience=") ? { kind: "excluded", reason: "unexpected" } : old(snapshot);
      }
      if (kind === "empty view") f.values.get(`${origin}/faq?audience=Employer`)!.snapshot.body = form;
      if (kind === "missing PDF") f.pdf.snapshot.status = 404;
      if (kind === "corrupt PDF") f.archive.readBytes = async () => Buffer.from("changed");
      if (kind === "missing extractor") delete f.formats.pdf;
      await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow();
    },
  );
  it("accepts only the exact root-only sitemap marker, not extra foreign locations", async () => {
    const f = fixture(),
      marker = "https://deployment.invalid//";
    f.scraper.adapter.sitemaps = [{ path: "/sitemap.xml", rootOnlyLocation: marker }];
    const xml = (locations: string[]) =>
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
    f.put("/sitemap.xml", xml([marker]), "text/xml");
    expect((await collectRecordedHost(f.scraper, f.archive, producer, f.formats)).complete).toBe(true);
    f.put("/sitemap.xml", xml([marker, "https://deployment.invalid/page"]), "text/xml");
    await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow(
      /official UBC hostname/,
    );
  });
});
