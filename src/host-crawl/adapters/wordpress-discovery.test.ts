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
