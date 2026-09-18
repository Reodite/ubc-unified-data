import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wordpressCollectionUrl } from "./adapters/wordpress-discovery.ts";
import { defineWordpressHost } from "./adapters/wordpress-page.ts";
import { collectRecordedHost } from "./collect.ts";
import {
  DocumentPolicyError,
  NonTextMediaError,
  type HostArchive,
  type Observation,
  type ProducerContext,
  type RetainedDocument,
  type Snapshot,
} from "./contracts.ts";
import { formatDocument, parseDocument } from "./document-format.ts";
import { formatHostList } from "./public-validation.ts";

const host = "fixture.ubc.ca";
const origin = `https://${host}`;
const root = `${origin}/`;
const post = `${origin}/procedure/`;
const api = `${origin}/wp-json/`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
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
const fixture = (name: string) =>
  `<html><head><title>Institutional guide</title></head><body><h1>Institutional guide</h1><div class="entry-content">${name === "placeholder" ? '<div data-excluded="true">Excluded fixture content</div>' : '<p>Demonstration procedure: prepare the required information, review the applicable requirements, and complete the recorded review before beginning the activity.</p><img src="/diagram.png">'}</div></body></html>`;
const homepage = fixture("homepage").replace("</head>", `<link rel="https://api.w.org/" href="${api}"></head>`);
const fixtureScraper = defineWordpressHost({
  hostname: host,
  title: "Institutional guide",
  scope: "Synthetic test scope",
  selectors: [".entry-content"],
  officialHomepage: ($) => $("h1").text() === "Institutional guide",
  excludePage: ($) => ($("[data-excluded]").length ? "Excluded test fixture" : null),
});

