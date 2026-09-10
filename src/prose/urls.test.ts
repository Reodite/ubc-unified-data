import { describe, expect, it } from "vitest";
import { toSafeMarkdown } from "./markdown.ts";
import { normalizedHref, secureUbcLink } from "./urls.ts";

describe("source href normalization", () => {
  it("repairs explicit mailboxes and bare hosts without guessing normal relative paths", () => {
    expect(normalizedHref("help@ubc.ca")).toBe("mailto:help@ubc.ca");
    expect(normalizedHref("students.ubc.ca/guide")).toBe("https://students.ubc.ca/guide");
    expect(normalizedHref("www.example.org/resource")).toBe("https://www.example.org/resource");
    expect(normalizedHref("course-planning/guide")).toBe("course-planning/guide");
    expect(normalizedHref("image.ubc.ca.jpg")).toBe("image.ubc.ca.jpg");
  });

  it("keeps repaired links in both Markdown and its link metadata", () => {
    const result = toSafeMarkdown(
      '<p><a href="help@ubc.ca">Contact</a> <a href="students.ubc.ca/guide">Guide</a></p>',
      "https://science.ubc.ca/students/example",
    );
    expect(result.links.map((link) => link.url)).toEqual(["mailto:help@ubc.ca", "https://students.ubc.ca/guide"]);
    expect(result.warnings.join(" ")).toContain("Normalized");
  });

  it("upgrades official legacy HTTP citations without changing the destination path", () => {
    expect(secureUbcLink("http://science.ubc.ca/students?a=1")).toBe("https://science.ubc.ca/students?a=1");
    expect(secureUbcLink("https://outside.example/path")).toBe("https://outside.example/path");
  });
});
