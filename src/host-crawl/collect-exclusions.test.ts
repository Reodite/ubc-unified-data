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

describe("reviewed Sport Facilities author sitemap", () => {
  const hostname = "sportfacilities.ubc.ca";
  const origin = `https://${hostname}/`;
  const author = `${origin}author/agmiu/`;
  const colleague = `${origin}author/webadmin/`;
  const robots = `User-agent: *\nSitemap: ${origin}wp-sitemap.xml\n`;
  const setup = () => {
    const f = fixture(`${page}<a href="${author}">Posts by agmiu</a>`, robots, hostname);
    f.put("/wp-sitemap.xml", index(`${origin}wp-sitemap-users-1.xml`, `${origin}wp-sitemap-posts-page-1.xml`));
    const users = f.put("/wp-sitemap-users-1.xml", urlset(author, colleague));
    f.put("/wp-sitemap-posts-page-1.xml", urlset(`${origin}guide/`));
    f.put("/guide/", page);
    return { ...f, users };
  };

  it("retains article pages but does not fetch source-identified WordPress author archives", async () => {
    const f = setup();
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([origin, `${origin}guide/`]);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(author);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(colleague);
  });

  it("does not exclude the same author-shaped links on another hostname", async () => {
    const other = "another.ubc.ca";
    const base = `https://${other}/`;
    const f = fixture(page, `User-agent: *\nSitemap: ${base}wp-sitemap.xml\n`, other);
    f.put("/wp-sitemap.xml", index(`${base}wp-sitemap-users-1.xml`));
    f.put("/wp-sitemap-users-1.xml", urlset(`${base}author/agmiu/`, `${base}author/webadmin/`));
    f.put("/author/agmiu/", "<title>Staff stories</title><main><p>Public staff stories.</p></main>");
    f.put("/author/webadmin/", "<title>Web team</title><main><p>Public web team updates.</p></main>");
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([
      base,
      `${base}author/agmiu/`,
      `${base}author/webadmin/`,
    ]);
  });

  it.each(["changed author", "added author", "seed conflict", "public sitemap conflict"])(
    "refuses %s rather than hiding required articles",
    async (kind) => {
      const f = setup();
      if (kind === "changed author") f.users.snapshot.body = urlset(author, `${origin}author/other/`);
      if (kind === "added author") f.users.snapshot.body = urlset(author, colleague, `${origin}author/other/`);
      if (kind === "seed conflict") f.seed("/author/agmiu/");
      if (kind === "public sitemap conflict") {
        f.put(
          "/wp-sitemap.xml",
          index(
            `${origin}wp-sitemap-users-1.xml`,
            `${origin}wp-sitemap-posts-page-1.xml`,
            `${origin}wp-sitemap-posts-post-1.xml`,
          ),
        );
        f.put("/wp-sitemap-posts-post-1.xml", urlset(author));
      }
      await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(
        kind.includes("author") ? "Reviewed users sitemap changed" : "User archive conflicts with a required page",
      );
    },
  );
});