function observation(url: string, body: unknown, html = false): Observation {
  const snapshot: Snapshot = {
    url,
    requested_url: url,
    status: 200,
    headers: { "content-type": html ? "text/html" : "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    bytes: 0,
    retrieved_at: "2025-01-01T00:00:00.000Z",
  };
  snapshot.bytes = Buffer.byteLength(snapshot.body);
  return { snapshot, sha256: hash(JSON.stringify(snapshot)) };
}

function setup() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in recorded collection");
    }),
  );
  const values = new Map<string, Observation>();
  const put = (o: Observation) => {
    values.set(o.snapshot.requested_url, o);
    return o;
  };
  const home = put(observation(root, homepage, true));
  put(observation(`${origin}/robots.txt`, "User-agent: *\nDisallow: /wp-admin/\n"));
  const routes = Object.fromEntries(
    ["types", "pages", "posts"].map((name) => [
      `/wp/v2/${name}`,
      { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/${name}` }] } },
    ]),
  );
  put(observation(api, { routes }));
  put(
    observation(
      `${api}wp/v2/types`,
      Object.fromEntries(
        [
          ["page", "pages"],
          ["post", "posts"],
        ].map(([name, base]) => [
          name,
          { rest_namespace: "wp/v2", rest_base: base, _links: { "wp:items": [{ href: `${api}wp/v2/${base}` }] } },
        ]),
      ),
    ),
  );
  const demos = [`${origin}/excluded/a/`, `${origin}/excluded/b/`];
  const records = (type: string, entries: string[]) =>
    entries.map((url, i) => ({ id: i + 1, link: url, status: "publish", type, modified_gmt: "2024-12-01T00:00:00" }));
  for (const [type, base, entries] of [
    ["page", "pages", [root]],
    ["post", "posts", [post, ...demos]],
  ] as const) {
    const o = observation(wordpressCollectionUrl(`${api}wp/v2/${base}`, 1), records(type, [...entries]));
    o.snapshot.headers["x-wp-total"] = String(entries.length);
    o.snapshot.headers["x-wp-totalpages"] = "1";
    put(o);
  }
  put(observation(post, fixture("article"), true));
  for (const demo of demos) put(observation(demo, fixture("placeholder"), true));
  const alias = observation(`${root}?p=216`, fixture("article"), true);
  alias.snapshot.url = post;
  put(alias);
  const retained: RetainedDocument[] = [];
  const archive: HostArchive = {
    hostname: host,
    input_sha256: hash("input"),
    homepage: home,
    urls: [...values].map(([url, o]) => ({
      url,
      kind: "page",
      state: "done",
      disposition: "excluded",
      reason: "fixture",
      snapshot: o.sha256,
      article_id: null,
      source_modified_at: null,
    })),
    retained,
    read: vi.fn(async (url) => {
      const o = values.get(url);
      if (!o) throw new Error(`Missing recorded observation: ${url}`);
      return o;
    }),
    readSnapshot: vi.fn(async (digest) => {
      const o = [...values.values()].find((o) => o.sha256 === digest);
      if (!o) throw new Error("Missing retained representative");
      return o;
    }),
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  return { archive, values, retained };
}

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("recorded complete-host collection", () => {
  it("does not use independent API text to bypass a document policy refusal", async () => {
    const f = setup(),
      catalog = f.values.get(api)!;
    const body = JSON.parse(catalog.snapshot.body);
    for (const base of ["pages", "posts"]) body.routes[`/wp/v2/${base}/(?P<id>[\\d]+)`] = { methods: ["GET"] };
    catalog.snapshot.body = JSON.stringify(body);
    f.archive.readDocument = async (url) => {
      if (url === post) throw new DocumentPolicyError("Document URL policy excludes the observed destination");
      return f.archive.read(url);
    };
    f.archive.apiFallbackEligible = () => true;
    const scraper = { ...fixtureScraper, adapter: { ...fixtureScraper.adapter, apiContentFallback: true } };
    await expect(collectRecordedHost(scraper, f.archive, producer)).rejects.toThrow(/Document URL policy/);
    expect(f.archive.read).not.toHaveBeenCalledWith(`${api}wp/v2/posts/1`);
  });
  it("exhausts CMS records and aliases, excludes placeholders, and replays identical text", async () => {
    const f = setup();
    const result = await collectRecordedHost(fixtureScraper, f.archive, producer);
    expect(result.host).toMatchObject({ hostname: host, document_count: 2, document_root: `data/documents/${host}` });
    expect(result.documents).toHaveLength(2);
    expect(formatHostList([result.host], [host]).length).toBeGreaterThan(0);
    for (const doc of result.documents) expect(parseDocument(formatDocument(doc))).toEqual(doc);
    expect(result.documents.find((doc) => doc.source_url === post)?.alternate_urls).toEqual([`${root}?p=216`]);
    for (const doc of result.documents)
      expect(doc.warnings).toContain(
        "An image has no text alternative; any instructions or data within it are not transcribed or OCR-extracted.",
      );
    expect(await collectRecordedHost(fixtureScraper, f.archive, producer)).toEqual(result);
    expect(f.archive.assertUnchanged).toHaveBeenCalledTimes(2);
  });

  it("uses explicitly declared independent API text without pretending publisher URLs were fetched", async () => {
    const f = setup();
    const catalog = f.values.get(api)!;
    const body = JSON.parse(catalog.snapshot.body);
    for (const base of ["pages", "posts"]) body.routes[`/wp/v2/${base}/(?P<id>[\\d]+)`] = { methods: ["GET"] };
    catalog.snapshot.body = JSON.stringify(body);
    const apiUrl = `${api}wp/v2/posts/1`;
    const item = observation(apiUrl, {
      id: 1,
      type: "post",
      status: "publish",
      link: post,
      modified_gmt: "2024-12-01T00:00:00",
      title: { rendered: "Public API procedure" },
      content: {
        rendered: "<p>Complete the documented preparation and review the stated requirements.</p>",
        protected: false,
      },
    });
    f.values.set(apiUrl, item);
    const original = f.archive.read;
    f.archive.read = vi.fn(async (url) => {
      if (url === post || url === `${root}?p=216`) throw new TypeError("fetch failed");
      return original(url);
    });
    f.archive.observedDestination = (url) => (url === `${root}?p=216` ? post : url);
    f.archive.apiFallbackEligible = (url) => url === post || url === `${root}?p=216`;
    const scraper = { ...fixtureScraper, adapter: { ...fixtureScraper.adapter, apiContentFallback: true } };
    const result = await collectRecordedHost(scraper, f.archive, producer);
    const document = result.documents.find((doc) => doc.source_url === apiUrl)!;
    expect(result.documents).toHaveLength(2);
    expect(document.alternate_urls).toEqual([]);
    expect(document.snapshot_sha256).toBe(item.sha256);
    expect(document.warnings).toEqual([expect.stringContaining(post)]);
    expect(parseDocument(formatDocument(document))).toEqual(document);
    expect(await collectRecordedHost(scraper, f.archive, producer)).toEqual(result);
    f.archive.read = vi.fn(async (url) => {
      if (url === post || url === `${root}?p=216`) throw new TypeError("terminated");
      return original(url);
    });
    expect(await collectRecordedHost(scraper, f.archive, producer)).toEqual(result);
    f.archive.apiFallbackEligible = () => false;
    await expect(collectRecordedHost(scraper, f.archive, producer)).rejects.toThrow(/Required page observations/);
    f.archive.apiFallbackEligible = () => true;
    const row = JSON.parse(item.snapshot.body);
    row.content.rendered = "<form><p>Complete the listed requirements.</p></form>";
    item.snapshot.body = JSON.stringify(row);
    await expect(collectRecordedHost(scraper, f.archive, producer)).rejects.toThrow(/empty after sanitization/);
  });

  it.each([401, 403, 404])("does not use API fallback to bypass HTML HTTP %s", async (status) => {
    const f = setup();
    const catalog = f.values.get(api)!;
    const body = JSON.parse(catalog.snapshot.body);
    for (const base of ["pages", "posts"]) body.routes[`/wp/v2/${base}/(?P<id>[\\d]+)`] = { methods: ["GET"] };
    catalog.snapshot.body = JSON.stringify(body);
    f.values.get(post)!.snapshot.status = status;
    const scraper = { ...fixtureScraper, adapter: { ...fixtureScraper.adapter, apiContentFallback: true } };
    await expect(collectRecordedHost(scraper, f.archive, producer)).rejects.toThrow();
    expect(f.archive.read).not.toHaveBeenCalledWith(`${api}wp/v2/posts/1`);
  });

  it("excludes observed non-text attachments but not unavailable text", async () => {
    const f = setup();
    const attachment = `${origin}/attachment/no-extension/`;
    f.archive.urls = [...f.archive.urls, { ...f.archive.urls[0]!, url: attachment }];
    const read = f.archive.read;
    f.archive.read = vi.fn(async (url) => {
      if (url === attachment) throw new NonTextMediaError("image/jpeg");
      return read(url);
    });
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).resolves.toMatchObject({ complete: true });
    f.archive.read = vi.fn(async (url) => {
      if (url === attachment) throw new TypeError("fetch failed");
      return read(url);
    });
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(
      /Required page observations/,
    );
  });

  it("retains other available observations after a page fails but still blocks publication", async () => {
    const f = setup();
    const originalRead = f.archive.read;
    f.archive.read = vi.fn(async (url) => {
      if (url === root) throw new TypeError("fetch failed");
      return originalRead(url);
    });
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(
      /Required page observations are unavailable/,
    );
    expect(f.archive.read).toHaveBeenCalledWith(post);
  });

  it("distinguishes dead historical links from missing advertised documents", async () => {
    const f = setup();
    const dead = observation(`${origin}/removed/`, "Gone", true);
    dead.snapshot.status = 410;
    f.values.set(dead.snapshot.url, dead);
    f.archive.urls = [...f.archive.urls, { ...f.archive.urls[0]!, url: dead.snapshot.url }];
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).resolves.toMatchObject({ complete: true });
    f.values.get(post)!.snapshot.status = 404;
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(/Advertised document/);
  });

  it("rejects unvetted homepage before reading other observations", async () => {
    const f = setup();
    await expect(
      collectRecordedHost(
        { ...fixtureScraper, vetHomepage: () => ({ accepted: false, reason: "unofficial" }) },
        f.archive,
        producer,
      ),
    ).rejects.toThrow(/not vetted/);
    expect(f.archive.read).not.toHaveBeenCalled();
  });

  it.each(["missing", "totals", "duplicate", "unknown-type", "private-record", "robots", "late-mutation"])(
    "blocks incomplete or invalid %s input",
    async (kind) => {
      const f = setup();
      const collection = f.values.get(wordpressCollectionUrl(`${api}wp/v2/posts`, 1))!;
      if (kind === "missing") f.values.delete(post);
      if (kind === "totals") collection.snapshot.headers["x-wp-total"] = "4";
      if (kind === "duplicate") {
        const rows = JSON.parse(collection.snapshot.body);
        rows[1].id = rows[0].id;
        collection.snapshot.body = JSON.stringify(rows);
      }
      if (kind === "private-record") {
        const rows = JSON.parse(collection.snapshot.body);
        rows[0].status = "private";
        collection.snapshot.body = JSON.stringify(rows);
      }
      if (kind === "unknown-type") {
        const types = f.values.get(`${api}wp/v2/types`)!;
        types.snapshot.body = JSON.stringify({ ...JSON.parse(types.snapshot.body), unreviewed: {} });
      }
      if (kind === "robots") f.values.get(`${origin}/robots.txt`)!.snapshot.body = "User-agent: *\nDisallow: /\n";
      if (kind === "late-mutation")
        f.archive.assertUnchanged = vi.fn(async () => {
          throw new Error("Archive changed");
        });
      await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow();
    },
  );

  it("skips unfetched CSS but refuses unsupported text-bearing resources", async () => {
    const f = setup();
    f.archive.urls = [...f.archive.urls, { ...f.archive.urls[0]!, url: `${origin}/files/custom.css`, snapshot: null }];
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).resolves.toMatchObject({
      complete: true,
    });
    f.values.get(root)!.snapshot.body += '<a href="/files/handbook.pdf">Handbook</a>';
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(/text-extraction adapter/);
  });

  it("follows every advertised CMS page and refuses changed totals", async () => {
    const f = setup();
    const first = f.values.get(wordpressCollectionUrl(`${api}wp/v2/posts`, 1))!;
    const template = JSON.parse(first.snapshot.body)[0];
    first.snapshot.body = JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ ...template, id: id + 1 })));
    first.snapshot.headers["x-wp-total"] = "101";
    first.snapshot.headers["x-wp-totalpages"] = "2";
    const second = observation(wordpressCollectionUrl(`${api}wp/v2/posts`, 2), [{ ...template, id: 101 }]);
    second.snapshot.headers["x-wp-total"] = "101";
    second.snapshot.headers["x-wp-totalpages"] = "2";
    f.values.set(second.snapshot.url, second);
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).resolves.toMatchObject({
      complete: true,
    });
    second.snapshot.headers["x-wp-total"] = "102";
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(/totals changed/);
  });

  it("traverses recorded sitemap indexes and rejects missing advertised input", async () => {
    const f = setup();
    const indexUrl = `${origin}/sitemap.xml`;
    const pageUrl = `${origin}/pages.xml`;
    f.values.get(`${origin}/robots.txt`)!.snapshot.body += `Sitemap: ${indexUrl}\n`;
    const index = observation(indexUrl, `<sitemapindex><sitemap><loc>${pageUrl}</loc></sitemap></sitemapindex>`);
    const page = observation(pageUrl, `<urlset><url><loc>${post}</loc></url></urlset>`);
    index.snapshot.headers["content-type"] = page.snapshot.headers["content-type"] = "application/xml";
    f.values.set(indexUrl, index);
    f.values.set(pageUrl, page);
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).resolves.toMatchObject({
      complete: true,
    });
    f.values.delete(pageUrl);
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(
      /Missing recorded observation/,
    );
  });

  it("excludes ambiguous repeated separators without dropping advertised records", async () => {
    const f = setup();
    f.archive.urls = [...f.archive.urls, { ...f.archive.urls[0]!, url: `${origin}/unverified//` }];
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).resolves.toMatchObject({ complete: true });
    expect(f.archive.read).not.toHaveBeenCalledWith(`${origin}/unverified//`);
    const inventory = f.values.get(wordpressCollectionUrl(`${api}wp/v2/posts`, 1))!;
    const rows = JSON.parse(inventory.snapshot.body);
    rows[0].link = `${origin}/required//`;
    inventory.snapshot.body = JSON.stringify(rows);
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(
      /advertises an ambiguous path/,
    );
  });

  it("acquires ordinary page_id permalinks and blocks unsupported advertised queries", async () => {
    const f = setup();
    const query = `${origin}/?page_id=7`;
    const inventory = f.values.get(wordpressCollectionUrl(`${api}wp/v2/pages`, 1))!;
    const rows = JSON.parse(inventory.snapshot.body);
    rows[0].id = 7;
    rows[0].link = query;
    inventory.snapshot.body = JSON.stringify(rows);
    f.values.set(query, observation(query, fixture("article"), true));
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).resolves.toMatchObject({ complete: true });
    expect(f.archive.read).toHaveBeenCalledWith(query);
    rows[0].link = `${origin}/?unreviewed=7`;
    inventory.snapshot.body = JSON.stringify(rows);
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(
      /Required publisher URL lacks/,
    );
  });

  it("requires complete sitemap XML and blocks missing currently advertised pages", async () => {
    const f = setup();
    const map = `${origin}/sitemap.xml`;
    const guide = `${origin}/guide/`;
    f.values.get(`${origin}/robots.txt`)!.snapshot.body += `Sitemap: ${map}\n`;
    const xml = observation(map, `<urlset><url><loc>${guide}</loc></url>`);
    xml.snapshot.headers["content-type"] = "application/xml";
    f.values.set(map, xml);
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow();
    xml.snapshot.body += "</urlset>";
    const gone = observation(guide, "Not found", true);
    gone.snapshot.status = 404;
    f.values.set(guide, gone);
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(/Advertised document/);
  });
  it("treats a recorded 410 robots response as absent policy in acquisition and replay", async () => {
    const f = setup();
    f.values.get(`${origin}/robots.txt`)!.snapshot.status = 410;
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).resolves.toMatchObject({ complete: true });
  });

  it("rejects malformed publisher calendar dates", async () => {
    const f = setup();
    const collection = f.values.get(wordpressCollectionUrl(`${api}wp/v2/posts`, 1))!;
    const records = JSON.parse(collection.snapshot.body);
    records[0].modified_gmt = "2025-02-31T00:00:00";
    collection.snapshot.body = JSON.stringify(records);
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(/GMT modification time/);
  });

  it("preserves null publisher time and never falls back to retained Markdown", async () => {
    const f = setup();
    const first = await collectRecordedHost(fixtureScraper, f.archive, producer);
    f.retained.push(
      ...first.documents.map((doc) => ({
        id: doc.id,
        source_url: doc.source_url,
        title: doc.title,
        snapshot: doc.snapshot_sha256,
        retrieved_at: doc.retrieved_at,
        source_modified_at: null,
        body_sha256: doc.body_sha256,
        content_sha256: doc.content_sha256,
        content_markdown: doc.content_markdown,
      })),
    );
    const replay = await collectRecordedHost(fixtureScraper, f.archive, producer);
    expect(replay.documents.every((doc) => doc.source_modified_at === null)).toBe(true);
    const alias = f.values.get(`${root}?p=216`)!;
    const original = alias.snapshot.body;
    alias.snapshot.body = original.replace(
      '<div class="entry-content">',
      '<div class="entry-content"><p>Additional observed instructions.</p>',
    );
    await expect(collectRecordedHost(fixtureScraper, f.archive, producer)).rejects.toThrow(/hide changed observed/);
    alias.snapshot.body = original;
    await expect(
      collectRecordedHost(
        {
          ...fixtureScraper,
          extract(snapshot) {
            const value = fixtureScraper.extract(snapshot);
            if (value.kind === "document") value.input.html += "<p>Unrecorded additional text.</p>";
            return value;
          },
        },
        f.archive,
        producer,
      ),
    ).rejects.toThrow(/Retained text or provenance changes/);
  });
});
