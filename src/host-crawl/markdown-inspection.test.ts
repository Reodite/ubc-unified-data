import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertSafeMarkdown } from "../prose/markdown.ts";
import { safeText } from "./document-format.ts";
import {
  inspectMarkdownSource,
  MARKDOWN_INSPECTION_LIMITS as LIMITS,
  MARKDOWN_INSPECTION_DIALECT,
} from "./markdown-inspection.mjs";

const bytes = (source: string) => new TextEncoder().encode(source);
const inspect = (source: string, titles: readonly (string | null)[] = ["Advertisement"]) =>
  inspectMarkdownSource(bytes(source), titles);
const rejects = (source: string, reason: string) => expect(() => inspect(source)).toThrow(reason);
const fetchGuard = vi.fn(() => {
  throw new Error("Network is forbidden in inspector tests.");
});

beforeAll(() => vi.stubGlobal("fetch", fetchGuard));
afterAll(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("restricted Markdown metadata", () => {
  it("declares immutable versioned bounds", () => {
    expect(LIMITS).toEqual({
      inputBytes: 1048576,
      lineBytes: 16384,
      lines: 16384,
      tokens: 50000,
      links: 2048,
      nesting: 32,
      titleBytes: 4096,
      metadataBytes: 262144,
      advertisedTitles: 6,
      advertisedTitleCodeUnits: 4096,
    });
    expect(Object.isFrozen(LIMITS)).toBe(true);
    expect(MARKDOWN_INSPECTION_DIALECT).toBe("ubc-markdown-verbatim-v1/markdown-it-15.0.2");
  });

  it("keeps source authority and returns only deeply frozen metadata", () => {
    const source = "# Native  *heading* `code` [label](https://example.org/a)\r\n\r\nBody.\r";
    const input = bytes(source);
    const original = input.slice();
    const result = inspectMarkdownSource(input, ["Not the title"]);
    expect(result).toMatchObject({
      source_bytes: input.length,
      source_bytes_sha256: createHash("sha256").update(original).digest("hex"),
      title: "Native  heading code label",
      title_origin: { kind: "markdown-body" },
      links: [{ text: "label", url: "https://example.org/a" }],
    });
    expect(Object.keys(result)).toEqual([
      "source_bytes",
      "source_bytes_sha256",
      "title",
      "title_origin",
      "links",
      "stats",
    ]);
    expect(Object.keys(result.stats)).toEqual(["emitted_tokens", "links", "max_depth"]);
    for (const value of [result, result.title_origin, result.links, result.links[0], result.stats]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(input).toEqual(original);
    input.fill(0);
    expect(result.source_bytes_sha256).toBe(createHash("sha256").update(original).digest("hex"));
  });

  it.each([
    ["# ATX\n\nParagraph", "ATX"],
    ["Setext\n======\n\nParagraph", "Setext"],
    ["First  part\nsecond\\\nthird\n====", "First  part second third"],
    ["# **Bold** &amp; \\[literal\\]", "Bold & [literal]"],
    ["# ` a` and `b `", " a and b "],
  ])("flattens the native H1 without collapsing internal spaces: %s", (source, title) => {
    expect(inspect(source).title).toBe(title.trim().replace(/^ +| +$/g, ""));
  });

  it("accepts all supported blocks, inline formatting and inert code", () => {
    const result = inspect(
      "# Title\n\n## Subheading\n\nText *em* **strong** ***both*** _em_ __strong__.\n" +
        "Soft break  \nHard break\\\nBackslash break. $5 ~single~ : (parenthesis)\n\n" +
        "> Quote\n>\n> - nested bullet\n\n- one\n- two\n\n3. three\n4. four\n\n***\n\n" +
        "`<script>[]{}|:::$$~~ &Tab; javascript:x`\n\n```\n  <script>\t [x](javascript:x)\n```\n",
    );
    expect(result.title).toBe("Title");
    expect(result.links).toEqual([]);
    expect(result.stats.max_depth).toBeGreaterThan(1);
  });

  it("retains citation labels and pair order without collapsing whitespace", () => {
    const result = inspect(
      "[a  *b* `c`\nd](https://example.org/a) " +
        "[a  *b* `c`\nd](https://example.org/a) " +
        "[different](https://example.org/a) [a](https://example.org/b)",
    );
    expect(result.links).toEqual([
      { text: "a  b c d", url: "https://example.org/a" },
      { text: "different", url: "https://example.org/a" },
      { text: "a", url: "https://example.org/b" },
    ]);
    expect(result.stats.links).toBe(4);
  });

  it("does not turn plain URLs, email, escaped HTML or entity syntax into citations", () => {
    expect(inspect("www.example.org user@example.org https://example.org \\<b> &lt;i&gt;").links).toEqual([]);
  });

  it("uses literal advertisement values and their original witness indexes", () => {
    expect(inspect("Body", [null, "", "  Literal *title*  ", "  Literal *title*  "])).toMatchObject({
      title: "  Literal *title*  ",
      title_origin: { kind: "advertisement", witness_index: 2 },
    });
    expect(inspect("> # Nested heading\n\nBody", ["Fallback"]).title_origin).toEqual({
      kind: "advertisement",
      witness_index: 0,
    });
  });

  it.each([
    ["# One\n\n# Two", "multiple root H1"],
    ["#\n\nBody", "empty title"],
    ["# &#32;\n\nBody", "empty title"],
    ["# tab\ttitle", "unsafe title"],
  ])("never substitutes fallback for an invalid H1: %s", (source, reason) => rejects(source, reason));

  it.each(["# Type `<T>`\n\nBody", "# &lt;Title&gt;\n\nBody"])(
    "rejects native titles incompatible with published metadata: %s",
    (source) => rejects(source, "unsafe title"),
  );

  it("rejects unsafe literal fallback titles without rewriting them", () => {
    for (const title of ["Type <T>", "Less < more", "More > less"]) {
      expect(() => inspect("Body", [title])).toThrow("unsafe title");
    }
  });

  it("validates advertisement evidence even when a native H1 supplies the title", () => {
    expect(() => inspect("# Native\n\nBody", ["A", "B"])).toThrow("conflicting advertisement titles");
    for (const title of ["bad\nlabel", "bad\u202elabel", "bad\ufffdlabel"]) {
      expect(() => inspect("# Native\n\nBody", [title])).toThrow("unsafe title in advertisement");
    }
    expect(inspect("# Native\n\nBody", ["<literal unused hint>"]).title).toBe("Native");
  });

  it("bounds all advertisement title inputs in source-witness code units", () => {
    expect(() => inspect("# Native\n\nBody", ["x".repeat(4097)])).toThrow("advertisement title limit");
    expect(inspect("# Native\n\nBody", ["界".repeat(4096)]).title).toBe("Native");
    expect(() => inspect("Body", ["界".repeat(4096)])).toThrow("title byte limit");
  });

  it("rejects absent, conflicting and unsafe fallback values", () => {
    expect(() => inspect("Body", [null, ""])).toThrow("missing title");
    expect(() => inspect("Body", ["A", "B"])).toThrow("conflicting advertisement titles");
    expect(() => inspect("Body", [" "])).toThrow("empty title");
    for (const title of ["x\ty", "x\ny", "x\u202ey", "x\ufffdy", "x\ud800y"]) {
      expect(() => inspect("Body", [title])).toThrow("unsafe title");
    }
    expect(() => inspect("Body", Array(7).fill("A"))).toThrow("advertisement limit");
    expect(inspect("Body", Array(6).fill("A")).title).toBe("A");
  });
});

describe("encoding and source limits", () => {
  it("requires a nonshared Uint8Array and typed advertisement array", () => {
    expect(() => inspectMarkdownSource("Body" as unknown as Uint8Array, [])).toThrow("byte input");
    expect(() => inspectMarkdownSource(new Uint8Array(new SharedArrayBuffer(8)), [])).toThrow("shared buffer");
    expect(() => inspectMarkdownSource(bytes("Body"), [7] as unknown as string[])).toThrow("advertisement input");
    expect(() => inspectMarkdownSource(bytes("Body"), null as unknown as string[])).toThrow("advertisement input");
    const backing = bytes("prefixBodytrailer");
    expect(inspectMarkdownSource(backing.subarray(6, 10), ["T"]).source_bytes).toBe(4);
    expect(inspectMarkdownSource(Buffer.from("Body"), ["T"]).source_bytes).toBe(4);
  });

  it.each([
    [[], "empty source"],
    [[0xef, 0xbb, 0xbf, 65], "BOM"],
    [[0xc3, 0x28], "UTF-8"],
    [[0xed, 0xa0, 0x80], "UTF-8"],
    [[0xff], "UTF-8"],
  ])("rejects exact invalid byte sequences %s", (value, reason) => {
    expect(() => inspectMarkdownSource(Uint8Array.from(value), ["T"])).toThrow(reason);
  });

  it.each(["\0", "\u0001", "\u000b", "\u000c", "\u007f", "\u0085", "\u200b", "\u202e", "\ufeff", "\ufffd"])(
    "rejects raw unsafe character %j even inside code",
    (character) => rejects(`\`a${character}b\``, "unsafe source character"),
  );

  it("allows raw source tabs and line endings outside metadata titles", () => {
    expect(inspect("a\tb\r\nc\rd\ne").title).toBe("Advertisement");
  });

  it("enforces byte limits before parsing without truncation", () => {
    const line = `${"x".repeat(8191)}\n`;
    const exact = line.repeat(128);
    expect(bytes(exact).length).toBe(LIMITS.inputBytes);
    expect(inspect(exact).source_bytes).toBe(LIMITS.inputBytes);
    rejects(`${exact}x`, "input byte limit");
  });

  it("counts UTF-8 bytes per line, treating CRLF and CR as line endings", () => {
    expect(inspect("é".repeat(8192)).source_bytes).toBe(LIMITS.lineBytes);
    rejects(`${"é".repeat(8192)}x`, "line byte limit");
    expect(inspect(`${"x".repeat(16384)}\r\n${"y".repeat(16384)}`).source_bytes).toBe(32770);
    expect(inspect(`${"x".repeat(16384)}\r${"y".repeat(16384)}`).source_bytes).toBe(32769);
  });

  it("counts physical lines without inventing a trailing empty line", () => {
    const exact = "x\n".repeat(LIMITS.lines);
    expect(inspect(exact).source_bytes).toBe(exact.length);
    rejects(`${exact}x`, "line count limit");
  });

  it("checks title UTF-8 bytes at the threshold", () => {
    expect(inspect(`# ${"é".repeat(2048)}`).title.length).toBe(2048);
    rejects(`# ${"é".repeat(2048)}x`, "title byte limit");
    expect(inspect("Body", ["é".repeat(2048)]).title.length).toBe(2048);
    expect(() => inspect("Body", [`${"é".repeat(2048)}x`])).toThrow("title byte limit");
  });
});

describe("unsupported syntax remains a whole-source failure", () => {
  it.each([
    ["Body\n\n[unused]: https://example.org/", "reference definitions"],
    ["Body\n\n[unused]: javascript:evil", "link destination"],
    ["[a][ref]\n\n[ref]: https://example.org/\n[ref]: https://example.org/other", "reference definitions"],
    ["[undefined][ref]", "residual syntax"],
    ["[shortcut]", "residual syntax"],
    ["[broken](https://example.org/", "residual syntax"],
    ['[x](https://example.org/ "bad)', "residual syntax"],
    ["a | b\n--- | ---\nx | y | <script>SENTINEL</script>", "tables"],
    ["![alt](https://example.org/image.png)", "images"],
    ["<https://example.org/>", "autolinks"],
    ["<a@example.org>", "autolinks"],
    ["<script>SENTINEL</script>", "raw HTML"],
    ["a <!-- comment --> b", "raw HTML"],
    ["~~gone~~", "strikethrough"],
    ["    indented", "indented code"],
    ["\tindented", "indented code"],
    ["a {attribute}", "residual syntax"],
    ["a | pipe", "residual syntax"],
    ["a ::: directive", "residual syntax"],
    ["a $$math$$", "residual syntax"],
    ["a ~~ unmatched", "residual syntax"],
    ["a ` unmatched", "residual syntax"],
    ["---\nreserved", "frontmatter"],
    ["\n \n+++\nreserved", "frontmatter"],
  ])("rejects %s specifically", (source, reason) => rejects(source, reason));

  it.each(["***", "___", "-", ">", "**", "* *", "_ _", "# **", "```\n \t\n```", "`   `"])(
    "requires a semantic nonblank text/code leaf: %s",
    (source) => rejects(source, "semantic text"),
  );

  it.each(["\\*", "&#42;", "`*`"])("retains deliberately literal marker leaves: %s", (source) => {
    expect(inspect(source).title).toBe("Advertisement");
  });

  it.each(["--- ", "---\t", " ---", "   ---  ", "+++ ", " +++\t"])(
    "rejects padded initial frontmatter delimiters: %j",
    (marker) => rejects(`${marker}\nreserved\n${marker}`, "frontmatter"),
  );

  it("keeps nonleading and other leading thematic breaks", () => {
    expect(inspect("***\n\nBody\n\n---").title).toBe("Advertisement");
  });

  it("rejects overdeep destination fallback rather than pretending it is ordinary text", () => {
    const nested = (depth: number) => `[x](https://example.org/${"(".repeat(depth)}a${")".repeat(depth)})`;
    expect(inspect(nested(32)).links).toHaveLength(1);
    rejects(nested(33), "residual syntax");
  });

  it("rejects deep block loss before the pinned fallback", () => {
    expect(inspect(`${"> ".repeat(31)}SENTINEL`).stats.max_depth).toBe(32);
    rejects(`${"> ".repeat(32)}SENTINEL`, "nesting limit");
    rejects(`${"> ".repeat(110)}<script>SENTINEL</script>`, "nesting limit");
  });

  it("checks post-delimiter nesting and recursive label scanning", () => {
    expect(inspect(`${"*".repeat(62)}text${"*".repeat(62)}`).stats.max_depth).toBe(32);
    rejects(`${"*".repeat(64)}text${"*".repeat(64)}`, "nesting limit");
    rejects(`${"[".repeat(100)}text${"]".repeat(100)}`, "nesting limit");
  });

  it("counts transient inline tokens before joining them", () => {
    const paragraphs = Array<string>(20).fill("&amp;".repeat(2497));
    const exact = paragraphs.join("\n\n");
    expect(inspect(exact).stats.emitted_tokens).toBe(LIMITS.tokens);
    paragraphs[19] += "&amp;";
    rejects(paragraphs.join("\n\n"), "token limit");
  });

  it("counts transient block tokens as well as inline tokens", () => {
    const source = "- a\n".repeat(8333);
    expect(inspect(source).stats.emitted_tokens).toBe(LIMITS.tokens);
    rejects(`${source}- a\n`, "token limit");
  });

  it("counts ordinary pending text as transient tokens", () => {
    expect(inspect("one").stats.emitted_tokens).toBe(4);
    expect(inspect("one *two* three").stats.emitted_tokens).toBe(8);
  });

  it("counts links before pair deduplication", () => {
    const link = "[x](https://example.org/)\n";
    const result = inspect(link.repeat(LIMITS.links));
    expect(result.links).toHaveLength(1);
    expect(result.stats.links).toBe(LIMITS.links);
    rejects(link.repeat(LIMITS.links + 1), "link limit");
  });

  it("bounds the complete serialized metadata without truncation", () => {
    const make = (extra: number) =>
      Array.from(
        { length: 33 },
        (_, index) => `[${"x".repeat(index < 32 ? 7900 : extra)}](https://example.org/${index})`,
      ).join("\n\n");
    const baseline = inspect(make(1));
    const spare = LIMITS.metadataBytes - Buffer.byteLength(JSON.stringify(baseline));
    expect(spare).toBeGreaterThan(0);
    const exact = inspect(make(1 + spare));
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(LIMITS.metadataBytes);
    rejects(make(2 + spare), "metadata byte limit");
  });
});

describe("code and ordinal semantics", () => {
  it.each(["`a  b`", "` a`", "`a `", "`   ` and text", "`a\tb`", "``a`b``"])(
    "accepts exact span content: %s",
    (source) => expect(inspect(source).title).toBe("Advertisement"),
  );

  it.each(["` a `", "`` ` ``", "`a\nb`", "`a\r\nb`", "` \t `"])(
    "rejects span folding or padding removal: %s",
    (source) => rejects(source, "code span normalization"),
  );

  it.each(["```\na\n```", "~~~~\na\n~~~~~\t", "```\n  a\t \n   ```", "```\n~~~\n```", "```\r\na\r\n```"])(
    "accepts distinct root info-less fences: %s",
    (source) => expect(inspect(source).links).toEqual([]),
  );

  it.each([
    ["```\na", "unclosed fence"],
    ["```", "unclosed fence"],
    ["````\na\n```", "unclosed fence"],
    ["```\na\n``` suffix", "unclosed fence"],
    ["```js\na\n```", "fence info"],
    ["``` \na\n```", "fence info"],
    [" ```\na\n```", "root column-zero fence"],
    ["> ```\n> a\n> ```", "root column-zero fence"],
    ["- ```\n  a\n  ```", "root column-zero fence"],
  ])("rejects unsupported fence semantics: %s", (source, reason) => rejects(source, reason));

  it("rejects deeply nested images before recursive child parsing can overflow", () => {
    rejects(`${"![".repeat(100)}text${"](https://example.org/)".repeat(100)}`, "nesting limit");
  });

  it("does not inspect inert syntax inside fences", () => {
    expect(inspect("~~~\n[x]: javascript:evil\n|table|\n&#0;\n---\n~~~").links).toEqual([]);
  });

  it("tracks consecutive literal ordinals per list owner", () => {
    expect(inspect("3. a\n4. b\n\n   8. c\n   9. d\n\n5. e").title).toBe("Advertisement");
    expect(inspect("01. a\n02. b\n\n7) c\n8) d").title).toBe("Advertisement");
    rejects("3. a\n9. b", "ordered list ordinal");
    rejects("1. a\n1. b", "ordered list ordinal");
    rejects("3. a\n4. b\n\n   8. c\n   10. d\n\n5. e", "ordered list ordinal");
  });
});

describe("entities and strict URI validation", () => {
  it.each(["&#0;", "&#9;", "&#10;", "&#13;", "&#12;", "&#127;", "&#x202e;", "&Tab;", "&NewLine;", "&#xD800;"])(
    "rejects decoded unsafe entities before text_join: %s",
    (entity) => rejects(`body ${entity}`, "unsafe entity"),
  );

  it("distinguishes escaped, entity and code spellings from residual syntax", () => {
    const source =
      "# \\[ok\\] &lbrack;ok&rbrack; \\` &#96; \\| &vert; \\{ &rbrace; \\:\\:\\: \\$\\$ \\~\\~\n\n" +
      "`&#0; &Tab;` \\&Tab; &amp;Tab;";
    expect(inspect(source).title).toBe("[ok] [ok] ` ` | | { } ::: $$ ~~");
  });

  it.each([
    ["https://example.org/a?x=1&amp;y=2", "https://example.org/a?x=1&y=2"],
    ["HTTP://EXAMPLE.ORG/a", "HTTP://EXAMPLE.ORG/a"],
    ["https://例え.テスト/道", "https://xn--r8jz45g.xn--zckzah/%E9%81%93"],
    ["mailto:a@example.org?subject=Hello&cc=b@example.org", "mailto:a@example.org?subject=Hello&cc=b@example.org"],
    [
      "mailto:a%40example.org?subject=Hello&amp;cc=b%40example.org",
      "mailto:a%40example.org?subject=Hello&cc=b%40example.org",
    ],
    ["tel:+1-604-555-0100;ext=9", "tel:+1-604-555-0100;ext=9"],
    ["https://example.org/%2520", "https://example.org/%2520"],
  ])("validates raw and normalized safe destination %s", (destination, expected) => {
    expect(inspect(`[cite](${destination})`).links).toEqual([{ text: "cite", url: expected }]);
  });

  it.each([
    "www.example.org/a",
    "a@example.org",
    "//example.org",
    "/relative",
    "#fragment",
    "javascript:evil",
    "data:text/plain,x",
    "https:example.org",
    "https:/example.org",
    "https:///example.org",
    "https://user:pass@example.org",
    "https://user@example.org",
    "https://example.org/\\path",
    "https://example.org/\\(path\\)",
    "https://example.org/%5cpath",
    "https://example.org/%255cpath",
    "https://example.org/%00",
    "https://example.org/%0a",
    "https://example.org/%250D",
    "https://example.org/%e2%80%ae",
    "https://example.org/%ef%bf%bd",
    "https://example.org/%ff%0a",
    "https://user%40example.org@elsewhere.org/",
    "mailto:invalid",
    "mailto:a@example.org#fragment",
    "mailto:a@example.org?unexpected=x",
    "mailto:a@example.org?cc=invalid",
    "mailto:a@example.org?body=Hi%0Athere",
    "tel:abc",
    "tel:---",
    "tel:123?x=1",
    "tel:123#x",
    "tel:123;ext=abc",
    "https://example.org/&#9;",
    "https://example.org/&#x202e;",
    "https://@example.org/",
    "https://%2540example.org/",
    "https://example.org/%c2%85",
    "https://example.org/%e2%80%8b",
    "https://example.org/&bsol;x",
  ])("rejects unsafe or repaired destination %s", (destination) => {
    rejects(`[cite](<${destination}>)`, "link destination");
  });

  it("rejects deep encoded unsafe forms and does not bless exhausted decoding", () => {
    const encoded = (depth: number) => `%${"25".repeat(depth)}0a`;
    for (const depth of [1, 6, 7, 8, 12]) {
      rejects(`[x](https://example.org/${encoded(depth)})`, "link destination");
    }
  });

  it.each(["&#9;", "&#65533;", "&#x202e;", "a\tb", "a\nb"])("checks all decoded link title controls: %s", (title) =>
    rejects(`[x](https://example.org/ "${title}")`, "unsafe link title"),
  );

  it("allows safe link titles but does not substitute them for citation labels", () => {
    expect(inspect('[label](https://example.org/ "Safe &amp; title")').links[0]?.text).toBe("label");
  });

  it("does not re-decode literal invalid entity spellings retained by the pinned title helper", () => {
    const parser = new MarkdownIt();
    const source = '[label](https://example.org/ "&#0;")';
    const link = parser.parse(source, {})[1]?.children?.find((token) => token.type === "link_open");
    expect(link?.attrGet("title")).toBe("&#0;");
    expect(inspect(source).links[0]?.text).toBe("label");
  });
});

describe("state isolation and deterministic semantics", () => {
  it("never changes shared parser prototypes or rules", () => {
    const parser = new MarkdownIt({ html: true });
    const sample = "# A\n\n[ref]: https://example.org/\n\n[ref]";
    const before = parser.render(sample);
    const helpers = parser.helpers;
    const blockPush = Object.getPrototypeOf(new parser.block.State("", parser, {}, [])).push;
    const inlinePush = Object.getPrototypeOf(new parser.inline.State("", parser, {}, [])).push;
    const expected = inspect("# Clean\n\n[link](https://example.org/)");
    rejects("[x]: https://example.org/", "reference definitions");
    rejects(`${"> ".repeat(110)}lost`, "nesting limit");
    expect(inspect("# Clean\n\n[link](https://example.org/)")).toEqual(expected);
    expect(parser.render(sample)).toBe(before);
    expect(parser.helpers).toBe(helpers);
    expect(Object.getPrototypeOf(new parser.block.State("", parser, {}, [])).push).toBe(blockPush);
    expect(Object.getPrototypeOf(new parser.inline.State("", parser, {}, [])).push).toBe(inlinePush);
  });

  it("accepted synthetic results satisfy the existing body and metadata safety contracts", () => {
    const bodies = [
      "Plain prose",
      "# Native\n\nText",
      "# Escaped \\[brackets\\]\n\nText",
      "Text \\<element> and &lt;other&gt;",
      "`<code>` body",
      "```\n<script>\n```",
      "- item\n- next",
      "3. third\n4. fourth",
      "> quoted\n\nbody",
    ];
    const destinations = [
      "https://example.org/a",
      "http://example.org/",
      "mailto:a@example.org",
      "tel:+1-604-555-0100",
      "https://example.org/a%20b",
      "https://example.org/?a=1&amp;b=2",
      "www.ubc.ca/a",
      "javascript:alert(1)",
      "https://user@example.org/",
      "#fragment",
    ];
    let accepted = 0;
    for (const body of bodies) {
      for (const destination of destinations) {
        const source = `${body}\n\n[label](<${destination}>)`;
        let result: ReturnType<typeof inspect>;
        try {
          result = inspect(source);
        } catch {
          continue;
        }
        accepted++;
        expect(() => assertSafeMarkdown(source)).not.toThrow();
        expect(() => safeText(result.title, "native title")).not.toThrow();
      }
    }
    expect(accepted).toBe(54);
  });

  it("preserves declared semantic text on deterministic safe examples", () => {
    const parser = new MarkdownIt({ html: true, linkify: false, typographer: false, breaks: false, maxNesting: 64 });
    for (let size = 1; size <= 24; size++) {
      const words = `safe${" text".repeat(size)}`;
      const source = `# ${words}\n\n${"> ".repeat(size)}[**${words}**](https://example.org/${size})\n\n\`a  ${size}\``;
      const original = bytes(source);
      const result = inspectMarkdownSource(original, []);
      expect(result.title).toBe(words);
      expect(result.links).toEqual([{ text: words, url: `https://example.org/${size}` }]);
      expect(result.source_bytes_sha256).toBe(createHash("sha256").update(original).digest("hex"));
      expect(parser.render(source)).toContain(`<strong>${words}</strong>`);
      expect(parser.render(source)).toContain(`<code>a  ${size}</code>`);
    }
  });
});
