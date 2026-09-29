import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, Observation, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { createGenericScraper } from "./generic.ts";

const hostname = "www.mdru.ubc.ca";
const children = [
  "posts-post",
  "posts-page",
  "posts-location",
  "posts-event",
  "posts-mdru-projects",
  "posts-mdru-publications",
  "posts-mdru-theses",
  "taxonomies-category",
  "taxonomies-post_tag",
  "users",
];
const producer: ProducerContext = {
  inputs_sha256: sha256("MDRU producer"),
  runtime: { node: "26", icu: "78", unicode: "17", platform: "linux", arch: "x64" },
};

function fixture(host = hostname, indexBody?: string, contentType = "text/html; charset=UTF-8") {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in sitemap MIME fixture");
    }),
  );
  const home = `https://${host}/`;
  const sitemap = `${home}wp-sitemap.xml`;
  const targets = children.map((kind) => `${home}wp-sitemap-${kind}-1.xml`);
  const index =
    indexBody ??
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${targets.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`;
  const values = new Map<string, Observation>();
  const put = (url: string, body: string, mime = "text/html", status = 200) => {
    const snapshot: Observation["snapshot"] = {
      url,
      requested_url: url,
      status,
      headers: { "content-type": mime },
      body,
      bytes: Buffer.byteLength(body),
      retrieved_at: "2026-09-27T00:00:00Z",
    };
    const observation = { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const homepage = put(
    home,
    `<html><head><title>Public MDRU research guide</title></head><body><main><h1>Research guide</h1><p>Learn about public medical decision research, project findings and collaboration at the university.</p></main></body></html>`,
  );
  put(`${home}robots.txt`, `User-agent: *\nSitemap: ${sitemap}`, "text/plain");
  const source = put(sitemap, index, contentType);
  for (const url of targets)
    put(
      url,
      url === targets[1] ? `<urlset><url><loc>${home}guide/</loc></url></urlset>` : "<urlset/>",
      "application/xml",
    );
  put(
    `${home}guide/`,
    `<html><head><title>Public MDRU guide</title></head><body><main><h1>Research</h1><p>UBC medical decision research provides public methods, findings, collaboration and learning opportunities.</p></main></body></html>`,
  );
  const archive: HostArchive = {
    hostname: host,
    input_sha256: sha256("input"),
    homepage,
    urls: [],
    retained: [],
    read: vi.fn(async (url) => {
      const item = values.get(url);
      if (!item) throw new Error(`Missing fixture ${url}`);
      return item;
    }),
    readDocument: vi.fn(async (url) => archive.read(url)),
    readSnapshot: vi.fn(async () => {
      throw new Error("No retained snapshots");
    }),
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  const base = createGenericScraper(host);
  const scraper = { ...base, vetHomepage: () => ({ accepted: true as const, reason: "Public research" }) };
  return { archive, source, targets, sitemap, collect: () => collectRecordedHost(scraper, archive, producer) };
}

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("source-witnessed MDRU XML MIME exception", () => {
  it("parses the exact structural index and every required child despite HTML MIME", async () => {
    const f = fixture();
    const completed = await f.collect();
    expect(completed.documents.some(({ source_url }) => source_url === `https://${hostname}/guide/`)).toBe(true);
    for (const child of f.targets) expect(f.archive.read).toHaveBeenCalledWith(child);
  });

  it("does not generalize to another host", async () => {
    const f = fixture("other.ubc.ca");
    await expect(f.collect()).rejects.toThrow("An advertised sitemap lacks a complete XML observation");
  });

  it("rejects changed advertised children", async () => {
    const f = fixture();
    f.source.snapshot.body = f.source.snapshot.body.replace("wp-sitemap-users-1.xml", "wp-sitemap-extra-1.xml");
    await expect(f.collect()).rejects.toThrow("Reviewed MDRU sitemap children changed");
    for (const child of f.targets) expect(f.archive.read).not.toHaveBeenCalledWith(child);
  });

  it("rejects HTML rather than an XML document", async () => {
    const f = fixture(hostname, "<html><body>Not a sitemap</body></html>");
    await expect(f.collect()).rejects.toThrow("Reviewed MDRU sitemap identity changed");
  });

  it("rejects a different physical URL for the reviewed index", async () => {
    const f = fixture();
    f.source.snapshot.url = `https://${hostname}/different.xml`;
    await expect(f.collect()).rejects.toThrow("Reviewed MDRU sitemap identity changed");
  });
});
