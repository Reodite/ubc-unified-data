import { describe, expect, it } from "vitest";
import { parseSitemap } from "./sitemap.ts";

describe("complete sitemap XML", () => {
  it("reads complete URL sets, escaped URLs and extension metadata", () => {
    expect(
      parseSitemap(
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="urn:image"><url><loc>https://example.ubc.ca/?x=1&amp;y=2</loc><lastmod>2026-01-01</lastmod><image:image><image:loc>https://example.ubc.ca/photo.jpg</image:loc></image:image></url></urlset>',
      ),
    ).toEqual({ kind: "pages", locations: ["https://example.ubc.ca/?x=1&y=2"] });
  });
  it("accepts prefixed sitemap indexes and complete empty sets", () => {
    expect(
      parseSitemap(
        '<s:sitemapindex xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9"><s:sitemap><s:loc><![CDATA[https://example.ubc.ca/map.xml]]></s:loc></s:sitemap></s:sitemapindex>',
      ),
    ).toEqual({ kind: "index", locations: ["https://example.ubc.ca/map.xml"] });
    expect(parseSitemap("<urlset/>")).toEqual({ kind: "pages", locations: [] });
  });
  it.each([
    "<urlset><url><loc>https://example.ubc.ca/guide</loc></url>",
    "<urlset><url><loc>https://example.ubc.ca/guide</loc></url></urlset><urlset/>",
    "<wrapper><urlset/></wrapper>",
    "<urlset><ignored><url><loc>https://example.ubc.ca/guide</loc></url></ignored></urlset>",
    "<urlset><url><loc>x</loc><loc>y</loc></url></urlset>",
    "<urlset><url><loc><b>x</b></loc></url></urlset>",
    "<urlset><url><loc>&unknown;</loc></url></urlset>",
    "<urlset><url><loc>x</loc></sitemap></urlset>",
    '<!DOCTYPE urlset SYSTEM "file:///etc/passwd"><urlset/>',
    '<urlset xmlns="urn:wrong"/>',
    "<urlset>Unexpected text</urlset>",
  ])("rejects incomplete or malformed input: %s", (body) => {
    expect(() => parseSitemap(body)).toThrow();
  });
});
