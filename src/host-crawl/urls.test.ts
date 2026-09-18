import { describe, expect, it } from "vitest";
import { documentPageExclusion } from "./urls.ts";

describe("declared public document routes", () => {
  it.each(["/", "/guidance/", "/files/policy.pdf", "/wp-content/uploads/2025/guide.PDF", "/files/guide%2Epdf"])(
    "permits %s",
    (path) => {
      expect(documentPageExclusion(`https://fixture.ubc.ca${path}`, "fixture.ubc.ca", ["pdf"])).toBeNull();
    },
  );
  it.each([
    "https://outside.example/guide.pdf",
    "https://fixture.ubc.ca/admin/guide.pdf",
    "https://fixture.ubc.ca/wp-admin/guide.pdf",
    "https://fixture.ubc.ca/wp-content/themes/guide.pdf",
    "https://fixture.ubc.ca/guide.pdf?token=one",
    "https://fixture.ubc.ca/guide.docx",
    "https://fixture.ubc.ca/wp-content/uploads/%2fadmin/guide.pdf",
    "https://fixture.ubc.ca/wp-content/uploads/../themes/guide.pdf",
  ])("rejects %s", (url) => {
    expect(documentPageExclusion(url, "fixture.ubc.ca", ["pdf"])).not.toBeNull();
  });
  it("requires an explicit PDF adapter", () => {
    expect(documentPageExclusion("https://fixture.ubc.ca/files/guide.pdf", "fixture.ubc.ca", [])).not.toBeNull();
  });
});
