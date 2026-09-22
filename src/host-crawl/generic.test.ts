import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toSafeMarkdown } from "../prose/markdown.ts";
import { wordpressCollectionUrl } from "./adapters/wordpress-discovery.ts";
import { collectRecordedHost } from "./collect.ts";
import type { CompletedHost, HostArchive, Observation, ProducerContext, SearchDocument } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { cheapGuardCompletedHost, createGenericScraper } from "./generic.ts";

const host = "fixture.ubc.ca";
const home = `https://${host}/`;
const scraper = createGenericScraper(host);
const producer: ProducerContext = {
  inputs_sha256: sha256("producer"),
  runtime: {
    node: "24.0.0",
    icu: "77.1",
    unicode: "16.0",
    platform: "linux",
    arch: "x64",
  },
};
function observation(path: string, body: string, media = "text/html"): Observation {
  const url = new URL(path, home).href;
  const snapshot = {
    url,
    requested_url: url,
    status: 200,
    headers: { "content-type": media },
    body,
    bytes: Buffer.byteLength(body),
    retrieved_at: "2025-01-01T00:00:00.000Z",
  };
  return { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
}
const sample = `<title>Public guide</title><header class="site-header">Global chrome</header>
<main id="main-content"><article><div class="entry-content"><h1>Public guide</h1>
<p>Prepare the required information.</p><div class="entry-content"><p>Nested prose once.</p></div>
<div class="accordion__trigger"><button aria-controls="answer"><h2>How to apply</h2></button></div>
<a class="accordion-toggle" href="#answer">How to apply</a><div id="answer" hidden aria-hidden="true"><p>Submit the form after review.</p></div>
<h3 role="button" aria-controls="deadline">When to apply</h3><p id="deadline" hidden>Apply before the deadline.</p>
<details><summary>Who can apply</summary><p>All eligible students.</p></details>
<p><span>Read</span><a href="/guide/">instructions</a></p>
<button>Print</button><form>Private controls</form><script>unsafe()</script><nav>Menu labels</nav>
</div></article></main><footer class="site-footer">Footer chrome</footer>`;

describe("generic screensaver inventory", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("No network in screensaver inventory fixtures");
      }),
    );
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  function inventory(paths: string[]) {
    const api = `${home}wp-json/`;
    const values = new Map<string, Observation>();
    const put = (path: string, body: string, media = "text/html") => {
      const value = observation(path, body, media);
      values.set(value.snapshot.url, value);
      return value;
    };
    const homepage = put(
      "/",
      `<title>Home</title><link rel="https://api.w.org/" href="${api}"><main><p>Public instructions.</p></main>`,
    );
    put("/robots.txt", "User-agent: *\nDisallow:\n", "text/plain");
    put(
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
    put(
      `${api}wp/v2/types`,
      JSON.stringify({
        page: { rest_namespace: "wp/v2", rest_base: "pages", _links: { "wp:items": [{ href: `${api}wp/v2/pages` }] } },
      }),
      "application/json",
    );
    const collection = put(
      wordpressCollectionUrl(`${api}wp/v2/pages`, 1),
      JSON.stringify(
        paths.map((path, i) => ({ id: i + 1, link: new URL(path, home).href, status: "publish", type: "page" })),
      ),
      "application/json",
    );
    collection.snapshot.headers["x-wp-total"] = String(paths.length);
    collection.snapshot.headers["x-wp-totalpages"] = "1";
    const archive: HostArchive = {
      hostname: host,
      input_sha256: sha256("screensaver inventory"),
      homepage,
      urls: [],
      retained: [],
      read: vi.fn(async (url) => {
        const value = values.get(url);
        if (!value) throw new Error(`Unrecorded ${url}`);
        return value;
      }),
      readSnapshot: async () => {
        throw new Error("No retained observations");
      },
      assertUnchanged: async () => {},
      close() {},
    };
    return { archive, put };
  }

  it("skips advertised and linked screensavers before reading while retaining installation prose", async () => {
    const file = "/files/2021/08/UBCFOM.sCr";
    const encoded = "/files/UBCFOM%2e%53c%52?download=1";
    const instructions = "/page/how-to-install-the-screensaver-on-windows-machines/";
    const f = inventory([file, encoded, instructions]);
    f.put(
      instructions,
      `<title>Install the screensaver</title><main><p>Windows installation instructions.</p><a href="${file}">Screensaver file</a></main>`,
    );
    const result = await collectRecordedHost(scraper, f.archive, producer);
    expect(result.complete).toBe(true);
    expect(result.documents).toHaveLength(2);
    expect(
      result.documents.find((document) => document.source_url === new URL(instructions, home).href)?.content_markdown,
    ).toContain("Windows installation instructions");
    expect(f.archive.read).toHaveBeenCalledWith(new URL(instructions, home).href);
    expect(f.archive.read).not.toHaveBeenCalledWith(new URL(file, home).href);
    expect(f.archive.read).not.toHaveBeenCalledWith(new URL(encoded, home).href);
  });

  it.each(["/screensaver/", "/files/UBCFOM.src", "/files/UBCFOM.scr-name/"])(
    "still requires an available article-looking observation: %s",
    async (path) => {
      const f = inventory([path]);
      await expect(collectRecordedHost(scraper, f.archive, producer)).rejects.toThrow("Required page observations");
      expect(f.archive.read).toHaveBeenCalledWith(new URL(path, home).href);
    },
  );

  it.each(["/files/UBCFOM.scr.pdf", "/files/guide.pdf"])(
    "excludes an advertised PDF without reading or blocking the HTML inventory: %s",
    async (path) => {
      const f = inventory([path]);
      const result = await collectRecordedHost(scraper, f.archive, producer);
      expect(result.complete).toBe(true);
      expect(result.documents).toHaveLength(1);
      expect(f.archive.read).not.toHaveBeenCalledWith(new URL(path, home).href);
    },
  );
});

