import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostScraper, Observation } from "../contracts.ts";
import { pageExclusion } from "../urls.ts";
import { discoverWordpress, wordpressCollectionUrl } from "./wordpress-discovery.ts";

const hostname = "fixture.ubc.ca";
const origin = `https://${hostname}`;
const prettyRoot = `${origin}/wp-json/`;
const queryRoot = `${origin}/index.php?rest_route=/`;
const fields = "id%2Clink%2Ctitle%2Cstatus%2Ctype%2Cmodified_gmt";
const parameters = (page: number) => `per_page=100&page=${page}&order=asc&orderby=id&_fields=${fields}`;

function observation(url: string, body: unknown): Observation {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    sha256: "0".repeat(64),
    snapshot: {
      url,
      requested_url: url,
      status: 200,
      headers: { "content-type": typeof body === "string" ? "text/html" : "application/json" },
      body: text,
      bytes: Buffer.byteLength(text),
      retrieved_at: "2025-01-01T00:00:00.000Z",
    },
  };
}

function endpoint(root: string, route: string, encoded = false): string {
  return root.includes("?")
    ? `${root.split("?")[0]}?rest_route=${encoded ? encodeURIComponent(route) : route}`
    : `${root}${route.slice(1)}`;
}

function fixture({ api = prettyRoot, restBase = "posts", exactHostInventory = true, encoded = false } = {}) {
  const scraper: HostScraper = {
    hostname,
    title: "Synthetic guide",
    scope: "Synthetic WordPress discovery",
    adapter: { kind: "wordpress", allowedTypes: ["post"], exactHostInventory },
    vetHomepage: () => ({ accepted: true, reason: "Synthetic homepage" }),
    extract: () => ({ kind: "excluded", reason: "Discovery-only fixture" }),
  };
  const homepage = observation(`${origin}/`, `<link rel="https://api.w.org/" href="${api}">`);
  const values = new Map<string, Observation>();
  const put = (url: string, body: unknown) => {
    const result = observation(url, body);
    values.set(url, result);
    return result;
  };
  const collection = endpoint(api, `/wp/v2/${restBase}`, encoded);
  const typesUrl = endpoint(api, "/wp/v2/types", encoded);
  const routes = {
    "/wp/v2/types": { methods: ["GET"], _links: { self: [{ href: typesUrl }] } },
    [`/wp/v2/${restBase}`]: { methods: ["GET"], _links: { self: [{ href: collection }] } },
    [`/wp/v2/${restBase}/(?P<id>[\\d]+)`]: { methods: ["GET"] },
  };
  const types = {
    post: {
      rest_namespace: "wp/v2",
      rest_base: restBase,
      _links: { "wp:items": [{ href: endpoint(api, `/wp/v2/${restBase}`, !encoded) }] },
    },
  };
  put(api, { routes });
  put(typesUrl, types);
  const record = (id: number) => ({
    id,
    link: `${origin}/entry-${id}/`,
    status: "publish",
    type: "post",
    modified_gmt: "2024-12-01T00:00:00",
  });
  const putPage = (page: number, ids: number[], total = ids.length, pages = Math.ceil(total / 100)) => {
    const url = wordpressCollectionUrl(collection, page);
    const result = put(url, ids.map(record));
    result.snapshot.headers["x-wp-total"] = String(total);
    result.snapshot.headers["x-wp-totalpages"] = String(pages);
    return result;
  };
  putPage(1, [7]);
  const read = vi.fn(async (url: string) => {
    const result = values.get(url);
    if (!result) throw new Error(`Missing synthetic observation: ${url}`);
    return result;
  });
  const discover = () => discoverWordpress(scraper, homepage, read);
  return { scraper, homepage, collection, typesUrl, routes, types, put, putPage, read, discover };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in discovery tests");
    }),
  );
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("advertised WordPress discovery", () => {
  it.each([false, true])("preserves pretty request bytes with exact-host inventory %s", async (exactHostInventory) => {
    const f = fixture({ exactHostInventory });
    expect(await f.discover()).toEqual([
      {
        url: `${origin}/entry-7/`,
        modified: "2024-12-01T00:00:00Z",
        id: 7,
        type: "post",
        api_url: `${prettyRoot}wp/v2/posts/7`,
      },
    ]);
    expect(f.read.mock.calls.map(([url]) => url)).toEqual([
      prettyRoot,
      `${prettyRoot}wp/v2/types`,
      `${prettyRoot}wp/v2/posts?${parameters(1)}`,
    ]);
  });

  it.each([
    "elementor_library",
    "elementor_snippet",
    "foundry_comp_block",
    "jp_act_log_event",
    "view",
    "view-template",
    "wpcf7_contact_form",
  ])("omits the reviewed internal CMS object type %s before requesting its collection", async (type) => {
    const f = fixture();
    f.scraper.adapter.allPublicTypes = true;
    (f.types as Record<string, unknown>)[type] = { name: "Reviewed internal object" };
    f.put(f.typesUrl, f.types);
    expect(await f.discover()).toHaveLength(1);
    expect(f.read.mock.calls.map(([url]) => url)).not.toContain(`${prettyRoot}wp/v2/${type}?${parameters(1)}`);
  });

  it("keeps an unreviewed custom type fatal for a specialized scraper", async () => {
    const f = fixture();
    (f.types as Record<string, unknown>).custom_article = {
      rest_namespace: "wp/v2",
      rest_base: "custom_article",
      _links: { "wp:items": [{ href: `${prettyRoot}wp/v2/custom_article` }] },
    };
    f.put(f.typesUrl, f.types);
    await expect(f.discover()).rejects.toThrow("Unreviewed public CMS type: custom_article");
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("accepts literal underscore collection names only in generic inventory", async () => {
    const generic = fixture({ restBase: "dictionary_entries" });
    generic.scraper.adapter.allPublicTypes = true;
    await expect(generic.discover()).resolves.toMatchObject([{ api_url: `${prettyRoot}wp/v2/dictionary_entries/7` }]);
    const specialized = fixture({ restBase: "dictionary_entries", exactHostInventory: false });
    await expect(specialized.discover()).rejects.toThrow("Unsupported content collection namespace");
    expect(specialized.read).toHaveBeenCalledTimes(2);
  });

  it.each(["entries%5Fone", "entries.two", "../posts", "posts/one", "Posts"])(
    "rejects nonliteral or unsafe REST base %s",
    async (restBase) => {
      const f = fixture();
      f.types.post.rest_base = restBase;
      f.put(f.typesUrl, f.types);
      await expect(f.discover()).rejects.toThrow("Unsupported content collection namespace");
    },
  );

  it.each([false, true])("uses the advertised query script with encoded self links %s", async (encoded) => {
    const f = fixture({ api: queryRoot, restBase: "dictionary_entries", encoded });
    f.scraper.adapter.apiContentFallback = true;
    expect(await f.discover()).toEqual([
      {
        url: `${origin}/entry-7/`,
        modified: "2024-12-01T00:00:00Z",
        id: 7,
        type: "post",
        api_url: `${origin}/index.php?rest_route=%2Fwp%2Fv2%2Fdictionary_entries%2F7`,
      },
    ]);
    expect(f.read.mock.calls.map(([url]) => url)).toEqual([
      queryRoot,
      f.typesUrl,
      `${origin}/index.php?rest_route=%2Fwp%2Fv2%2Fdictionary_entries&${parameters(1)}`,
    ]);
    expect(pageExclusion(f.collection, hostname)).toBe("Unsupported query or form selection");
  });

  it("accepts an encoded query root advertised only in the Link header", async () => {
    const api = `${origin}/?rest_route=%2f`;
    const f = fixture({ api });
    f.homepage.snapshot.body = "<p>Synthetic homepage</p>";
    f.homepage.snapshot.headers.link = `<${api}>; rel="https://api.w.org/"`;
    f.types.post._links["wp:items"][0]!.href = `${origin}/?rest_route=%2fwp/v2%2fposts`;
    f.put(f.typesUrl, f.types);
    await expect(f.discover()).resolves.toMatchObject([{ api_url: `${origin}/?rest_route=%2Fwp%2Fv2%2Fposts%2F7` }]);
    expect(f.read).toHaveBeenNthCalledWith(1, api);
  });

  it("never guesses a root and keeps query roots opt-in", async () => {
    const unadvertised = fixture();
    unadvertised.homepage.snapshot.body = "<p>WordPress homepage without API advertisement</p>";
    await expect(unadvertised.discover()).rejects.toThrow("One advertised WordPress API root");
    expect(unadvertised.read).not.toHaveBeenCalled();
    const specialized = fixture({ api: queryRoot, exactHostInventory: false });
    specialized.scraper.adapter.allPublicTypes = true;
    await expect(specialized.discover()).rejects.toThrow("Unsupported WordPress API root");
    expect(specialized.read).not.toHaveBeenCalled();
  });

  it.each([
    "index.php?rest_route=/&rest_route=/",
    "index.php?rest_route=/&page=1",
    "index.php?rest_route=/&",
    "index.php?rest_route=",
    "index.php?rest_route=/wp/v2",
    "index.php?%72est_route=/",
    "index.php?rest_route=%252F",
    "index.php?rest_route=//#fragment",
    "index.php?rest_route=/#",
    "index.php?rest_route=/#fragment",
    "sub/../index.php?rest_route=/",
    "sub/%2e%2E/index.php?rest_route=/",
    "sub%2findex.php?rest_route=/",
    "sub//index.php?rest_route=/",
    "sub\\index.php?rest_route=/",
  ])("rejects malformed root %s before reading", async (suffix) => {
    const f = fixture();
    f.homepage.snapshot.body = `<link rel="https://api.w.org/" href="${origin}/${suffix}">`;
    await expect(f.discover()).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
  });

  describe.each(["self", "wp:items"] as const)("%s route identity", (relation) => {
    it.each([
      "/?rest_route=/wp/v2/posts",
      "/wp-json/wp/v2/posts",
      "/index.php?rest_route=/wp/v2/pages",
      "/index.php?rest_route=/wp/v2/posts/",
      "/index.php?rest_route=/wp/v2/posts&rest_route=/wp/v2/posts",
      "/index.php?rest_route=/wp/v2/posts&page=1",
      "/index.php?rest_route=/wp/v2/../posts",
      "/index.php?rest_route=/wp/v2/%2e%2e/posts",
      "/index.php?rest_route=/wp/v2/%70osts",
      "/index.php?rest_route=%252Fwp%252Fv2%252Fposts",
      "/index.php?rest_route=/wp//v2/posts",
      "/index.php?rest_route=/wp/v2/posts#fragment",
      "/sub/../index.php?rest_route=/wp/v2/posts",
      "/sub/%2e%2e/index.php?rest_route=/wp/v2/posts",
    ])("rejects namespace escape or non-slash equivalence %s", async (suffix) => {
      const f = fixture({ api: queryRoot });
      const href = `${origin}${suffix}`;
      if (relation === "self") {
        f.routes["/wp/v2/posts"] = { methods: ["GET"], _links: { self: [{ href }] } };
        f.put(queryRoot, { routes: f.routes });
      } else {
        f.types.post._links["wp:items"][0]!.href = href;
        f.put(f.typesUrl, f.types);
      }
      await expect(f.discover()).rejects.toThrow();
      expect(f.read).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects an escaped types route before fetching it", async () => {
    const f = fixture({ api: queryRoot });
    f.routes["/wp/v2/types"]._links.self[0]!.href = `${origin}/index.php?rest_route=/wp/v2/types&context=edit`;
    f.put(queryRoot, { routes: f.routes });
    await expect(f.discover()).rejects.toThrow("Invalid CMS rest_route query");
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it("exhausts query pagination without changing the advertised script", async () => {
    const f = fixture({ api: queryRoot });
    f.putPage(
      1,
      Array.from({ length: 100 }, (_, i) => i + 1),
      101,
    );
    f.putPage(2, [101], 101);
    const pages = await f.discover();
    expect(pages).toHaveLength(101);
    expect(pages[100]!.api_url).toBe(`${origin}/index.php?rest_route=%2Fwp%2Fv2%2Fposts%2F101`);
    expect(f.read.mock.calls.slice(2).map(([url]) => url)).toEqual(
      [1, 2].map((page) => `${origin}/index.php?rest_route=%2Fwp%2Fv2%2Fposts&${parameters(page)}`),
    );
  });

  it.each([
    ["duplicate", "duplicate CMS identity"],
    ["changed totals", "CMS totals changed"],
    ["missing record", "did not exhaust"],
    ["wrong page count", "pagination totals disagree"],
  ])("does not relax query collection %s checks", async (kind, message) => {
    const f = fixture({ api: queryRoot });
    f.putPage(
      1,
      Array.from({ length: 100 }, (_, i) => i + 1),
      101,
    );
    f.putPage(
      2,
      kind === "duplicate" ? [1] : kind === "missing record" ? [] : [101],
      kind === "changed totals" ? 102 : 101,
      kind === "wrong page count" ? 1 : 2,
    );
    await expect(f.discover()).rejects.toThrow(message);
  });

  it("counts outbound inventory without fetching it or relaxing document queries", async () => {
    const f = fixture({ api: queryRoot });
    const page = f.putPage(1, [1, 2, 3]);
    const rows = JSON.parse(page.snapshot.body);
    rows[0].link = "https://example.org/outbound";
    rows[1].link = "https://other.ubc.ca/outbound";
    rows[2].link = `${origin}/?unsupported=3`;
    page.snapshot.body = JSON.stringify(rows);
    const pages = await f.discover();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.url).toBe(rows[2].link);
    expect(pageExclusion(pages[0]!.url, hostname)).toBe("Unsupported query or form selection");
    expect(f.read).toHaveBeenCalledTimes(3);
    rows[1].id = rows[0].id;
    page.snapshot.body = JSON.stringify(rows);
    await expect(f.discover()).rejects.toThrow("duplicate CMS identity");
  });
});

describe("reviewed IRES internal archive-block type", () => {
  const host = "ires.ubc.ca";
  const base = `https://${host}/`;
  const api = `${base}wp-json/`;
  const setup = () => {
    const homepage = observation(base, `<link rel="https://api.w.org/" href="${api}">`);
    const values = new Map<string, Observation>();
    const routes = {
      "/wp/v2/types": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/types` }] } },
      "/wp/v2/posts": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/posts` }] } },
    };
    const types = {
      post: {
        rest_namespace: "wp/v2",
        rest_base: "posts",
        _links: { "wp:items": [{ href: `${api}wp/v2/posts` }] },
      },
      "wpa-helper": {
        name: "WordPress Archives Blocks",
        slug: "wpa-helper",
        has_archive: false,
        rest_namespace: "wp/v2",
        rest_base: "wpa-helper",
        _links: { "wp:items": [{ href: `${api}wp/v2/wpa-helper` }] },
      },
    };
    const posts = observation(wordpressCollectionUrl(`${api}wp/v2/posts`, 1), [
      {
        id: 42,
        link: `${base}public-article/`,
        status: "publish",
        type: "post",
        modified_gmt: "2024-12-01T00:00:00",
      },
    ]);
    posts.snapshot.headers["x-wp-total"] = "1";
    posts.snapshot.headers["x-wp-totalpages"] = "1";
    values.set(posts.snapshot.url, posts);
    const scraper: HostScraper = {
      hostname: host,
      title: "IRES",
      scope: "Public environmental research",
      adapter: { kind: "wordpress", allowedTypes: [], allPublicTypes: true, exactHostInventory: true },
      vetHomepage: () => ({ accepted: true, reason: "Public homepage" }),
      extract: () => ({ kind: "excluded", reason: "Discovery fixture" }),
    };
    const discover = () => {
      values.set(api, observation(api, { routes }));
      values.set(`${api}wp/v2/types`, observation(`${api}wp/v2/types`, types));
      return discoverWordpress(scraper, homepage, async (url) => {
        const value = values.get(url);
        if (!value) throw new Error(`Missing fixture ${url}`);
        return value;
      });
    };
    return { routes, types, scraper, discover };
  };

  it("counts public posts but omits only the non-GET WordPress Archives Blocks helper", async () => {
    const f = setup();
    expect((await f.discover()).map((item) => item.url)).toEqual([`${base}public-article/`]);
  });

  it.each(["name", "slug", "archive", "namespace", "base", "item", "route", "hostname"])(
    "does not hide changed or public IRES helper metadata: %s",
    async (change) => {
      const f = setup();
      const helper = f.types["wpa-helper"];
      if (change === "name") helper.name = "Research articles";
      if (change === "slug") helper.slug = "other";
      if (change === "archive") helper.has_archive = true;
      if (change === "namespace") helper.rest_namespace = "custom/v1";
      if (change === "base") helper.rest_base = "public-helper";
      if (change === "item") helper._links["wp:items"][0]!.href = `${api}wp/v2/other`;
      if (change === "route")
        Object.assign(f.routes, {
          "/wp/v2/wpa-helper": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/wpa-helper` }] } },
        });
      if (change === "hostname") f.scraper.hostname = "other.ubc.ca";
      await expect(f.discover()).rejects.toThrow();
    },
  );
});

describe("reviewed Visit UBC search-control page", () => {
  const host = "visit.ubc.ca";
  const root = `https://${host}/`;
  const api = `${root}wp-json/`;
  const search = `${root}?s=search`;
  const setup = (hostname = host) => {
    const origin = `https://${hostname}/`;
    const apiRoot = `${origin}wp-json/`;
    const pages = `${apiRoot}wp/v2/pages`;
    const homepage = observation(
      origin,
      `<html><head><link rel="https://api.w.org/" href="${apiRoot}"></head><body><form method="get" action="${origin}" class="search-form"><input type="text" name="s" value="Search this site..."></form></body></html>`,
    );
    const records = [
      {
        id: 970,
        type: "page",
        status: "publish",
        title: { rendered: "Search" },
        modified_gmt: "2019-10-23T15:47:35",
        link: `${origin}?s=search`,
      },
      ...Array.from({ length: 67 }, (_, index) => ({
        id: 1000 + index,
        type: "page",
        status: "publish",
        title: { rendered: `Page ${index}` },
        modified_gmt: "2026-01-01T12:00:00",
        link: `${origin}page-${index}/`,
      })),
    ];
    const values = new Map<string, Observation>([
      [
        apiRoot,
        observation(apiRoot, {
          routes: {
            "/wp/v2/types": { methods: ["GET"], _links: { self: [{ href: `${apiRoot}wp/v2/types` }] } },
            "/wp/v2/pages": { methods: ["GET"], _links: { self: [{ href: pages }] } },
          },
        }),
      ],
      [
        `${apiRoot}wp/v2/types`,
        observation(`${apiRoot}wp/v2/types`, {
          page: {
            name: "Pages",
            slug: "page",
            has_archive: false,
            rest_namespace: "wp/v2",
            rest_base: "pages",
            _links: { "wp:items": [{ href: pages }] },
          },
        }),
      ],
    ]);
    const first = observation(wordpressCollectionUrl(pages, 1), records);
    first.snapshot.headers["x-wp-total"] = "68";
    first.snapshot.headers["x-wp-totalpages"] = "1";
    values.set(first.snapshot.url, first);
    const scraper: HostScraper = {
      hostname,
      title: "Visit UBC",
      scope: "Public campus guide",
      adapter: { kind: "wordpress", allPublicTypes: true, allowedTypes: [], exactHostInventory: true },
      vetHomepage: () => ({ accepted: true, reason: "Public campus guide" }),
      extract: () => ({ kind: "excluded", reason: "Discovery fixture" }),
    };
    const excluded = new Set<string>();
    const excludedLocations = new Set<string>();
    const discover = () =>
      discoverWordpress(
        scraper,
        homepage,
        async (url) => {
          const item = values.get(url);
          if (!item) throw new Error(`Missing fixture ${url}`);
          return item;
        },
        new Set<string>(),
        excluded,
        excludedLocations,
      );
    return { homepage, records, first, values, excluded, excludedLocations, discover, origin };
  };

  it("keeps ordinary pages while excluding only the CMS-backed GET search form", async () => {
    const f = setup();
    const pages = await f.discover();
    expect(pages).toHaveLength(67);
    expect(pages.some(({ url }) => url === search)).toBe(false);
    expect(f.excluded).toEqual(new Set([search]));
  });

  it.each(["changed form", "changed title", "changed date", "changed id", "changed query", "changed total"])(
    "refuses an unreviewed search control: %s",
    async (change) => {
      const f = setup();
      if (change === "changed form")
        f.homepage.snapshot.body = f.homepage.snapshot.body.replace('method="get"', 'method="post"');
      if (change === "changed title") f.records[0]!.title.rendered = "Campus article";
      if (change === "changed date") f.records[0]!.modified_gmt = "2025-01-01T12:00:00";
      if (change === "changed id") f.records[0]!.id = 971;
      if (change === "changed query") f.records[0]!.link = `${root}?s=faculty`;
      if (change === "changed total") f.first.snapshot.headers["x-wp-total"] = "69";
      f.first.snapshot.body = JSON.stringify(f.records);
      await expect(f.discover()).rejects.toThrow();
    },
  );

  it("does not suppress a different host's search page", async () => {
    const f = setup("other.ubc.ca");
    expect((await f.discover()).filter(({ url }) => url === `${f.origin}?s=search`)).toHaveLength(1);
    expect(f.excluded.size).toBe(0);
  });

  const locationFixture = () => {
    const f = setup();
    const typeUrl = `${api}wp/v2/types`;
    const types = JSON.parse(f.values.get(typeUrl)!.snapshot.body);
    const catalog = JSON.parse(f.values.get(api)!.snapshot.body);
    const collection = `${api}wp/v2/location`;
    types.location = {
      name: "Locations",
      slug: "location",
      has_archive: false,
      rest_namespace: "wp/v2",
      rest_base: "location",
      _links: { "wp:items": [{ href: collection }] },
    };
    catalog.routes["/wp/v2/location"] = { methods: ["GET"], _links: { self: [{ href: collection }] } };
    f.values.get(typeUrl)!.snapshot.body = JSON.stringify(types);
    f.values.get(api)!.snapshot.body = JSON.stringify(catalog);
    const missing = `${root}eat-drink-and-stay/accommodation/standard-suites/`;
    const locationRows = [
      {
        id: 323,
        link: missing.replace("https://", "http://"),
        title: { rendered: "Gage Suites" },
        modified_gmt: "2024-06-17T17:33:55",
        status: "publish",
        type: "location",
      },
      ...Array.from({ length: 58 }, (_, index) => ({
        id: 400 + index,
        link: `${root}page-${index}/`,
        title: { rendered: `Map marker ${index}` },
        modified_gmt: "2026-01-01T12:00:00",
        status: "publish",
        type: "location",
      })),
      {
        id: 810,
        link: missing.replace("https://", "http://"),
        title: { rendered: "Standard Suites (Ponderosa Commons)" },
        modified_gmt: "2019-05-03T23:20:28",
        status: "publish",
        type: "location",
      },
    ];
    const locationPage = observation(wordpressCollectionUrl(collection, 1), locationRows);
    locationPage.snapshot.headers["x-wp-total"] = "60";
    locationPage.snapshot.headers["x-wp-totalpages"] = "1";
    f.values.set(locationPage.snapshot.url, locationPage);
    return { ...f, types, locationRows, locationPage, missing };
  };

  it("counts all 60 map markers but keeps only 58 independently cited detail candidates", async () => {
    const f = locationFixture();
    const pages = await f.discover();
    expect(pages.filter(({ type }) => type === "location")).toHaveLength(58);
    expect(f.excludedLocations).toEqual(new Set([f.missing]));
    expect(pages.some(({ url }) => url === f.missing)).toBe(false);
  });

  it.each([
    "changed title",
    "changed date",
    "changed id",
    "changed URL",
    "new root identity",
    "changed type",
    "changed total",
  ])("refuses changed map-marker identity: %s", async (change) => {
    const f = locationFixture();
    const record = f.locationRows.find(({ id }) => id === 323)!;
    if (change === "changed title") record.title.rendered = "Different location";
    if (change === "changed date") record.modified_gmt = "2025-01-01T12:00:00";
    if (change === "changed id") record.id = 324;
    if (change === "changed URL") record.link = `${root}eat-drink-and-stay/accommodation/other-suites/`;
    if (change === "new root identity") f.locationRows[1]!.link = record.link;
    if (change === "changed type") {
      f.types.location.has_archive = true;
      f.values.get(`${api}wp/v2/types`)!.snapshot.body = JSON.stringify(f.types);
    }
    if (change === "changed total") f.locationPage.snapshot.headers["x-wp-total"] = "61";
    f.locationPage.snapshot.body = JSON.stringify(f.locationRows);
    await expect(f.discover()).rejects.toThrow();
  });
});

describe("reviewed Advancing Health organizer identities", () => {
  const host = "www.advancinghealth.ubc.ca";
  const ids = [10702, 11041, 13325, 13329, 13956, 13975, 13980, 14109, 14140, 14176, 14250, 14279];
  const broken = new Map([
    [11041, ["VCH Research Institute", "2023-10-12T17:36:12"]],
    [13325, ["Clinical Trials BC", "2025-06-05T22:37:45"]],
    [13956, ["Providence Health", "2025-09-29T22:01:55"]],
    [14109, ["Clinical Trials British Columbia", "2026-01-13T18:11:12"]],
    [14140, ["UBC Centre for Health Services and Policy Research (CHSPR)", "2026-02-03T23:14:14"]],
  ]);
  const setup = (hostname = host) => {
    const origin = `https://${hostname}`;
    const api = `${origin}/wp-json/`;
    const collection = `${api}wp/v2/tribe_organizer`;
    const homepage = observation(`${origin}/`, `<link rel="https://api.w.org/" href="${api}">`);
    const records = ids.map((id) => ({
      id,
      link: broken.has(id) ? `${origin}/organizer/` : `${origin}/organizer/organization-${id}/`,
      title: { rendered: broken.get(id)?.[0] ?? `Organization ${id}` },
      modified_gmt: broken.get(id)?.[1] ?? "2026-01-01T12:00:00",
      status: "publish",
      type: "tribe_organizer",
    }));
    const types = {
      tribe_organizer: {
        name: "Organizers",
        slug: "tribe_organizer",
        has_archive: false,
        rest_namespace: "wp/v2",
        rest_base: "tribe_organizer",
        _links: { "wp:items": [{ href: collection }] },
      },
    };
    const values = new Map<string, Observation>([
      [
        api,
        observation(api, {
          routes: {
            "/wp/v2/types": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/types` }] } },
            "/wp/v2/tribe_organizer": { methods: ["GET"], _links: { self: [{ href: collection }] } },
          },
        }),
      ],
      [`${api}wp/v2/types`, observation(`${api}wp/v2/types`, types)],
    ]);
    const page = observation(wordpressCollectionUrl(collection, 1), records);
    page.snapshot.headers["x-wp-total"] = "12";
    page.snapshot.headers["x-wp-totalpages"] = "1";
    values.set(page.snapshot.url, page);
    const scraper: HostScraper = {
      hostname,
      title: "Health research",
      scope: "Public health research",
      adapter: { kind: "wordpress", allowedTypes: [], allPublicTypes: true, exactHostInventory: true },
      vetHomepage: () => ({ accepted: true, reason: "Public research" }),
      extract: () => ({ kind: "excluded", reason: "Discovery fixture" }),
    };
    const excluded = new Set<string>();
    const discover = () =>
      discoverWordpress(
        scraper,
        homepage,
        async (url) => {
          const item = values.get(url);
          if (!item) throw new Error(`Missing fixture ${url}`);
          return item;
        },
        excluded,
      );
    return { records, types, typeObservation: values.get(`${api}wp/v2/types`)!, page, excluded, discover, origin };
  };

  it("counts all twelve publisher records and keeps seven independent organizer pages", async () => {
    const f = setup();
    const pages = await f.discover();
    expect(pages).toHaveLength(7);
    expect(pages.map(({ id }) => id)).toEqual(ids.filter((id) => !broken.has(id)));
    expect(f.excluded).toEqual(new Set([`${f.origin}/organizer/`]));
  });

  it.each(["changed name", "changed date", "changed identity", "new root identity", "changed type", "changed total"])(
    "refuses an unreviewed organizer inventory: %s",
    async (change) => {
      const f = setup();
      const record = f.records.find(({ id }) => id === 11041)!;
      if (change === "changed name") record.title.rendered = "Different organization";
      if (change === "changed date") record.modified_gmt = "2026-01-01T12:00:00";
      if (change === "changed identity") record.link = `${f.origin}/organizer/new-location/`;
      if (change === "new root identity") f.records[0]!.link = `${f.origin}/organizer/`;
      if (change === "changed type") {
        f.types.tribe_organizer.has_archive = true;
        f.typeObservation.snapshot.body = JSON.stringify(f.types);
      }
      if (change === "changed total") f.page.snapshot.headers["x-wp-total"] = "13";
      f.page.snapshot.body = JSON.stringify(f.records);
      await expect(f.discover()).rejects.toThrow();
    },
  );

  it("does not exclude similarly shaped links on another host", async () => {
    const f = setup("lsi.ubc.ca");
    const pages = await f.discover();
    expect(pages).toHaveLength(12);
    expect(pages.filter(({ url }) => url === `${f.origin}/organizer/`)).toHaveLength(5);
    expect(f.excluded.size).toBe(0);
  });
});

describe("source-witnessed recurring UBC events", () => {
  const host = "mediastudies.arts.ubc.ca";
  const base = `https://${host}/`;
  const api = `${base}wp-json/`;
  const event = {
    id: 18741,
    link: `${base}events/event/bms-info-session-2026/`,
    title: { rendered: "BMS Information Session" },
    status: "publish",
    type: "event",
    modified_gmt: "2026-01-01T12:00:00",
  };
  const setup = (records: (typeof event)[] = [event, structuredClone(event)], advertisedTotal = records.length) => {
    const homepage = observation(base, `<link rel="https://api.w.org/" href="${api}">`);
    const routes = {
      "/wp/v2/types": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/types` }] } },
      "/wp/v2/events": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/events` }] } },
    };
    const types = {
      event: {
        name: "Events",
        slug: "event",
        has_archive: "events/event",
        rest_namespace: "wp/v2",
        rest_base: "events",
        _links: { "wp:items": [{ href: `${api}wp/v2/events` }] },
      },
    };
    const values = new Map<string, Observation>();
    const put = (url: string, body: unknown, count = advertisedTotal) => {
      const item = observation(url, body);
      if (url.includes("?")) {
        item.snapshot.headers["x-wp-total"] = String(count);
        item.snapshot.headers["x-wp-totalpages"] = String(Math.ceil(count / 100));
      }
      values.set(url, item);
    };
    const scraper: HostScraper = {
      hostname: host,
      title: "Media Studies",
      scope: "Public educational events",
      adapter: { kind: "wordpress", allowedTypes: [], allPublicTypes: true, exactHostInventory: true },
      vetHomepage: () => ({ accepted: true, reason: "Public homepage" }),
      extract: () => ({ kind: "excluded", reason: "Discovery fixture" }),
    };
    const discover = () => {
      put(api, { routes });
      put(`${api}wp/v2/types`, types);
      put(wordpressCollectionUrl(`${api}wp/v2/events`, 1), records);
      return discoverWordpress(scraper, homepage, async (url) => {
        const item = values.get(url);
        if (!item) throw new Error(`Missing fixture ${url}`);
        return item;
      });
    };
    return { event, routes, types, scraper, discover };
  };

  it("counts both advertised recurrence rows but emits one physical event permalink", async () => {
    const f = setup();
    expect((await f.discover()).map((item) => item.url)).toEqual([event.link]);
  });

  it("still requires the complete advertised row count", async () => {
    const f = setup([event, structuredClone(event)], 3);
    await expect(f.discover()).rejects.toThrow("CMS inventory did not exhaust its advertised total");
  });

  it.each([
    "changed link",
    "changed title",
    "changed modification",
    "other host",
    "wrong type metadata",
    "wrong archive",
  ])("refuses duplicate events without matching publisher identity: %s", async (change) => {
    const rows = [structuredClone(event), structuredClone(event)];
    const f = setup(rows);
    if (change === "changed link") rows[1]!.link = `${base}events/event/another-session/`;
    if (change === "changed title") rows[1]!.title.rendered = "Other event";
    if (change === "changed modification") rows[1]!.modified_gmt = "2026-02-01T12:00:00";
    if (change === "other host") f.scraper.hostname = "other.ubc.ca";
    if (change === "wrong type metadata") f.types.event.name = "Articles";
    if (change === "wrong archive") f.types.event.has_archive = "events/news";
    await expect(f.discover()).rejects.toThrow();
  });
});

describe("reviewed Korean Studies non-GET tour component", () => {
  const host = "korean.arts.ubc.ca";
  const base = `https://${host}/`;
  const api = `${base}wp-json/`;
  const setup = () => {
    const homepage = observation(base, `<link rel="https://api.w.org/" href="${api}">`);
    const values = new Map<string, Observation>();
    const routes = {
      "/wp/v2/types": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/types` }] } },
      "/wp/v2/posts": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/posts` }] } },
    };
    const types = {
      post: {
        rest_namespace: "wp/v2",
        rest_base: "posts",
        _links: { "wp:items": [{ href: `${api}wp/v2/posts` }] },
      },
      ubcvrpress: {
        name: "Tours",
        slug: "ubcvrpress",
        has_archive: false,
        rest_namespace: "wp/v2",
        rest_base: "ubcvrpress",
        _links: { "wp:items": [{ href: `${api}wp/v2/ubcvrpress` }] },
      },
    };
    const posts = observation(wordpressCollectionUrl(`${api}wp/v2/posts`, 1), [
      { id: 42, link: `${base}public-article/`, status: "publish", type: "post", modified_gmt: "2024-12-01T00:00:00" },
    ]);
    posts.snapshot.headers["x-wp-total"] = "1";
    posts.snapshot.headers["x-wp-totalpages"] = "1";
    values.set(posts.snapshot.url, posts);
    const scraper: HostScraper = {
      hostname: host,
      title: "Korean Studies",
      scope: "Public Korean Studies articles",
      adapter: { kind: "wordpress", allowedTypes: [], allPublicTypes: true, exactHostInventory: true },
      vetHomepage: () => ({ accepted: true, reason: "Public homepage" }),
      extract: () => ({ kind: "excluded", reason: "Discovery fixture" }),
    };
    const discover = () => {
      values.set(api, observation(api, { routes }));
      values.set(`${api}wp/v2/types`, observation(`${api}wp/v2/types`, types));
      return discoverWordpress(scraper, homepage, async (url) => {
        const value = values.get(url);
        if (!value) throw new Error(`Missing fixture ${url}`);
        return value;
      });
    };
    return { routes, types, scraper, discover };
  };

  it("keeps public posts but does not request an unadvertised GET tour component", async () => {
    const f = setup();
    expect((await f.discover()).map((item) => item.url)).toEqual([`${base}public-article/`]);
  });

  it.each(["name", "slug", "archive", "namespace", "base", "item", "route", "hostname"])(
    "does not hide changed or public Korean tour metadata: %s",
    async (change) => {
      const f = setup();
      const tour = f.types.ubcvrpress;
      if (change === "name") tour.name = "Research articles";
      if (change === "slug") tour.slug = "other";
      if (change === "archive") tour.has_archive = true;
      if (change === "namespace") tour.rest_namespace = "custom/v1";
      if (change === "base") tour.rest_base = "public-tours";
      if (change === "item") tour._links["wp:items"][0]!.href = `${api}wp/v2/other`;
      if (change === "route")
        Object.assign(f.routes, {
          "/wp/v2/ubcvrpress": { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/ubcvrpress` }] } },
        });
      if (change === "hostname") f.scraper.hostname = "other.ubc.ca";
      await expect(f.discover()).rejects.toThrow();
    },
  );
});

describe("reviewed Orthopaedics homepage inventory anomaly", () => {
  const host = "orthopaedics.med.ubc.ca";
  const base = `https://${host}/`;
  const api = `${base}wp-json/`;
  const alias = {
    id: 5444,
    link: base,
    status: "publish",
    type: "post",
    modified_gmt: "-0001-11-30T07:00:00",
    title: { rendered: "" },
  };
  const page = {
    id: 133,
    link: base,
    status: "publish",
    type: "page",
    modified_gmt: "2026-07-07T22:50:50",
    title: { rendered: "UBC Orthopaedics" },
  };
  const fixture = () => {
    const homepage = observation(base, `<link rel="https://api.w.org/" href="${api}">`);
    const values = new Map<string, Observation>();
    const paths = ["types", "pages", "posts"];
    values.set(
      api,
      observation(api, {
        routes: Object.fromEntries(
          paths.map((path) => [
            `/wp/v2/${path}`,
            { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/${path}` }] } },
          ]),
        ),
      }),
    );
    values.set(
      `${api}wp/v2/types`,
      observation(
        `${api}wp/v2/types`,
        Object.fromEntries(
          ["page", "post"].map((type) => [
            type,
            {
              rest_namespace: "wp/v2",
              rest_base: `${type}s`,
              _links: { "wp:items": [{ href: `${api}wp/v2/${type}s` }] },
            },
          ]),
        ),
      ),
    );
    const collection = (type: "page" | "post", rows: unknown[]) => {
      const url = wordpressCollectionUrl(`${api}wp/v2/${type}s`, 1);
      const result = observation(url, rows);
      result.snapshot.headers["x-wp-total"] = String(rows.length);
      result.snapshot.headers["x-wp-totalpages"] = "1";
      values.set(url, result);
      return result;
    };
    const pages = collection("page", [structuredClone(page)]);
    const posts = collection("post", [structuredClone(alias)]);
    const scraper: HostScraper = {
      hostname: host,
      title: "Orthopaedics",
      scope: "Public academic pages",
      adapter: { kind: "wordpress", allowedTypes: ["page", "post"], exactHostInventory: true },
      vetHomepage: () => ({ accepted: true, reason: "Public homepage" }),
      extract: () => ({ kind: "excluded", reason: "Discovery fixture" }),
    };
    const discover = () =>
      discoverWordpress(scraper, homepage, async (url) => {
        const value = values.get(url);
        if (!value) throw new Error(`Missing fixture ${url}`);
        return value;
      });
    return { pages, posts, discover };
  };

  it("counts but omits only the untitled invalid-date homepage post corroborated by the page record", async () => {
    const f = fixture();
    expect(await f.discover()).toEqual([
      {
        url: base,
        modified: "2026-07-07T22:50:50Z",
        id: 133,
        type: "page",
        api_url: `${api}wp/v2/pages/133`,
      },
    ]);
  });

  it.each(["id", "link", "title", "date", "status", "corroboration"])(
    "rejects a changed Orthopaedics %s instead of weakening GMT validation",
    async (change) => {
      const f = fixture();
      const [row] = JSON.parse(f.posts.snapshot.body);
      if (change === "id") row.id = 5445;
      if (change === "link") row.link = `${base}other/`;
      if (change === "title") row.title.rendered = "Public article";
      if (change === "date") row.modified_gmt = "-0001-11-30T07:00:01";
      if (change === "status") row.status = "draft";
      if (change === "corroboration") {
        const [witness] = JSON.parse(f.pages.snapshot.body);
        witness.title.rendered = "Changed homepage";
        f.pages.snapshot.body = JSON.stringify([witness]);
      }
      f.posts.snapshot.body = JSON.stringify([row]);
      await expect(f.discover()).rejects.toThrow();
    },
  );

  it("keeps a genuinely dated homepage post visible to downstream conflict checks", async () => {
    const f = fixture();
    const [row] = JSON.parse(f.posts.snapshot.body);
    row.modified_gmt = "2026-07-07T22:50:50";
    f.posts.snapshot.body = JSON.stringify([row]);
    expect((await f.discover()).map((item) => item.id)).toEqual([133, 5444]);
  });
});

describe("WordPress collection requests", () => {
  it("retains only the REST route and appends fixed inventory parameters", () => {
    expect(wordpressCollectionUrl(`${prettyRoot}wp/v2/posts`, 2)).toBe(`${prettyRoot}wp/v2/posts?${parameters(2)}`);
    for (const route of ["/wp/v2/dictionary_entries", "%2fwp%2Fv2/dictionary_entries"])
      expect(wordpressCollectionUrl(`${origin}/index.php?rest_route=${route}`, 2)).toBe(
        `${origin}/index.php?rest_route=%2Fwp%2Fv2%2Fdictionary_entries&${parameters(2)}`,
      );
  });

  it.each([
    "/index.php?other=1",
    "/index.php?rest_route=/wp/v2/posts&other=1",
    "/index.php?rest_route=/wp/v2/posts&rest_route=/wp/v2/posts",
    "/index.php?rest_route=/wp/v2/posts&per_page=100",
    "/index.php?rest_route=/wp/v2/posts&page=2",
    "/index.php?rest_route=/wp/v2/posts&order=asc",
    "/index.php?rest_route=/wp/v2/posts&orderby=id",
    "/index.php?rest_route=/wp/v2/posts&_fields=id",
    "/index.php?rest_route=/wp/v2/../posts",
    "/index.php?rest_route=/wp/v2/posts#",
    "/wp-json/wp/v2/posts?per_page=100",
    "/wp-json/wp/v2/../posts",
    "/wp-json/wp/v2/%2e%2e/posts",
    "/wp-json/wp%2fv2/posts",
    "/wp-json/wp%252fv2/posts",
    "/wp-json/wp\\v2/posts",
  ])("rejects preexisting parameters and path escapes in %s", (suffix) => {
    expect(() => wordpressCollectionUrl(`${origin}${suffix}`, 1)).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid page %s",
    (page) => {
      expect(() => wordpressCollectionUrl(`${prettyRoot}wp/v2/posts`, page)).toThrow("Invalid CMS collection request");
    },
  );
});
