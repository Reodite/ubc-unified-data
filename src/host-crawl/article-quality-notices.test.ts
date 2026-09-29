import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertPublishableArticle } from "./article-quality.ts";

const notices: string[] = JSON.parse(
  readFileSync(new URL("../../test/fixtures/host-crawl/rejected-notices.json", import.meta.url), "utf8"),
);
const source_url = "https://example.ubc.ca/guidance/";

describe("exact unfinished source and access-denial notices", () => {
  it.each(notices)("rejects a complete notice without rewriting it: %s", (notice) => {
    for (const content_markdown of [notice, notice.replaceAll(".", "\\."), `\n**${notice}**\n`]) {
      const document = Object.freeze({ source_url, content_markdown });
      expect(() => assertPublishableArticle(document)).toThrow(/known placeholder/);
      expect(document.content_markdown).toBe(content_markdown);
    }
  });

  it.each(notices)("retains explanatory prose quoting the notice: %s", (notice) => {
    expect(() =>
      assertPublishableArticle({
        source_url,
        content_markdown: `The following message means the source has no public article yet:\n\n${notice}\n\nContact the service desk for help with your account.`,
      }),
    ).not.toThrow();
  });

  it.each([
    "No positions available at this time.",
    "Submission is now closed.",
    "Proposals are now closed.",
    "This is for students registered in the program. Applications close Friday.",
    "The word test identifies a classroom assessment, not a draft page.",
    "Please check back in September.",
  ])("does not impose a generic minimum length or reject useful status prose: %s", (content_markdown) => {
    expect(() => assertPublishableArticle({ source_url, content_markdown })).not.toThrow();
  });
});
