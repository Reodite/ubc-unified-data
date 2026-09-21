import { afterEach, describe, expect, it, vi } from "vitest";
import { wordpressCollectionUrl } from "./adapters/wordpress-discovery.ts";
import { collectRecordedHost, type CollectionFormats } from "./collect.ts";
import type {
  CompletedHost,
  HostArchive,
  HostScraper,
  Observation,
  ProducerContext,
  RetainedDocument,
  SearchDocument,
} from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { createGenericScraper } from "./generic.ts";

const host = "fixture.ubc.ca";
const home = `https://${host}/`;
const producer: ProducerContext = {
  inputs_sha256: sha256("synthetic producer"),
  runtime: { node: "26", icu: "78", unicode: "17", platform: "linux", arch: "x64" },
};
const prose = "<p>Public programme eligibility and application guidance.</p>";
const html = (body = "", head = "") =>
  `<html><head><title>Public guide</title>${head}</head><body><main>${prose}${body}</main></body></html>`;
const anchor = (path: string, label = "Public guidance") => `<a href="${path}">${label}</a>`;
const feed = (path: string, mime = "application/atom+xml", rel = "alternate") =>
  `<link rel="${rel}" type="${mime}" href="${path}">`;
const formId = "contact_message_feedback_form";
const action = `/image-captcha-refresh/${formId}`;
const captcha = (id = formId, href = `/image-captcha-refresh/${id}`) =>
  `<form method="post" action="/contact"><input type="hidden" name="form_id" value="${id}"><fieldset class="captcha captcha-type-challenge--image"><input type="hidden" name="captcha_sid" value="synthetic-session"><input type="hidden" name="captcha_token" value="synthetic-token"><input type="text" name="captcha_response"><a class="reload-captcha" href="${href}">Get a new challenge</a>${anchor("/privacy", "Privacy guidance")}${anchor("/help", "Contact guidance")}</fieldset></form>`;
const urlset = (path: string) => `<urlset><url><loc>${new URL(path, home).href}</loc></url></urlset>`;

