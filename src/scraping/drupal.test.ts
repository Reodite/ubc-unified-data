import { describe, expect, it } from "vitest";
import { Http, InvalidValueError } from "../core/http.ts";
import { drupalDocument, drupalRecords, richText, unavailableRelationships } from "./drupal.ts";

function httpFor(handler: (url: URL) => unknown): Http {
  const http = new Http({ retries: 0 });
  http.responder = (_method, url) => new Response(JSON.stringify(handler(new URL(url))));
  return http;
}

const node = (id: string) => ({ id, type: "node--page", attributes: { status: true } });

describe("structured Drupal collection policy", () => {
  it("accepts terminal zero totals but refuses permission-filtered intermediate emptiness", async () => {
    expect(
      await drupalRecords(
        httpFor(() => ({ data: [], meta: { count: 0 } })),
        "test.ubc.ca",
        "node/page",
      ),
    ).toEqual([]);
    let calls = 0;
    const http = httpFor(() => {
      calls++;
      return {
        data: [],
        meta: { omitted: { detail: "Permission filtered" } },
        links: { next: "?page%5Boffset%5D=50" },
      };
    });
    await expect(drupalRecords(http, "test.ubc.ca", "node/page")).rejects.toThrow(/Empty intermediate JSON:API page/);
    expect(calls).toBe(1);
  });

  it("follows relative links without requiring increasing offsets or stable later counts", async () => {
    const offsets: string[] = [];
    const http = httpFor((url) => {
      const offset = url.searchParams.get("page[offset]") ?? "0";
      offsets.push(offset);
      if (offset === "0") return { data: [node("a")], meta: { count: 3 }, links: { next: "?page%5Boffset%5D=100" } };
      if (offset === "100")
        return { data: [node("b")], meta: { count: 999 }, links: { next: { href: "?page%5Boffset%5D=50" } } };
      return { data: [node("c")], links: { next: null } };
    });
    expect((await drupalRecords(http, "test.ubc.ca", "node/page")).map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(offsets).toEqual(["0", "100", "50"]);
  });

  it("rejects a same-origin next link to another resource before fetching it", async () => {
    let calls = 0;
    const http = httpFor(() => {
      calls++;
      return { data: [node("a")], links: { next: "/jsonapi/node/private" } };
    });
    await expect(drupalRecords(http, "test.ubc.ca", "node/page")).rejects.toThrow(
      new InvalidValueError("Unsafe or repeated JSON:API pagination link: https://test.ubc.ca/jsonapi/node/private"),
    );
    expect(calls).toBe(1);
  });

  it("rejects a multi-page cycle before requesting a page twice", async () => {
    const seen: string[] = [];
    const http = httpFor((url) => {
      seen.push(url.href);
      return {
        data: [node(String(seen.length))],
        links: { next: seen.length === 1 ? "?page%5Boffset%5D=50" : seen[0] },
      };
    });
    await expect(drupalRecords(http, "test.ubc.ca", "node/page")).rejects.toThrow(/Unsafe or repeated/);
    expect(seen).toHaveLength(2);
  });

  it("ignores string counts but enforces numeric first-page counts", async () => {
    expect(
      await drupalRecords(
        httpFor(() => ({ data: [node("a")], meta: { count: "2" } })),
        "test.ubc.ca",
        "node/page",
      ),
    ).toHaveLength(1);
    await expect(
      drupalRecords(
        httpFor(() => ({ data: [node("a")], meta: { count: 2 } })),
        "test.ubc.ca",
        "node/page",
      ),
    ).rejects.toThrow("JSON:API count mismatch at https://test.ubc.ca/jsonapi/node/page: 1/2");
  });
});

describe("Drupal document mapping", () => {
  it("preserves body precedence, field fragments, unavailable relationships and source timestamps", () => {
    const row = {
      id: "uuid",
      nid: 7,
      status: true,
      title: "Advice",
      changed: { value: "2026-01-01T12:30:00+00:00" },
      body: { processed: "<p>Processed</p>", value: "Raw" },
      field_help: { value: "<p>Help</p>" },
      related: {
        uid: "editor",
        revision_uid: "editor",
        node_type: "page",
        audience: ["students", "missing"],
        campus: "missing",
      },
    };
    expect(richText(row.body)).toBe("<p>Processed</p>");
    expect(richText({ processed: "", value: "Raw" })).toBe("Raw");
    expect(unavailableRelationships(row)).toEqual(["audience", "campus"]);
    expect(
      drupalDocument(row, "source", "test.ubc.ca", "node/page", null, "retrieved", { field_help: "Get help" }),
    ).toMatchObject({
      id: "source:uuid",
      source_id: "source",
      upstream_id: "uuid",
      source_url: "https://test.ubc.ca/node/7",
      api_url: "https://test.ubc.ca/jsonapi/node/page/uuid",
      content_html: "<p>Processed</p>\n<h2>Get help</h2>\n<p>Help</p>",
      source_modified_at: "2026-01-01T12:30:00+00:00",
      retrieved_at: "retrieved",
      related: { audience: ["students", "missing"], campus: "missing" },
      unavailable_relationships: ["audience", "campus"],
    });
  });
});
