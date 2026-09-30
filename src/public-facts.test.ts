import { describe, expect, it } from "vitest";
import { assertPublicFacts, factsHash, publicFacts } from "./public-facts.ts";
import { document } from "./source-documents.ts";

const page = document({
  sourceId: "housing_residence",
  upstreamId: "example",
  title: "Example Residence",
  url: "https://vancouver.housing.ubc.ca/residences/example/",
  campus: "vancouver",
  html: "<p>Residence eligibility conditions and application instructions.</p>",
  retrievedAt: "2026-09-10T00:00:00Z",
});

describe("facts-and-links field projection", () => {
  it("selects only allowed factual fields, not fetched prose or HTML", () => {
    const row = publicFacts("housing/residences", {
      ...page,
      beds: 200,
      undergraduate_audience: true,
      quick_facts_text: "Long source description",
      unexpected_field: "unrecognized metadata",
    });
    expect(row).toMatchObject({ id: page.id, title: page.title, beds: 200, undergraduate_audience: true });
    for (const field of [
      "content_html",
      "content_text",
      "content_sha256",
      "quick_facts_text",
      "headings",
      "tables",
      "links",
      "unexpected_field",
    ])
      expect(row).not.toHaveProperty(field);
    expect(row.record_sha256).toBe(factsHash(row));
  });

  it("exports guidance as source indexes, without a copied body", () => {
    const row = publicFacts("student-support/learning_commons_pages", { ...page, upstream_id: 1, slug: "study" });
    expect(row.source_url).toBe(page.source_url);
    expect(row).not.toHaveProperty("content_text");
  });

  it("rejects unexpected fields, nested HTML and long prose-like labels", () => {
    const row = publicFacts("housing/residences", { ...page, beds: 200 });
    expect(() => assertPublicFacts("housing/residences", { ...row, content_text: "copied body" })).toThrow(
      /Unapproved/,
    );
    expect(() => publicFacts("housing/residences", { ...page, front_desk_text: "<p>HTML</p>" })).toThrow(/HTML/);
    expect(() => publicFacts("housing/residences", { ...page, front_desk_text: "word ".repeat(70) })).toThrow(
      /Long text/,
    );
    expect(() => publicFacts("housing/fee_tables", { ...page, values: [{ rendered: "copied markup" }] })).toThrow(
      /Prose field/,
    );
  });

  it("hashes fact fields independently of source text and retrieval time", () => {
    const first = publicFacts("housing/residences", { ...page, beds: 200 });
    const second = publicFacts("housing/residences", {
      ...page,
      beds: 200,
      retrieved_at: "2026-09-11T00:00:00Z",
      content_text: "Different residence eligibility conditions",
    });
    expect(first.record_sha256).toBe(second.record_sha256);
    expect(publicFacts("housing/residences", { ...page, beds: 201 }).record_sha256).not.toBe(first.record_sha256);
    expect(() => assertPublicFacts("housing/residences", { ...first, beds: 201 })).toThrow(/Fact hash/);
  });
});