function fixture(body = html(), robots = "User-agent: *\n") {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in synthetic machine-link collection");
    }),
  );
  const values = new Map<string, Observation>();
  const representatives = new Map<string, Observation>();
  const put = (path: string, body = html(), contentType = "text/html", status = 200) => {
    const url = new URL(path, home).href;
    const snapshot: Observation["snapshot"] = {
      url,
      requested_url: url,
      status,
      headers: { "content-type": contentType },
      body,
      bytes: Buffer.byteLength(body),
      retrieved_at: "2026-01-01T00:00:00Z",
    };
    const observation = { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const homepage = put("/", body);
  put("/robots.txt", robots, "text/plain");
  put("/privacy", html("<p>Read the public privacy terms.</p>"));
  put("/help", html("<p>Find accessible contact instructions.</p>"));
  const archive: HostArchive = {
    hostname: host,
    input_sha256: sha256("synthetic immutable input"),
    homepage,
    urls: [],
    retained: [],
    read: vi.fn(async (url) => {
      const observation = values.get(url);
      if (!observation) throw new Error(`Missing recorded observation: ${url}`);
      return observation;
    }),
    readDocument: vi.fn(async (url) => archive.read(url)),
    readSnapshot: vi.fn(async (digest) => {
      const observation = representatives.get(digest);
      if (!observation) throw new Error(`Missing retained representative: ${digest}`);
      return observation;
    }),
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  const seed = (...paths: string[]) => {
    archive.urls = [
      ...archive.urls,
      ...paths.map((path) => ({
        url: new URL(path, home).href,
        kind: "page",
        state: "pending",
        disposition: null,
        reason: null,
        snapshot: null,
        article_id: null,
        source_modified_at: null,
      })),
    ];
  };
  const setHome = (body: string) => {
    archive.homepage = put("/", body);
  };
  const scraper = createGenericScraper(host);
  const collect = async (selected = scraper, formats: CollectionFormats = {}) => {
    const capture = () =>
      JSON.stringify({
        hostname: archive.hostname,
        input: archive.input_sha256,
        homepage: archive.homepage,
        urls: archive.urls,
        retained: archive.retained,
        observations: [...values],
        representatives: [...representatives],
      });
    const before = capture();
    try {
      return await collectRecordedHost(selected, archive, producer, formats);
    } finally {
      expect(capture()).toBe(before);
    }
  };
  return { archive, values, representatives, put, seed, setHome, scraper, collect };
}

type Fixture = ReturnType<typeof fixture>;
const strict = (scraper: HostScraper): HostScraper => ({
  ...scraper,
  adapter: { ...scraper.adapter, exactHostInventory: false },
});
const retained = (document: SearchDocument): RetainedDocument => ({
  id: document.id,
  source_url: document.source_url,
  title: document.title,
  snapshot: document.snapshot_sha256,
  retrieved_at: document.retrieved_at,
  source_modified_at: document.source_modified_at,
  body_sha256: document.body_sha256,
  content_sha256: document.content_sha256,
  content_markdown: document.content_markdown,
});
const requireDocument = (result: CompletedHost, path: string) => {
  const document = result.documents.find((entry) => entry.source_url === new URL(path, home).href);
  expect(document).toBeDefined();
  expect(document!.content_markdown).toContain("Public programme eligibility and application guidance\\.");
  return document!;
};

function wordpress(f: Fixture, paths: string[], apiText?: string) {
  const api = `${home}wp-json/`;
  f.setHome(
    f.archive.homepage.snapshot.body.replace("</head>", `<link rel="https://api.w.org/" href="${api}"></head>`),
  );
  const routes: Record<string, unknown> = Object.fromEntries(
    ["types", "pages"].map((name) => [
      `/wp/v2/${name}`,
      { methods: ["GET"], _links: { self: [{ href: `${api}wp/v2/${name}` }] } },
    ]),
  );
  if (apiText !== undefined) {
    f.scraper.adapter.apiContentFallback = true;
    routes["/wp/v2/pages/(?P<id>[\\d]+)"] = { methods: ["GET"] };
    f.archive.apiFallbackEligible = (url) => url === new URL(paths[0]!, home).href;
  }
  f.put(api, JSON.stringify({ routes }), "application/json");
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
  const records = paths.map((path, index) => ({
    id: index + 1,
    type: "page",
    status: "publish",
    link: new URL(path, home).href,
    modified_gmt: null,
  }));
  const collection = f.put(wordpressCollectionUrl(`${api}wp/v2/pages`, 1), JSON.stringify(records), "application/json");
  collection.snapshot.headers["x-wp-total"] = String(paths.length);
  collection.snapshot.headers["x-wp-totalpages"] = "1";
  const item = `${api}wp/v2/pages/1`;
  if (apiText !== undefined)
    f.put(
      item,
      JSON.stringify({
        ...records[0],
        title: { rendered: "Public guide" },
        content: { rendered: apiText, protected: false },
      }),
      "application/json",
    );
  return item;
}

const machineCases = [
  {
    label: "Atom",
    path: "/status.atom",
    head: feed("/status.atom"),
    body: anchor("/status.atom", "Atom updates"),
    source: "/contact",
    response: "<feed></feed>",
    mime: "application/atom+xml",
    denied: false,
  },
  {
    label: "RSS",
    path: "/status.rss",
    head: feed("/status.rss", "application/rss+xml", "alternate enclosure"),
    body: anchor("/status.rss", "RSS updates"),
    source: "/events",
    response: "<rss></rss>",
    mime: "application/rss+xml",
    denied: false,
  },
  ...[formId, "event_submission_form"].map((id, index) => ({
    label: index ? "events CAPTCHA" : "contact CAPTCHA",
    path: `/image-captcha-refresh/${id}`,
    head: "",
    body: captcha(id),
    source: index ? "/events" : "/contact",
    response: '{"challenge":"synthetic"}',
    mime: "application/json",
    denied: true,
  })),
];

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("positive observed machine-link exclusions", () => {
  it.each(machineCases.flatMap((entry) => ["seed", "link", "queued"].map((placement) => ({ ...entry, placement }))))(
    "omits $label from $placement dispatch while preserving ordinary form links",
    async ({ path, head, body, source, response, mime, denied, placement }) => {
      const f = fixture(html(), `User-agent: *\n${denied ? `Disallow: ${path}\n` : ""}`);
      f.put(path, response, mime);
      f.put("/zz-guide", html(anchor(path)));
      const proof = html(`${body}${anchor("/zz-guide")}`, head);
      const expected = [home, `${home}zz-guide`];
      if (denied) expected.push(`${home}privacy`, `${home}help`);
      if (placement === "queued") {
        f.setHome(html(anchor(source)));
        f.put(source, proof);
        f.seed(path, source);
        expected.push(new URL(source, home).href);
      } else {
        f.setHome(proof);
        if (placement === "seed") f.seed(path);
      }
      const result = await f.collect();
      expect(result.complete).toBe(true);
      expect(result.documents.map((document) => document.source_url).sort()).toEqual(expected.sort());
      expect(f.archive.read).not.toHaveBeenCalledWith(new URL(path, home).href);
      expect(f.archive.readDocument).not.toHaveBeenCalledWith(new URL(path, home).href);
      expect(f.archive.assertUnchanged).toHaveBeenCalledOnce();
      for (const document of result.documents) expect(document.alternate_urls).toEqual([]);
      if (placement === "queued") expect(f.archive.readDocument).toHaveBeenCalledWith(new URL(source, home).href);
      if (denied) {
        requireDocument(result, "/privacy");
        requireDocument(result, "/help");
      }
    },
  );

  it("recognizes both raw head feed declarations without treating them as sitemap exemptions", async () => {
    const f = fixture(
      html(
        `${anchor("/status.atom")}${anchor("/status.rss")}${anchor("/guide")}`,
        `${feed("/status.atom")}${feed("/status.rss", "application/rss+xml")}`,
      ),
    );
    f.seed("/status.atom", "/status.rss");
    f.put("/status.atom", "<feed/>", "application/atom+xml");
    f.put("/status.rss", "<rss/>", "application/rss+xml");
    f.put("/guide", html(`${anchor("/status.atom")}${anchor("/status.rss")}`));
    const result = await f.collect();
    expect(result.documents.map((document) => document.source_url).sort()).toEqual([home, `${home}guide`]);
    for (const suffix of ["atom", "rss"]) expect(f.archive.read).not.toHaveBeenCalledWith(`${home}status.${suffix}`);
    expect(f.archive.assertUnchanged).toHaveBeenCalledOnce();
  });
});

describe("machine-link preservation", () => {
  it.each(machineCases)("collects ordinary $label prose without machine proof", async ({ path }) => {
    const f = fixture(html(anchor(path)));
    f.put(path);
    f.seed(path);
    requireDocument(await f.collect(), path);
    expect(f.archive.readDocument).toHaveBeenCalledWith(new URL(path, home).href);
  });

  it.each(machineCases.flatMap((entry) => ["robots", "non-HTML"].map((failure) => ({ ...entry, failure }))))(
    "keeps unproved $label strict on $failure",
    async ({ path, mime, response, failure }) => {
      const f = fixture(html(anchor(path)), `User-agent: *\n${failure === "robots" ? `Disallow: ${path}\n` : ""}`);
      f.put(path, response, mime);
      await expect(f.collect()).rejects.toThrow(failure === "robots" ? "robots policy" : "Missing complete HTML");
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
      if (failure === "robots") expect(f.archive.readDocument).not.toHaveBeenCalledWith(new URL(path, home).href);
      else expect(f.archive.readDocument).toHaveBeenCalledWith(new URL(path, home).href);
    },
  );

  it("collects bounded ordinary routes containing feed and challenge vocabulary", async () => {
    const paths = ["programmes", "services", "guidance", "resources"].flatMap((section) => [
      `/${section}/updates.atom`,
      `/${section}/updates.rss`,
      `/${section}/image-captcha-refresh`,
      `/image-captcha-refresh/${section}_guide`,
    ]);
    const f = fixture(html(paths.map((path) => anchor(path)).join("")));
    for (const path of paths) f.put(path);
    const result = await f.collect();
    expect(result.documents).toHaveLength(paths.length + 1);
    for (const path of paths) requireDocument(result, path);
  });

  const invalidFeeds = [
    { label: "missing relation", markup: feed("/status.atom").replace(' rel="alternate"', "") },
    { label: "substring relation", markup: feed("/status.atom", "application/atom+xml", "not-alternate") },
    { label: "missing MIME", markup: feed("/status.atom").replace(' type="application/atom+xml"', "") },
    { label: "HTML MIME", markup: feed("/status.atom", "text/html") },
    { label: "generic XML MIME", markup: feed("/status.atom", "application/xml") },
    { label: "mismatched MIME suffix", markup: feed("/status.atom", "application/rss+xml") },
    { label: "different suffix", markup: feed("/status.rss") },
    { label: "ordinary suffix", markup: feed("/status.atom.html") },
    { label: "no suffix", markup: feed("/status") },
    { label: "outbound host", markup: feed("https://other.ubc.ca/status.atom") },
    { label: "credentialed URL", markup: feed(`https://reader@${host}/status.atom`) },
    { label: "query", markup: feed("/status.atom?page_id=7") },
    { label: "fragment", markup: feed("/status.atom#updates") },
    { label: "empty query", markup: feed("/status.atom?") },
    { label: "empty fragment", markup: feed("/status.atom#") },
    { label: "dot segment", markup: feed("/nested/../status.atom") },
    { label: "encoded dot segment", markup: feed("/nested/%2e%2e/status.atom") },
    { label: "malformed escape", markup: feed("/%zz/status.atom") },
    { label: "repeated separator", markup: feed("//fixture.ubc.ca//status.atom") },
    { label: "comment", markup: `<!--${feed("/status.atom")}-->` },
    {
      label: "script string",
      markup: `<script type="application/json">${JSON.stringify(feed("/status.atom"))}</script>`,
    },
    { label: "body declaration", markup: "", body: feed("/status.atom") },
    {
      label: "anchor declaration",
      markup: "",
      body: '<a rel="alternate" type="application/atom+xml" href="/status.atom">Feed guidance</a>',
    },
  ];
  it.each(invalidFeeds)("does not infer feed proof from $label", async ({ markup, body = "" }) => {
    const f = fixture(html(`${anchor("/status.atom")}${body}`, markup));
    f.put("/status.atom");
    requireDocument(await f.collect(), "/status.atom");
    expect(f.archive.readDocument).toHaveBeenCalledWith(`${home}status.atom`);
  });

  const invalidCaptcha = [
    { label: "ordinary anchor", body: captcha().replace('class="reload-captcha"', 'class="guidance"') },
    {
      label: "non-captcha fieldset",
      body: captcha().replace('class="captcha captcha-type-challenge--image"', 'class="guidance"'),
    },
    {
      label: "non-image challenge",
      body: captcha().replace("captcha-type-challenge--image", "captcha-type-challenge--text"),
    },
    { label: "non-fieldset wrapper", body: captcha().replaceAll("fieldset", "div") },
    { label: "GET form", body: captcha().replace('method="post"', 'method="get"') },
    { label: "default method", body: captcha().replace('method="post"', "") },
    { label: "no form", body: captcha().replace(/<form[^>]*>|<\/form>/g, "") },
    { label: "wrong form ID", body: captcha().replace(`value="${formId}"`, 'value="different_form"') },
    { label: "missing form ID", body: captcha().replace(/<input[^>]*name="form_id"[^>]*>/, "") },
    {
      label: "nonhidden form ID",
      body: captcha().replace('type="hidden" name="form_id"', 'type="text" name="form_id"'),
    },
    {
      label: "duplicate form ID",
      body: captcha().replace("</form>", `<input type="hidden" name="form_id" value="${formId}"></form>`),
    },
    {
      label: "different form owns ID",
      body: `${captcha().replace(/<input[^>]*name="form_id"[^>]*>/, "")}<form method="post"><input type="hidden" name="form_id" value="${formId}"></form>`,
    },
    { label: "missing session", body: captcha().replace(/<input[^>]*name="captcha_sid"[^>]*>/, "") },
    { label: "missing token", body: captcha().replace(/<input[^>]*name="captcha_token"[^>]*>/, "") },
    {
      label: "nonhidden token",
      body: captcha().replace('type="hidden" name="captcha_token"', 'type="text" name="captcha_token"'),
    },
    { label: "missing response", body: captcha().replace(/<input[^>]*name="captcha_response"[^>]*>/, "") },
    {
      label: "response outside fieldset",
      body: captcha()
        .replace('<input type="text" name="captcha_response">', "")
        .replace("</form>", '<input type="text" name="captcha_response"></form>'),
    },
    {
      label: "token in sibling fieldset",
      body: captcha()
        .replace(/<input[^>]*name="captcha_token"[^>]*>/, "")
        .replace(
          "</form>",
          '<fieldset><input type="hidden" name="captcha_token" value="synthetic-token"></fieldset></form>',
        ),
    },
    {
      label: "reload outside fieldset",
      body: captcha()
        .replace(/<a class="reload-captcha"[^>]*>[^<]*<\/a>/, "")
        .replace("</form>", `<a class="reload-captcha" href="${action}">Public guidance</a></form>`),
    },
  ];
  it.each(invalidCaptcha)("does not infer challenge proof from $label", async ({ body }) => {
    const f = fixture(html(body));
    f.put(action);
    requireDocument(await f.collect(), action);
    expect(f.archive.readDocument).toHaveBeenCalledWith(new URL(action, home).href);
  });

  it.each([
    "/image-captcha-refresh/wrong_form",
    `${action}/extra`,
    `${action}?page_id=7`,
    `${action}#guide`,
    `${action}?`,
    `${action}#`,
    "/nested/../image-captcha-refresh/contact_message_feedback_form",
    "/image-captcha-refresh/%63ontact_message_feedback_form",
  ])("keeps an unproved challenge destination collectable: %s", async (href) => {
    const path = new URL(href, home);
    path.hash = "";
    const f = fixture(html(captcha(formId, href)));
    f.put(path.href);
    requireDocument(await f.collect(), path.href);
  });

  it.each(machineCases)("does not apply $label proof to allowed query variants", async ({ path, head, body }) => {
    const query = `${path}?page_id=7`;
    const f = fixture(html(`${body}${anchor(query)}`, head));
    f.put(path);
    f.put(query);
    requireDocument(await f.collect(), query);
    expect(f.archive.readDocument).toHaveBeenCalledWith(new URL(query, home).href);
  });

  it.each(machineCases)(
    "keeps specialized $label collection strict",
    async ({ path, head, body, response, mime, denied }) => {
      const f = fixture(html(body, head), `User-agent: *\n${denied ? `Disallow: ${path}\n` : ""}`);
      f.put(path, response, mime);
      f.seed(path);
      await expect(f.collect(strict(f.scraper))).rejects.toThrow(denied ? "robots policy" : "Missing complete HTML");
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    },
  );

  it.each(machineCases)(
    "does not treat extractor-normalized $label markup as raw proof",
    async ({ path, head, body }) => {
      const f = fixture(html(), `User-agent: *\nDisallow: ${path}\n`);
      const extract = f.scraper.extract;
      f.scraper.extract = (snapshot) => {
        const decision = extract(snapshot);
        if (decision.kind === "document") decision.input.html += html(body, head);
        return decision;
      };
      await expect(f.collect()).rejects.toThrow("robots policy");
      expect(f.archive.readDocument).not.toHaveBeenCalledWith(new URL(path, home).href);
    },
  );

  it.each(machineCases)("does not treat independent API $label markup as raw proof", async ({ path, head, body }) => {
    const f = fixture(html(), `User-agent: *\nDisallow: ${path}\n`);
    const item = wordpress(f, ["/contact"], html(body, head));
    await expect(f.collect()).rejects.toThrow("robots policy");
    expect(f.archive.read).toHaveBeenCalledWith(item);
    expect(f.archive.readDocument).not.toHaveBeenCalledWith(new URL(path, home).href);
    expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
  });

  it.each(machineCases)("does not use an old retained $label representative as proof", async ({ path, head, body }) => {
    const currentBody = body.replace(/<input[^>]*name="form_id"[^>]*>/, "");
    const f = fixture(html(currentBody));
    f.put(path);
    const first = await f.collect();
    const previous = retained(requireDocument(first, "/"));
    const old = structuredClone(f.archive.homepage);
    old.snapshot.body = html(body, head);
    old.snapshot.bytes = Buffer.byteLength(old.snapshot.body);
    old.sha256 = sha256(JSON.stringify(old.snapshot));
    previous.snapshot = old.sha256;
    f.representatives.set(old.sha256, old);
    f.archive.retained = [previous];
    requireDocument(await f.collect(), path);
    expect(f.archive.readSnapshot).toHaveBeenCalledWith(old.sha256);
  });
});

describe("machine-link protected document boundaries", () => {
  it.each(machineCases.flatMap((entry) => ["XML", "CMS"].map((inventory) => ({ ...entry, inventory }))))(
    "keeps $inventory-advertised $label required despite positive markup",
    async ({ path, head, body, inventory }) => {
      const f = fixture(html(body, head));
      f.put(path, "Unavailable advertised document", "text/html", 404);
      if (inventory === "XML") {
        f.put("/robots.txt", `User-agent: *\nSitemap: ${home}sitemap.xml\n`, "text/plain");
        f.put("/sitemap.xml", urlset(path), "application/xml");
      } else wordpress(f, [path]);
      await expect(f.collect()).rejects.toThrow(/conflict|Advertised document/i);
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    },
  );

  it.each(machineCases.flatMap((entry) => ["final", "intermediate"].map((identity) => ({ ...entry, identity }))))(
    "protects a homepage's $identity $label identity",
    async ({ path, head, body, identity }) => {
      const f = fixture(html(body, head));
      const target = new URL(path, home).href;
      if (identity === "final") f.archive.homepage.snapshot.url = target;
      else
        f.archive.homepage.snapshot.redirects = [
          { url: home, location: path, status: 302, snapshot: sha256("first synthetic hop") },
          { url: target, location: "/", status: 302, snapshot: sha256("second synthetic hop") },
        ];
      f.put(path, "Unavailable homepage identity", "text/html", 403);
      await expect(f.collect()).rejects.toThrow(/conflict|Missing complete HTML/i);
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    },
  );

  it.each(machineCases)("protects the required public-view base for $label", async ({ path, head, body }) => {
    const f = fixture(html(body, head), `User-agent: *\nDisallow: ${path}\n`);
    f.scraper.adapter.views = [{ path, parameter: "page_id", values: ["7"], placeholder: "0" }];
    await expect(f.collect()).rejects.toThrow(/conflict|robots policy/i);
    expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
  });

  it.each(["/status.atom?page_id=7", `${action}?page_id=7`])(
    "preserves an actual required public view: %s",
    async (path) => {
      const base = path.split("?")[0]!;
      const proof = base.endsWith(".atom") ? feed(path) : "";
      const body = base.endsWith(".atom") ? anchor(path) : captcha(formId, path);
      const f = fixture(html(body, proof));
      f.scraper.adapter.views = [{ path: base, parameter: "page_id", values: ["7"], placeholder: "0" }];
      const select = `<form method="get" action="${base}"><select name="page_id"><option value="0">Choose</option><option value="7">Public guide</option></select></form>`;
      f.put(base, html(select));
      f.put(path, html(select));
      const document = requireDocument(await f.collect(), path);
      expect(document.alternate_urls).toEqual([]);
      expect(f.archive.readDocument).toHaveBeenCalledWith(new URL(path, home).href);
    },
  );

  it.each(["/guide.pdf", "/image-captcha-refresh/contact_form.pdf"])(
    "does not hide an actual PDF behind machine-like markup: %s",
    async (path) => {
      const f = fixture(html(`${anchor(path)}${captcha("contact_form.pdf", path)}`, feed(path)));
      const bytes = Buffer.from("%PDF-synthetic recorded fixture");
      const observation = f.put(path, "", "application/pdf");
      observation.snapshot.bytes = bytes.length;
      observation.snapshot.binary = { media_type: "application/pdf", sha256: sha256(bytes.toString()) };
      f.archive.readBytes = vi.fn(async () => bytes);
      const extract = vi.fn(async () => ({
        title: "Public PDF guide",
        markdown: "Public programme eligibility and application guidance\\.",
        warnings: [],
        pageCount: 1,
      }));
      const result = await f.collect(f.scraper, { pdf: { profile_sha256: sha256("synthetic PDF profile"), extract } });
      expect(requireDocument(result, path).extraction?.format).toBe("pdf");
      expect(extract).toHaveBeenCalledWith(bytes, new URL(path, home).href);
    },
  );

  it.each(machineCases)(
    "preserves or rejects a retained $label source instead of omitting it",
    async ({ path, head, body }) => {
      const f = fixture(html(anchor(path)));
      f.put(path);
      const previous = requireDocument(await f.collect(), path);
      f.archive.retained = [retained(previous)];
      f.setHome(html(body, head));
      const outcome = await f.collect().then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      if ("error" in outcome) expect(String(outcome.error)).toMatch(/conflict|Retained document would be lost/i);
      else expect(requireDocument(outcome.result, path)).toEqual(previous);
    },
  );

  it.each(["document", "alias"])("does not silently discard an emitted %s when proof arrives late", async (kind) => {
    const path = kind === "document" ? "/a-report.atom" : "/z-report.atom";
    const f = fixture();
    f.put(path);
    f.put("/contact", html(anchor(path), feed(path)));
    f.seed(path, "/contact");
    if (kind === "alias") {
      const alias = f.put("/a-alias");
      alias.snapshot.url = new URL(path, home).href;
      alias.snapshot.redirects = [
        { url: `${home}a-alias`, location: path, status: 302, snapshot: sha256("alias hop") },
      ];
      f.seed("/a-alias");
    }
    const outcome = await f.collect().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    if ("error" in outcome) expect(String(outcome.error)).toMatch(/conflict/i);
    else {
      const document = requireDocument(outcome.result, path);
      expect(document.alternate_urls).toEqual(kind === "alias" ? [`${home}a-alias`] : []);
      expect(outcome.result.documents.some((entry) => entry.source_url === `${home}contact`)).toBe(true);
    }
  });
});

describe("observed prefixed challenge collection", () => {
  it.each(
    ["/index%2ephp", "/index%2Ephp"].flatMap((prefix) => ["seed", "link"].map((placement) => ({ prefix, placement }))),
  )(
    "excludes the exact $prefix action from $placement without dropping ordinary variants",
    async ({ prefix, placement }) => {
      const source = `${prefix}/contact`;
      const target = `${prefix}${action}`;
      const proof = captcha(formId, target).replace('method="post"', `method="post" data-action="${source}"`);
      const f = fixture(html(anchor(source)), `User-agent: *\nDisallow: ${target}\n`);
      f.put(source, html(proof + anchor(`${prefix}/zz-guide`)));
      f.put(`${prefix}/zz-guide`, html(anchor(target)));
      f.put(target, '{"challenge":"synthetic"}', "application/json");
      f.seed(source);
      if (placement === "seed") f.seed(target);
      const result = await f.collect();
      expect(result.documents).toHaveLength(5);
      for (const path of [source, `${prefix}/zz-guide`, "/privacy", "/help"]) requireDocument(result, path);
      expect(f.archive.read).not.toHaveBeenCalledWith(new URL(target, home).href);
      for (const doc of result.documents) expect(doc.alternate_urls).toEqual([]);
    },
  );

  it.each(["/index%2ephp", "/index%2Ephp"])(
    "keeps publisher-required %s controls in conflict rather than hiding them",
    async (prefix) => {
      const source = `${prefix}/contact`;
      const target = `${prefix}${action}`;
      const proof = captcha(formId, target).replace('method="post"', `method="post" data-action="${source}"`);
      const f = fixture(html(anchor(source)), `User-agent: *\nSitemap: ${home}sitemap.xml\n`);
      f.put("/sitemap.xml", urlset(target), "application/xml");
      f.put(source, html(proof));
      f.put(target, "Unavailable advertised document", "text/html", 404);
      f.seed(source);
      await expect(f.collect()).rejects.toThrow(/conflict|Advertised document/i);
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    },
  );

  it.each([null, "/index%2Ephp/contact"])(
    "keeps unproved prefixed prose collectable with data-action %s",
    async (dataAction) => {
      const source = "/index%2ephp/contact";
      const target = `/index%2ephp${action}`;
      const proof = captcha(formId, target).replace(
        'method="post"',
        `method="post"${dataAction === null ? "" : ` data-action="${dataAction}"`}`,
      );
      const f = fixture(html(anchor(source)));
      f.put(source, html(proof));
      f.put(target);
      requireDocument(await f.collect(), target);
      expect(f.archive.readDocument).toHaveBeenCalledWith(new URL(target, home).href);
    },
  );
});
