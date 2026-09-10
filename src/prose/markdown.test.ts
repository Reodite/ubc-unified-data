import { load } from "cheerio";
import fc from "fast-check";
import MarkdownIt from "markdown-it";
import { describe, expect, it, vi } from "vitest";
import { assertSafeMarkdown, toSafeMarkdown, type MarkdownResult } from "./markdown.ts";

type Token = ReturnType<typeof renderer.parse>[number];

const SOURCE = "https://students.example.edu/guides/registration?year=2026";
const renderer = new MarkdownIt({ html: true });

function textHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tokenTypes(tokens: Token[]): string[] {
  return tokens.flatMap((token) => [token.type, ...tokenTypes(token.children ?? [])]);
}

function rendered(result: MarkdownResult) {
  expect(() => assertSafeMarkdown(result.markdown)).not.toThrow();
  const types = tokenTypes(renderer.parse(result.markdown, {}));
  expect(types).not.toContain("html_inline");
  expect(types).not.toContain("html_block");
  expect(types).not.toContain("image");
  const $ = load(renderer.render(result.markdown), {}, false);
  const allowed = new Set([
    "p",
    "a",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "blockquote",
    "strong",
    "em",
    "s",
    "pre",
    "code",
    "hr",
    "br",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ]);
  for (const node of $("*").toArray()) {
    if (!("tagName" in node)) throw new Error("Expected an element.");
    expect(allowed.has(node.tagName), node.tagName).toBe(true);
    for (const [name, value] of Object.entries(node.attribs)) {
      expect(["href", "title", "start"], name).toContain(name);
      if (name === "href") {
        expect(value).toMatch(/^(?:https?:\/\/|mailto:|tel:)/);
        expect(new URL(value).username).toBe("");
        expect(new URL(value).password).toBe("");
      }
    }
  }
  return $;
}