describe("source-witnessed WordPress gallery attachments", () => {
  const origin = "https://rbsc.library.ubc.ca/";
  const media = `<dt class="gallery-icon"><a href="${origin}article/photo/"><img class="attachment-medium size-medium" src="${origin}files/photo.jpeg"></a></dt>`;

  it("keeps the public article without fetching its gallery attachment page", async () => {
    const f = fixture(`${page}<a href="/article/">Read article</a>`, "User-agent: *\n", "rbsc.library.ubc.ca");
    f.put("/article/", `<title>Public article</title><main><p>Article guidance.</p><dl>${media}</dl></main>`);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([origin, `${origin}article/`]);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${origin}article/photo/`);
  });

  it("refuses to conceal an explicitly seeded gallery URL", async () => {
    const f = fixture(`${page}<a href="/article/">Read article</a>`, "User-agent: *\n", "rbsc.library.ubc.ca");
    f.put("/article/", `<title>Public article</title><main><p>Article guidance.</p><dl>${media}</dl></main>`);
    f.seed("/article/photo/");
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(
      "Gallery attachment conflicts with a required page",
    );
  });

  it("excludes Southern Medical photo gallery links without hiding article prose", async () => {
    const host = "smp.med.ubc.ca";
    const origin = `https://${host}/`;
    const article = "/2019/06/26/farewell-dr-allan-jones/";
    const photo = `${article}smp-2015s-at-ubco/`;
    const gallery = `<dt class="gallery-icon"><a href="${origin}${photo.slice(1)}"><img class="attachment-medium_large size-medium_large" src="${origin}wp-content/uploads/sites/93/2019/06/SMP-2015s-at-UBCO-768x546.jpg"></a></dt>`;
    const f = fixture(`${page}<a href="${article}">Read article</a>`, "User-agent: *\n", host);
    f.put(
      article,
      `<title>Farewell Dr. Allan Jones</title><main><p>Public medical programme article.</p><dl>${gallery}</dl></main>`,
    );
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([
      origin,
      `${origin}${article.slice(1)}`,
    ]);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${origin}${photo.slice(1)}`);

    const seeded = fixture(`${page}<a href="${article}">Read article</a>`, "User-agent: *\n", host);
    seeded.put(
      article,
      `<title>Farewell Dr. Allan Jones</title><main><p>Public medical programme article.</p><dl>${gallery}</dl></main>`,
    );
    seeded.seed(photo);
    await expect(collectRecordedHost(seeded.scraper, seeded.archive, producer)).rejects.toThrow(
      "Gallery attachment conflicts with a required page",
    );

    const captioned = fixture(`${page}<a href="${article}">Read article</a>`, "User-agent: *\n", host);
    captioned.put(
      article,
      `<title>Farewell Dr. Allan Jones</title><main><p>Public medical programme article.</p><dl>${gallery.replace("</a>", "Photo explanation</a>")}</dl></main>`,
    );
    captioned.put(photo, `<title>Image explanation</title><main><p>Public photo essay.</p></main>`);
    const kept = await collectRecordedHost(captioned.scraper, captioned.archive, producer);
    expect(kept.documents.map((document) => document.source_url)).toContain(`${origin}${photo.slice(1)}`);
  });

  it("excludes MSL image-only WordPress attachment links without hiding public essays", async () => {
    const host = "www.msl.ubc.ca";
    const origin = `https://${host}/`;
    const photo = `${origin}article/photo/`;
    const source = `<title>Laboratory research</title><main><p>Public molecular research report.</p><p><a rel="attachment wp-att-9437" href="${photo}"><img class="alignright wp-image-9437 size-full" src="${origin}wp-content/uploads/2022/07/Nobu-with-3-cakes.jpg"></a></p></main>`;
    const f = fixture(`${page}<a href="/article/">Read article</a>`, "User-agent: *\n", host);
    f.put("/article/", source);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([origin, `${origin}article/`]);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(photo);

    const seeded = fixture(`${page}<a href="/article/">Read article</a>`, "User-agent: *\n", host);
    seeded.put("/article/", source);
    seeded.seed("/article/photo/");
    await expect(collectRecordedHost(seeded.scraper, seeded.archive, producer)).rejects.toThrow(
      "Gallery attachment conflicts with a required page",
    );

    const captioned = fixture(`${page}<a href="/article/">Read article</a>`, "User-agent: *\n", host);
    captioned.put("/article/", source.replace("</a>", "Read public photo essay</a>"));
    captioned.put(
      "/article/photo/",
      `<title>Public photo essay</title><main><p>Research image explanation.</p></main>`,
    );
    const kept = await collectRecordedHost(captioned.scraper, captioned.archive, producer);
    expect(kept.documents.map((document) => document.source_url)).toContain(photo);
  });

  it("excludes Mechanical Engineering's observed image-only gallery permalinks", async () => {
    const host = "mech.ubc.ca";
    const origin = `https://${host}/`;
    const article = "/2018/03/10/sailbot-and-mech-celebrate-adas-return-and-future-endeavors/";
    const photo = `${article}img_9258/`;
    const gallery = `<dt class="gallery-icon"><a href="${origin}${photo.slice(1)}"><img class="attachment-thumbnail size-thumbnail" src="${origin}files/2018/03/IMG_9258-150x150.jpg"></a></dt>`;
    const articleBody = `<title>Sailbot and MECH Celebrate Ada's Return</title><main><p>Public mechanical engineering article.</p><dl>${gallery}</dl></main>`;
    const f = fixture(`${page}<a href="${article}">Read article</a>`, "User-agent: *\n", host);
    f.put(article, articleBody);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([
      origin,
      `${origin}${article.slice(1)}`,
    ]);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${origin}${photo.slice(1)}`);

    const seeded = fixture(`${page}<a href="${article}">Read article</a>`, "User-agent: *\n", host);
    seeded.put(article, articleBody);
    seeded.seed(photo);
    await expect(collectRecordedHost(seeded.scraper, seeded.archive, producer)).rejects.toThrow(
      "Gallery attachment conflicts with a required page",
    );

    const captioned = fixture(`${page}<a href="${article}">Read article</a>`, "User-agent: *\n", host);
    captioned.put(article, articleBody.replace("</a>", "Read a photo essay</a>"));
    captioned.put(photo, `<title>Gallery essay</title><main><p>Public engineering photo explanation.</p></main>`);
    const kept = await collectRecordedHost(captioned.scraper, captioned.archive, producer);
    expect(kept.documents.map((document) => document.source_url)).toContain(`${origin}${photo.slice(1)}`);
  });

  it("does not follow media-only Southern Medical photo pagination", async () => {
    const host = "smp.med.ubc.ca";
    const origin = `https://${host}/`;
    const photo = "/2019/06/26/farewell-dr-allan-jones/smp-video-2/";
    const next = "/2019/06/26/farewell-dr-allan-jones/smp-video-3/";
    const attachment = (content: string) =>
      `<title>SMP Video 2</title><body class="singular-attachment attachment-image"><div class="entry-content"><p class="attachment-image"><img src="${origin}wp-content/uploads/sites/93/2019/06/SMP-Video-2.jpg"></p>${content}<nav id="image-navigation"><ul class="pager"><li class="next next-image"><a href="${origin}${next.slice(1)}">Next</a></li></ul></nav></div></body>`;
    const f = fixture(`${page}<a href="${photo}">Recorded photo</a>`, "User-agent: *\n", host);
    f.put(photo, attachment(""));
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url)).toEqual([origin]);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${origin}${next.slice(1)}`);

    const seeded = fixture(`${page}<a href="${photo}">Recorded photo</a>`, "User-agent: *\n", host);
    seeded.put(photo, attachment(""));
    seeded.seed(next);
    await expect(collectRecordedHost(seeded.scraper, seeded.archive, producer)).rejects.toThrow(
      "Gallery attachment conflicts with a required page",
    );

    const captioned = fixture(`${page}<a href="${photo}">Recorded photo</a>`, "User-agent: *\n", host);
    captioned.put(photo, attachment("<p>Medical training photo caption.</p>"));
    captioned.put(next, `<title>Photo essay</title><main><p>Public explanatory prose.</p></main>`);
    const kept = await collectRecordedHost(captioned.scraper, captioned.archive, producer);
    expect(kept.documents.map((document) => document.source_url)).toContain(`${origin}${next.slice(1)}`);
  });

  it("does not exclude a gallery-shaped link on another hostname", async () => {
    const target = `${home}article/photo/`;
    const f = fixture(
      `${page}<dt class="gallery-icon"><a href="${target}"><img class="attachment-medium" src="${home}files/photo.jpeg"></a></dt>`,
    );
    f.put("/article/photo/", page);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([home, target]);
  });
});

describe("MSL calendar-view controls", () => {
  const host = "www.msl.ubc.ca";
  const origin = `https://${host}/`;
  const month = `${origin}events-calendar/month/`;
  const html = `${page}<div class="wrap-nav-elements"><a class="nav-element nav-icon calendar-icon" href="${month}"></a></div><a href="/event/public-seminar/">Public seminar</a>`;

  it("preserves event articles while excluding witnessed view controls", async () => {
    const f = fixture(html, "User-agent: *\n", host);
    f.put("/event/public-seminar/", `<title>Public seminar</title><main><p>Research seminar description.</p></main>`);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([
      origin,
      `${origin}event/public-seminar/`,
    ]);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(month);
  });

  it("does not reactivate a source-witnessed view control from the old frontier", async () => {
    const f = fixture(html, "User-agent: *\n", host);
    f.seed("/events-calendar/month/");
    f.put("/event/public-seminar/", `<title>Public seminar</title><main><p>Research seminar description.</p></main>`);
    const result = await collectRecordedHost(f.scraper, f.archive, producer);
    expect(result.documents.map((document) => document.source_url)).not.toContain(month);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(month);
  });

  it("refuses to hide a publisher-advertised calendar page", async () => {
    const f = fixture(html, `User-agent: *\nSitemap: ${origin}sitemap.xml\n`, host);
    f.put("/sitemap.xml", urlset(month));
    await expect(collectRecordedHost(f.scraper, f.archive, producer)).rejects.toThrow(
      "Non-document discovery conflicts with a required page",
    );
  });
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
