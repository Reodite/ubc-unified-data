import { describe, expect, it, vi } from "vitest";
import type { Observation } from "../contracts.ts";
import { sitemapPages } from "./sitemaps.ts";

const hostname = "fixture.ubc.ca";
const origin = `https://${hostname}/`;
const urlset = (...locations: string[]) =>
  `<urlset>${locations.map((url) => `<url><loc>${url.replaceAll("&", "&amp;")}</loc></url>`).join("")}</urlset>`;
const index = (...locations: string[]) =>
  `<sitemapindex>${locations.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`;

function fixture(host = hostname) {
  const observations = new Map<string, Observation>();
  const put = (path: string, body: string, status = 200) => {
    const url = new URL(path, `https://${host}/`).href;
    const observation: Observation = {
      sha256: "a".repeat(64),
      snapshot: {
        requested_url: url,
        url,
        status,
        headers: { "content-type": "application/xml" },
        body,
        bytes: Buffer.byteLength(body),
        retrieved_at: "2026-01-01T00:00:00Z",
      },
    };
    observations.set(url, observation);
    return observation;
  };
  const read = vi.fn(async (url: string) => {
    const observation = observations.get(url);
    if (!observation) throw new Error(`Missing fixture: ${url}`);
    return observation;
  });
  return { observations, put, read };
}

describe("sitemap discovery ordering and closure", () => {
  it("keeps stable initial ordering, breadth-first children, sorted pages and ordered literal witnesses", async () => {
    const f = fixture();
    const starts = [`${origin}sitemap.html`, `${origin}sitemap.xml`, `${origin}other.xml`, `${origin}sitemap.xml`];
    const query = `${origin}?p=7`;
    f.put("/sitemap.xml", index(`${origin}b.xml`, `${origin}a.xml`, `${origin}b.xml`));
    f.put("/other.xml", urlset(`${origin}z/`, query));
    const companion = f.put("/sitemap.html", "Not found", 404);
    companion.snapshot.url = `${origin}sitemap/`;
    companion.snapshot.redirects = [
      { url: `${origin}sitemap.html`, location: "/sitemap/", status: 301, snapshot: "b".repeat(64) },
    ];
    f.put("/b.xml", index(`${origin}grandchild.xml`));
    f.put("/a.xml", urlset(`${origin}a/`, `${origin}z/`));
    f.put("/grandchild.xml", urlset(query));
    const before = structuredClone({ starts, observations: f.observations });

    const result = await sitemapPages(starts, hostname, f.read, [], true);

    expect(f.read.mock.calls.map(([url]) => url)).toEqual(
      ["sitemap.xml", "other.xml", "sitemap.html", "b.xml", "a.xml", "grandchild.xml"].map((path) => origin + path),
    );
    expect(result.pages).toEqual([query, `${origin}a/`, `${origin}z/`]);
    expect([...result.nonDocuments]).toEqual([`${origin}sitemap.html`, `${origin}sitemap/`]);
    expect([...result.advertisingSitemaps].map(([url, witnesses]) => [url, [...witnesses]])).toEqual([
      [`${origin}z/`, [`${origin}other.xml`, `${origin}a.xml`]],
      [query, [`${origin}other.xml`, `${origin}grandchild.xml`]],
      [`${origin}a/`, [`${origin}a.xml`]],
    ]);
    expect(result.attachmentPages.size).toBe(0);
    expect(result.userArchivePages.size).toBe(0);
    expect({ starts, observations: f.observations }).toEqual(before);
  });

  it("does not reorder or exempt an HTML companion outside exact-host inventory", async () => {
    const f = fixture();
    f.put("/sitemap.html", "Not found", 404);
    f.put("/sitemap.xml", "<urlset/>");
    await expect(sitemapPages([`${origin}sitemap.html`, `${origin}sitemap.xml`], hostname, f.read)).rejects.toThrow(
      "An advertised sitemap lacks a complete XML observation",
    );
    expect(f.read.mock.calls).toEqual([[`${origin}sitemap.html`]]);
  });

  it("requires an absent companion to close as XML when an index also requires it as a child", async () => {
    const f = fixture();
    f.put("/sitemap.html", "Not found", 410);
    f.put("/sitemap.xml", index(`${origin}sitemap.html`, `${origin}child.xml`));
    f.put("/child.xml", "<urlset/>");
    await expect(
      sitemapPages([`${origin}sitemap.html`, `${origin}sitemap.xml`], hostname, f.read, [], true),
    ).rejects.toThrow("An advertised sitemap child lacks a complete XML observation");
    expect(f.read.mock.calls.map(([url]) => url)).toEqual([
      `${origin}sitemap.xml`,
      `${origin}sitemap.html`,
      `${origin}child.xml`,
    ]);
  });

  it.each([false, true])("preserves attachment role conflicts with reversed inventory %s", async (reverse) => {
    const host = "moa.ubc.ca";
    const home = `https://${host}/`;
    const target = `${home}article/photo/`;
    const f = fixture(host);
    const starts = [`${home}attachment-sitemap.xml`, `${home}page-sitemap.xml`];
    f.put("/attachment-sitemap.xml", urlset(target));
    f.put("/page-sitemap.xml", urlset(target));
    if (reverse) starts.reverse();
    await expect(sitemapPages(starts, host, f.read, [], true)).rejects.toThrow(
      "Attachment sitemap conflicts with a required page",
    );
    expect(f.read.mock.calls.map(([url]) => url)).toEqual(starts);
  });

  it.each([false, true])("preserves user archive conflicts with reversed inventory %s", async (reverse) => {
    const host = "sportfacilities.ubc.ca";
    const home = `https://${host}/`;
    const target = `${home}author/agmiu/`;
    const f = fixture(host);
    const starts = [`${home}wp-sitemap-users-1.xml`, `${home}page-sitemap.xml`];
    f.put("/wp-sitemap-users-1.xml", urlset(target, `${home}author/webadmin/`));
    f.put("/page-sitemap.xml", urlset(target));
    if (reverse) starts.reverse();
    await expect(sitemapPages(starts, host, f.read, [], true)).rejects.toThrow(
      "User archive conflicts with a required page",
    );
    expect(f.read.mock.calls.map(([url]) => url)).toEqual(starts);
  });

  it("does not turn normalized locations or a changed requested identity into query witnesses", async () => {
    const f = fixture();
    const target = `${origin}?p=7`;
    f.put("/normalized.xml", urlset(`${target}#alias`));
    f.put("/relocated.xml", urlset(target)).snapshot.requested_url = `${origin}other.xml`;
    const result = await sitemapPages(
      [`${origin}normalized.xml`, `${origin}relocated.xml`],
      hostname,
      f.read,
      [],
      true,
    );
    expect(result.pages).toEqual([target]);
    expect(result.advertisingSitemaps.size).toBe(0);
  });

  it("propagates the required child's original read failure without dispatching later children", async () => {
    const f = fixture();
    f.put("/sitemap.xml", index(`${origin}missing.xml`, `${origin}later.xml`));
    const error = new Error("Required observation is unavailable");
    f.read.mockImplementationOnce(async () => f.observations.get(`${origin}sitemap.xml`)!).mockRejectedValueOnce(error);
    await expect(sitemapPages([`${origin}sitemap.xml`], hostname, f.read, [], true)).rejects.toBe(error);
    expect(f.read.mock.calls.map(([url]) => url)).toEqual([`${origin}sitemap.xml`, `${origin}missing.xml`]);
  });
});
