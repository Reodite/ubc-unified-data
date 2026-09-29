import { afterEach, describe, expect, it, vi } from "vitest";
import { wordpressCollectionUrl } from "./adapters/wordpress-discovery.ts";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, Observation, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { createGenericScraper } from "./generic.ts";

const hostname = "visit.ubc.ca";
const home = `https://${hostname}/`;
const api = `${home}wp-json/`;
const search = `${home}?s=search`;
const missingLocation = `${home}eat-drink-and-stay/accommodation/standard-suites/`;
const producer: ProducerContext = {
  inputs_sha256: sha256("visit producer"),
  runtime: { node: "26", icu: "78", unicode: "17", platform: "linux", arch: "x64" },
};

function fixture(
  conflict: "none" | "seed" | "sitemap" | "other-cms" = "none",
  location: "none" | "normal" | "seed" | "sitemap" | "other-cms" | "recovered" = "none",
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in Visit search-control collection");
    }),
  );
  const values = new Map<string, Observation>();
  const put = (url: string, body: string, contentType = "text/html", status = 200) => {
    const snapshot: Observation["snapshot"] = {
      url,
      requested_url: url,
      status,
      headers: { "content-type": contentType },
      body,
      bytes: Buffer.byteLength(body),
      retrieved_at: "2026-09-26T00:00:00Z",
    };
    const observation = { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const homepage = put(
    home,
    `<html><head><title>Visit UBC campus guide</title><link rel="https://api.w.org/" href="${api}"></head><body><main><h1>Visit campus</h1><p>Plan a public campus visit with information about educational tours, attractions, directions and access.</p><form method="get" action="${home}"><input name="s" type="text" value="Search this site..."></form><a href="${search}">Search this site</a></main></body></html>`,
  );
  const sitemapUrl = conflict === "sitemap" ? search : location === "sitemap" ? missingLocation : null;
  put(`${home}robots.txt`, sitemapUrl ? `User-agent: *\nSitemap: ${home}sitemap.xml` : "User-agent: *\n", "text/plain");
  if (sitemapUrl) put(`${home}sitemap.xml`, `<urlset><url><loc>${sitemapUrl}</loc></url></urlset>`, "application/xml");
  const collection = `${api}wp/v2/pages`;
  const types: Record<string, unknown> = {
    page: {
      name: "Pages",
      slug: "page",
      has_archive: false,
      rest_namespace: "wp/v2",
      rest_base: "pages",
      _links: { "wp:items": [{ href: collection }] },
    },
  };
  const routes: Record<string, unknown> = {
    "/wp/v2/types": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/types` }] } },
    "/wp/v2/pages": { methods: ["GET"], _links: { self: [{ href: collection }] } },
  };
  if (conflict === "other-cms" || location === "other-cms") {
    types.post = {
      name: "Posts",
      rest_namespace: "wp/v2",
      rest_base: "posts",
      _links: { "wp:items": [{ href: `${api}wp/v2/posts` }] },
    };
    routes["/wp/v2/posts"] = { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/posts` }] } };
    const posts = put(
      wordpressCollectionUrl(`${api}wp/v2/posts`, 1),
      JSON.stringify([
        {
          id: 1,
          link: location === "other-cms" ? missingLocation : search,
          title: { rendered: "Actual article" },
          status: "publish",
          type: "post",
          modified_gmt: "2026-01-01T12:00:00",
        },
      ]),
      "application/json",
    );
    posts.snapshot.headers["x-wp-total"] = "1";
    posts.snapshot.headers["x-wp-totalpages"] = "1";
  }
  if (location !== "none") {
    const collection = `${api}wp/v2/location`;
    types.location = {
      name: "Locations",
      slug: "location",
      has_archive: false,
      rest_namespace: "wp/v2",
      rest_base: "location",
      _links: { "wp:items": [{ href: collection }] },
    };
    routes["/wp/v2/location"] = { methods: ["GET"], _links: { self: [{ href: collection }] } };
    const marker = missingLocation.replace("https://", "http://");
    const rows = [
      {
        id: 323,
        link: marker,
        title: { rendered: "Gage Suites" },
        modified_gmt: "2024-06-17T17:33:55",
        status: "publish",
        type: "location",
      },
      ...Array.from({ length: 58 }, (_, index) => ({
        id: 400 + index,
        link: `${home}page-${index}/`,
        title: { rendered: `Map marker ${index}` },
        modified_gmt: "2026-01-01T12:00:00",
        status: "publish",
        type: "location",
      })),
      {
        id: 810,
        link: marker,
        title: { rendered: "Standard Suites (Ponderosa Commons)" },
        modified_gmt: "2019-05-03T23:20:28",
        status: "publish",
        type: "location",
      },
    ];
    const page = put(wordpressCollectionUrl(collection, 1), JSON.stringify(rows), "application/json");
    page.snapshot.headers["x-wp-total"] = "60";
    page.snapshot.headers["x-wp-totalpages"] = "1";
    put(missingLocation, "<title>Page not found</title>", "text/html", location === "recovered" ? 200 : 404);
  }
  put(api, JSON.stringify({ routes }), "application/json");
  put(`${api}wp/v2/types`, JSON.stringify(types), "application/json");
  const records = [
    {
      id: 970,
      link: search,
      title: { rendered: "Search" },
      modified_gmt: "2019-10-23T15:47:35",
      status: "publish",
      type: "page",
    },
    ...Array.from({ length: 67 }, (_, index) => ({
      id: 1000 + index,
      link: `${home}page-${index}/`,
      title: { rendered: `Page ${index}` },
      modified_gmt: "2026-01-01T12:00:00",
      status: "publish",
      type: "page",
    })),
  ];
  const list = put(wordpressCollectionUrl(collection, 1), JSON.stringify(records), "application/json");
  list.snapshot.headers["x-wp-total"] = "68";
  list.snapshot.headers["x-wp-totalpages"] = "1";
  for (let index = 0; index < 67; index++)
    put(
      `${home}page-${index}/`,
      `<html><head><title>Page ${index} | Visit UBC</title></head><body><main><h1>Page ${index}</h1><p>This campus guide describes public UBC Vancouver attractions and practical visit information. Visitors can use the maps, directions and tour information to plan a trip.</p></main></body></html>`,
    );
  const archive: HostArchive = {
    hostname,
    homepage,
    input_sha256: sha256("visit input"),
    retained: [],
    urls: [...(conflict === "seed" ? [search] : []), ...(location === "seed" ? [missingLocation] : [])].map((url) => ({
      url,
      kind: "page",
      state: "pending" as const,
      disposition: null,
      reason: null,
      snapshot: null,
      article_id: null,
      source_modified_at: null,
    })),
    read: vi.fn(async (url) => {
      const item = values.get(url);
      if (!item) throw new Error(`Missing fixture ${url}`);
      return item;
    }),
    readDocument: vi.fn(async (url) => archive.read(url)),
    readSnapshot: vi.fn(async () => {
      throw new Error("No retained representative");
    }),
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  const base = createGenericScraper(hostname);
  const scraper = {
    ...base,
    vetHomepage: () => ({ accepted: true as const, reason: "Public visit guidance" }),
    adapter: { ...base.adapter, kind: "wordpress" as const, allPublicTypes: true, exactHostInventory: true },
  };
  return { archive, collect: () => collectRecordedHost(scraper, archive, producer) };
}

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("source-witnessed Visit UBC search control", () => {
  it("keeps 67 public CMS pages without requesting the publisher search form", async () => {
    const f = fixture();
    const completed = await f.collect();
    expect(completed.documents.map(({ source_url }) => source_url)).toEqual(
      expect.arrayContaining(Array.from({ length: 67 }, (_, index) => `${home}page-${index}/`)),
    );
    expect(completed.documents.some(({ source_url }) => source_url === search)).toBe(false);
    expect(f.archive.read).not.toHaveBeenCalledWith(search);
  });

  it.each(["seed", "sitemap", "other-cms"] as const)(
    "refuses another %s role for the exact search query",
    async (conflict) => {
      const f = fixture(conflict);
      await expect(f.collect()).rejects.toThrow("Reviewed search control conflicts with a required page");
      expect(f.archive.read).not.toHaveBeenCalledWith(search);
    },
  );

  it("preserves article pages while witnessing the two stale map markers' shared 404", async () => {
    const f = fixture("none", "normal");
    const result = await f.collect();
    expect(result.documents.map(({ source_url }) => source_url)).toEqual(
      expect.arrayContaining(Array.from({ length: 67 }, (_, index) => `${home}page-${index}/`)),
    );
    expect(result.documents.some(({ source_url }) => source_url === missingLocation)).toBe(false);
    expect(f.archive.read).toHaveBeenCalledWith(missingLocation);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(missingLocation);
  });

  it.each(["seed", "sitemap", "other-cms"] as const)(
    "refuses another %s role for the missing map-marker URL",
    async (conflict) => {
      const f = fixture("none", conflict);
      await expect(f.collect()).rejects.toThrow("Reviewed location identity conflicts with a required page");
      expect(f.archive.read).not.toHaveBeenCalledWith(missingLocation);
    },
  );

  it("refuses to hide a map-marker URL that now serves public HTML", async () => {
    const f = fixture("none", "recovered");
    await expect(f.collect()).rejects.toThrow("Reviewed location URL lacks its public 404 witness");
  });
});
