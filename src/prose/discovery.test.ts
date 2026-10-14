import { describe, expect, it } from "vitest";
import { ProseClient } from "./client.ts";
import { discoverDrupal, discoverSitemaps, discoverWordpress, wordpressPayload } from "./discovery.ts";
import type { ProseSource } from "./model.ts";

const source: ProseSource = {
  key: "test",
  title: "Student articles",
  host: "test.ubc.ca",
  campus: "vancouver",
  strategy: "wordpress",
  scope: () => null,
};
const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
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
function page(id: number) {
  return {
    id,
    link: `https://test.ubc.ca/students/${id}/`,
    title: { rendered: `Article ${id}` },
    content: { rendered: `<p>Instructions ${id}</p>`, protected: false },
    status: "publish",
    modified_gmt: "2026-01-01T00:00:00",
  };
}
function node(id: number) {
  return {
    id: `uuid-${id}`,
    type: "node--ubc_page",
    attributes: {
      drupal_internal__nid: id,
      title: `Article ${id}`,
      path: { alias: `/students/${id}` },
      changed: "2026-01-01T00:00:00Z",
      status: true,
    },
  };
}

describe("complete prose inventories", () => {
  it("exhausts WordPress totals without a sample cap", async () => {
    const calls: string[] = [];
    const c = client((url) => {
      calls.push(url.href);
      if (url.pathname.endsWith("/types")) return json({ page: { rest_base: "pages" } });
      const number = Number(url.searchParams.get("page"));
      const rows = Array.from({ length: number === 1 ? 100 : 23 }, (_, index) => page((number - 1) * 100 + index + 1));
      return json(rows, { "x-wp-total": "123", "x-wp-totalpages": "2" });
    });
    const result = await discoverWordpress(source, c);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(123);
    expect(calls).toHaveLength(3);
  });

  it("recovers a fully parsed JSON suffix after erroneous theme output", () => {
    const result = wordpressPayload(
      '<!DOCTYPE html><title>Theme output</title><script>const unrelated = [{"id":999}];</script>' +
        JSON.stringify([page(1)]),
    );
    expect(result.discardedPrefix).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as { id: number }).id).toBe(1);
    expect(() => wordpressPayload('<!DOCTYPE html><script>const partial = [{"id":999}];</script>')).toThrow(
      "no complete JSON",
    );
  });

  it("resolves relative permalinks and retains external references for scope exclusion", async () => {
    const result = await discoverWordpress(
      source,
      client((url) =>
        url.pathname.endsWith("/types")
          ? json({ page: { rest_base: "pages" } })
          : json(
              [
                { ...page(1), link: "/students/relative" },
                { ...page(2), link: "https://outside.example/article" },
              ],
              { "x-wp-total": "2", "x-wp-totalpages": "1" },
            ),
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.entries.map((entry) => entry.url)).toContain("https://test.ubc.ca/students/relative");
    expect(result.entries.map((entry) => entry.url)).toContain("https://outside.example/article");
  });

  it("accepts an advertised empty WordPress content type", async () => {
    const result = await discoverWordpress(
      source,
      client((url) =>
        url.pathname.endsWith("/types")
          ? json({ post: { rest_base: "posts" } })
          : json([], { "x-wp-total": "0", "x-wp-totalpages": "0" }),
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  it.each(["01", "1e0", "+1", "1.0", "0x1"])("retains Number-compatible prose totals %s", async (header) => {
    const result = await discoverWordpress(
      source,
      client((url) =>
        url.pathname.endsWith("/types")
          ? json({ page: { rest_base: "pages" } })
          : json([page(1)], { "x-wp-total": header, "x-wp-totalpages": header }),
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it("distinguishes present empty headers from absent prose totals", async () => {
    const run = (headers: Record<string, string>) =>
      discoverWordpress(
        source,
        client((url) => (url.pathname.endsWith("/types") ? json({ page: { rest_base: "pages" } }) : json([], headers))),
      );
    expect((await run({ "x-wp-total": "", "x-wp-totalpages": "" })).errors).toEqual([]);
    expect((await run({})).errors.join(" ")).toContain("Missing/changing WordPress totals");
  });

  it("stops before requesting a third WordPress page after inconsistent second-page totals", async () => {
    const calls: number[] = [];
    const result = await discoverWordpress(
      source,
      client((url) => {
        if (url.pathname.endsWith("/types")) return json({ page: { rest_base: "pages" } });
        const number = Number(url.searchParams.get("page"));
        calls.push(number);
        return json(
          Array.from({ length: 100 }, (_, id) => page((number - 1) * 100 + id)),
          {
            "x-wp-total": "201",
            "x-wp-totalpages": number === 1 ? "3" : "2",
          },
        );
      }),
    );
    expect(result.errors.join(" ")).toContain("Missing/changing WordPress totals");
    expect(calls).toEqual([1, 2]);
    expect(result.entries).toHaveLength(100);
    expect(result.inventories).toHaveLength(1);
  });

  it("validates consumed WordPress identities before requesting the next page", async () => {
    const calls: number[] = [];
    const result = await discoverWordpress(
      source,
      client((url) => {
        if (url.pathname.endsWith("/types")) return json({ page: { rest_base: "pages" } });
        calls.push(Number(url.searchParams.get("page")));
        return json([page(1), page(1)], { "x-wp-total": "101", "x-wp-totalpages": "2" });
      }),
    );
    expect(result.errors.join(" ")).toContain("Duplicate WordPress page id 1");
    expect(calls).toEqual([1]);
  });

  it("reports unexposed placeholders without constructing private record URLs", async () => {
    const urls: string[] = [];
    const result = await discoverWordpress(
      source,
      client((url) => {
        urls.push(url.href);
        return url.pathname.endsWith("/types")
          ? json({ page: { rest_base: "pages" } })
          : json([page(1), []], { "x-wp-total": "2", "x-wp-totalpages": "1" });
      }),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.notes.join(" ")).toContain("1 unexposed placeholders");
    expect(urls).toHaveLength(2);
  });

  it("fails changed WordPress counts instead of reporting complete coverage", async () => {
    const result = await discoverWordpress(
      source,
      client((url) => {
        if (url.pathname.endsWith("/types")) return json({ page: { rest_base: "pages" } });
        return url.searchParams.get("page") === "1"
          ? json(
              Array.from({ length: 100 }, (_, index) => page(index)),
              { "x-wp-total": "101", "x-wp-totalpages": "2" },
            )
          : json([page(101)], { "x-wp-total": "102", "x-wp-totalpages": "2" });
      }),
    );
    expect(result.errors.join(" ")).toContain("changing WordPress totals");
  });

  it("walks nested sitemaps and deduplicates overlapping article URLs", async () => {
    const c = client((url) => {
      if (url.pathname === "/sitemap.xml")
        return new Response(
          `<sitemapindex><sitemap><loc>https://test.ubc.ca/a.xml</loc></sitemap><sitemap><loc>https://test.ubc.ca/b.xml</loc></sitemap></sitemapindex>`,
        );
      return new Response(
        `<urlset><url><loc>https://test.ubc.ca/students/one/</loc><lastmod>2026-01-01</lastmod></url></urlset>`,
      );
    });
    const result = await discoverSitemaps({ ...source, sitemaps: ["https://test.ubc.ca/sitemap.xml"] }, c);
    expect(result.errors).toEqual([]);
    expect(result.inventories).toHaveLength(3);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.discoveredBy).toHaveLength(2);
  });

  it("continues through an empty permission-filtered Drupal batch", async () => {
    const offsets: number[] = [];
    const result = await discoverDrupal(
      { ...source, strategy: "drupal", drupalTypes: ["ubc_page"] },
      client((url) => {
        if (url.pathname === "/jsonapi")
          return json({ data: [], links: { "node--ubc_page": { href: "https://test.ubc.ca/jsonapi/node/ubc_page" } } });
        const offset = Number(url.searchParams.get("page[offset]") ?? 0);
        offsets.push(offset);
        const next = new URL(url);
        next.searchParams.set("page[offset]", String(offset + 50));
        return json({
          data: offset === 50 ? [] : [node(offset + 1)],
          meta: offset === 50 ? { omitted: { detail: "Unpublished resources were omitted." } } : {},
          links: offset < 100 ? { next: { href: next.href } } : {},
        });
      }),
    );
    expect(result.errors).toEqual([]);
    expect(offsets).toEqual([0, 50, 100]);
    expect(result.entries).toHaveLength(2);
  });

  it("rejects an empty Drupal cursor that changes spelling but does not advance", async () => {
    let batches = 0;
    const result = await discoverDrupal(
      { ...source, strategy: "drupal", drupalTypes: ["ubc_page"] },
      client((url) => {
        if (url.pathname === "/jsonapi") return json({ links: { "node--ubc_page": {} } });
        batches++;
        const next = new URL(url);
        next.searchParams.set("page[offset]", "0");
        next.searchParams.set("extra", "different-spelling");
        return json({ data: [], links: { next: { href: next.href } } });
      }),
    );
    expect(result.errors.join(" ")).toContain("Unsafe or cyclic");
    expect(batches).toBe(1);
  });

  it("rejects a Drupal cycle before requesting an earlier page twice", async () => {
    const calls: string[] = [];
    const result = await discoverDrupal(
      { ...source, strategy: "drupal", drupalTypes: ["ubc_page"] },
      client((url) => {
        if (url.pathname === "/jsonapi") return json({ links: { "node--ubc_page": {} } });
        calls.push(url.href);
        return json({
          data: [node(calls.length)],
          links: { next: calls.length === 1 ? "?page%5Boffset%5D=50" : calls[0] },
        });
      }),
    );
    expect(result.errors.join(" ")).toContain("Unsafe or cyclic JSON:API next link");
    expect(calls).toHaveLength(2);
  });

  it("accepts Number-compatible increasing Drupal offsets but rejects malformed next envelopes", async () => {
    const run = (next: unknown) =>
      discoverDrupal(
        { ...source, strategy: "drupal", drupalTypes: ["ubc_page"] },
        client((url) => {
          if (url.pathname === "/jsonapi") return json({ links: { "node--ubc_page": {} } });
          return url.searchParams.has("page[offset]")
            ? json({ data: [node(2)] })
            : json({ data: [node(1)], links: { next } });
        }),
      );
    const result = await run("?page%5Boffset%5D=5e1");
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(2);
    expect((await run({})).errors.join(" ")).toContain("Invalid JSON:API next link:");
  });

  it("rejects Drupal next links that leave the requested collection", async () => {
    let records = 0;
    const result = await discoverDrupal(
      { ...source, strategy: "drupal", drupalTypes: ["ubc_page"] },
      client((url) => {
        if (url.pathname === "/jsonapi") return json({ links: { "node--ubc_page": {} } });
        records++;
        return json({
          data: [node(1)],
          links: { next: { href: "https://other.ubc.ca/jsonapi/node/ubc_page?page%5Boffset%5D=50" } },
        });
      }),
    );
    expect(result.errors.join(" ")).toContain("Unsafe or cyclic");
    expect(records).toBe(1);
  });
});
