import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wordpressCollectionUrl } from "./adapters/wordpress-discovery.ts";
import { collectRecordedHost } from "./collect.ts";
import { NonTextMediaError, type HostArchive, type Observation, type ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { cheapGuardCompletedHost, createGenericScraper } from "./generic.ts";
import * as machineLinks from "./machine-links.ts";
import { pageExclusion } from "./urls.ts";

const host = "ccli.ubc.ca";
const home = `https://${host}/`;
const query = `${home}?post_type=team-member&p=3962`;
const sitemap = `${home}team-member-sitemap.xml`;
const producer: ProducerContext = {
  inputs_sha256: sha256("synthetic query producer"),
  runtime: { node: "26.0.0", icu: "78.1", unicode: "17.0", platform: "linux", arch: "x64" },
};
const html = (body = "<p>Public institutional guidance.</p>", head = "") =>
  `<html><head><title>Public guide</title>${head}</head><body><main>${body}</main></body></html>`;
const urlset = (...urls: string[]) =>
  `<urlset>${urls.map((url) => `<url><loc>${url.replaceAll("&", "&amp;")}</loc></url>`).join("")}</urlset>`;

function fixture() {
  const values = new Map<string, Observation>();
  const put = (url: string, body = html(), media = "text/html", status = 200) => {
    const snapshot: Observation["snapshot"] = {
      requested_url: url,
      url,
      body,
      bytes: Buffer.byteLength(body),
      status,
      headers: { "content-type": media },
      retrieved_at: "2026-01-01T00:00:00Z",
    };
    const observation = { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const homepage = put(home);
  put(`${home}robots.txt`, `User-agent: *\nSitemap: ${sitemap}\n`, "text/plain");
  put(sitemap, urlset(query), "application/xml");
  put(query, html("<p>A selected team member biography.</p>"));
  const archive: HostArchive = {
    hostname: host,
    input_sha256: sha256("synthetic query input"),
    homepage,
    urls: [],
    retained: [],
    read: vi.fn(async (url) => {
      const observation = values.get(url);
      if (!observation) throw new Error(`Missing fixture observation: ${url}`);
      return observation;
    }),
    readDocument: vi.fn(async (url) => archive.read(url)),
    readSnapshot: vi.fn(async () => {
      throw new Error("No retained fixture observations");
    }),
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  const scraper = createGenericScraper(host);
  const collect = async () => {
    const capture = () =>
      JSON.stringify({
        homepage: archive.homepage,
        urls: archive.urls,
        retained: archive.retained,
        observations: [...values],
      });
    const before = capture();
    try {
      return await collectRecordedHost(scraper, archive, producer);
    } finally {
      expect(capture()).toBe(before);
    }
  };
  const seed = (url: string) => {
    archive.urls = [
      {
        url,
        kind: "page",
        state: "pending",
        disposition: null,
        reason: null,
        snapshot: null,
        article_id: null,
        source_modified_at: null,
      },
    ];
  };
  const wordpress = (includeQuery = false, fallback = false) => {
    const api = `${home}wp-json/`;
    archive.homepage = put(home, html(undefined, `<link rel="https://api.w.org/" href="${api}">`));
    const routes: Record<string, unknown> = Object.fromEntries(
      ["types", "team-member"].map((name) => [
        `/wp/v2/${name}`,
        { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/${name}` }] } },
      ]),
    );
    if (fallback) {
      scraper.adapter.apiContentFallback = true;
      routes["/wp/v2/team-member/(?P<id>[\\d]+)"] = { methods: ["GET"] };
      archive.apiFallbackEligible = () => true;
    }
    put(api, JSON.stringify({ routes }), "application/json");
    put(
      `${api}wp/v2/types`,
      JSON.stringify({
        "team-member": {
          rest_namespace: "wp/v2",
          rest_base: "team-member",
          _links: { "wp:items": [{ href: `${api}wp/v2/team-member` }] },
        },
      }),
      "application/json",
    );
    const records = Array.from({ length: fallback ? 1 : 91 }, (_, index) => ({
      id: includeQuery && index === 0 ? 3962 : index + 1,
      type: "team-member",
      status: "publish",
      link: includeQuery && index === 0 ? query : home,
    }));
    const collection = put(
      wordpressCollectionUrl(`${api}wp/v2/team-member`, 1),
      JSON.stringify(records),
      "application/json",
    );
    collection.snapshot.headers["x-wp-total"] = String(records.length);
    collection.snapshot.headers["x-wp-totalpages"] = "1";
    return `${api}wp/v2/team-member/3962`;
  };
  return { archive, scraper, put, values, collect, seed, wordpress };
}

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in query fixtures");
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rejected = [
  "?post_type=team-member&p=0",
  "?post_type=team-member&p=-1",
  "?post_type=team-member&p=03962",
  "?post_type=team-member&p=3963",
  "?post_type=team-member&p=9999999999999999999999999999",
  "?post_type=page&p=3962",
  "?post_type=team-member",
  "?post_type=team-member&p=",
  "?p=3962&post_type=team-member",
  "?post_type=team-member&p=3962&extra=1",
  "?post_type=team-member&p=3962&p=3962",
  "?post_type=team-member&post_type=team-member&p=3962",
  "?post_type=team%2Dmember&p=3962",
  "?post%5Ftype=team-member&p=3962",
  "?post_type=team-member&%70=3962",
  "?post_type=team-member&p=%333962",
  "?post_type=team-member&p=3962&",
  "?post_type=team-member&p=3962#alias",
  "profile/?post_type=team-member&p=3962",
  "guide.pdf?post_type=team-member&p=3962",
  "private/?post_type=team-member&p=3962",
  "wp-json/?post_type=team-member&p=3962",
  "file.json?post_type=team-member&p=3962",
  "wp-content/?post_type=team-member&p=3962",
];

describe("singleton query URL boundaries", () => {
  it("admits only the exact CCLI query without changing the global default", () => {
    expect(createGenericScraper(host).excludeUrl!(query)).toBeNull();
    expect(pageExclusion(query, host)).toBe("Unsupported query or form selection");
    expect(createGenericScraper("other.ubc.ca").excludeUrl!(query.replace(host, "other.ubc.ca"))).not.toBeNull();
  });
  it.each(rejected)("rejects unreviewed query identity %s", (path) => {
    expect(createGenericScraper(host).excludeUrl!(home + path)).not.toBeNull();
  });
  it.each([
    query.replace("https:", "http:"),
    query.replace(host, `reader@${host}`),
    query.replace(host, "other.ubc.ca"),
  ])("rejects unsafe origin %s", (url) => {
    expect(createGenericScraper(host).excludeUrl!(url)).not.toBeNull();
  });
  it.each(["?p=0", "?p=03962", "?page_id=12", "?page=2", "?paged=3", "guide.pdf"])(
    "preserves existing generic policy %s",
    (path) => {
      expect(createGenericScraper(host).excludeUrl!(home + path)).toBeNull();
      expect(createGenericScraper("other.ubc.ca").excludeUrl!(`https://other.ubc.ca/${path}`)).toBeNull();
    },
  );
});

describe("required query collection", () => {
  it("fetches sitemap-advertised HTML independently of the complete 91-record API inventory", async () => {
    const f = fixture();
    f.wordpress();
    const result = await f.collect();
    expect(f.archive.readDocument).toHaveBeenCalledWith(query);
    expect(result.documents.find((document) => document.source_url === query)?.content_markdown).toContain(
      "selected team member biography",
    );
    expect(result.documents.every((document) => document.alternate_urls.length === 0)).toBe(true);
    expect(cheapGuardCompletedHost(result).documents).toHaveLength(2);
    expect(f.archive.assertUnchanged).toHaveBeenCalledOnce();
  });
  it("accepts the requested advertising sitemap reached through an XML index", async () => {
    const f = fixture();
    f.put(`${home}robots.txt`, `User-agent: *\nSitemap: ${home}sitemap_index.xml\n`, "text/plain");
    f.put(
      `${home}sitemap_index.xml`,
      `<sitemapindex><sitemap><loc>${sitemap}</loc></sitemap></sitemapindex>`,
      "application/xml",
    );
    expect((await f.collect()).documents.some((document) => document.source_url === query)).toBe(true);
  });
  it.each(["missing", "wrong sitemap", "seed only", "CMS only", "redirected wrong sitemap"])(
    "requires advertising witness before any document dispatch: %s",
    async (mode) => {
      const f = fixture();
      f.put(`${home}robots.txt`, "User-agent: *\n", "text/plain");
      if (mode === "seed only") f.seed(query);
      if (mode === "CMS only") f.wordpress(true);
      if (mode.includes("wrong sitemap")) {
        const wrong = `${home}page-sitemap.xml`;
        f.put(`${home}robots.txt`, `User-agent: *\nSitemap: ${wrong}\n`, "text/plain");
        const observation = f.put(wrong, urlset(query), "application/xml");
        if (mode.startsWith("redirected")) observation.snapshot.url = sitemap;
      }
      await expect(f.collect()).rejects.toThrow(/required query.*sitemap witness/i);
      expect(f.archive.readDocument).not.toHaveBeenCalled();
      expect(f.archive.read).not.toHaveBeenCalledWith(sitemap);
    },
  );
  it.each([404, 500])("keeps failed advertised XML fatal: %s", async (status) => {
    const f = fixture();
    f.put(sitemap, "Unavailable", "text/html", status);
    await expect(f.collect()).rejects.toThrow(/complete XML/);
    expect(f.archive.readDocument).not.toHaveBeenCalled();
  });
  it("does not count a sibling sitemap as the declaration witness", async () => {
    const f = fixture();
    const other = `${home}page-sitemap.xml`;
    f.put(`${home}robots.txt`, `User-agent: *\nSitemap: ${sitemap}\nSitemap: ${other}\n`, "text/plain");
    f.put(sitemap, urlset(home), "application/xml");
    f.put(other, urlset(query), "application/xml");
    await expect(f.collect()).rejects.toThrow(/required query.*sitemap witness/i);
    expect(f.archive.readDocument).not.toHaveBeenCalled();
  });
  it.each([404, 410, 500])("keeps unavailable required HTML fatal: %s", async (status) => {
    const f = fixture();
    f.put(query, "Unavailable", "text/html", status);
    await expect(f.collect()).rejects.toThrow(/Advertised document|complete HTML/);
    expect(f.archive.readDocument).toHaveBeenCalledWith(query);
  });
  it.each(["application/json", "application/pdf", ""])("requires HTML rather than %s", async (media) => {
    const f = fixture();
    const observed = f.put(query, "{}", media);
    if (media === "application/pdf")
      observed.snapshot.binary = { media_type: "application/pdf", sha256: sha256("PDF") };
    await expect(f.collect()).rejects.toThrow(/Required query.*HTML/);
  });
  it.each(["scope", "nontext", "read error", "API fallback"])("cannot erase a required query on %s", async (mode) => {
    const f = fixture();
    const api = mode === "API fallback" ? f.wordpress(true, true) : undefined;
    const diagnostic =
      mode === "nontext" ? new NonTextMediaError("image/png") : new Error("Synthetic acquisition diagnostic");
    f.archive.observedScopeExclusion = () => (mode === "scope" ? "Outside host" : null);
    f.archive.readDocument = vi.fn(async (url) => {
      if (url === query) throw diagnostic;
      return f.archive.read(url);
    });
    await expect(f.collect()).rejects.toThrow(diagnostic.message);
    expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    if (api) expect(f.archive.read).not.toHaveBeenCalledWith(api);
  });
  it.each(["empty", "furniture", "excluded", "sanitized"])(
    "requires searchable text for %s extraction",
    async (mode) => {
      const f = fixture();
      if (mode === "empty") f.put(query, "");
      if (mode === "furniture") f.put(query, html("<form><input name='q'>Control</form>"));
      const extract = f.scraper.extract;
      if (["excluded", "sanitized"].includes(mode))
        f.scraper.extract = (snapshot) =>
          snapshot.url !== query
            ? extract(snapshot)
            : mode === "excluded"
              ? { kind: "excluded", reason: "Synthetic no prose" }
              : {
                  kind: "document",
                  input: {
                    url: query,
                    title: "Synthetic",
                    html: "<script>only()</script>",
                    retrievedAt: snapshot.retrieved_at,
                    sourceModifiedAt: null,
                  },
                };
      await expect(f.collect()).rejects.toThrow(/no searchable|empty after sanitization/);
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    },
  );
  it.each(["requested", "final", "hop source", "hop destination"])("checks robots at %s identity", async (part) => {
    const f = fixture();
    const denied = `${home}blocked/`;
    f.put(
      `${home}robots.txt`,
      `User-agent: *\nDisallow: ${part === "requested" ? "/?post_type=team-member&p=3962" : "/blocked/"}\nSitemap: ${sitemap}\n`,
      "text/plain",
    );
    const snapshot = f.values.get(query)!.snapshot;
    if (part === "final") snapshot.url = denied;
    if (part.startsWith("hop"))
      snapshot.redirects = [
        {
          url: part === "hop source" ? denied : query,
          location: part === "hop destination" ? denied : query,
          status: 302,
          snapshot: sha256("hop"),
        },
      ];
    await expect(f.collect()).rejects.toThrow(/robots policy/);
    if (part === "requested") expect(f.archive.readDocument).not.toHaveBeenCalledWith(query);
  });
  it.each(["requested_url", "url", "hop source", "hop destination"])(
    "rejects selected identity loss at %s",
    async (part) => {
      const f = fixture();
      const snapshot = f.values.get(query)!.snapshot;
      if (part === "requested_url" || part === "url") snapshot[part] = home;
      else
        snapshot.redirects = [
          {
            url: part === "hop source" ? home : query,
            location: part === "hop destination" ? "/" : query,
            status: 302,
            snapshot: sha256("hop"),
          },
        ];
      await expect(f.collect()).rejects.toThrow(/Required query.*identity/);
    },
  );
  it("rejects ordinary alias requests that redirect into the query", async () => {
    const f = fixture();
    const alias = `${home}alias/`;
    const observation = f.put(alias);
    observation.snapshot.url = query;
    f.seed(alias);
    await expect(f.collect()).rejects.toThrow(/Required query.*identity/);
  });
  it("does not infer an alias from a canonical tag", async () => {
    const f = fixture();
    f.put(query, html("<p>Selected biography.</p>", `<link rel="canonical" href="${home}unreviewed-permalink/">`));
    const document = (await f.collect()).documents.find((document) => document.source_url === query)!;
    expect(document.source_url).toBe(query);
    expect(document.alternate_urls).toEqual([]);
  });
  it("fails on conflicting machine evidence before document dispatch", async () => {
    const f = fixture();
    vi.spyOn(machineLinks, "discoverMachineLinks").mockReturnValue(new Set([query]));
    await expect(f.collect()).rejects.toThrow(/Non-document discovery conflicts/);
    expect(f.archive.readDocument).not.toHaveBeenCalled();
  });
  it("rejects a missing required identity at final output coverage", async () => {
    const f = fixture();
    const exclude = f.scraper.excludeUrl!;
    f.scraper.excludeUrl = (url) => (url === query ? "Synthetic document policy exclusion" : exclude(url));
    await expect(f.collect()).rejects.toThrow(/Required query is missing from complete output/);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(query);
    expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
  });
  it("rejects a copied declaration before inventory or document requests", async () => {
    const f = fixture();
    const other = createGenericScraper("other.ubc.ca");
    other.adapter = { ...other.adapter, requiredQueries: f.scraper.adapter.requiredQueries };
    f.archive.hostname = other.hostname;
    f.archive.homepage = f.put("https://other.ubc.ca/");
    await expect(collectRecordedHost(other, f.archive, producer)).rejects.toThrow(/required query namespace/i);
    expect(f.archive.read).not.toHaveBeenCalled();
    expect(f.archive.readDocument).not.toHaveBeenCalled();
  });
  it.each(["missing observation", "malformed XML", "wrong requested identity", "normalized page alias"])(
    "requires valid literal sitemap evidence: %s",
    async (mode) => {
      const f = fixture();
      if (mode === "missing observation") f.values.delete(sitemap);
      if (mode === "malformed XML") f.put(sitemap, "<broken", "application/xml");
      if (mode === "wrong requested identity") f.values.get(sitemap)!.snapshot.requested_url = `${home}other.xml`;
      if (mode === "normalized page alias") f.put(sitemap, urlset(`${query}#alias`), "application/xml");
      await expect(f.collect()).rejects.toThrow();
      expect(f.archive.readDocument).not.toHaveBeenCalled();
    },
  );
  it.each(["identity", "status", "JSON", "PDF"])(
    "checks retained required-query representatives independently of extraction: %s",
    async (mode) => {
      const f = fixture();
      const previous = (await f.collect()).documents.find((document) => document.source_url === query)!;
      const old = structuredClone(f.values.get(query)!);
      if (mode === "identity") old.snapshot.requested_url = home;
      if (mode === "status") old.snapshot.status = 404;
      if (mode === "JSON") old.snapshot.headers["content-type"] = "application/json";
      if (mode === "PDF") old.snapshot.binary = { media_type: "application/pdf", sha256: sha256("synthetic PDF") };
      old.sha256 = sha256(JSON.stringify(old.snapshot));
      f.archive.retained = [
        {
          id: previous.id,
          source_url: query,
          title: previous.title,
          snapshot: old.sha256,
          retrieved_at: previous.retrieved_at,
          source_modified_at: previous.source_modified_at,
          body_sha256: previous.body_sha256,
          content_sha256: previous.content_sha256,
          content_markdown: previous.content_markdown,
        },
      ];
      f.archive.readSnapshot = vi.fn(async () => old);
      const extract = f.scraper.extract;
      const decision = extract(f.values.get(query)!.snapshot);
      f.scraper.extract = (snapshot) => (snapshot.url === query ? decision : extract(snapshot));
      await expect(f.collect()).rejects.toThrow(
        mode === "identity" ? /Required query.*identity/ : /Required query.*HTML/,
      );
      expect(f.archive.readSnapshot).toHaveBeenCalledWith(old.sha256);
    },
  );
  it("preserves unrelated scope and nontext exclusions", async () => {
    const f = fixture();
    f.archive.homepage = f.put(home, html('<a href="/image">Image</a><a href="/outside">Outside</a>'));
    f.archive.observedScopeExclusion = (url) => (url === `${home}outside` ? "Outside host" : null);
    f.archive.readDocument = vi.fn(async (url) => {
      if (url === `${home}image`) throw new NonTextMediaError("image/png");
      if (url === `${home}outside`) throw new Error("Off-host");
      return f.archive.read(url);
    });
    expect((await f.collect()).documents).toHaveLength(2);
  });
});
