import { afterEach, describe, expect, it, vi } from "vitest";
import { wordpressCollectionUrl } from "./adapters/wordpress-discovery.ts";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, Observation, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { createGenericScraper } from "./generic.ts";

const hostname = "www.advancinghealth.ubc.ca";
const home = `https://${hostname}/`;
const api = `${home}wp-json/`;
const root = `${home}organizer/`;
const ids = [10702, 11041, 13325, 13329, 13956, 13975, 13980, 14109, 14140, 14176, 14250, 14279];
const broken = new Map([
  [11041, ["VCH Research Institute", "2023-10-12T17:36:12"]],
  [13325, ["Clinical Trials BC", "2025-06-05T22:37:45"]],
  [13956, ["Providence Health", "2025-09-29T22:01:55"]],
  [14109, ["Clinical Trials British Columbia", "2026-01-13T18:11:12"]],
  [14140, ["UBC Centre for Health Services and Policy Research (CHSPR)", "2026-02-03T23:14:14"]],
]);
const producer: ProducerContext = {
  inputs_sha256: sha256("organizer producer"),
  runtime: { node: "26", icu: "78", unicode: "17", platform: "linux", arch: "x64" },
};

function fixture(conflict: "none" | "seed" | "sitemap" | "other-cms" = "none") {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in organizer collection");
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
      retrieved_at: "2026-09-22T00:00:00Z",
    };
    const observation = { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const homepage = put(
    home,
    `<html><head><title>Public health research</title><link rel="https://api.w.org/" href="${api}"></head><body><main><h1>Public research</h1><p>Read public health research, event and organization programmes at UBC.</p><a href="${root}">Organizers</a></main></body></html>`,
  );
  const robots = put(
    `${home}robots.txt`,
    conflict === "sitemap" ? `User-agent: *\nSitemap: ${home}sitemap.xml` : "User-agent: *\n",
    "text/plain",
  );
  if (conflict === "sitemap")
    put(`${home}sitemap.xml`, `<urlset><url><loc>${root}</loc></url></urlset>`, "application/xml");
  const collection = `${api}wp/v2/tribe_organizer`;
  const types: Record<string, unknown> = {
    tribe_organizer: {
      name: "Organizers",
      slug: "tribe_organizer",
      has_archive: false,
      rest_namespace: "wp/v2",
      rest_base: "tribe_organizer",
      _links: { "wp:items": [{ href: collection }] },
    },
  };
  const routes: Record<string, unknown> = {
    "/wp/v2/types": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/types` }] } },
    "/wp/v2/tribe_organizer": { methods: ["GET"], _links: { self: [{ href: collection }] } },
  };
  if (conflict === "other-cms") {
    types.page = {
      name: "Pages",
      rest_namespace: "wp/v2",
      rest_base: "pages",
      _links: { "wp:items": [{ href: `${api}wp/v2/pages` }] },
    };
    routes["/wp/v2/pages"] = { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/pages` }] } };
    const pages = put(
      wordpressCollectionUrl(`${api}wp/v2/pages`, 1),
      JSON.stringify([
        {
          id: 1,
          link: root,
          title: { rendered: "Required guide" },
          status: "publish",
          type: "page",
          modified_gmt: "2026-01-01T12:00:00",
        },
      ]),
      "application/json",
    );
    pages.snapshot.headers["x-wp-total"] = "1";
    pages.snapshot.headers["x-wp-totalpages"] = "1";
  }
  put(api, JSON.stringify({ routes }), "application/json");
  put(`${api}wp/v2/types`, JSON.stringify(types), "application/json");
  const records = ids.map((id) => ({
    id,
    link: broken.has(id) ? root : `${root}organization-${id}/`,
    title: { rendered: broken.get(id)?.[0] ?? `Organization ${id}` },
    modified_gmt: broken.get(id)?.[1] ?? "2026-01-01T12:00:00",
    status: "publish",
    type: "tribe_organizer",
  }));
  const list = put(wordpressCollectionUrl(collection, 1), JSON.stringify(records), "application/json");
  list.snapshot.headers["x-wp-total"] = "12";
  list.snapshot.headers["x-wp-totalpages"] = "1";
  put(root, "<title>Page not found</title>", "text/html", 404);
  for (const { id, link } of records) {
    if (broken.has(id)) continue;
    put(
      link,
      `<html><head><title>Organization ${id}</title></head><body><main><h1>Organization ${id}</h1><p>Public organization profile. This research partner helps UBC teams develop health-related collaborations and share evidence with the public. Learn about research programmes, partnerships and events at this institution.</p></main></body></html>`,
    );
  }
  const archive: HostArchive = {
    hostname,
    homepage,
    input_sha256: sha256("organizer input"),
    retained: [],
    urls:
      conflict === "seed"
        ? [
            {
              url: root,
              kind: "page",
              state: "pending",
              disposition: null,
              reason: null,
              snapshot: null,
              article_id: null,
              source_modified_at: null,
            },
          ]
        : [],
    read: vi.fn(async (url) => {
      const item = values.get(url);
      if (!item) throw new Error(`Missing fixture ${url}`);
      return item;
    }),
    readDocument: vi.fn(async (url) => archive.read(url)),
    readSnapshot: vi.fn(async () => {
      throw new Error("No representative snapshot");
    }),
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  const base = createGenericScraper(hostname);
  const scraper = {
    ...base,
    vetHomepage: () => ({ accepted: true as const, reason: "Public health research" }),
    adapter: { ...base.adapter, kind: "wordpress" as const, allPublicTypes: true, exactHostInventory: true },
  };
  return {
    archive,
    root404: values.get(root)!,
    robots,
    collect: () => collectRecordedHost(scraper, archive, producer),
  };
}

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("source-witnessed Advancing Health organizer roots", () => {
  it("preserves seven public organizer candidates and does not request the shared 404 index", async () => {
    const f = fixture();
    const result = await f.collect();
    expect(result.documents.map(({ source_url }) => source_url)).toEqual(
      expect.arrayContaining(ids.filter((id) => !broken.has(id)).map((id) => `${root}organization-${id}/`)),
    );
    expect(result.documents.some(({ source_url }) => source_url === root)).toBe(false);
    expect(f.archive.read).toHaveBeenCalledWith(root);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(root);
  });

  it("refuses to hide a root that now serves public HTML", async () => {
    const f = fixture();
    f.root404.snapshot.status = 200;
    await expect(f.collect()).rejects.toThrow("Reviewed organizer root lacks its public 404 witness");
  });

  it.each(["seed", "sitemap", "other-cms"] as const)("refuses a competing %s document identity", async (conflict) => {
    const f = fixture(conflict);
    await expect(f.collect()).rejects.toThrow("Reviewed organizer identity conflicts with a required page");
    expect(f.archive.read).not.toHaveBeenCalledWith(root);
  });
});
