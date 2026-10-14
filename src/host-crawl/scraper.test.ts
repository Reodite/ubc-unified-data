import { describe, expect, it, vi } from "vitest";
import type { ArticleInput } from "../prose/model.ts";
import type { Snapshot } from "./contracts.ts";
import { defineHtmlHost, defineWordpressHost } from "./scraper.ts";

const hostname = "example.ubc.ca";
const home = `https://${hostname}/`;
const body = "<title>Student guide</title><main><h1>Student guide</h1><p>Public student guidance.</p></main>";
const snapshot = (changes: Partial<Snapshot> = {}): Snapshot => ({
  requested_url: home,
  url: home,
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  retrieved_at: "2026-01-01T00:00:00.000Z",
  body,
  bytes: Buffer.byteLength(body),
  ...changes,
});
const options = { hostname, title: "Student guide", scope: "Public student guidance", selectors: ["main"] };

describe("shared HTML host lifecycle", () => {
  it("collects a new site from a descriptor without a custom extraction loop", () => {
    const scraper = defineHtmlHost(options);
    expect(scraper.adapter).toEqual({ kind: "html", allowedTypes: [] });
    expect(scraper.vetHomepage(snapshot()).accepted).toBe(true);
    const result = scraper.extract(snapshot());
    expect(result.kind).toBe("document");
    if (result.kind !== "document") throw new Error(result.reason);
    expect(result.input).toMatchObject({ url: home, title: "Student guide", retrievedAt: snapshot().retrieved_at });
    expect(result.input.html).toContain("Public student guidance.");
    expect(result.input.html).not.toContain("<h1>");
  });

  it.each([
    { requested_url: "https://other.ubc.ca/" },
    { url: "https://other.ubc.ca/" },
    { status: 206 },
    { status: 404 },
    { headers: { "content-type": "application/json" } },
    { headers: { "content-type": "text/not-html" } },
    { binary: { media_type: "application/pdf" as const, sha256: "a".repeat(64) } },
    { redirects: [{ url: home, location: "https://other.ubc.ca/", status: 302, snapshot: "a".repeat(64) }] },
  ])("rejects invalid observations before site extraction: %j", (change) => {
    const extractPage = vi.fn();
    const scraper = defineHtmlHost({ ...options, extractPage });
    const value = snapshot(change);
    expect(scraper.vetHomepage(value).accepted).toBe(false);
    expect(() => scraper.extract(value)).toThrow();
    expect(extractPage).not.toHaveBeenCalled();
  });

  it("checks both requested and resolved page policy before extraction", () => {
    const extractPage = vi.fn();
    const scraper = defineHtmlHost({ ...options, extractPage });
    for (const field of ["requested_url", "url"]) {
      expect(scraper.extract(snapshot({ [field]: `${home}wp-admin/` })).kind).toBe("excluded");
    }
    expect(extractPage).not.toHaveBeenCalled();
  });

  it("requires the homepage identity and substantive body by default", () => {
    const scraper = defineHtmlHost(options);
    expect(scraper.vetHomepage(snapshot({ requested_url: `${home}article/` })).accepted).toBe(false);
    expect(scraper.vetHomepage(snapshot({ url: `${home}article/` })).accepted).toBe(false);
    expect(
      scraper.vetHomepage(snapshot({ body: "<body><script>window.title = 'Guide'</script></body>" })).accepted,
    ).toBe(false);
  });

  it("passes the original homepage DOM to site evidence predicates", () => {
    const officialHomepage = vi.fn(($) => $("script[type='application/ld+json']").length === 1);
    const scraper = defineHtmlHost({ ...options, officialHomepage });
    const value = snapshot({ body: `${body}<script type="application/ld+json">{}</script>` });
    expect(scraper.vetHomepage(value).accepted).toBe(true);
    expect(officialHomepage).toHaveBeenCalledTimes(1);
  });

  it("normalizes HTML and exposes the same normalization for API fallback", () => {
    const normalizeArticle = vi.fn((input: ArticleInput) => ({ ...input, title: "Normalized title" }));
    const scraper = defineWordpressHost({ ...options, officialHomepage: () => true, normalizeArticle });
    expect(scraper.normalizeArticle).toBe(normalizeArticle);
    expect(scraper.extract(snapshot())).toMatchObject({ kind: "document", input: { title: "Normalized title" } });
    expect(normalizeArticle).toHaveBeenCalledTimes(1);
  });

  it("shares parsed-page extraction hooks without losing returned metadata", () => {
    const scraper = defineHtmlHost({
      ...options,
      extractPage($, response) {
        expect($("main p").text()).toBe("Public student guidance.");
        return {
          kind: "document",
          input: {
            url: response.url,
            title: "Site title",
            html: $("main").html()!,
            retrievedAt: response.retrieved_at,
            upstreamId: "42",
            warnings: ["Source instructions include an interactive form."],
          },
        };
      },
    });
    expect(scraper.extract(snapshot())).toMatchObject({
      kind: "document",
      input: { upstreamId: "42", warnings: ["Source instructions include an interactive form."] },
    });
  });

  it("does not allow an extraction hook to emit an off-host canonical URL", () => {
    const scraper = defineHtmlHost({
      ...options,
      extractPage: () => ({
        kind: "document",
        input: {
          url: "https://other.ubc.ca/",
          title: "Guide",
          html: "<p>Guide</p>",
          retrievedAt: snapshot().retrieved_at,
        },
      }),
    });
    expect(() => scraper.extract(snapshot())).toThrow("outside the exact HTTPS host scope");
  });

  it("excludes WordPress post indexes and honors site exclusions first", () => {
    const value = snapshot({
      body: "<body class='blog'><main><article class='hentry'>First</article><article class='hentry'>Second</article></main></body>",
    });
    expect(defineWordpressHost({ ...options, officialHomepage: () => true }).extract(value)).toMatchObject({
      kind: "excluded",
      reason: expect.stringContaining("post index"),
    });
    expect(
      defineWordpressHost({ ...options, officialHomepage: () => true, excludePage: () => "Site exclusion" }).extract(
        value,
      ),
    ).toEqual({ kind: "excluded", reason: "Site exclusion" });
  });
});
