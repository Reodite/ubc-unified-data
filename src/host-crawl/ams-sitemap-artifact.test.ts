import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, Observation, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { createGenericScraper } from "./generic.ts";

const hostname = "www.ams.ubc.ca";
const producer: ProducerContext = {
  inputs_sha256: sha256("AMS producer"),
  runtime: { node: "26", icu: "78", unicode: "17", platform: "linux", arch: "x64" },
};

function fixture(host = hostname) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in AMS XML fixture");
    }),
  );
  const home = `https://${host}/`;
  const sitemap = `${home}tec_recurring_events-sitemap.xml`;
  const events = Array.from(
    { length: 65 },
    (_, index) => `${home}event/public-course-${index}/2026-09-${String((index % 28) + 1).padStart(2, "0")}/`,
  );
  const values = new Map<string, Observation>();
  const put = (url: string, body: string, mime = "text/html") => {
    const snapshot: Observation["snapshot"] = {
      url,
      requested_url: url,
      status: 200,
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
    `<html><head><title>Public AMS campus programmes</title></head><body><main><h1>Programmes</h1><p>Explore public UBC student events, educational programmes and campus opportunities.</p></main></body></html>`,
  );
  put(`${home}robots.txt`, `User-agent: *\nSitemap: ${home}sitemap_index.xml`, "text/plain");
  put(
    `${home}sitemap_index.xml`,
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex><sitemap><loc>${sitemap}</loc></sitemap></sitemapindex>`,
    "text/xml",
  );
  const source = put(
    sitemap,
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">"\\n"\t${events.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`,
    "text/xml; charset=UTF-8",
  );
  for (const [index, url] of events.entries())
    put(
      url,
      `<html><head><title>Public course ${index}</title></head><body><main><h1>Course ${index}</h1><p>UBC students can learn about this public programme, the event's objectives and how to participate in the campus workshop.</p></main></body></html>`,
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
  const scraper = { ...base, vetHomepage: () => ({ accepted: true as const, reason: "Public programmes" }) };
  return { archive, events, source, collect: () => collectRecordedHost(scraper, archive, producer) };
}

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("source-witnessed AMS recurring-event sitemap artifact", () => {
  it("retains all 65 public event URLs while removing one literal marker from parsing", async () => {
    const f = fixture();
    const completed = await f.collect();
    for (const url of f.events) expect(completed.documents.some(({ source_url }) => source_url === url)).toBe(true);
    expect(f.source.snapshot.body).toContain('>"\\n"\t<url>');
  });

  it("rejects the same artifact on another hostname", async () => {
    const f = fixture("other.ubc.ca");
    await expect(f.collect()).rejects.toThrow("Unexpected sitemap text");
  });

  it("rejects a changed or duplicated marker", async () => {
    const f = fixture();
    f.source.snapshot.body = f.source.snapshot.body.replace('>"\\n"\t<url>', '>"\\n"\t"\\n"\t<url>');
    await expect(f.collect()).rejects.toThrow();
  });

  it("rejects a changed recurring-event inventory count", async () => {
    const f = fixture();
    f.source.snapshot.body = f.source.snapshot.body.replace(
      "</urlset>",
      `<url><loc>https://${hostname}/event/extra/</loc></url></urlset>`,
    );
    await expect(f.collect()).rejects.toThrow("Reviewed AMS event sitemap changed");
  });

  it("rejects a source relocation", async () => {
    const f = fixture();
    f.source.snapshot.url = `https://${hostname}/other-map.xml`;
    await expect(f.collect()).rejects.toThrow("Reviewed AMS sitemap artifact changed");
  });
});
