import { readFileSync } from "node:fs";
import { load } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wordpressCollectionUrl } from "./adapters/wordpress-discovery.ts";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, HostScraper, Observation, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";

const reviewed: Array<{ hostname: string; role: string; bodyClass: string; message: string }> = JSON.parse(
  readFileSync(new URL("../../test/fixtures/host-crawl/empty-archive-witnesses.json", import.meta.url), "utf8"),
);
const empty = "Apologies, but no results were found.";
const producer: ProducerContext = {
  inputs_sha256: sha256("synthetic producer"),
  runtime: {
    node: process.versions.node,
    icu: process.versions.icu!,
    unicode: process.versions.unicode!,
    platform: process.platform,
    arch: process.arch,
  },
};
const html = (body: string, classes = "", links = "") =>
  `<html><head><title>Fixture</title></head><body class="${classes}"><nav>${links}</nav><main>${body}</main></body></html>`;

function fixture(hostname = "lam.library.ubc.ca", classes = "archive category", body = `<p>${empty}</p>`) {
  const origin = `https://${hostname}`;
  const archiveUrl = `${origin}/browse/`;
  const followup = `${origin}/followup/`;
  const values = new Map<string, Observation>();
  const put = (url: string, body: string, media = "text/html") => {
    const snapshot: Observation["snapshot"] = {
      url,
      requested_url: url,
      body,
      bytes: Buffer.byteLength(body),
      status: 200,
      headers: { "content-type": media },
      retrieved_at: "2026-01-02T03:04:05.000Z",
    };
    const observation = { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const homepage = put(
    `${origin}/`,
    html("<p>Public registration guidance.</p>", "home", `<a href="${archiveUrl}">Browse</a>`),
  );
  put(`${origin}/robots.txt`, "User-agent: *\nDisallow:\n", "text/plain");
  const archivePage = put(archiveUrl, html(body, classes, `<a href="${followup}">Useful followup</a>`));
  put(followup, html("<p>Complete the registration form before Friday.</p>"));
  const scraper: HostScraper = {
    hostname,
    title: "Synthetic public guidance",
    scope: "Synthetic fixture articles",
    adapter: { kind: "html", allowedTypes: [], exactHostInventory: true },
    vetHomepage: () => ({ accepted: true, reason: "Synthetic homepage" }),
    extract: (snapshot) => ({
      kind: "document",
      input: {
        url: snapshot.url,
        title: "Fixture",
        retrievedAt: snapshot.retrieved_at,
        html: load(snapshot.body)("main").html()!,
      },
    }),
  };
  const archive: HostArchive = {
    hostname,
    input_sha256: sha256("synthetic input"),
    homepage,
    urls: [],
    retained: [],
    read: vi.fn(async (url) => {
      const observation = values.get(url);
      if (!observation) throw new Error(`Unrecorded fixture URL: ${url}`);
      return observation;
    }),
    readSnapshot: async () => {
      throw new Error("No retained fixture snapshot");
    },
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  return { origin, archiveUrl, followup, archivePage, homepage, archive, scraper, put };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in archive quality tests");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("source-witnessed empty archive exclusions", () => {
  it.each(reviewed)(
    "excludes only witnessed $hostname $role archives while retaining discovered links",
    async ({ hostname, bodyClass, message }) => {
      const f = fixture(hostname, bodyClass, `<p>${message}</p>`);
      const result = await collectRecordedHost(f.scraper, f.archive, producer);
      expect(result.complete).toBe(true);
      expect(result.documents.map((doc) => doc.source_url).sort()).toEqual([`${f.origin}/`, f.followup]);
      expect(result.host.document_count).toBe(2);
      expect(f.archive.read).toHaveBeenCalledWith(f.followup);
    },
  );

  it.each([
    "Apologies, but no events were found for the requested venue.",
    "Apologies, but no events were found for the requested category.",
    "Apologies, but no results were found for the requested archive.",
    " Apologies,\n but no results were found. ",
  ])("recognizes only exact normalized empty messages: %s", async (body) => {
    const f = fixture("mech.ubc.ca", "archive post-type-archive-event", `<p>${body}</p>`);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.some((doc) => doc.source_url === f.archiveUrl)).toBe(false);
    expect(result.documents).toHaveLength(2);
  });

  it.each([
    { hostname: "other.ubc.ca", classes: "archive category" },
    { hostname: "lam.library.ubc.ca", classes: "archive author" },
    { hostname: "lam.library.ubc.ca", classes: "category" },
    { hostname: "lam.library.ubc.ca", classes: "archive" },
    { hostname: "smp.med.ubc.ca", classes: "archive category" },
    { hostname: "smp.med.ubc.ca", classes: "archive author" },
    { hostname: "macl.arts.ubc.ca", classes: "archive tax-event-category" },
    { hostname: "mech.ubc.ca", classes: "archive post-type-archive-eventual" },
  ])(
    "does not infer approval from hostname or archive-like URLs: $hostname $classes",
    async ({ hostname, classes }) => {
      const f = fixture(hostname, classes);
      await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(/known placeholder/);
    },
  );

  it("does not accept classes on a content element as body role evidence", async () => {
    const f = fixture();
    f.archivePage.snapshot.body = html(`<div class="archive category">${empty}</div>`);
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(/known placeholder/);
  });

  it("keeps substantive archive prose rather than matching a message substring", async () => {
    const f = fixture("lam.library.ubc.ca", "archive category", `<p>${empty}</p><p>Registration closes on Friday.</p>`);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents).toHaveLength(3);
    expect(result.documents.find((doc) => doc.source_url === f.archiveUrl)?.content_markdown).toBe(
      `${empty.replace(".", "\\.")}\n\nRegistration closes on Friday\\.`,
    );
  });

  it.each(["On this page", "You must be logged in as an instructor to view this content."])(
    "never treats other placeholder signatures as empty archives: %s",
    async (body) => {
      const f = fixture("lam.library.ubc.ca", "archive category", `<p>${body}</p>`);
      await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(/known placeholder/);
    },
  );

  it.each(["seed", "sitemap", "CMS"])("fails instead of excluding an archive with a %s conflict", async (role) => {
    const f = fixture();
    if (role === "seed")
      f.archive.urls = [
        {
          url: f.archiveUrl,
          kind: "page",
          state: "done",
          disposition: null,
          reason: null,
          snapshot: f.archivePage.sha256,
          article_id: null,
          source_modified_at: null,
        },
      ];
    if (role === "sitemap") {
      f.scraper.adapter.sitemaps = [{ path: "/sitemap.xml" }];
      f.put(
        `${f.origin}/sitemap.xml`,
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${f.archiveUrl}</loc></url></urlset>`,
        "application/xml",
      );
    }
    if (role === "CMS") {
      const api = `${f.origin}/wp-json/`;
      f.homepage.snapshot.body = f.homepage.snapshot.body.replace(
        "</head>",
        `<link rel="https://api.w.org/" href="${api}"></head>`,
      );
      f.scraper.adapter = { kind: "wordpress", allowedTypes: ["page"], exactHostInventory: true };
      f.put(
        api,
        JSON.stringify({
          routes: Object.fromEntries(
            ["types", "pages"].map((name) => [
              `/wp/v2/${name}`,
              { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/${name}` }] } },
            ]),
          ),
        }),
        "application/json",
      );
      f.put(
        `${api}wp/v2/types`,
        JSON.stringify({
          page: {
            rest_namespace: "wp/v2",
            rest_base: "pages",
            _links: { "wp:items": [{ href: `${api}wp/v2/pages` }] },
          },
        }),
        "application/json",
      );
      const page = f.put(
        wordpressCollectionUrl(`${api}wp/v2/pages`, 1),
        JSON.stringify([
          { id: 1, link: f.archiveUrl, status: "publish", type: "page", modified_gmt: "2026-01-01T00:00:00" },
        ]),
        "application/json",
      );
      Object.assign(page.snapshot.headers, { "x-wp-total": "1", "x-wp-totalpages": "1" });
    }
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(
      /Reviewed empty archive conflicts with a required page/,
    );
  });

  it.each(["requested", "final", "physical request", "redirect source", "redirect destination"])(
    "checks homepage conflicts in the %s identity",
    async (identity) => {
      const f = fixture();
      const homepage = `${f.origin}/`;
      if (identity === "requested") f.homepage.snapshot.body = f.archivePage.snapshot.body;
      if (identity === "final") f.archivePage.snapshot.url = homepage;
      if (identity === "physical request") f.archivePage.snapshot.requested_url = homepage;
      if (identity === "redirect source" || identity === "redirect destination")
        f.archivePage.snapshot.redirects = [
          {
            url: identity === "redirect source" ? homepage : f.archiveUrl,
            location: identity === "redirect destination" ? "/" : f.archiveUrl,
            status: 302,
            snapshot: sha256("synthetic redirect"),
          },
        ];
      await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(
        /Reviewed empty archive conflicts with a required page/,
      );
    },
  );

  it("rejects a retained source rather than silently dropping its document", async () => {
    const f = fixture();
    f.archive.retained = [
      {
        id: `documents:official-web:${sha256(f.archiveUrl).slice(0, 24)}`,
        source_url: f.archiveUrl,
        title: "Fixture",
        snapshot: f.archivePage.sha256,
        retrieved_at: f.archivePage.snapshot.retrieved_at,
        source_modified_at: null,
        body_sha256: sha256(empty),
        content_sha256: sha256(`Fixture\n${empty}`),
        content_markdown: empty,
      },
    ];
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(
      /Reviewed empty archive conflicts with a required page/,
    );
  });

  it("rejects an archive that owns a declared required public-view form", async () => {
    const f = fixture();
    f.scraper.adapter.views = [{ path: "/browse/", parameter: "mode", placeholder: "", values: ["open"] }];
    f.scraper.excludeUrl = () => null;
    f.archivePage.snapshot.body = f.archivePage.snapshot.body.replace(
      "</body>",
      '<form action="/browse/" method="get"><select name="mode"><option value="">Select</option><option value="open">Open</option></select></form></body>',
    );
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(
      /Reviewed empty archive conflicts with a required page/,
    );
  });
});
