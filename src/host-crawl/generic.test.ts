import { describe, expect, it, vi } from "vitest";
import { toSafeMarkdown } from "../prose/markdown.ts";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, Observation, ProducerContext } from "./contracts.ts";
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
function observation(path: string, body: string): Observation {
  const url = new URL(path, home).href;
  const snapshot = {
    url,
    requested_url: url,
    status: 200,
    headers: { "content-type": "text/html" },
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

  it("vets only public nonempty homepage HTML and preserves private, query and PDF boundaries", () => {
    const valid = observation("/", "<p>Public homepage.</p>").snapshot;
    expect(scraper.vetHomepage(valid).accepted).toBe(true);
    for (const change of [
      { url: "https://other.ubc.ca/" },
      { status: 403 },
      { body: "<script>only()</script>" },
      { headers: { "content-type": "application/json" } },
    ])
      expect(scraper.vetHomepage({ ...valid, ...change }).accepted).toBe(false);
    expect(scraper.documentFormats).toEqual(["pdf"]);
    expect(scraper.excludeUrl!(`${home}wp-content/uploads/guide.pdf`)).toBeNull();
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