describe("toSafeMarkdown prose structures", () => {
  it("preserves heading, paragraph, nested-list, and blockquote order", () => {
    const result = toSafeMarkdown(
      `
      <h1>Planning your studies</h1>
      <p>Read <strong>every step</strong> and <em>keep a copy</em>.</p>
      <ol start="3"><li><p>Choose a subject.</p><ul><li>Check prerequisites.</li><li>Ask an adviser.</li></ul>
        <p>Keep the confirmation.</p></li><li>Submit the request.</li></ol>
      <blockquote><p>Advice stays with its context.</p><blockquote>Allow extra time.</blockquote></blockquote>
      <h2>After applying</h2><p>Watch for a reply.</p>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect(
      $.root()
        .children()
        .toArray()
        .map((node) => node.tagName),
    ).toEqual(["h1", "p", "ol", "blockquote", "h2", "p"]);
    expect($("ol").attr("start")).toBe("3");
    expect($("ol > li")).toHaveLength(2);
    expect(
      $("ol > li > ul > li")
        .toArray()
        .map((node) => $(node).text()),
    ).toEqual(["Check prerequisites.", "Ask an adviser."]);
    expect($("ol > li").first().text()).toContain("Keep the confirmation.");
    expect($("strong").text()).toBe("every step");
    expect($("em").text()).toBe("keep a copy");
    expect($("blockquote > blockquote").text()).toContain("Allow extra time.");
  });

  it("retains advisory and collapsed FAQ bodies rather than treating them as invisible", () => {
    const result = toSafeMarkdown(
      `
      <aside><p>Check the deadline before applying.</p></aside>
      <div role="alert" class="alert alert-warning"><p>Processing may take longer.</p></div>
      <details hidden><summary>Can I change my request?</summary><p>Yes, contact your adviser.</p></details>
      <h3><button aria-expanded="false" aria-controls="answer">What should I keep?</button></h3>
      <div id="answer" hidden aria-hidden="true" class="collapse" style="display:none"><p>Keep the full explanation.</p>
      <ul><li>The reference number.</li><li>The confirmation email.</li></ul></div>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("blockquote")).toHaveLength(2);
    expect($.text()).toContain("Can I change my request?");
    expect($.text()).toContain("Yes, contact your adviser.");
    expect($("h3").text()).toBe("What should I keep?");
    expect($.text()).toContain("Keep the full explanation.");
    expect($("li")).toHaveLength(2);
    expect(result.markdown).not.toMatch(/<(?:details|summary|div|button)\b/i);
  });

  it("preserves headings inside linked cards and accordion summaries", () => {
    const result = toSafeMarkdown(
      `<a href="/process"><h2>Application process</h2><p>Read the full explanation.</p></a>
      <details><summary><h3>When should I ask?</h3></summary><p>Ask before the deadline.</p></details>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("h2").text()).toBe("Application process");
    expect($("h3").text()).toBe("When should I ask?");
    expect($.text()).toContain("Read the full explanation.");
    expect($.text()).toContain("Ask before the deadline.");
    expect(result.links).toContainEqual({ text: "Source link", url: "https://students.example.edu/process" });
  });

  it("preserves definition explanations, deletion, abbreviations, and footnote markers", () => {
    const result = toSafeMarkdown(
      `<dl><dt>Confirmation</dt><dd><p>A saved response with your reference.</p><p>Keep it for later.</p></dd></dl>
      <p><abbr title="Example Student Association">ESA</abbr> uses H<sub>2</sub>O <del>old wording</del>.<sup>1</sup></p>
      <p><sup>1</sup> The note explains the exception.</p>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("strong").text()).toContain("Confirmation");
    expect($.text()).toContain("A saved response with your reference.");
    expect($.text()).toContain("Keep it for later.");
    expect($.text()).toContain("ESA (Example Student Association)");
    expect($.text()).toContain("[subscript: 2]");
    expect($("s").text()).toBe("old wording");
    expect($.text()).toContain("[1] The note explains the exception.");
  });

  it("does not truncate long explanations or later paragraphs", () => {
    const paragraph = "A synthetic explanation includes context, an exception, and the next action. ".repeat(1800);
    const result = toSafeMarkdown(
      `<p>${paragraph}</p><h2>Final section</h2><p>Do not lose the last instruction.</p>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("p").first().text()).toBe(paragraph.trim());
    expect($("p").last().text()).toBe("Do not lose the last instruction.");
    expect($("h2").text()).toBe("Final section");
  });

  it("preserves code and uses fences that cannot be closed by its content", () => {
    const code = 'const example = "<img src=x onerror=alert(1)>";\n  ```\n<script>alert(2)</script>\n````\n    end();';
    const inline = " `<b>not markup</b>` ";
    const result = toSafeMarkdown(
      `<p>Enter <code>${textHtml(inline)}</code> exactly.</p><pre><code class="language-js">${textHtml(code)}</code></pre>
      <pre>  keep indentation\n\tand tabs</pre>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("p code").text()).toBe(inline);
    expect($("pre code").first().text()).toBe(`${code}\n`);
    expect($("pre code").last().text()).toBe("  keep indentation\n\tand tabs\n");
    expect($("script, img")).toHaveLength(0);
  });
});

describe("toSafeMarkdown code boundaries", () => {
  it("keeps generated combinations of HTML, Markdown delimiters, and whitespace inside code", () => {
    const fragment = fc.constantFrom(
      "<img src=x onerror=bad>",
      "<script>bad()</script>",
      "```",
      "  ````",
      "`",
      "\n",
      "\t",
      " ",
      "[x](javascript:bad)",
      "| value |",
      "&lt;",
      "\\",
    );
    fc.assert(
      fc.property(fc.array(fragment, { minLength: 1, maxLength: 20 }), (fragments) => {
        const code = fragments.join("");
        const result = toSafeMarkdown(`<pre><code>${textHtml(code)}</code></pre>`, SOURCE);
        const $ = rendered(result);
        expect($("pre code").text()).toBe(`${code}${code.endsWith("\n") ? "" : "\n"}`);
        expect($("pre")).toHaveLength(1);
      }),
      { numRuns: 150, seed: 20260911 },
    );
  });
});

describe("toSafeMarkdown tables", () => {
  it("keeps captions, inline formatting, links, and a footnote after a normal table", () => {
    const result = toSafeMarkdown(
      `<table summary="Applies to the example intake."><caption>Aid &amp; deadlines</caption>
      <thead><tr><th>Option</th><th>Explanation</th></tr></thead><tbody>
      <tr><td>Example award</td><td><strong>Submit early</strong>, then <em>keep copies</em>.<sup><a href="#note-1">1</a></sup></td></tr>
      <tr><td>Contact</td><td><a href="../advising">Read the guidance</a></td></tr></tbody></table>
      <p id="note-1"><sup>1</sup> An extension requires approval.</p>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("table")).toHaveLength(1);
    expect(
      $("thead th")
        .toArray()
        .map((node) => $(node).text()),
    ).toEqual(["Option", "Explanation"]);
    expect($("tbody tr")).toHaveLength(2);
    expect($("td strong").text()).toBe("Submit early");
    expect($("td em").text()).toBe("keep copies");
    expect($.text()).toContain("Aid & deadlines");
    expect($.text()).toContain("Applies to the example intake.");
    expect($.text()).toContain("[1] An extension requires approval.");
    expect(result.links).toContainEqual({ text: "1", url: `${SOURCE}#note-1` });
    expect(result.links).toContainEqual({ text: "Read the guidance", url: "https://students.example.edu/advising" });
  });

  it("preserves every headerless row instead of emitting HTML or promoting data to a heading", () => {
    const result = toSafeMarkdown(
      `<table><caption>Important contacts</caption><tr><td>Advising</td><td>Ask before applying.</td></tr>
      <tr><td>Registration</td><td>Keep the reference.</td></tr></table>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("table")).toHaveLength(1);
    expect(
      $("thead th")
        .toArray()
        .map((node) => $(node).text()),
    ).toEqual(["", ""]);
    expect(
      $("tbody td")
        .toArray()
        .map((node) => $(node).text()),
    ).toEqual(["Advising", "Ask before applying.", "Registration", "Keep the reference."]);
    expect(result.warnings.join(" ")).toMatch(/headerless/);
    expect(result.markdown).not.toContain("<table");
  });

  it("retains merged cells and footer explanations as labelled row/cell lists", () => {
    const result = toSafeMarkdown(
      `<table><caption>Application routes</caption><thead><tr><th rowspan="2">Route</th><th colspan="2">Timing</th></tr>
      <tr><th>First stage</th><th>Second stage</th></tr></thead><tbody>
      <tr><td>Example route</td><td>Review</td><td>Confirm</td></tr></tbody>
      <tfoot><tr><td colspan="3"><p><sup>1</sup> Approval is not automatic.</p><p><a href="/exceptions">Read every exception.</a></p></td></tr></tfoot></table>`,
      SOURCE,
    );
    const $ = rendered(result);
    for (const text of [
      "Application routes",
      "Route",
      "Timing",
      "First stage",
      "Second stage",
      "Example route",
      "Review",
      "Confirm",
      "Approval is not automatic.",
      "Read every exception.",
    ]) {
      expect($.text()).toContain(text);
    }
    expect(result.markdown).toContain("rowspan 2");
    expect(result.markdown).toContain("colspan 2");
    expect(result.markdown).toContain("colspan 3");
    expect(result.markdown).toContain("Footer row");
    expect(result.warnings.join(" ")).toMatch(/complex table/);
    expect(result.links).toContainEqual({
      text: "Read every exception.",
      url: "https://students.example.edu/exceptions",
    });
  });

  it("keeps cell paragraphs, lists, blockquotes, code, and line breaks without raw br tags", () => {
    const result = toSafeMarkdown(
      `<table><tr><th>Action</th><th>Instructions</th></tr><tr><td>Apply</td><td>
      <p>First read the policy.</p><ul><li>Collect documents.</li><li>Keep originals.</li></ul>
      <blockquote>Do not submit twice.</blockquote><pre><code>step(1);\nstep(2);</code></pre>
      <p>Contact one office.<br>Wait for a response.</p></td></tr></table>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("blockquote").text()).toContain("Do not submit twice.");
    expect($("pre code").text()).toBe("step(1);\nstep(2);\n");
    expect(
      $("li")
        .toArray()
        .some((node) => $(node).text() === "Collect documents."),
    ).toBe(true);
    expect($("br")).toHaveLength(1);
    expect(result.markdown).not.toContain("<br");
    expect($.text()).toContain("Wait for a response.");
  });

  it("keeps literal pipes, backslashes, and entity spellings in simple table cells", () => {
    const values = ["a | b", "one \\| two", "literal &lt;img&gt;", "[not a link](javascript:bad)"];
    const result = toSafeMarkdown(
      `<table><tr><th>Value</th></tr>${values.map((value) => `<tr><td>${textHtml(value)}</td></tr>`).join("")}</table>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect(
      $("tbody td")
        .toArray()
        .map((node) => $(node).text()),
    ).toEqual(values);
    expect(result.links).toEqual([]);
  });

  it("does not corrupt pipes in inline code when a table needs a fallback", () => {
    const result = toSafeMarkdown(
      `<table><tr><td><code>a | b \\| c</code></td><td>Explanation remains.</td></tr></table>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("code").text()).toBe("a | b \\| c");
    expect($.text()).toContain("Explanation remains.");
    expect(result.warnings.join(" ")).toMatch(/complex table/);
  });

  it("preserves nested tables and captions without duplicating cell prose", () => {
    const result = toSafeMarkdown(
      `<table><caption>Outer context</caption><tr><td>Outer explanation.</td><td>
      <table><caption>Inner context</caption><tr><th>Nested heading</th></tr><tr><td>Nested explanation.</td></tr></table>
      <p>After the inner table.</p></td></tr></table>`,
      SOURCE,
    );
    const $ = rendered(result);
    for (const text of [
      "Outer context",
      "Outer explanation.",
      "Inner context",
      "Nested heading",
      "Nested explanation.",
      "After the inner table.",
    ]) {
      expect($.text().split(text)).toHaveLength(2);
    }
    expect($("table")).toHaveLength(1);
  });

  it("labels large and open-ended spans without expanding or dropping source cells", () => {
    const result = toSafeMarkdown(
      `<table><tbody><tr><td rowspan="0" colspan="999999999999999999999">All remaining rows.</td><td>One cell.</td></tr>
      <tr><td>Last cell.</td></tr></tbody></table>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect(result.markdown).toContain("rowspan 0");
    expect(result.markdown).toContain("colspan 999999999999999999999");
    expect($.text()).toContain("All remaining rows.");
    expect($.text()).toContain("Last cell.");
    expect(result.markdown.length).toBeLessThan(1000);
  });
});

describe("toSafeMarkdown links and embedded content", () => {
  it("resolves relative links against the source, ignoring an injected base element", () => {
    const result = toSafeMarkdown(
      `<base href="https://attacker.example/"><p><a href="../advising">Advising</a>, <a href="/fees">Fees</a>,
      <a href="?year=2027">Next year</a>, <a href="#exceptions">Exceptions</a>, <a href="//cdn.example.edu/help">Help</a>.</p>`,
      SOURCE,
    );
    rendered(result);
    expect(result.links).toEqual([
      { text: "Advising", url: "https://students.example.edu/advising" },
      { text: "Fees", url: "https://students.example.edu/fees" },
      { text: "Next year", url: "https://students.example.edu/guides/registration?year=2027" },
      { text: "Exceptions", url: `${SOURCE}#exceptions` },
      { text: "Help", url: "https://cdn.example.edu/help" },
    ]);
  });

  it("keeps encoded Unicode, percent signs, and ordinary ampersands in safe destinations", () => {
    const result = toSafeMarkdown(
      `<p><a href="r%C3%A9sum%C3%A9-%CF%80.pdf">Résumé</a>
      <a href="guide&amp;notes.pdf?discount=100%25">Notes</a></p>`,
      SOURCE,
    );
    rendered(result);
    expect(result.links).toEqual([
      { text: "Résumé", url: "https://students.example.edu/guides/r%C3%A9sum%C3%A9-%CF%80.pdf" },
      { text: "Notes", url: "https://students.example.edu/guides/guide&notes.pdf?discount=100%25" },
    ]);
  });

  it("keeps safe mailto, tel, URL punctuation, and link titles without Markdown injection", () => {
    const result = toSafeMarkdown(
      `<p><a href="mailto:advising@example.edu?subject=Application%20question">Email</a>
      <a href="tel:+1-604-555-0100;ext=12">Phone</a>
      <a href="/file (draft).pdf?q=a&amp;copy;=1" title="&quot; onmouseover=&quot;alert(1)&lt;img src=x&gt;">Read <em>carefully</em></a></p>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect(result.links).toContainEqual({
      text: "Email",
      url: "mailto:advising@example.edu?subject=Application%20question",
    });
    expect(result.links).toContainEqual({ text: "Phone", url: "tel:+1-604-555-0100;ext=12" });
    expect(result.links).toContainEqual({
      text: "Read carefully",
      url: "https://students.example.edu/file%20%28draft%29.pdf?q=a&copy;=1",
    });
    expect($("a").last().attr("title")).toBe('" onmouseover="alert(1)<img src=x>');
    expect($("a em").text()).toBe("carefully");
  });

  it("keeps useful image alt and caption text as links without fetching or embedding", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network expected"));
    try {
      const result = toSafeMarkdown(
        `<figure><img src="/images/diagram.png" alt="Three steps: choose, apply, confirm." onerror="alert(1)">
        <figcaption>The diagram shows when to contact an adviser.</figcaption></figure>`,
        SOURCE,
      );
      const $ = rendered(result);
      expect($("img")).toHaveLength(0);
      expect($.text()).toContain("Three steps: choose, apply, confirm.");
      expect($.text()).toContain("The diagram shows when to contact an adviser.");
      expect(result.links).toEqual([
        { text: "Three steps: choose, apply, confirm.", url: "https://students.example.edu/images/diagram.png" },
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("retains text before and after adjacent images in document order", () => {
    const result = toSafeMarkdown(
      '<p>Before <img src="/one" alt="Middle"> after <img src="/two" alt="Again"> ending.</p>',
      SOURCE,
    );
    const $ = rendered(result);
    expect($.text().trim()).toBe("Before Middle after Again ending.");
    expect(result.links.map((link) => link.text)).toEqual(["Middle", "Again"]);
  });

  it("retains alt text even when an unsafe image URL is discarded", () => {
    const text = '[not a link](javascript:alert(1)) <img src=x onerror="bad">';
    const result = toSafeMarkdown(
      `<img src="data:image/svg+xml,bad" alt="${textHtml(text).replace(/"/g, "&quot;")}">`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($.text().trim()).toBe(text);
    expect(result.links).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/image URL/);
  });

  it.each(["iframe", "embed", "object", "video", "audio", "canvas", "svg"])(
    "replaces %s-only content with a safe source link and warning",
    (tag) => {
      const attr = tag === "object" ? "data" : "src";
      const result = toSafeMarkdown(
        `<${tag} ${attr}="javascript:alert(1)" srcdoc="&lt;script&gt;bad&lt;/script&gt;" title="Applying explained"></${tag}>`,
        SOURCE,
      );
      const $ = rendered(result);
      expect($("a").attr("href")).toBe(SOURCE);
      expect($.text()).toContain("Applying explained");
      expect(result.links).toEqual([{ text: "Embedded content: Applying explained", url: SOURCE }]);
      expect(result.warnings.join(" ")).toMatch(/Embedded content/);
    },
  );

  it("keeps safe media URLs and explicit video source links", () => {
    const result = toSafeMarkdown(
      `<iframe src="https://media.example.edu/explanation" title="Example walkthrough"></iframe>
      <video><source src="/walkthrough.mp4"><track src="/captions.vtt" label="English captions"></video>`,
      SOURCE,
    );
    rendered(result);
    expect(result.links.map((link) => link.url)).toContain("https://media.example.edu/explanation");
    expect(result.links.map((link) => link.url)).toContain("https://students.example.edu/walkthrough.mp4");
    expect(result.links.map((link) => link.url)).toContain("https://students.example.edu/captions.vtt");
  });
});

