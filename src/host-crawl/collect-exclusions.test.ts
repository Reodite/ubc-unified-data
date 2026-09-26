import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, HostScraper, Observation, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { createGenericScraper } from "./generic.ts";

const host = "fixture.ubc.ca";
const home = `https://${host}/`;
const producer: ProducerContext = {
  inputs_sha256: sha256("producer"),
  runtime: { node: "26", icu: "78", unicode: "17", platform: "linux", arch: "x64" },
};
const page = "<title>Public guide</title><main><p>Public programme eligibility and application guidance.</p></main>";
const comment = (href = "/trackback/") =>
  `<div id="comments-template"><p class="comments-closed pings-open">Comments are closed, but <a href="${href}" title="Trackback URL for this post">trackbacks</a> and pingbacks are open.</p></div>`;
const relComment = (href = "/trackback/") =>
  `<div id="comments-template"><a rel="trackback" href="${href}">Trackback</a></div>`;
const urlset = (...urls: string[]) => `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
const index = (...urls: string[]) =>
  `<sitemapindex>${urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`;

function fixture(body = page, robots = "User-agent: *\n", hostname = host) {
  const origin = `https://${hostname}/`;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in synthetic collection");
    }),
  );
  const values = new Map<string, Observation>();
  const put = (path: string, body: string, status = 200) => {
    const url = new URL(path, origin).href;
    const snapshot: Observation["snapshot"] = {
      url,
      requested_url: url,
      status,
      headers: { "content-type": path.endsWith(".xml") ? "application/xml" : "text/html" },
      body,
      bytes: Buffer.byteLength(body),
      retrieved_at: "2026-01-01T00:00:00Z",
    };
    const observation = { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const homepage = put("/", body);
  put("/robots.txt", robots);
  const archive: HostArchive = {
    hostname,
    input_sha256: sha256("input"),
    homepage,
    urls: [],
    retained: [],
    read: vi.fn(async (url) => {
      const observation = values.get(url);
      if (!observation) throw new Error(`Missing recorded observation: ${url}`);
      return observation;
    }),
    readDocument: vi.fn(async (url) => archive.read(url)),
    readSnapshot: async () => {
      throw new Error("No retained snapshots");
    },
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  const seed = (path: string, kind = "page") => {
    archive.urls = [
      ...archive.urls,
      {
        url: new URL(path, origin).href,
        kind,
        state: "pending",
        disposition: null,
        reason: null,
        snapshot: null,
        article_id: null,
        source_modified_at: null,
      },
    ];
  };
  return { archive, values, put, seed, scraper: createGenericScraper(hostname) };
}

function pairFixture(status = 404) {
  const f = fixture(page, `User-agent: *\nSitemap: ${home}sitemap.html\nSitemap: ${home}sitemap.xml\n`);
  f.put("/sitemap.xml", index(`${home}pages.xml`, `${home}misc.xml`));
  f.put("/pages.xml", urlset(`${home}guide`));
  f.put("/misc.xml", urlset(`${home}sitemap.html`));
  f.put("/guide", `${page}<a href="/sitemap.html">Sitemap</a><a href="/sitemap/">HTML sitemap</a>`);
  const companion = f.put("/sitemap.html", "Not found", status);
  companion.snapshot.url = `${home}sitemap/`;
  companion.snapshot.redirects = [
    {
      url: `${home}sitemap.html`,
      location: "/sitemap/",
      status: 301,
      snapshot: sha256("redirect"),
    },
  ];
  f.seed("/sitemap.html", "sitemap");
  f.seed("/sitemap/", "sitemap");
  return { ...f, companion };
}

const strict = (scraper: HostScraper): HostScraper => ({
  ...scraper,
  adapter: { ...scraper.adapter, exactHostInventory: false },
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("WordPress attachment sitemap identities", () => {
  it("excludes a literal numeric attachment identity without requesting it", async () => {
    const attachment = `${home}?attachment_id=22327`;
    const f = fixture(page, `User-agent: *\nSitemap: ${home}sitemap.xml\n`);
    f.put("/sitemap.xml", index(`${home}attachment-sitemap.xml`, `${home}page-sitemap.xml`));
    f.put("/attachment-sitemap.xml", urlset(attachment));
    f.put("/page-sitemap.xml", urlset(`${home}guide`));
    f.put("/guide", page);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([home, `${home}guide`]);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(attachment);
  });

  it.each([
    ["unrelated sitemap", "/page-sitemap.xml", `${home}?attachment_id=22327`],
    ["nonnumeric identity", "/attachment-sitemap.xml", `${home}?attachment_id=media`],
    ["additional selector", "/attachment-sitemap.xml", `${home}?attachment_id=22327&preview=1`],
    ["nonliteral legacy identity", "/attachment-sitemap.xml", `http://${host}/?attachment_id=22327`],
  ])("does not infer an attachment exclusion from a %s", async (_, sitemap, target) => {
    const f = fixture(page, `User-agent: *\nSitemap: ${home}sitemap.xml\n`);
    f.put("/sitemap.xml", index(new URL(sitemap, home).href));
    f.put(sitemap, urlset(target.replaceAll("&", "&amp;")));
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(
      "Required publisher URL lacks a supported discovery policy",
    );
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${home}?attachment_id=22327`);
  });

  it("keeps an attachment-looking semantic path eligible even inside that sitemap", async () => {
    const target = `${home}attachment_id/22327`;
    const f = fixture(page, `User-agent: *\nSitemap: ${home}attachment-sitemap.xml\n`);
    f.put("/attachment-sitemap.xml", urlset(target));
    f.put("/attachment_id/22327", page);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.some((document) => document.source_url === target)).toBe(true);
  });

  it("excludes MOA attachment-sitemap permalinks even when linked from public HTML", async () => {
    const origin = "https://moa.ubc.ca/";
    const attachment = `${origin}2024/01/story/img_6687_banner/`;
    const article = `${origin}2024/01/story/`;
    const f = fixture(
      `${page}<a href="${attachment}">View image</a>`,
      `User-agent: *\nSitemap: ${origin}sitemap.xml\n`,
      "moa.ubc.ca",
    );
    f.put("/sitemap.xml", index(`${origin}attachment-sitemap3.xml`, `${origin}post-sitemap.xml`));
    f.put("/attachment-sitemap3.xml", urlset(attachment));
    f.put("/post-sitemap.xml", urlset(article));
    f.put("/2024/01/story/", page);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([origin, article].sort());
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(attachment);
  });

  it.each(["another HTML sitemap", "the frozen seed"])(
    "refuses a MOA attachment permalink also required by %s",
    async (source) => {
      const origin = "https://moa.ubc.ca/";
      const attachment = `${origin}2024/01/story/img_6687_banner/`;
      const f = fixture(page, `User-agent: *\nSitemap: ${origin}sitemap.xml\n`, "moa.ubc.ca");
      f.put("/sitemap.xml", index(`${origin}attachment-sitemap3.xml`, `${origin}post-sitemap.xml`));
      f.put("/attachment-sitemap3.xml", urlset(attachment));
      f.put("/post-sitemap.xml", urlset(source === "another HTML sitemap" ? attachment : `${origin}article/`));
      if (source === "the frozen seed") f.seed(attachment);
      await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(
        "Attachment sitemap conflicts with a required page",
      );
    },
  );
});

describe("persistent absent sitemap companion exclusions", () => {
  it.each([404, 410])(
    "does not reinsert a validated HTTP %s companion from XML, seeds or later links",
    async (status) => {
      const f = pairFixture(status);
      const before = JSON.stringify({ urls: f.archive.urls, observations: [...f.values] });
      const result = await collectRecordedHost(f.scraper, f.archive, producer);
      expect(result.documents.map((document) => document.source_url).sort()).toEqual([home, `${home}guide`]);
      expect(f.archive.read).toHaveBeenCalledWith(`${home}pages.xml`);
      expect(f.archive.read).toHaveBeenCalledWith(`${home}misc.xml`);
      expect(vi.mocked(f.archive.read).mock.calls.filter(([url]) => url === `${home}sitemap.html`)).toHaveLength(1);
      expect(f.archive.read).not.toHaveBeenCalledWith(`${home}sitemap/`);
      expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${home}sitemap.html`);
      expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${home}sitemap/`);
      expect(f.archive.assertUnchanged).toHaveBeenCalledOnce();
      expect(JSON.stringify({ urls: f.archive.urls, observations: [...f.values] })).toBe(before);
    },
  );

  it("retains the original identity when the returned requested identity is the same-path redirect", async () => {
    const f = pairFixture();
    f.companion.snapshot.requested_url = `${home}sitemap/`;
    expect((await collectRecordedHost(f.scraper, f.archive, producer)).complete).toBe(true);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${home}sitemap.html`);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${home}sitemap/`);
  });

  it.each(["missing child", "failed child", "malformed child", "HTML child", "late HTML child"])(
    "requires complete XML despite a companion: %s",
    async (failure) => {
      const f = pairFixture();
      if (failure === "missing child") f.values.delete(`${home}pages.xml`);
      if (failure === "failed child") f.values.get(`${home}pages.xml`)!.snapshot.status = 404;
      if (failure === "malformed child") f.values.get(`${home}pages.xml`)!.snapshot.body = "<urlset>";
      if (failure === "HTML child") f.put("/sitemap.xml", index(`${home}pages.xml`, `${home}sitemap.html`));
      if (failure === "late HTML child") {
        f.put("/pages.xml", index(`${home}late.xml`));
        f.put("/late.xml", index(`${home}sitemap/`));
        f.values.set(`${home}sitemap/`, f.companion);
      }
      await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow();
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    },
  );

  it.each([
    "forbidden",
    "successful HTML",
    "sole HTML",
    "robots original",
    "robots redirect",
    "robots XML",
    "unavailable",
    "specialized",
  ])("does not exempt an invalid sitemap companion: %s", async (failure) => {
    const f = pairFixture();
    if (failure === "forbidden") f.companion.snapshot.status = 403;
    if (failure === "successful HTML") f.companion.snapshot.status = 200;
    if (failure === "sole HTML") f.put("/robots.txt", `User-agent: *\nSitemap: ${home}sitemap.html\n`);
    const denied = new Map([
      ["robots original", "/sitemap.html"],
      ["robots redirect", "/sitemap/"],
      ["robots XML", "/pages.xml"],
    ]).get(failure);
    if (denied) f.values.get(`${home}robots.txt`)!.snapshot.body += `Disallow: ${denied}\n`;
    if (failure === "unavailable") f.values.delete(`${home}sitemap.html`);
    await expect(
      collectRecordedHost(failure === "specialized" ? strict(f.scraper) : f.scraper, f.archive, producer),
    ).rejects.toThrow();
    expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
  });

  it.each(["/unrelated", "/other-sitemap.html"])("keeps unrelated advertised 404 pages required: %s", async (path) => {
    const f = pairFixture();
    f.put("/misc.xml", urlset(`${home}sitemap.html`, new URL(path, home).href));
    f.put(path, "Not found", 404);
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("Advertised document");
    expect(f.archive.readDocument).toHaveBeenCalledWith(new URL(path, home).href);
  });

  it.each(["/", "/unrelated", "/sitemap/?required=1"])(
    "does not infer unrelated redirect exclusions: %s",
    async (destination) => {
      const f = pairFixture();
      f.companion.snapshot.url = new URL(destination, home).href;
      f.companion.snapshot.redirects![0]!.location = destination;
      await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("sitemap");
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    },
  );

  it("does not hide an unrelated intermediate or requested identity", async () => {
    const f = pairFixture();
    f.companion.snapshot.requested_url = `${home}required`;
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("sitemap");
    f.companion.snapshot.requested_url = `${home}sitemap.html`;
    f.companion.snapshot.redirects = [
      { url: `${home}sitemap.html`, location: "/required", status: 302, snapshot: sha256("first") },
      { url: `${home}required`, location: "/sitemap/", status: 302, snapshot: sha256("second") },
    ];
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("sitemap");
  });

  it.each(["final", "intermediate"])("protects a homepage's %s redirect identity", async (kind) => {
    const f = pairFixture();
    if (kind === "final") f.archive.homepage.snapshot.url = `${home}sitemap/`;
    else
      f.archive.homepage.snapshot.redirects = [
        { url: home, location: "/sitemap/", status: 302, snapshot: sha256("first") },
        { url: `${home}sitemap/`, location: "/", status: 302, snapshot: sha256("second") },
      ];
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("conflicts with a required page");
  });
});

describe("source-anchored comment machine actions", () => {
  it.each([comment(), relComment()])(
    "registers homepage metadata before frozen seeds or links can dispatch: %s",
    async (markup) => {
      const f = fixture(`${page}${markup}`, "User-agent: *\nDisallow: /trackback/\n");
      f.seed("/trackback/");
      f.put("/guide", `${page}<a href="/trackback/">Trackback action</a>`);
      f.archive.homepage.snapshot.body += '<a href="/guide">Guide</a>';
      const before = JSON.stringify({ urls: f.archive.urls, observations: [...f.values] });
      const result = await collectRecordedHost(f.scraper, f.archive, producer);
      expect(result.documents).toHaveLength(2);
      expect(f.archive.read).not.toHaveBeenCalledWith(`${home}trackback/`);
      expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${home}trackback/`);
      expect(JSON.stringify({ urls: f.archive.urls, observations: [...f.values] })).toBe(before);
      await expect(collectRecordedHost(strict(f.scraper), f.archive, producer)).rejects.toThrow("robots policy");
    },
  );

  it("registers later page metadata before dispatching an already queued action", async () => {
    const f = fixture(page, "User-agent: *\nDisallow: /post/trackback/\n");
    f.seed("/post/trackback/");
    f.seed("/post/");
    f.put("/post/", `${page}${comment("/post/trackback/")}`);
    expect((await collectRecordedHost(f.scraper, f.archive, producer)).documents).toHaveLength(2);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${home}post/trackback/`);
  });

  it.each([
    { label: "changed relation", markup: relComment().replace('rel="trackback"', 'rel="alternate"') },
    { label: "changed title", markup: comment().replace("Trackback URL for this post", "Trackback discussion") },
    { label: "changed context", markup: comment().replace('id="comments-template"', 'id="main-content"') },
    { label: "changed metadata", markup: comment().replace('class="comments-closed pings-open"', 'class="article"') },
    { label: "relation outside comments", markup: relComment().replace('id="comments-template"', 'id="main-content"') },
    { label: "ordinary link", markup: '<a href="/trackback/">Trackback guidance</a>' },
  ])("keeps unproved denied URLs strict: $label", async ({ markup }) => {
    const f = fixture(`${page}${markup}`, "User-agent: *\nDisallow: /trackback/\n");
    f.seed("/trackback/");
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("robots policy");
    expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
  });

  it.each(["/guide", "/other/trackback/", "/trackback/?page=1"])(
    "does not classify a different destination from comment context: %s",
    async (destination) => {
      const f = fixture(`${page}${comment(destination)}`, `User-agent: *\nDisallow: ${destination}\n`);
      f.seed(destination);
      await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("robots policy");
    },
  );

  it("resolves metadata against the HTML base without changing the source action identity", async () => {
    const f = fixture(
      `<base href="/other/">${page}${comment("trackback/")}`,
      "User-agent: *\nDisallow: /other/trackback/\n",
    );
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("robots policy");
  });

  it("collects an ordinary page discussing trackbacks and keeps advertised absence strict", async () => {
    const f = fixture(
      `${page}<a href="/trackback/">Trackback guidance</a>`,
      `User-agent: *\nSitemap: ${home}sitemap.xml\n`,
    );
    f.put("/sitemap.xml", urlset(`${home}trackback/`));
    const article = f.put("/trackback/", page);
    expect((await collectRecordedHost(f.scraper, f.archive, producer)).documents).toHaveLength(2);
    expect(f.archive.readDocument).toHaveBeenCalledWith(`${home}trackback/`);
    article.snapshot.status = 404;
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("Advertised document");
  });

  it("does not use normalized prose to invent an action exclusion", async () => {
    const f = fixture(page, "User-agent: *\nDisallow: /trackback/\n");
    const extract = f.scraper.extract;
    f.scraper.extract = (snapshot) => {
      const decision = extract(snapshot);
      if (decision.kind === "document") decision.input.html += comment();
      return decision;
    };
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow("robots policy");
  });
});
