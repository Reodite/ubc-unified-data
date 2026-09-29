import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertPublishableArticle } from "./article-quality.ts";

const templates: Array<{ source_url: string; title: string; body: string }> = JSON.parse(
  readFileSync(new URL("../../test/fixtures/host-crawl/rejected-template-bodies.json", import.meta.url), "utf8"),
);

describe("reviewed unfinished site templates", () => {
  it.each(templates)("rejects the complete source template $source_url", ({ source_url, body }) => {
    const document = Object.freeze({ source_url, content_markdown: body });
    expect(() => assertPublishableArticle(document)).toThrow(/known placeholder/);
    expect(document.content_markdown).toBe(body);
  });

  it.each(templates)("keeps explanatory prose quoting $title", ({ source_url, body }) => {
    expect(() =>
      assertPublishableArticle({
        source_url,
        content_markdown: `This guide explains the sample layout below and how to replace its test content.\n\n${body}`,
      }),
    ).not.toThrow();
  });
});
