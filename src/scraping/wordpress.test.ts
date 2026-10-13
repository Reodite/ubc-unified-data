import { describe, expect, it } from "vitest";
import { Http, InvalidValueError } from "../core/http.ts";
import { wordpressDocument, wordpressPages } from "./wordpress.ts";

function httpFor(handler: (url: URL) => Response): Http {
  const http = new Http({ retries: 0 });
  http.responder = (_method, url) => handler(new URL(url));
  return http;
}

const json = (body: unknown, total: string, pages: string) =>
  new Response(JSON.stringify(body), {
    headers: { "x-wp-total": total, "x-wp-totalpages": pages },
  });

describe("structured WordPress collection policy", () => {
  it.each(["01", "1e0", "+1", "1.0", "0x1"])(
    "accepts Number-compatible headers %s rather than requiring decimal syntax",
    async (header) => {
      const http = httpFor(() => json([{ id: 1 }], header, header));
      expect(await wordpressPages(http, "test.ubc.ca")).toEqual([{ id: 1 }]);
    },
  );

  it.each([
    ["0", "0"],
    ["", ""],
    ["101", "1"],
    ["1.5", "1"],
    ["9007199254740992", "90071992547410"],
  ])("rejects absent, zero or inconsistent first totals %s/%s before parsing rows", async (total, pages) => {
    const http = httpFor(() => json({ errors: [] }, total, pages));
    await expect(wordpressPages(http, "test.ubc.ca")).rejects.toThrow(
      new InvalidValueError("Missing or inconsistent WordPress totals from https://test.ubc.ca/wp-json/wp/v2/pages"),
    );
  });

  it("requires only first-page headers and checks the final identity count", async () => {
    const http = httpFor((url) =>
      url.searchParams.get("page") === "1"
        ? json(
            Array.from({ length: 100 }, (_, id) => ({ id })),
            "101",
            "2",
          )
        : json([{ id: 100 }], "999", "10"),
    );
    expect(await wordpressPages(http, "test.ubc.ca")).toHaveLength(101);
  });

  it("retains lexical identity ordering and caller filters", async () => {
    const http = httpFor((url) => {
      expect(url.searchParams.get("parent")).toBe("48");
      expect(url.searchParams.get("per_page")).toBe("100");
      return json([{ id: 2 }, { id: 10 }], "2", "1");
    });
    expect(await wordpressPages(http, "test.ubc.ca", { parent: 48, per_page: 1 })).toEqual([{ id: 10 }, { id: 2 }]);
  });
});

describe("WordPress document mapping", () => {
  it.each([undefined, "", "0000-00-00T00:00:00", "2026-02-30T12:00:00"])(
    "preserves modification handling without introducing date validation: %s",
    (modified) => {
      const row = {
        id: 7,
        parent: 4,
        slug: "help",
        status: "publish",
        link: "https://test.ubc.ca/help/",
        title: { rendered: "Help &amp; advice" },
        content: { rendered: "<p>Read this.</p>" },
        modified_gmt: modified,
      };
      const result = wordpressDocument(row, "test_source", "test.ubc.ca", null, "retrieved");
      expect(result).toMatchObject({
        id: "test_source:7",
        upstream_id: 7,
        source_id: "test_source",
        parent_id: "test_source:4",
        slug: "help",
        source_url: row.link,
        api_url: "https://test.ubc.ca/wp-json/wp/v2/pages/7",
        title: "Help & advice",
        content_html: "<p>Read this.</p>",
        content_text: "Read this.",
        retrieved_at: "retrieved",
        source_modified_at: modified && modified !== "0000-00-00T00:00:00" ? `${modified}Z` : null,
      });
    },
  );
});