describe("toSafeMarkdown XSS resistance", () => {
  const unsafeDestinations = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java&#x73;cript:alert(1)",
    "javascript&colon;alert(1)",
    "java&#x09;script:alert(1)",
    "java&#10;script:alert(1)",
    "java\tscript:alert(1)",
    "java\u200Bscript:alert(1)",
    "javascript%3Aalert(1)",
    "%6a%61vascript%3Aalert(1)",
    "java%2573cript%253Aalert(1)",
    "java%0ascript:alert(1)",
    "data:text/html,bad",
    "vbscript:bad",
    "file:///etc/passwd",
    "ftp://files.example.edu/file",
    "/bad%0d%0aheader",
    "https://user:password@example.edu/private",
    "//user@example.edu/private",
    "https:\\attacker.example/path",
    "mailto:person@example.edu?subject=test%0ABcc:bad@example.edu",
    "mailto:person@example.edu?attach=/etc/passwd",
    "tel:javascript:bad",
    "tel://attacker.example",
    "https://example.edu/%2509bad",
    "java%E2%80%8Bscript:bad",
    "javascript&amp;colon;bad",
    "java&amp;#x73;cript:bad",
  ];

  it.each(unsafeDestinations)("rejects the unsafe destination %j without losing its label", (destination) => {
    const result = toSafeMarkdown(`<p>Before <a href="${destination}">Keep this explanation</a> after.</p>`, SOURCE);
    const $ = rendered(result);
    expect($("a")).toHaveLength(0);
    expect($.text().trim()).toBe("Before Keep this explanation after.");
    expect(result.links).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/unsafe or unsupported link/);
  });

  it("removes executable markup, style, and forms before Markdown conversion", () => {
    const result = toSafeMarkdown(
      `<h2 onclick="bad()">Safe heading</h2><script>LEAK_SCRIPT</script><style>LEAK_STYLE</style>
      <form action="https://attacker.example"><label>LEAK_FORM</label><input name="password"><textarea>LEAK_TEXTAREA</textarea></form>
      <p style="background:url(javascript:bad)" onmouseover="bad()">Keep the explanation.</p>
      <object data="data:text/html,bad"><script>LEAK_OBJECT_SCRIPT</script></object>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($.text()).toContain("Safe heading");
    expect($.text()).toContain("Keep the explanation.");
    expect(result.markdown).not.toMatch(/LEAK_|onclick|onmouseover|background:|<script|<style|<form/);
  });

  it.each([
    '<svg><textarea><img src=x onerror="alert(1)"></textarea></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<xmp><img src=x onerror="alert(1)"></xmp><p>Keep the ending.</p>',
    "<template><div><script>bad()</script><p>Keep this template explanation.</p></div></template>",
    '<noscript><p>Keep this alternative explanation.</p><img src="javascript:bad" alt="Example"></noscript>',
  ])("keeps malformed and foreign-content payloads inert: %s", (html) => {
    const result = toSafeMarkdown(html, SOURCE);
    const $ = rendered(result);
    expect($("script, img, style, svg, math, form, iframe, object, embed")).toHaveLength(0);
  });

  it("retains explanatory noscript and template content while removing their scripts", () => {
    const result = toSafeMarkdown(
      `<noscript><p>Alternative instructions are still useful.</p><script>LEAK_SCRIPT</script></noscript>
      <template><p>Stored accordion instructions are still useful.</p><script>LEAK_SCRIPT</script></template>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($.text()).toContain("Alternative instructions are still useful.");
    expect($.text()).toContain("Stored accordion instructions are still useful.");
    expect($.text()).not.toContain("LEAK_SCRIPT");
  });

  it("escapes literal HTML and Markdown-like text without changing real list or quote structure", () => {
    const payload = '[bad](javascript:alert(1)) ![pixel](https://attacker.example/pixel) <img src=x onerror="bad">';
    const result = toSafeMarkdown(
      `<blockquote><p>${textHtml(payload)}</p><ul><li>${textHtml("# not a heading")}</li>
      <li>${textHtml("> not a nested quote")}</li><li>${textHtml("[ref]: javascript:bad")}</li></ul></blockquote>
      <p>${textHtml("---\n<script>bad()</script>\n1. not a list")}</p>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("blockquote")).toHaveLength(1);
    expect($("blockquote p").first().text()).toBe(payload);
    expect($("blockquote ul > li")).toHaveLength(3);
    expect($("h1, ol, img, script, a, hr")).toHaveLength(0);
    expect(result.links).toEqual([]);
  });

  it("escapes punctuation split across text nodes and code fences containing HTML", () => {
    const result = toSafeMarkdown(
      `<p>[<span>link</span>](<span>https://attacker.example</span>)</p>
      <p>&lt;<span>img</span> src=x onerror=bad&gt;</p><ul><li><p>!<span>[tracking]</span>(https://attacker.example/image)</p></li></ul>
      <p><code>${textHtml("``\n<img src=x onerror=bad>\n```")}</code></p>`,
      SOURCE,
    );
    const $ = rendered(result);
    expect($("a, img")).toHaveLength(0);
    expect($.text()).toContain("[link](https://attacker.example)");
    expect($.text()).toContain("<img src=x onerror=bad>");
  });

  it.each(["file:///tmp/page", "javascript:bad", "https://user:password@example.edu/page", "/relative-source"])(
    "rejects an unsafe or nonabsolute source URL %s",
    (source) => {
      expect(() => toSafeMarkdown("<p>Text</p>", source)).toThrow(/source URL/);
    },
  );

  it("returns a deterministic empty result for empty input", () => {
    expect(toSafeMarkdown("", SOURCE)).toEqual({ markdown: "", links: [], warnings: [] });
    const html = "<p>Text <a href='/help'>Help</a>.</p>";
    expect(toSafeMarkdown(html, SOURCE)).toEqual(toSafeMarkdown(html, SOURCE));
  });
});

describe("assertSafeMarkdown", () => {
  it.each([
    "<script>alert(1)</script>",
    "A <img src=x onerror=bad> image.",
    "> - **Nested** <iframe src=bad></iframe>",
    "| A |\n| --- |\n| <svg onload=bad></svg> |",
    "<!-- raw HTML comment -->",
    "<https://user:password@example.edu/>",
    "[bad](javascript:alert%281%29)",
    "> - [bad](java&#x09;script:bad)",
    "[bad](data:text/html,bad)",
    "[bad](file:///tmp/file)",
    "[bad](//example.edu/file)",
    "[bad](/relative)",
    "![image](https://example.edu/image.png)",
    "> - ![image](data:image/png;base64,AAAA)",
    "> - [reference][bad]\n\n[bad]: javascript:alert%281%29",
  ])("rejects unsafe Markdown even in nested tokens: %s", (markdown) => {
    expect(() => assertSafeMarkdown(markdown)).toThrow(/Unsafe Markdown/);
  });

  it.each([
    "Literal &lt;script&gt; and &lt;img src=x&gt; text.",
    "`<script>alert(1)</script>`",
    "````\n  ```\n<img src=x onerror=bad>\n````",
    "> - [Help](https://example.edu/help)\n>   - [Email](mailto:person@example.edu)",
    "| Heading |\n| --- |\n| [Phone](tel:+16045550100) |",
  ])("accepts inert code, escaped text, and safe links: %s", (markdown) => {
    expect(() => assertSafeMarkdown(markdown)).not.toThrow();
  });
});