describe("generic host throughput adapter", () => {
  it("keeps one prose boundary, hidden answers, headings and adjacent inline labels", () => {
    const result = scraper.extract(observation("/", sample).snapshot);
    expect(result.kind).toBe("document");
    if (result.kind !== "document") throw new Error("Expected shared prose sample");
    const markdown = toSafeMarkdown(result.input.html, home).markdown;
    expect(markdown).toContain("## How to apply");
    expect(markdown.match(/How to apply/g)).toHaveLength(1);
    expect(markdown.match(/Nested prose once/g)).toHaveLength(1);
    expect(markdown).toContain("Submit the form after review");
    expect(markdown).toContain("Who can apply");
    expect(markdown).toContain("### When to apply");
    expect(markdown).toContain(`Read [instructions](${home}guide/)`);
    expect(markdown).not.toMatch(/chrome|Private controls|unsafe|Menu labels|Print/);
    const captioned = scraper.extract(
      observation(
        "/",
        `<title>Guide</title><div class="carousel-caption">Course support.</div><div class="entry-content"><p>Main guidance.</p><p class="byline">Author attribution.</p><time class="entry-date">2011</time></div>`,
      ).snapshot,
    );
    if (captioned.kind !== "document") throw new Error("Expected caption and prose");
    expect(captioned.input.html).toContain("Course support");
    expect(captioned.input.html).toContain("Author attribution");
    expect(captioned.input.html).toContain("2011");
    const emptyEntry = scraper.extract(
      observation(
        "/",
        `<title>Guide</title><main><div class="entry-content"></div><div class="carousel-caption">Caption.</div><p>Substantive main text.</p></main>`,
      ).snapshot,
    );
    if (emptyEntry.kind !== "document") throw new Error("Expected main boundary");
    expect(emptyEntry.input.html).toContain("Substantive main text");
    for (const wrapper of [
      "main id='main-content'",
      "article",
      "main",
      "section role='main'",
      "div class='region-content'",
      "body",
    ]) {
      const tag = wrapper.split(" ")[0];
      const extracted = scraper.extract(
        observation("/", `<title>Guide</title><${wrapper}><p>Plain public prose.</p></${tag}>`).snapshot,
      );
      expect(extracted.kind).toBe("document");
    }
  });

  it("uses the first textual heading rather than an empty decorative heading", () => {
    const result = scraper.extract(
      observation(
        "/",
        '<title>Site title</title><main><h1>&nbsp;</h1><h1><img src="/photo.png"></h1><h1>Programme requirements</h1><p>Complete the required courses.</p></main>',
      ).snapshot,
    );
    expect(result.kind === "document" && result.input.title).toBe("Programme requirements");
    const fallback = scraper.extract(
      observation("/", "<title>Source title</title><main><h1>&nbsp;</h1><p>Public guidance.</p></main>").snapshot,
    );
    expect(fallback.kind === "document" && fallback.input.title).toBe("Source title");
  });

  it("vets only public nonempty homepage HTML and excludes private queries and downloads", () => {
    const valid = observation("/", "<p>Public homepage.</p>").snapshot;
    expect(scraper.vetHomepage(valid).accepted).toBe(true);
    for (const change of [
      { url: "https://other.ubc.ca/" },
      { status: 403 },
      { body: "<script>only()</script>" },
      { headers: { "content-type": "application/json" } },
    ])
      expect(scraper.vetHomepage({ ...valid, ...change }).accepted).toBe(false);
    expect(scraper.documentFormats).toBeUndefined();
    expect(scraper.excludeUrl!(`${home}wp-content/uploads/guide.pdf`)).not.toBeNull();
    expect(scraper.excludeUrl!(`${home}?page_id=12`)).toBeNull();
    for (const path of [
      "admin/guide.pdf",
      "private/guide.pdf",
      "user/login",
      "wp-admin/",
      "guide.pdf?download=1",
      "?filter=all",
    ])
      expect(scraper.excludeUrl!(new URL(path, home).href)).not.toBeNull();
  });

  it.each([
    ["manufacturing.engineering.ubc.ca", "/node/1.md"],
    ["macisaacnursing.ubc.ca", "/node/2421.md"],
    ["mining.ubc.ca", "/node/1.md"],
    ["scarp.ubc.ca", "/node/1.md"],
  ])("keeps former standalone Markdown sources outside active collection for %s", (hostname, target) => {
    const reviewed = createGenericScraper(hostname);
    expect(reviewed.documentFormats).toBeUndefined();
    expect(reviewed.excludeUrl!(`https://${hostname}${target}`)).not.toBeNull();
    expect(createGenericScraper(`other.${hostname}`).documentFormats).toBeUndefined();
  });

  it("guards one exact declared Markdown target without admitting nearby paths", () => {
    const markdownHost = "manufacturing.engineering.ubc.ca";
    const sourceUrl = `https://${markdownHost}/node/1.md`;
    const body = "# Manufacturing guide\n\nExact source body.";
    const title = "Manufacturing guide";
    const document: SearchDocument = {
      id: `documents:official-web:${sha256(sourceUrl).slice(0, 24)}`,
      hostname: markdownHost,
      title,
      source_url: sourceUrl,
      retrieved_at: "2026-01-01T00:00:00.000Z",
      source_modified_at: null,
      snapshot_sha256: sha256("markdown snapshot"),
      input_sha256: sha256("input"),
      body_sha256: sha256(body),
      content_sha256: sha256(`${title}\n${body}`),
      content_markdown: body,
      warnings: [],
      alternate_urls: [],
      producer,
      extraction: {
        format: "markdown",
        source_bytes_sha256: sha256(body),
        source_bytes: Buffer.byteLength(body),
        profile_sha256: sha256("runtime profile"),
        termination: "observed-pid-absence",
        title_origin: { kind: "markdown-body" },
        witnesses: [
          {
            source_url: `https://${markdownHost}/`,
            snapshot_sha256: sha256("homepage snapshot"),
            target_url: sourceUrl,
            channel: "html-head",
            title: null,
          },
        ],
      },
    };
    const completed: CompletedHost = {
      complete: true,
      host: {
        hostname: markdownHost,
        title: markdownHost,
        homepage_url: `https://${markdownHost}/`,
        homepage_retrieved_at: "2026-01-01T00:00:00.000Z",
        homepage_sha256: sha256("homepage snapshot"),
        scope: "Public guidance",
        document_root: `data/documents/${markdownHost}`,
        document_count: 1,
      },
      documents: [document],
    };
    expect(cheapGuardCompletedHost(completed)).toEqual(completed);
    const nearby = structuredClone(completed);
    const nearbyDocument = nearby.documents[0]!;
    nearbyDocument.source_url = `https://${markdownHost}/node/2.md`;
    nearbyDocument.id = `documents:official-web:${sha256(nearbyDocument.source_url).slice(0, 24)}`;
    if (nearbyDocument.extraction?.format !== "markdown") throw new Error("Expected Markdown fixture");
    nearbyDocument.extraction.witnesses[0]!.target_url = nearbyDocument.source_url;
    expect(() => cheapGuardCompletedHost(nearby)).toThrow(/Unsafe completed document URL/);
    const forgedWitness = structuredClone(completed);
    const forgedDocument = forgedWitness.documents[0]!;
    if (forgedDocument.extraction?.format !== "markdown") throw new Error("Expected Markdown fixture");
    forgedDocument.extraction.witnesses[0]!.snapshot_sha256 = sha256("other homepage snapshot");
    expect(() => cheapGuardCompletedHost(forgedWitness)).toThrow(/Unsafe completed document URL/);
  });

  it("closes cached HTML links and deterministically deduplicates only exact title/body with observed aliases", async () => {
    const html =
      "<title>Guide</title><link rel='https://api.w.org/' href='https://other.ubc.ca/wp-json/'><main><p>One source procedure.</p></main><nav><a href='/copy/'>Copy</a></nav>";
    const homepage = observation("/", html);
    const copy = observation("/copy/", html);
    const robots = observation("/robots.txt", "User-agent: *\nDisallow:\n");
    const values = new Map([homepage, copy, robots].map((o) => [o.snapshot.url, o]));
    const archive: HostArchive = {
      hostname: host,
      input_sha256: sha256("inputs"),
      homepage,
      urls: [],
      retained: [],
      read: vi.fn(async (url) => {
        const value = values.get(url);
        if (!value) throw new Error(`Unrecorded ${url}`);
        return value;
      }),
      readSnapshot: async () => {
        throw new Error("No retained observations");
      },
      assertUnchanged: async () => {},
      close() {},
    };
    const collected = await collectRecordedHost(scraper, archive, producer);
    expect(collected.documents).toHaveLength(2);
    const guarded = cheapGuardCompletedHost(collected);
    expect(guarded.host.document_count).toBe(1);
    expect(guarded.documents[0]!.source_url).toBe(home);
    expect(guarded.documents[0]!.alternate_urls).toEqual([`${home}copy/`]);
    expect(
      cheapGuardCompletedHost({
        ...collected,
        documents: [...collected.documents].reverse(),
      }),
    ).toEqual(guarded);
    expect(cheapGuardCompletedHost(guarded)).toEqual(guarded);
    const changedTitle = collected.documents.map((doc, index) =>
      index
        ? doc
        : {
            ...doc,
            title: "Different title",
            content_sha256: sha256(`Different title\n${doc.content_markdown}`),
          },
    );
    expect(cheapGuardCompletedHost({ ...collected, documents: changedTitle }).documents).toHaveLength(2);
    expect(collected.documents.every((doc) => doc.alternate_urls.length === 0)).toBe(true);
    const dated = collected.documents.map((doc, index) => ({
      ...doc,
      source_modified_at: index ? "2012-01-01T00:00:00.000Z" : "2011-01-01T00:00:00.000Z",
    }));
    expect(cheapGuardCompletedHost({ ...collected, documents: dated }).documents).toHaveLength(2);
    for (const patch of [
      { content_markdown: "" },
      { hostname: "other.ubc.ca" },
      { content_markdown: "<script>bad()</script>" },
      { content_sha256: sha256("broken") },
    ])
      expect(() =>
        cheapGuardCompletedHost({
          ...guarded,
          documents: [{ ...guarded.documents[0]!, ...patch }],
        }),
      ).toThrow();
    expect(() =>
      cheapGuardCompletedHost({
        ...guarded,
        documents: [],
        host: { ...guarded.host, document_count: 0 },
      }),
    ).toThrow();
    expect(archive.read).toHaveBeenCalledTimes(3);
  });
});
