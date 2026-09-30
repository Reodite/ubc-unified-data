import { describe, expect, it } from "vitest";
import { ProseClient } from "./client.ts";
import { collectLiveSource } from "./collect.ts";
import type { ProseSource } from "./model.ts";

const source: ProseSource = {
  key: "example",
  title: "Public student guidance",
  host: "example.ubc.ca",
  campus: "vancouver",
  strategy: "sitemap",
  sitemaps: ["https://example.ubc.ca/sitemap.xml"],
  selectors: ["main"],
  scope: (url) => (new URL(url).pathname.startsWith("/staff/") ? "Staff-only section." : null),
};
function client(handler: (url: URL) => Response): ProseClient {
  return new ProseClient({
    minInterval: 0,
    retries: 0,
    fetcher: (async (input) => {
      const url = new URL(String(input));
      return url.pathname === "/robots.txt" ? new Response("") : handler(url);
    }) as typeof fetch,
  });
}
const page = (title: string, body: string, canonical?: string) =>
  new Response(
    `<html><head><title>${title}</title>${canonical ? `<link rel="canonical" href="${canonical}">` : ""}</head><body><main><h1>${title}</h1>${body}</main></body></html>`,
  );

describe("exhaustive article collection", () => {
  it("follows articles missing from the sitemap and records scope exclusions", async () => {
    const requested: string[] = [];
    const result = await collectLiveSource(
      source,
      client((url) => {
        requested.push(url.pathname);
        if (url.pathname === "/sitemap.xml")
          return new Response(
            `<urlset><url><loc>https://example.ubc.ca/first</loc></url><url><loc>https://example.ubc.ca/staff/private</loc></url></urlset>`,
          );
        if (url.pathname === "/first")
          return page("First", '<p>Full explanation.</p><a href="/second">Second guide</a>');
        if (url.pathname === "/second")
          return page("Second", '<p>Additional conditions.</p><a href="/first">Earlier guide</a>');
        throw new Error(`Unexpected URL: ${url.href}`);
      }),
    );
    expect(result.discoveryErrors).toEqual([]);
    expect(result.articles).toHaveLength(2);
    expect(result.inventory).toHaveLength(3);
    expect(result.inventory.find((entry) => entry.url.includes("/staff/"))?.status).toBe("excluded");
    expect(requested).not.toContain("/staff/private");
  });

  it("records an inaccessible URL instead of dropping it", async () => {
    const result = await collectLiveSource(
      source,
      client((url) => {
        if (url.pathname === "/sitemap.xml")
          return new Response(`<urlset><url><loc>https://example.ubc.ca/missing</loc></url></urlset>`);
        return new Response(null, { status: 404 });
      }),
    );
    expect(result.articles).toEqual([]);
    expect(result.inventory).toEqual([
      expect.objectContaining({ status: "unavailable", http_status: 404, reason: expect.stringContaining("404") }),
    ]);
  });

  it("deduplicates canonical aliases without losing inventory provenance", async () => {
    const result = await collectLiveSource(
      source,
      client((url) => {
        if (url.pathname === "/sitemap.xml")
          return new Response(
            `<urlset><url><loc>https://example.ubc.ca/alias</loc></url><url><loc>https://example.ubc.ca/canonical</loc></url></urlset>`,
          );
        return page("Guide", "<p>Same canonical instructions.</p>", "https://example.ubc.ca/canonical");
      }),
    );
    expect(result.articles).toHaveLength(1);
    expect(result.inventory.map((entry) => entry.status)).toEqual(["collected", "duplicate"]);
    expect(result.inventory[0]!.article_id).toBe(result.inventory[1]!.article_id);
  });

  it("keeps processing after a source parser failure and marks that URL failed", async () => {
    const result = await collectLiveSource(
      source,
      client((url) => {
        if (url.pathname === "/sitemap.xml")
          return new Response(
            `<urlset><url><loc>https://example.ubc.ca/broken</loc></url><url><loc>https://example.ubc.ca/good</loc></url></urlset>`,
          );
        return url.pathname === "/broken"
          ? new Response("<title>Missing template</title><div>No recognized container</div>")
          : page("Good", "<p>Usable public instructions.</p>");
      }),
    );
    expect(result.articles).toHaveLength(1);
    expect(result.inventory.find((entry) => entry.url.endsWith("broken"))?.status).toBe("failed");
    expect(result.inventory.find((entry) => entry.url.endsWith("good"))?.status).toBe("collected");
  });
});
