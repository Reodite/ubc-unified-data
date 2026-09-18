import { describe, expect, it, vi } from "vitest";
import { toSafeMarkdown } from "../prose/markdown.ts";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, Observation, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { createGenericScraper } from "./generic.ts";
import { htmlBaseUrl } from "./html-base.ts";
import { hostUrl, inventoryUrl } from "./urls.ts";

const host = "fixture.ubc.ca";
const home = `https://${host}/`;
const producer: ProducerContext = {
  inputs_sha256: sha256("producer"),
  runtime: { node: "26", icu: "78", unicode: "17", platform: "linux", arch: "x64" },
};
function fixture(body: string, robots = "User-agent: *\n", extra: Record<string, string> = {}) {
  const values = new Map<string, Observation>();
  for (const [path, text] of Object.entries({ "/": body, "/robots.txt": robots, ...extra })) {
    const url = new URL(path, home).href;
    const snapshot = {
      url,
      requested_url: url,
      status: 200,
      headers: { "content-type": path.endsWith(".xml") ? "text/xml" : "text/html" },
      body: text,
      bytes: Buffer.byteLength(text),
      retrieved_at: "2026-01-01T00:00:00Z",
    };
    values.set(url, { snapshot, sha256: sha256(JSON.stringify(snapshot)) });
  }
  const archive: HostArchive = {
    hostname: host,
    input_sha256: sha256("input"),
    homepage: values.get(home)!,
    urls: [],
    retained: [],
    read: vi.fn(async (url) => {
      const value = values.get(url);
      if (!value) throw new Error(`Missing recorded observation: ${url}`);
      return value;
    }),
    readSnapshot: async () => {
      throw new Error("No retained snapshots");
    },
    assertUnchanged: async () => {},
    close() {},
  };
  return archive;
}
const page = "<title>Public guide</title><main><p>Public programme eligibility and application guidance.</p></main>";

describe("generic exact-host discovery", () => {
  it("filters outbound references but does not relax physical URL validation", () => {
    expect(inventoryUrl("https://example.org/", host)).toBeNull();
    expect(inventoryUrl("https://other.ubc.ca/", host)).toBeNull();
    expect(inventoryUrl("mailto:person@ubc.ca", host)).toBeNull();
    expect(inventoryUrl(`http://${host}/guide`, host)).toBe(`${home}guide`);
    expect(() => inventoryUrl(`https://user@${host}/`, host)).toThrow();
    expect(() => hostUrl(`http://${host}/guide`, host)).toThrow();
  });

  it("resolves one local HTML base for links without changing citations", async () => {
    const body = `<base href="${home}resources/">${page}<a href="guide">Read guide</a>`;
    const archive = fixture(body, undefined, { "/resources/guide": page });
    const result = await collectRecordedHost(createGenericScraper(host), archive, producer);
    expect(result.documents.map((d) => d.source_url).sort()).toEqual([home, `${home}resources/guide`]);
    expect(result.documents.every((d) => !d.alternate_urls.includes(`${home}resources/`))).toBe(true);
    const extracted = createGenericScraper(host).extract(
      fixture(`<base href="${home}resources/">${page.replace("guidance.", '<a href="guide">guidance.</a>')}`).homepage
        .snapshot,
    );
    if (extracted.kind !== "document") throw new Error("Expected document");
    expect(toSafeMarkdown(extracted.input.html, home).markdown).toContain(`${home}resources/guide`);
    expect(() => htmlBaseUrl(`<base href="https://other.ubc.ca/">`, host, home, true)).toThrow();
    expect(() => htmlBaseUrl(`<base href="/"><base href="/other">`, host, home, true)).toThrow();
    expect(() => htmlBaseUrl(`<base href="/">`, host, home)).toThrow();
  });

  it("filters foreign sitemap declarations and entries before fetching", async () => {
    const archive = fixture(
      page,
      `User-agent: *\nSitemap: https://other.ubc.ca/sitemap.xml\nSitemap: ${home}sitemap.xml`,
      {
        "/sitemap.xml": `<urlset><url><loc>https://example.org/outbound</loc></url><url><loc>http://${host}/guide</loc></url></urlset>`,
        "/guide": page,
      },
    );
    const result = await collectRecordedHost(createGenericScraper(host), archive, producer);
    expect(result.documents).toHaveLength(2);
    expect(archive.read).not.toHaveBeenCalledWith("https://other.ubc.ca/sitemap.xml");
    expect(archive.read).not.toHaveBeenCalledWith("https://example.org/outbound");
    expect(archive.read).toHaveBeenCalledWith(`${home}guide`);
  });

  it("excludes only recorded outbound referrals, never unavailable public pages", async () => {
    const archive = fixture(`${page}<a href="/referral">Referral</a>`);
    archive.observedScopeExclusion = (url) => (url.endsWith("/referral") ? "Recorded external redirect" : null);
    expect((await collectRecordedHost(createGenericScraper(host), archive, producer)).documents).toHaveLength(1);
    archive.observedScopeExclusion = () => null;
    await expect(collectRecordedHost(createGenericScraper(host), archive, producer)).rejects.toThrow(
      "Required page observations",
    );
  });
});
