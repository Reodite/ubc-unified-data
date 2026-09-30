import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Observation, Snapshot } from "./contracts.ts";
import {
  assertMarkdownIdentity,
  discoverMarkdownAlternates,
  markdownSources,
  type MarkdownSourceDeclaration,
} from "./markdown-source-policy.ts";

const pairs = [
  ["manufacturing.engineering.ubc.ca", "1"],
  ["macisaacnursing.ubc.ca", "2421"],
  ["mining.ubc.ca", "1"],
  ["scarp.ubc.ca", "1"],
] as const;
const host = "mining.ubc.ca";
const home = `https://${host}/`;
const target = `${home}node/1.md`;
const declaration: MarkdownSourceDeclaration = { hostname: host, source_url: home, target_url: target };
const html = (head = "", body = "<h1>Do not borrow this title</h1>") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const link = (href = "/node/1.md", title?: string) =>
  `<link rel="alternate" type="text/markdown" href="${href}"${title === undefined ? "" : ` title="${title}"`}>`;
const header = (href = "/node/1.md", title?: string) =>
  `<${href}>; rel="alternate"; type="text/markdown"${title === undefined ? "" : `; title="${title}"`}`;
const snapshotDigest = (snapshot: Snapshot) => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
function observed(head = link(), headers: Record<string, string> = {}, body?: string): Observation {
  const snapshot: Snapshot = {
    requested_url: home,
    url: home,
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: html(head, body),
    bytes: Buffer.byteLength(html(head, body)),
    retrieved_at: "2026-01-01T00:00:00Z",
  };
  return { sha256: snapshotDigest(snapshot), snapshot };
}
function discover(observation = observed(), declarations: readonly MarkdownSourceDeclaration[] = [declaration]) {
  return discoverMarkdownAlternates(observation, declarations);
}
function targetObservation(): Observation {
  const result = observed();
  result.snapshot.requested_url = target;
  result.snapshot.url = target;
  result.snapshot.headers = { "content-type": "text/markdown" };
  result.sha256 = snapshotDigest(result.snapshot);
  return result;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("finite Markdown source declarations", () => {
  it.each(pairs)("declares only the exact reviewed homepage for %s", (hostname, node) => {
    const declarations = markdownSources(hostname);
    expect(declarations).toEqual([
      { hostname, source_url: `https://${hostname}/`, target_url: `https://${hostname}/node/${node}.md` },
    ]);
    expect(Object.isFrozen(declarations)).toBe(true);
    expect(Object.isFrozen(declarations[0])).toBe(true);
    expect(() => (declarations as MarkdownSourceDeclaration[]).pop()).toThrow();
  });

  it.each(["fixture.ubc.ca", "MINING.UBC.CA", "mining.ubc.ca.", "https://mining.ubc.ca/", "", "__proto__"])(
    "does not synthesize declarations for %s",
    (hostname) => {
      const result = markdownSources(hostname);
      expect(result).toEqual([]);
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it.each([
    { hostname: "fixture.ubc.ca" },
    { hostname: "MINING.UBC.CA" },
    { source_url: `${home}alias` },
    { source_url: home.slice(0, -1) },
    { source_url: home.replace("https:", "http:") },
    { target_url: `${home}node/2.md` },
    { target_url: `${target}?` },
    { target_url: `${target}#` },
    { target_url: `https://reader@${host}/node/1.md` },
    { target_url: `https://${host}:443/node/1.md` },
    { target_url: "https://scarp.ubc.ca/node/1.md" },
  ])("rejects caller-supplied policy expansion: %j", (change) => {
    const invalid = { ...declaration, ...change };
    expect(() => discover(observed(), [invalid])).toThrow();
    expect(() => assertMarkdownIdentity(invalid, targetObservation())).toThrow();
  });

  it("deduplicates exact declarations but does not silently drop unmatched selected sources", () => {
    expect(discover(observed(), [declaration, { ...declaration }])).toHaveLength(1);
    expect(() => discover(observed(), [...markdownSources("scarp.ubc.ca"), declaration])).toThrow();
  });

  it("leaves empty policy behavior inert even for an invalid observation", () => {
    const input = observed();
    input.snapshot.status = 403;
    input.sha256 = snapshotDigest(input.snapshot);
    deepFreeze(input);
    const result = discover(input, []);
    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("exact source observation context", () => {
  it.each([
    (s: Snapshot) => {
      s.status = 206;
    },
    (s: Snapshot) => {
      s.status = 301;
    },
    (s: Snapshot) => {
      s.status = 404;
    },
    (s: Snapshot) => {
      s.headers["content-type"] = "text/plain";
    },
    (s: Snapshot) => {
      delete s.headers["content-type"];
    },
    (s: Snapshot) => {
      s.headers["content-type"] = "text/html, text/plain";
    },
    (s: Snapshot) => {
      s.headers["Content-Type"] = "text/plain";
    },
    (s: Snapshot) => {
      s.headers["content-range"] = "bytes 0-10/100";
    },
    (s: Snapshot) => {
      s.binary = { media_type: "application/pdf", sha256: "a".repeat(64) };
    },
    (s: Snapshot) => {
      s.requested_url = `${home}alias`;
    },
    (s: Snapshot) => {
      s.url = `${home}alias`;
    },
    (s: Snapshot) => {
      s.url = `https://${host}:443/`;
    },
    (s: Snapshot) => {
      s.url = home.slice(0, -1);
    },
    (s: Snapshot) => {
      s.bytes = -1;
    },
    (s: Snapshot) => {
      s.bytes = Number.POSITIVE_INFINITY;
    },
    (s: Snapshot) => {
      s.redirects = [{ url: `${home}alias`, location: home, status: 302, snapshot: "a".repeat(64) }];
    },
    (s: Snapshot) => {
      s.redirects = [{ url: home, location: `${home}alias`, status: 302, snapshot: "a".repeat(64) }];
    },
  ])("rejects incomplete, binary, ambiguous, or differently identified sources %#", (mutate) => {
    const input = observed();
    mutate(input.snapshot);
    input.sha256 = snapshotDigest(input.snapshot);
    expect(() => discover(input)).toThrow();
  });

  it("rejects coordinated HTML and HTTP title rewrites under the original snapshot digest", () => {
    const input = observed(link(undefined, "Home"), { link: header(undefined, "Home") });
    const originalDigest = input.sha256;
    input.snapshot.body = input.snapshot.body.replace('title="Home"', 'title="Invented"');
    input.snapshot.headers.link = header(undefined, "Invented");
    input.snapshot.bytes = Buffer.byteLength(input.snapshot.body);
    expect(snapshotDigest(input.snapshot)).not.toBe(originalDigest);
    expect(() => discover(input)).toThrow("snapshot digest does not bind");
    input.sha256 = snapshotDigest(input.snapshot);
    expect(discover(input).map(({ title }) => title)).toEqual(["Invented", "Invented"]);
  });

  it("rejects a well-shaped but unbound snapshot digest", () => {
    expect(() => discover({ ...observed(), sha256: "0".repeat(64) })).toThrow("snapshot digest does not bind");
  });

  it("checks digest binding before parsing malformed advertisements", () => {
    const input = observed('<template><base href="/node/"></template>', { link: "malformed" });
    input.sha256 = "0".repeat(64);
    expect(() => discover(input)).toThrow("snapshot digest does not bind");
  });

  it("checks HTML and Link byte bounds before hashing the supplied snapshot", () => {
    for (const input of [
      observed(`<!-- ${"x".repeat(4 * 1024 * 1024)} -->`),
      observed(link(), { link: "x".repeat(64 * 1024 + 1) }),
    ]) {
      input.sha256 = "0".repeat(64);
      expect(() => discover(input)).toThrow("byte limit exceeded");
    }
  });

  it.each(["", "a".repeat(63), "g".repeat(64), "A".repeat(64), `${"a".repeat(64)}\n`])(
    "rejects malformed snapshot digests %#",
    (sha256) => expect(() => discover({ ...observed(), sha256 })).toThrow(),
  );

  it.each([
    "text/html\r\n; charset=utf-8",
    "text/html\u00a0; charset=utf-8",
    "text/html; charset=utf-8; charset=utf-16",
  ])("rejects malformed or duplicate source media parameters %#", (type) =>
    expect(() => discover(observed(link(), { "content-type": type }))).toThrow(),
  );

  it("accepts case-insensitive header names and HTML media type", () => {
    const input = observed();
    input.snapshot.headers = { "Content-Type": "Text/HTML; charset=UTF-8", Link: header() };
    input.sha256 = snapshotDigest(input.snapshot);
    expect(discover(input).map((value) => value.channel)).toEqual(["html-head", "http-link"]);
  });
});

describe("active original HTML head witnesses", () => {
  it.each(pairs)("binds a witness to %s and its source digest", (hostname, node) => {
    const input = observed(link(`/node/${node}.md`, "Home"));
    input.snapshot.url = `https://${hostname}/`;
    input.snapshot.requested_url = input.snapshot.url;
    input.sha256 = snapshotDigest(input.snapshot);
    const selected = markdownSources(hostname);
    expect(discover(input, selected)).toEqual([
      {
        source_url: selected[0]!.source_url,
        snapshot_sha256: input.sha256,
        target_url: selected[0]!.target_url,
        channel: "html-head",
        title: "Home",
      },
    ]);
  });

  it("decodes HTML attribute syntax without trimming, entity re-decoding or H1 borrowing", () => {
    const title = "  Home, &quot;literal&quot; &amp;lt;tag&amp;gt;  ";
    expect(discover(observed(link(undefined, title)))[0]!.title).toBe('  Home, "literal" &lt;tag&gt;  ');
    expect(discover()[0]!.title).toBeNull();
    expect(discover(observed(link(undefined, "")))[0]!.title).toBe("");
  });

  it("keeps hostile-looking titles as literal data", () => {
    expect(discover(observed(link(undefined, "&lt;script&gt;alert(1)&lt;/script&gt;")))[0]!.title).toBe(
      "<script>alert(1)</script>",
    );
  });

  it.each(["nul\u0000title", "line&#10;break", "control&#x7f;title", "bidi&#x202e;title"])(
    "rejects raw or decoded control-bearing HTML titles %#",
    (title) => expect(() => discover(observed(link(undefined, title)))).toThrow(),
  );

  it.each([
    '<link rel="\u00a0alternate\u00a0" type="text/markdown" href="/node/1.md">',
    '<link rel="alternate" type="\u00a0text/markdown\u00a0" href="/node/1.md">',
    '<link rel="alternate" type="text/markdown; charset=utf-8" href="/node/1.md">',
    '<link rel="alternate canonical" type="text/markdown" href="/node/1.md">',
    '<link rel="alternate shortlink" type="text/markdown" href="/node/1.md">',
  ])("does not repair non-HTML token separators or conflicting media/roles %#", (head) => {
    expect(() => discover(observed(head))).toThrow();
  });

  it("matches mixed-case relation tokens and MIME without token substring matching", () => {
    expect(discover(observed('<LINK REL="help\tALTERNATE next" TYPE="TEXT/MARKDOWN" HREF="/node/1.md">'))).toHaveLength(
      1,
    );
    expect(() => discover(observed(link().replace("alternate", "not-alternate")))).toThrow();
    expect(() => discover(observed(link().replace("text/markdown", "text/markdown-extra")))).toThrow();
  });

  it.each([
    html("", link()),
    html(`<!-- ${link()} -->`),
    html(`<template>${link()}</template>`),
    html(`<noscript>${link()}</noscript>`),
    html(`<script>${JSON.stringify(link())}</script>`),
    html("", `<head>${link()}</head>`),
    `${link()}${html()}`,
    `${html()}${link()}`,
    `<html><body>${link()}</body></html>`,
    html(`<meta name="description" content='${link()}'>`),
    html('<link rel="canonical shortlink" type="text/markdown" href="/node/1.md">'),
  ])("does not promote inert, relocated, body or unrelated metadata %#", (body) => {
    const input = observed();
    input.snapshot.body = body;
    input.snapshot.bytes = Buffer.byteLength(body);
    input.sha256 = snapshotDigest(input.snapshot);
    expect(() => discover(input)).toThrow();
  });

  it("ignores inert conflicting advertisements beside active proof", () => {
    expect(
      discover(
        observed(
          `${link()}<template>${link("/node/9.md")}</template><noscript>${link("/node/8.md")}</noscript><!-- ${link("/node/7.md")} -->`,
          {},
          link("/node/6.md"),
        ),
      ),
    ).toHaveLength(1);
  });

  it.each([
    link().replace('rel="alternate"', 'rel="alternate" REL="canonical"'),
    link().replace('href="/node/1.md"', 'href="/node/1.md" HREF="/node/2.md"'),
    link().replace('type="text/markdown"', 'type="text/plain" TYPE="text/markdown"'),
    link().replace('href="/node/1.md"', 'href="/node/1.md" href="/node/1.md"'),
    link().replace('href="/node/1.md"', 'href="/node/1.md" title="A" TITLE="B"'),
    '<link rel="alternate" type="text/markdown">',
    '<link rel="alternate" type="text/markdown" href="/node/1.md" title="unterminated>',
  ])("fails closed on duplicated or malformed head attributes %#", (head) => {
    expect(() => discover(observed(`${link()}${head}`))).toThrow();
  });
});

describe("channel-specific URL resolution", () => {
  it("resolves relative HTML and HTTP targets using different contexts", () => {
    const result = discover(observed(`<base href="/node/">${link("1.md")}`, { link: header("node/1.md") }));
    expect(result.map((item) => item.target_url)).toEqual([target, target]);
    expect(result.map((item) => item.channel)).toEqual(["html-head", "http-link"]);
    expect(() => discover(observed(`<base href="/node/">${link("1.md")}`, { link: header("1.md") }))).toThrow();
  });

  it("rejects an inert template base instead of manufacturing a relative HTML witness", () => {
    const head = `<template><base href="/node/"></template>${link("1.md")}`;
    expect(() => discover(observed(head))).toThrow();
    expect(() => discover(observed(link("1.md")))).toThrow();
  });

  it("does not let a valid HTTP witness hide an inert base manufacturing HTML proof", () => {
    const head = `<template><base href="/node/"></template>${link("1.md")}`;
    expect(() => discover(observed(head, { link: header(target) }))).toThrow();
  });

  it.each([
    html("", '<base href="/node/">'),
    `<base href="/node/">${html()}`,
    `${html()}<base href="/node/">`,
    html('<template><template><base href="/node/"></template></template>'),
  ])("rejects every inert or parser-relocated base considered by the shared helper %#", (body) => {
    const input = observed("", { link: header(target) });
    input.snapshot.body = body;
    input.snapshot.bytes = Buffer.byteLength(body);
    input.sha256 = snapshotDigest(input.snapshot);
    expect(() => discover(input)).toThrow();
  });

  it.each([
    '<base href="/node/"><base href="/node/">',
    '<base href="https://other.ubc.ca/">',
    '<base href="https://reader@mining.ubc.ca/">',
    '<base href="/node/#ignored">',
    '<base href="/node/?x=1">',
    '<base href="/node/%00/">',
    '<base href="/node/" HREF="/other/">',
  ])("rejects unsafe or ambiguous HTML bases %#", (base) => {
    expect(() => discover(observed(`${base}${link()}`, { link: header() }))).toThrow();
  });

  it.each([
    "https://other.ubc.ca/node/1.md",
    "https://reader@mining.ubc.ca/node/1.md",
    "https://reader:secret@mining.ubc.ca/node/1.md",
    "http://mining.ubc.ca/node/1.md",
    "https://mining.ubc.ca:8443/node/1.md",
    "https://mining.ubc.ca:443/node/1.md",
    "https://mining.ubc.ca./node/1.md",
    "https://MINING.UBC.CA/node/1.md",
    "https:////mining.ubc.ca/node/1.md",
    "mining.ubc.ca/node/1.md",
    "reader@mining.ubc.ca/node/1.md",
    "/node/2.md",
    "/node/2421.md",
    "/node/1.md?",
    "/node/1.md#",
    "/node/1.md?download=1",
    "/node/1.md#text",
    "/node/1.md%00",
    "/node/%31.md",
    "/node/%2531.md",
    "/node/1.md%0a",
    "/node/1.md%C2%85",
    "/node/%5c1.md",
    "/node/%zz.md",
    "/node/\t1.md",
    "/node/../node/1.md",
    "/node/%2e%2e/node/1.md",
    "/node//1.md",
    "\\node\\1.md",
    "javascript:alert(1)",
    "data:text/markdown,Home",
    "",
  ])("rejects unsafe, repaired or undeclared Markdown targets %s", (href) => {
    expect(() => discover(observed(`${link()}${link(href)}`))).toThrow();
    expect(() => discover(observed(link(), { link: header(href) }))).toThrow();
  });
});

describe("bounded HTTP Link grammar", () => {
  it("parses quoted commas, semicolons and backslash escapes without splitting titles", () => {
    const input = observed("", {
      link: `${header(undefined, 'Home, \\"Quoted\\"; \\Path')}, <style.css>; rel=stylesheet; type="text/css"`,
    });
    expect(discover(input)).toEqual([
      {
        source_url: home,
        snapshot_sha256: input.sha256,
        target_url: target,
        channel: "http-link",
        title: 'Home, "Quoted"; Path',
      },
    ]);
  });

  it("preserves quoted backslashes and literal Unicode text", () => {
    const text = 'Home \\ path, "quoted" — 工程';
    const escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    expect(discover(observed("", { link: header(undefined, escaped) }))[0]!.title).toBe(text);
    expect(discover(observed(link(undefined, "工程 &amp; café")))[0]!.title).toBe("工程 & café");
  });

  it("does not HTML-decode HTTP title values", () => {
    expect(discover(observed("", { link: header(undefined, "  &quot;Home&quot;  ") }))[0]!.title).toBe(
      "  &quot;Home&quot;  ",
    );
  });

  it("accepts a bounded set of relation casing, order, quoting and whitespace variations", () => {
    for (const rel of ['"ALTERNATE help"', '"help alternate"', "alternate", '"alternate ALTERNATE"']) {
      for (const title of ["Home", "Home, Mining", "A; B", 'A \\"quote\\"']) {
        for (const spacing of [" ", "\t", ""]) {
          const value = `<node/1.md>${spacing};${spacing}TYPE="Text/Markdown"; ReL=${rel}; title="${title}"`;
          const result = discover(observed("", { link: value }));
          expect(result).toHaveLength(1);
          expect(result[0]!.target_url).toBe(target);
        }
      }
    }
  });

  it("accepts explicit exact source anchors but never a target/source substitution", () => {
    expect(discover(observed("", { link: `${header()}; anchor="${home}"` }))).toHaveLength(1);
    expect(discover(observed("", { link: `${header()}; anchor="/"` }))).toHaveLength(1);
  });

  it.each([
    `${header()}; anchor="/other"`,
    `${header()}; anchor="#part"`,
    `${header()}; anchor="${target}"`,
    `${header()}; anchor="https://scarp.ubc.ca/"`,
    `${header()}; rel="alternate"`,
    `${header()}; TYPE="text/markdown"`,
    `${header()}; title="Home"; TITLE="Home"`,
    `${header()}; x=one; X=two`,
    `${header()}; title*=UTF-8'en'Home`,
    `${header()}; title`,
    `${header()}; =value`,
    `${header()}; title="unterminated`,
    `${header()}; title="escaped\\`,
    `${header()}; title="Home"garbage`,
    `${header()}; type="text/plain"`,
    `${header()}; anchor="/"; anchor="/"`,
    `${header()}; rel="alternate canonical"`,
    `${header()};`,
    `${header()},`,
    `,${header()}`,
    `${header()},,${header()}`,
    `${header()} ${header()}`,
    `/node/1.md; rel=alternate; type="text/markdown"`,
    `</node/1.md; rel=alternate; type="text/markdown"`,
    `</node/1.md>>; rel=alternate; type="text/markdown"`,
    `${header()}; title="injected\r\nX-Evil: yes"`,
    `${header()}; title="injected\u0000title"`,
    `${header()}; title="control\u0085title"`,
    `${header()}; title="bidi\u202etitle"`,
    `${header()}; title="Home", broken`,
    `${header()}; type=text/markdown`,
  ])("rejects malformed, ambiguous or unsupported headers %#", (value) => {
    expect(() => discover(observed(link(), { link: value }))).toThrow();
  });

  it("rejects case-duplicated Link header fields rather than selecting one", () => {
    expect(() => discover(observed(link(), { link: header(), Link: header("/node/2.md") }))).toThrow();
  });

  it("accepts declared inclusive parser boundaries without truncating exact duplicates", () => {
    const title = "a".repeat(4096);
    expect(discover(observed(link(undefined, title), { link: header(undefined, title) }))).toHaveLength(2);
    const parameters = Array.from({ length: 30 }, (_, i) => `p${i}=x`).join(";");
    expect(discover(observed("", { link: `${header()};${parameters}` }))).toHaveLength(1);
    const attributes = Array.from({ length: 61 }, (_, i) => `p${i}="x"`).join(" ");
    expect(discover(observed(link().replace(">", ` ${attributes}>`)))).toHaveLength(1);
    expect(
      discover(observed(link().repeat(256), { link: Array.from({ length: 256 }, () => header()).join(",") })),
    ).toHaveLength(2);
  });

  it.each([
    { head: link().repeat(257), value: header() },
    { head: link().replace(">", ` data-value="${"x".repeat(16 * 1024)}">`), value: header() },
    { head: link().replace(">", ` ${Array.from({ length: 62 }, (_, i) => `p${i}="x"`).join(" ")}>`), value: header() },
    { head: link(undefined, "a".repeat(4097)), value: header() },
    { head: link(), value: header(undefined, "a".repeat(4097)) },
    { head: link(), value: `${header()}; a=${"b".repeat(70_000)}` },
    { head: link(), value: Array.from({ length: 257 }, () => header()).join(",") },
    { head: link(), value: `${header()}; ${Array.from({ length: 33 }, (_, i) => `p${i}=x`).join(";")}` },
    { head: `${link()}<!-- ${"x".repeat(4 * 1024 * 1024)} -->`, value: header() },
  ])("rejects parser overflow instead of truncating %#", ({ head, value }) => {
    expect(() => discover(observed(head, { link: value }))).toThrow();
  });
});

describe("witness consistency and immutability", () => {
  it("collapses only exact duplicates in stable channel/title order", () => {
    const input = observed(`${link(undefined, "Home")}${link()}${link(undefined, "Home")}`, {
      link: `${header(undefined, "Home")}, ${header()}, ${header(undefined, "Home")}`,
    });
    const result = discover(input);
    expect(result.map((item) => [item.channel, item.title])).toEqual([
      ["html-head", null],
      ["html-head", "Home"],
      ["http-link", null],
      ["http-link", "Home"],
    ]);
    const reordered = observed(`${link()}${link(undefined, "Home")}`, {
      link: `${header()}, ${header(undefined, "Home")}`,
    });
    expect(reordered.sha256).not.toBe(input.sha256);
    const reorderedResult = discover(reordered);
    expect(reorderedResult.every((item) => item.snapshot_sha256 === reordered.sha256)).toBe(true);
    expect(result.every((item) => item.snapshot_sha256 === input.sha256)).toBe(true);
    expect(reorderedResult.map(({ channel, title, target_url }) => ({ channel, title, target_url }))).toEqual(
      result.map(({ channel, title, target_url }) => ({ channel, title, target_url })),
    );
  });

  it.each([
    observed(link(undefined, "Home"), { link: header(undefined, "Mining") }),
    observed(`${link(undefined, "Home")}${link(undefined, " Home ")}`),
    observed("", { link: `${header(undefined, "Home")}, ${header(undefined, "HOME")}` }),
    observed(link(undefined, " "), { link: header(undefined, "Home") }),
    observed(`${link()}${link("/node/9.md")}`),
    observed(link(), { link: header("/node/9.md") }),
  ])("rejects conflicting nonempty titles or Markdown targets %#", (input) => {
    expect(() => discover(input)).toThrow();
  });

  it("allows absent and explicitly empty titles beside a literal title", () => {
    expect(discover(observed(`${link()}${link(undefined, "")}`, { link: header(undefined, "Home") }))).toHaveLength(3);
  });

  it("never mutates observations or caller-owned declarations and deeply freezes its outputs", () => {
    const input = deepFreeze(observed(link(undefined, "Home"), { link: header(undefined, "Home") }));
    const declarations = deepFreeze([{ ...declaration }]);
    const before = JSON.stringify({ input, declarations });
    const result = discover(input, declarations);
    expect(JSON.stringify({ input, declarations })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    for (const witness of result) {
      expect(Object.isFrozen(witness)).toBe(true);
      expect(() => {
        (witness as { title: string }).title = "Changed";
      }).toThrow();
    }
    const mutableInput = observed();
    const mutableDeclaration = { ...declaration };
    discover(mutableInput, [mutableDeclaration]);
    expect(Object.isFrozen(mutableInput)).toBe(false);
    expect(Object.isFrozen(mutableDeclaration)).toBe(false);
  });
});

describe("exact Markdown target identity", () => {
  it("accepts an identity-preserving response without inferring any content equivalence", () => {
    const input = deepFreeze(targetObservation());
    expect(() => assertMarkdownIdentity(deepFreeze({ ...declaration }), input)).not.toThrow();
  });

  it("rejects redirect overflow rather than checking only a prefix", () => {
    const input = targetObservation();
    input.snapshot.redirects = Array.from({ length: 33 }, () => ({
      url: target,
      location: target,
      status: 302,
      snapshot: "b".repeat(64),
    }));
    input.sha256 = snapshotDigest(input.snapshot);
    expect(() => assertMarkdownIdentity(declaration, input)).toThrow();
  });

  it("accepts only identity-preserving redirect locations", () => {
    const input = targetObservation();
    input.snapshot.redirects = [{ url: target, location: target, status: 302, snapshot: "b".repeat(64) }];
    input.sha256 = snapshotDigest(input.snapshot);
    expect(() => assertMarkdownIdentity(declaration, input)).not.toThrow();
  });

  it.each([
    (s: Snapshot) => {
      s.requested_url = home;
    },
    (s: Snapshot) => {
      s.url = `${home}node/2.md`;
    },
    (s: Snapshot) => {
      s.url = `${target}#`;
    },
    (s: Snapshot) => {
      s.url = `${target}?`;
    },
    (s: Snapshot) => {
      s.url = `https://reader@${host}/node/1.md`;
    },
    (s: Snapshot) => {
      s.url = `https://${host}:443/node/1.md`;
    },
    (s: Snapshot) => {
      s.redirects = [{ url: home, location: target, status: 302, snapshot: "b".repeat(64) }];
    },
    (s: Snapshot) => {
      s.redirects = [{ url: target, location: home, status: 302, snapshot: "b".repeat(64) }];
    },
    (s: Snapshot) => {
      s.redirects = [
        { url: target, location: `${home}alias`, status: 302, snapshot: "b".repeat(64) },
        { url: `${home}alias`, location: target, status: 302, snapshot: "c".repeat(64) },
      ];
    },
  ])("rejects any requested, final or intermediate identity substitution %#", (mutate) => {
    const input = targetObservation();
    mutate(input.snapshot);
    input.sha256 = snapshotDigest(input.snapshot);
    expect(() => assertMarkdownIdentity(declaration, input)).toThrow();
  });
});
