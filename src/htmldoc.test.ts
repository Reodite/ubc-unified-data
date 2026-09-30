import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blocks, items, sections, text, unescapeHtml } from "./htmldoc.ts";

const fixture = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test/fixtures/htmldoc.json"), "utf8"),
) as Array<{
  input: string;
  blocks: Array<["Heading" | "Table", ...unknown[]]>;
  sections: Array<[number, string, string, string[]]>;
  text: string;
}>;

function mineBlocks(html: string): Array<["Heading" | "Table", ...unknown[]]> {
  return blocks(html).map((block) =>
    "level" in block ? ["Heading", block.text, [], []] : ["Table", "", block.headers, block.rows],
  );
}

function mineSections(html: string): Array<[number, string, string, string[]]> {
  return sections(html).map((section) => [section.level, section.heading, section.text, section.items]);
}

describe("htmldoc block, section and text extraction", () => {
  for (const [index, input] of fixture.entries()) {
    it(`case ${index}: ${input.input.slice(0, 70)}`, () => {
      expect(mineBlocks(input.input)).toEqual(input.blocks);
      expect(mineSections(input.input)).toEqual(input.sections);
      expect(text(input.input)).toBe(input.text);
    });
  }
});

describe("complete table admission", () => {
  const unclosed = "<h4>Courses</h4><table><tr><td>Module</td></tr>";

  it("keeps tolerant fragment parsing as the default", () => {
    expect(blocks(unclosed)).toEqual([
      { level: 4, text: "Courses" },
      { headers: [], rows: [["Module"]] },
    ]);
    expect(() => blocks(unclosed, { requireClosedTables: true })).toThrow("Unclosed HTML table");
  });

  it.each([
    "<table><tr><td>Module</td></tr></table>",
    "<table><tr><td>Module</table>",
    '<table title="unrelated > character"><tr><td>Module</td></tr></table>',
    "<table><tr><td>Module</p></td></tr></table>",
  ])("accepts an explicitly closed table with existing HTML tolerance: %s", (html) => {
    expect(blocks(html, { requireClosedTables: true })).toEqual(blocks(html));
  });

  it.each([
    "<!-- </table> -->",
    '<script>const value = "</table>";</script>',
    '<style>.x::after {content: "</table>"}</style>',
    '<div title="</table>">Text</div>',
    "&lt;/table&gt;",
  ])("does not accept closing-tag text as table closure: %s", (decoy) => {
    expect(() => blocks(unclosed + decoy, { requireClosedTables: true })).toThrow("Unclosed HTML table");
  });

  it("requires every opened table to close, including outer nested tables", () => {
    expect(() => blocks("<table><tr><td>Outer<table><tr><td>Inner</table>", { requireClosedTables: true })).toThrow(
      "Unclosed HTML table",
    );
  });
});

describe("items() falls back to prose", () => {
  it("returns list items when present", () => {
    expect(items("<ul><li>one</li><li>two</li></ul>")).toEqual(["one", "two"]);
  });
  it("falls back to the fragment text", () => {
    expect(items("<p>just a sentence</p>")).toEqual(["just a sentence"]);
  });
});

describe("unescapeHtml matches html.unescape", () => {
  it("decodes named and numeric references", () => {
    expect(unescapeHtml("&lt;tag&gt; &copy; &#38; &#x27;")).toBe("<tag> © & '");
  });
  it("keeps unknown names, with the longest-prefix fallback", () => {
    expect(unescapeHtml("&bogus; &ampx &CounterClockwiseContourIntegral; &fjlig;")).toBe("&bogus; &x ∳ fj");
  });
  it("maps invalid and out-of-range numeric references", () => {
    expect(unescapeHtml("&#0; &#13; &#x80; &#xD800; &#x110000; &#x10FFFE;")).toBe("\uFFFD \r \u20ac \uFFFD \uFFFD ");
  });
});
