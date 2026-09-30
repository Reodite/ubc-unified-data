import { describe, expect, it } from "vitest";
import { Http } from "./base.ts";
import {
  contentLinks,
  document,
  drupalRecords,
  plainText,
  uniqueRows,
  webUrl,
  wordpressDocument,
  wordpressPages,
} from "./source-documents.ts";

const SOURCE = "https://learningcommons.ubc.ca/example/";

function mockHttp(handler: (url: string) => Response): Http {
  const http = new Http({ retries: 0 });
  http.responder = (_method, url) => handler(url);
  return http;
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
}

function node(id: string) {
  return { id, type: "node--service", attributes: { title: id, status: true } };
}

describe("source document normalization", () => {
  it("preserves reading order and separates inline cells and lines", () => {
    expect(
      plainText(
        "<p>Before</p><ul><li>First</li><li>Second</li></ul><p>After</p><table><tr><td>A</td><td>B</td></tr></table>",
      ),
    ).toBe("Before First Second After A B");
    expect(plainText("Canadian<br>Permanent Resident<br>International<script>secret()</script>")).toBe(
      "Canadian Permanent Resident International",
    );
  });

  it("resolves links without allowing executable schemes or credentials", () => {
    expect(
      contentLinks(
        `<a href="/help/">Help</a><a href="/help/">Duplicate</a><a href="#x">Self</a><a href="javascript:alert(1)">Bad</a><a href="mailto:test@ubc.ca">Email</a>`,
        SOURCE,
      ),
    ).toEqual([{ text: "Help", url: "https://learningcommons.ubc.ca/help/" }]);
    expect(webUrl("https://user:password@example.org/", SOURCE)).toBeNull();
    expect(webUrl("data:text/plain,hello", SOURCE)).toBeNull();
  });

  it("separates publication and retrieval timestamps and uses content-based hashes", () => {
    const input = {
      sourceId: "commons",
      upstreamId: 1,
      url: SOURCE,
      campus: "vancouver",
      title: "Study &amp; learn",
      html: "<h2>Advice</h2><p>Read this.</p><script>alert(1)</script><form>Private form</form>",
      modified: "2024-01-01T00:00:00Z",
      retrievedAt: "2026-09-10T00:00:00Z",
    };
    const first = document(input);
    const second = document({ ...input, retrievedAt: "2026-09-11T00:00:00Z" });
    expect(first).toMatchObject({
      id: "commons:1",
      title: "Study & learn",
      source_modified_at: input.modified,
      retrieved_at: input.retrievedAt,
    });
    expect(first.content_text).toBe("Advice Read this.");
    expect(first.content_html).not.toMatch(/script|Private form/);
    expect(first.content_sha256).toBe(second.content_sha256);
    expect(first.content_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("normalizes WordPress GMT timestamps and preserves source and parent identifiers", () => {
    const row = {
      id: 7,
      parent: 4,
      status: "publish",
      slug: "example",
      link: SOURCE,
      title: { rendered: "Study" },
      content: { rendered: "<p>Guidance</p>", protected: false },
      modified_gmt: "2026-01-01T12:30:00",
    };
    expect(
      wordpressDocument(row, "commons", "learningcommons.ubc.ca", "vancouver", "2026-09-10T00:00:00Z"),
    ).toMatchObject({
      id: "commons:7",
      parent_id: "commons:4",
      source_modified_at: "2026-01-01T12:30:00Z",
      api_url: "https://learningcommons.ubc.ca/wp-json/wp/v2/pages/7",
    });
    expect(() =>
      wordpressDocument(
        { ...row, content: { protected: true } },
        "commons",
        "learningcommons.ubc.ca",
        "vancouver",
        "now",
      ),
    ).toThrow(/Non-public/);
    expect(() =>
      wordpressDocument(
        { ...row, link: "https://example.org/x" },
        "commons",
        "learningcommons.ubc.ca",
        "vancouver",
        "now",
      ),
    ).toThrow(/host/);
  });

  it("rejects duplicate or missing ids rather than silently losing records", () => {
    expect(() => uniqueRows([{ id: 1 }, { id: 1 }], SOURCE)).toThrow(/Duplicate/);
    expect(() => uniqueRows([{}], SOURCE)).toThrow(/Missing/);
  });
});

describe("complete WordPress collections", () => {
  it("fetches all pages in stable order and verifies the total", async () => {
    const calls: number[] = [];
    const http = mockHttp((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      calls.push(page);
      expect(new URL(url).searchParams.get("orderby")).toBe("id");
      const rows = page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }];
      return json(rows, { "x-wp-total": "101", "x-wp-totalpages": "2" });
    });
    expect(await wordpressPages(http, "learningcommons.ubc.ca")).toHaveLength(101);
    expect(calls).toEqual([1, 2]);
  });

  it("rejects absent totals, incomplete pages, duplicate records and error-shaped payloads", async () => {
    await expect(
      wordpressPages(
        mockHttp(() => json([{ id: 1 }])),
        "learningcommons.ubc.ca",
      ),
    ).rejects.toThrow(/totals/);
    await expect(
      wordpressPages(
        mockHttp(() => json([{ id: 1 }], { "x-wp-total": "2", "x-wp-totalpages": "1" })),
        "learningcommons.ubc.ca",
      ),
    ).rejects.toThrow(/mismatch/);
    await expect(
      wordpressPages(
        mockHttp(() => json([{ id: 1 }, { id: 1 }], { "x-wp-total": "2", "x-wp-totalpages": "1" })),
        "learningcommons.ubc.ca",
      ),
    ).rejects.toThrow(/Duplicate/);
    await expect(
      wordpressPages(
        mockHttp(() => json({ error: "Blocked" }, { "x-wp-total": "1", "x-wp-totalpages": "1" })),
        "learningcommons.ubc.ca",
      ),
    ).rejects.toThrow(/record array/);
  });

  it("propagates a later-page failure instead of returning partial data", async () => {
    const http = mockHttp((url) =>
      new URL(url).searchParams.get("page") === "1"
        ? json(
            Array.from({ length: 100 }, (_, id) => ({ id })),
            { "x-wp-total": "101", "x-wp-totalpages": "2" },
          )
        : new Response("Denied", { status: 403 }),
    );
    await expect(wordpressPages(http, "learningcommons.ubc.ca")).rejects.toThrow(/403/);
  });
});

describe("complete Drupal collections", () => {
  const next = "https://it.ubc.ca/jsonapi/node/service?page%5Boffset%5D=50";
  it("follows pagination and preserves native UUIDs", async () => {
    const http = mockHttp((url) =>
      url === next
        ? json({ data: [node("b")], links: {} })
        : json({ data: [node("a")], links: { next: { href: next } }, meta: { count: 2 } }),
    );
    expect((await drupalRecords(http, "it.ubc.ca", "node/service")).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("supports JSON:API string links and rejects malformed next links", async () => {
    const http = mockHttp((url) =>
      url === next ? json({ data: [node("b")], links: {} }) : json({ data: [node("a")], links: { next } }),
    );
    expect(await drupalRecords(http, "it.ubc.ca", "node/service")).toHaveLength(2);
    await expect(
      drupalRecords(
        mockHttp(() => json({ data: [node("a")], links: { next: {} } })),
        "it.ubc.ca",
        "node/service",
      ),
    ).rejects.toThrow(/Invalid JSON:API next/);
  });

  it("rejects pagination cycles, cross-origin links and empty intermediate pages", async () => {
    const cycle = mockHttp((url) => json({ data: [node("a")], links: { next: { href: url } } }));
    await expect(drupalRecords(cycle, "it.ubc.ca", "node/service")).rejects.toThrow(/repeated/);
    const cross = mockHttp(() => json({ data: [node("a")], links: { next: { href: "https://example.org/private" } } }));
    await expect(drupalRecords(cross, "it.ubc.ca", "node/service")).rejects.toThrow(/Unsafe/);
    const empty = mockHttp(() => json({ data: [], links: { next: { href: next } } }));
    await expect(drupalRecords(empty, "it.ubc.ca", "node/service")).rejects.toThrow(/Empty intermediate/);
  });

  it("rejects missing arrays and mismatched advertised counts", async () => {
    await expect(
      drupalRecords(
        mockHttp(() => json({ errors: [] })),
        "it.ubc.ca",
        "node/service",
      ),
    ).rejects.toThrow(/record array/);
    await expect(
      drupalRecords(
        mockHttp(() => json({ data: [node("a")], meta: { count: 2 } })),
        "it.ubc.ca",
        "node/service",
      ),
    ).rejects.toThrow(/mismatch/);
  });
});
