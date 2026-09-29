import { describe, expect, it } from "vitest";
import { fixture, markdownDocument, origin, producer } from "./collect-markdown-test-fixture.ts";
import { collectRecordedHost } from "./collect.ts";
import { withMarkdownCollectionRuntime } from "./markdown-collection-runtime.ts";

describe("exact witnessed Markdown collection", () => {
  it("carries real authenticated runtime links into bounded collector traversal", async () => {
    const f = fixture();
    const bytes = Buffer.from("# Body heading\n\n[Program details](/program).", "utf8");
    f.target.snapshot.body = bytes.toString("utf8");
    f.target.snapshot.bytes = bytes.length;
    f.refresh(f.target);
    f.setReceipt(bytes);
    f.put(
      `${origin}/program`,
      "<html><body><main><h1>Program details</h1><p>Academic requirements.</p></main></body></html>",
      "text/html; charset=utf-8",
    );
    const result = await withMarkdownCollectionRuntime(true, async (markdown) => {
      if (!markdown) throw new Error("Missing real Markdown runtime");
      return collectRecordedHost(f.scraper, f.archive, producer, { markdown });
    });
    const document = markdownDocument(result.value);
    expect(result.value.documents.map((candidate) => candidate.source_url)).toContain(`${origin}/program`);
    expect(document.extraction.profile_sha256).toBe(result.profile_sha256);
    expect(document.content_markdown).toBe(bytes.toString("utf8"));
    expect(f.archive.read).toHaveBeenCalledWith(`${origin}/program`);
  }, 180_000);
});
