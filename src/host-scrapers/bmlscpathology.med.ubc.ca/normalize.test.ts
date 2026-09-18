import { readFileSync } from "node:fs";
import { load, type CheerioAPI } from "cheerio";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { wordpressRecordInput } from "../../host-crawl/adapters/wordpress-content.ts";
import { assertSafeMarkdown, toSafeMarkdown } from "../../prose/markdown.ts";
import type { ArticleInput } from "../../prose/model.ts";
import { bmlscScraper } from "./index.ts";
import { normalizeArticle } from "./normalize.ts";

const HOME = "https://bmlscpathology.med.ubc.ca/";
const FIXTURES = ["curriculum-grid", "entrance-grid", "gpa-grid", "coop-grid", "student-widgets"];
const text = (value: string) => value.replace(/\s+/g, " ").trim();
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../test/fixtures/host-scrapers/bmlscpathology.med.ubc.ca/${name}.html`, import.meta.url),
    "utf8",
  );
const input = (html: string): ArticleInput => ({
  url: `${HOME}sample/`,
  html,
  title: "Synthetic example",
  retrievedAt: "2026-01-02T00:00:00Z",
  sourceModifiedAt: "2025-01-02T00:00:00Z",
  upstreamId: "999",
  warnings: ["Existing provenance"],
});

function normalized(html: string) {
  const article = normalizeArticle(input(html));
  const result = toSafeMarkdown(article.html, article.url);
  assertSafeMarkdown(result.markdown);
  const $ = load(new MarkdownIt().render(result.markdown));
  return { article, ...result, $ };
}

function rows($: CheerioAPI, selector: string) {
  return $(selector)
    .find("tr")
    .toArray()
    .map((row) =>
      $(row)
        .children("th,td")
        .toArray()
        .map((cell) => text($(cell).text())),
    );
}

function mutate(name: string, change: ($: CheerioAPI) => void) {
  const $ = load(fixture(name), {}, false);
  change($);
  return $.root().html()!;
}

describe("BMLSc semantic widget normalization", () => {
  it("keeps the one normalizer on both host extraction paths", () => {
    expect(bmlscScraper.normalizeArticle).toBe(normalizeArticle);
    expect(bmlscScraper.adapter).toMatchObject({ apiContentFallback: true });
    const html = `<div id="content"><div class="hentry"><div class="entry-content">${fixture("curriculum-grid")}</div></div></div>`;
    const result = bmlscScraper.extract({
      requested_url: `${HOME}sample/`,
      url: `${HOME}sample/`,
      status: 200,
      headers: { "content-type": "text/html" },
      retrieved_at: "2026-01-02T00:00:00Z",
      body: html,
      bytes: Buffer.byteLength(html),
    });
    expect(result.kind).toBe("document");
    if (result.kind !== "document") throw new Error("Expected synthetic document");
    expect(text(load(result.input.html)("h2.year__bar").text())).toBe("Year 3 — 31–32 credits — 14 courses");
  });

  it.each(FIXTURES)("normalizes unwrapped %s fragments idempotently without changing metadata", (name) => {
    const original = input(fixture(name));
    const first = normalizeArticle(original);
    expect(first.html).not.toBe(original.html);
    expect({ ...first, html: original.html }).toEqual(original);
    expect(normalizeArticle(first)).toBe(first);
    expect(normalizeArticle(original)).toEqual(first);
    const wrapped = normalized(`<div class="entry-content">${original.html}</div>`);
    expect(wrapped.markdown).toBe(normalized(original.html).markdown);
  });

  it("normalizes independently public API content without inventing an HTML-page observation", () => {
    const apiUrl = `${HOME}wp-json/wp/v2/pages/999`;
    const body = JSON.stringify({
      id: 999,
      type: "page",
      status: "publish",
      link: `${HOME}sample/`,
      title: { rendered: "Sample requirements" },
      content: { protected: false, rendered: fixture("entrance-grid") },
      modified_gmt: "2025-01-02T00:00:00",
    });
    const original = wordpressRecordInput(
      {
        sha256: "a".repeat(64),
        snapshot: {
          requested_url: apiUrl,
          url: apiUrl,
          status: 200,
          headers: { "content-type": "application/json" },
          body,
          bytes: Buffer.byteLength(body),
          retrieved_at: "2026-01-02T00:00:00Z",
        },
      },
      { id: 999, type: "page", url: `${HOME}sample/`, api_url: apiUrl, modified: "2025-01-02T00:00:00Z" },
      bmlscScraper.hostname,
    );
    const result = bmlscScraper.normalizeArticle!(original);
    expect(load(result.html)("table").length).toBe(2);
    expect(result.url).toBe(apiUrl);
    expect(result.warnings).toEqual(original.warnings);
    expect(result.warnings?.[0]).toContain("independently public WordPress REST record");
    expect({ ...result, html: original.html }).toEqual(original);
  });

  it("separates year labels from numeric credit totals in the curriculum summary", () => {
    const result = normalized(fixture("curriculum-grid"));
    expect(text(result.$.root().text())).toContain("Year 3 — 31–32 cr");
    expect(text(result.$.root().text())).toContain("Year 4 — 30 cr");
    expect(result.markdown).not.toMatch(/Year 331|Year 430/);
  });

  it.each(["label", "unit"])("rejects a malformed credit-summary %s instead of guessing", (part) => {
    const html = mutate("curriculum-grid", ($) => {
      if (part === "label") $(".credit").first().children(".credit__l").remove();
      else $(".credit").first().find("small").remove();
    });
    expect(() => normalizeArticle(input(html))).toThrow(/credit summary/);
  });

  it("separates curriculum fields without calculating or reconciling credits", () => {
    const result = normalized(fixture("curriculum-grid"));
    const $ = result.$;
    expect(text($("h2").text())).toBe("Year 3 — 31–32 credits — 14 courses");
    expect(
      $("h3")
        .map((_, node) => text($(node).text()))
        .get(),
    ).toEqual(["Sample laboratory skills — 9 cr", "Optional / as required"]);
    expect(
      $("li")
        .map((_, node) => text($(node).text()))
        .get(),
    ).toEqual([
      "TEST_V 301 — Observation & measurement[1] — 3 cr",
      "TEST_V 302 — Sample methods[2] — 1.5 cr",
      "TEST_V 401 / DEMO_V 402 — Optional sample[3] (see below) — —",
    ]);
    expect(result.links).toEqual(
      expect.arrayContaining([
        { text: "1", url: `${HOME}sample/#note-1` },
        { text: "TEST_V 302 — Sample methods[2] — 1.5 cr", url: `${HOME}files/sample-syllabus.pdf#outline` },
      ]),
    );
    expect(text($.text())).toContain("Keep the stated total, even when it differs from these rows.");
    const dom = load(result.article.html);
    expect(dom(".crow__name > .pdf > svg").length).toBe(0);
    expect(dom("#unknown").html()).toBe(load(fixture("curriculum-grid"))("#unknown").html());
    expect(dom("#unknown svg title").text()).toBe("Laboratory map");
  });

  it("keeps unknown content between course rows in its original position", () => {
    const html = mutate("curriculum-grid", ($) => {
      $(".crow").first().after('Unassigned prose<span class="unknown-course-note">Unknown note</span>');
    });
    const result = normalized(html);
    const prose = text(result.$.text());
    expect(prose.indexOf("Unassigned prose")).toBeGreaterThan(prose.indexOf("TEST_V 301"));
    expect(prose.indexOf("Unknown note")).toBeLessThan(prose.indexOf("TEST_V 302"));
    expect(load(result.article.html)(".unknown-course-note").html()).toBe("Unknown note");
  });

  it("keeps titled visuals inside the known PDF wrapper rather than blanket-removing SVG", () => {
    const html = mutate("curriculum-grid", ($) => {
      $(".pdf svg").prepend("<title>Sample course diagram</title>");
    });
    const result = normalized(html);
    expect(load(result.article.html)(".pdf svg title").text()).toBe("Sample course diagram");
    expect(result.markdown).toContain("Embedded svg");
  });

  it("builds separate entrance tables with sourced captions, headers and intact cell associations", () => {
    const { $, article, links } = normalized(fixture("entrance-grid"));
    const headers = ["Subject", "UBC Vancouver", "UBC Okanagan"];
    expect(rows($, "table:first-of-type")).toEqual([
      headers,
      ["Sample science", "TEST 111 or TEST 112[2] + 113", "DEMO 121 and lab credit[3,4]"],
      ["Sample arts", "6 credits — any year", ""],
    ]);
    expect(rows($, "table:last-of-type")).toEqual([
      headers,
      ["Sample advanced topic", "Vancouver only", "Okanagan only"],
    ]);
    expect(text($.text())).toContain("First sample group[1]");
    expect(text($.text())).toContain("Second sample group");
    expect(links).toContainEqual({ text: "lab credit", url: `${HOME}requirements/#lab` });
    expect(load(article.html)("#unknown-grid").html()).toBe(load(fixture("entrance-grid"))("#unknown-grid").html());
    const renamed = normalized(
      mutate("entrance-grid", ($) => {
        $(".gt__cell--head").eq(1).html("<em>Source campus label</em>");
      }),
    );
    expect(rows(renamed.$, "table:first-of-type")[0]).toEqual(["Subject", "Source campus label", "UBC Okanagan"]);
  });

  it("retains explicit span attributes and nested cell structure for the shared complex-table renderer", () => {
    const html = mutate("entrance-grid", ($) => {
      $(".gt__cell--head").first().attr("colspan", "2");
      $(".gt__cell--rowlabel:not(.gt__cell--head)").first().attr("rowspan", "2");
      $(".gt__val").first().append("<ul><li>Sample cell note</li></ul>");
    });
    const result = normalized(html);
    const $ = load(result.article.html);
    expect($("th[colspan=2]").length).toBe(2);
    expect($("td[rowspan=2]").length).toBe(1);
    expect(result.markdown).toContain("colspan 2");
    expect(result.markdown).toContain("rowspan 2");
    expect(result.markdown).toContain("Sample cell note");
    expect(result.warnings).toContain(
      "A complex table is represented as row/cell lists; merged-cell spans are labelled.",
    );
  });

  it("separates GPA percentages and grades, retaining every row and collapsed FAQ", () => {
    const result = normalized(fixture("gpa-grid"));
    expect(rows(result.$, "table")).toEqual([
      ["Entrance GPA range", "Average entrance GPA", "Average graduation GPA"],
      ["80–96%", "85% A−", "88% A"],
      ["60–71%", "67% B−[1]", "79% B+"],
    ]);
    const source = load(fixture("gpa-grid"));
    for (const node of source("summary,p").toArray())
      expect(text(result.$.text())).toContain(text(source(node).text()).replace(/^1/, "[1]"));
    expect(load(result.article.html)("details[hidden]").length).toBe(1);
    expect(result.links).toContainEqual({ text: "B+", url: `${HOME}grade-legend/` });
  });

  it("retains the exact schedule order and each term/tag column association", () => {
    const result = normalized(fixture("coop-grid"));
    expect(rows(result.$, "table")).toEqual([
      ["Year", "Fall", "Winter", "Summer"],
      ["3", "Study Term 5 — Apply for Co-op", "Study Term 6[1] — Study", "Work Term 1 — Work"],
      ["4", "Work Term 2 — Work", "Work Term 3 — Work", "Work Term 4 — Work"],
      ["5", "Study Term 7 — Study", "Study Term 8 — Study", "—"],
    ]);
    expect(result.links).toContainEqual({ text: "Work", url: `${HOME}sample-work/` });
  });

  it("gives each alumni card one linked source name and retains its intact photo, year and role", () => {
    const html = fixture("student-widgets");
    const source = load(html);
    const result = normalized(html);
    const dom = load(result.article.html);
    expect(dom(".alumni > article.alum").length).toBe(2);
    for (const [i, node] of source(".alumni > a.alum").toArray().entries()) {
      const original = source(node);
      const actual = dom(".alumni > article.alum").eq(i);
      expect(actual.find("a").length).toBe(1);
      expect(actual.find("h3 a").attr("href")).toBe(original.attr("href"));
      for (const selector of [".alum__photo", ".alum__year", ".alum__role"])
        expect(actual.find(selector).html()).toBe(original.find(selector).html());
      expect(result.$(`a[href="${new URL(original.attr("href")!, HOME).href}"]`).length).toBe(1);
    }
    expect(
      dom(".qhint")
        .map((_, node) => text(dom(node).text()))
        .get(),
    ).toEqual([
      "Scroll instructions for a laboratory instrument must remain.",
      "Drag, scroll or use the arrows — 8 voices",
    ]);
    expect(dom("#unknown-visual").html()).toBe(source("#unknown-visual").html());
    expect(dom("a.alum[href='/unrelated/']").html()).toBe(source("a.alum[href='/unrelated/']").html());
    expect(result.links).toContainEqual({ text: "Alex Example", url: `${HOME}files/sample-person.jpg` });
    expect(text(result.$.text())).toContain("Sample laboratory coordinator");
  });

  it("deduplicates exact images per declared track, preserving first copies and near matches", () => {
    const $ = load(fixture("homepage"), {}, false);
    const track = $(".pura-col:not(.pura-col--text) > .pura-track").first();
    const first = track.children(".pura-shot").first();
    const firstBytes = $.html(first[0]!);
    for (const [attribute, value] of [
      ["alt", "Laboratory detail"],
      ["src", "/files/other.png"],
      ["title", "Different caption"],
      ["srcset", "/files/high-resolution.png 2x"],
    ]) {
      const near = first.clone();
      near.find("img").attr(attribute!, value!);
      track.append(near);
    }
    const linked = first.clone().wrapInner('<a href="/first-story/">');
    const otherLink = linked.clone();
    otherLink.find("a").attr("href", "/second-story/");
    track.append(
      linked,
      otherLink,
      '<span class="pura-shot">Unknown non-image</span><span class="pura-shot">Unknown non-image</span>',
    );
    const expected = track
      .children()
      .toArray()
      .filter((_, i) => i !== 1)
      .map((node) => $.html(node));
    track
      .parent()
      .after('<div class="pura-col pura-col--3"><div class="pura-track pura-up pura-up--slow"></div></div>');
    $(".pura-up--slow").append(first.clone(), first.clone());
    $(".entry-content").append(first.clone(), first.clone(), '<button id="puraPause">Unknown pause</button>');
    const original = input($(".entry-content").html()!);
    const result = normalizeArticle(original);
    const dom = load(result.html);
    const actual = dom(".pura-col:not(.pura-col--3):not(.pura-col--text) > .pura-track > .pura-shot");
    expect(actual.map((_, node) => dom.html(node)).get()).toEqual(expected);
    expect(dom.html(actual[0]!)).toBe(firstBytes);
    expect(dom(".pura-up--slow > .pura-shot").length).toBe(1);
    expect(dom("body > .pura-shot").length).toBe(2);
    expect(dom("#puraPause").text()).toBe("Unknown pause");
    expect(normalizeArticle(result)).toBe(result);
  });

  it("returns unknown markup and empty articles untouched", () => {
    for (const html of [
      "",
      " <div class='gt__grid'><span>Unknown</span></div> ",
      "<svg><title>Data</title></svg><div class='year__bar'>Unknown</div>",
    ]) {
      const original = input(html);
      expect(normalizeArticle(original)).toBe(original);
    }
  });
});

const MALFORMED: [string, string, ($: CheerioAPI) => void][] = [
  [
    "curriculum-grid",
    "year heading",
    ($) => {
      $(".year__meta").remove();
    },
  ],
  [
    "curriculum-grid",
    "course row",
    ($) => {
      $(".crow").first().append("<span>Unexpected field</span>");
    },
  ],
  [
    "curriculum-grid",
    "course row",
    ($) => {
      $(".crow__cr").first().remove();
    },
  ],
  [
    "curriculum-grid",
    "course row",
    ($) => {
      $(".crow").first().append("unassigned text");
    },
  ],
  [
    "entrance-grid",
    "entrance grid headers",
    ($) => {
      $(".gt__cell--head").eq(2).remove();
    },
  ],
  [
    "entrance-grid",
    "entrance grid headers",
    ($) => {
      $(".gt__grid--main").append($(".gt__cell--head").first().clone());
    },
  ],
  [
    "entrance-grid",
    "entrance grid group boundary",
    ($) => {
      $(".gt__grid--main > .gt__cell").eq(9).remove();
    },
  ],
  [
    "entrance-grid",
    "entrance grid incomplete row",
    ($) => {
      $(".gt__grid--main > .gt__cell").last().remove();
    },
  ],
  [
    "entrance-grid",
    "entrance grid incomplete row",
    ($) => {
      $(".gt__grid--main").append('<div class="gt__cell gt__cell--group">Empty group</div>');
    },
  ],
  [
    "entrance-grid",
    "entrance grid missing group",
    ($) => {
      $(".gt__cell--group").first().remove();
    },
  ],
  [
    "entrance-grid",
    "entrance grid",
    ($) => {
      $(".gt__grid--main").append("<p>Unexpected cell</p>");
    },
  ],
  [
    "entrance-grid",
    "entrance grid",
    ($) => {
      $(".gt__grid--main").append("unassigned text");
    },
  ],
  [
    "entrance-grid",
    "entrance grid row label",
    ($) => {
      $(".gt__grid--main > .gt__cell").eq(4).removeClass("gt__cell--rowlabel");
    },
  ],
  [
    "gpa-grid",
    "GPA grid incomplete row",
    ($) => {
      $("#gpaTable .gt__cell").last().remove();
    },
  ],
  [
    "gpa-grid",
    "GPA grid headers",
    ($) => {
      $("#gpaTable .gt__cell--head").eq(1).removeClass("gt__cell--head");
    },
  ],
  [
    "gpa-grid",
    "GPA grid column label",
    ($) => {
      $("#gpaTable .gt__cell[data-l]").first().attr("data-l", "Average graduation GPA");
    },
  ],
  [
    "gpa-grid",
    "GPA grid group boundary",
    ($) => {
      $("#gpaTable .gt__grid").append('<div class="gt__cell gt__cell--group">Unexpected group</div>');
    },
  ],
  [
    "coop-grid",
    "schedule width",
    ($) => {
      $(".sched__row").last().children().last().remove();
    },
  ],
  [
    "coop-grid",
    "schedule header",
    ($) => {
      $(".sched__row--head").remove();
    },
  ],
  [
    "coop-grid",
    "schedule rows",
    ($) => {
      $(".sched").append("<p>Unassigned term</p>");
    },
  ],
  [
    "coop-grid",
    "schedule term",
    ($) => {
      $(".term").first().remove();
    },
  ],
  [
    "coop-grid",
    "schedule column label",
    ($) => {
      $("[data-term]").first().attr("data-term", "Winter");
    },
  ],
  [
    "student-widgets",
    "alumni card",
    ($) => {
      $(".alum__name").first().remove();
    },
  ],
];

it.each(MALFORMED)("fails closed for malformed %s: %s", (name, reason, change) => {
  const original = input(mutate(name, change));
  const unchanged = structuredClone(original);
  expect(() => normalizeArticle(original)).toThrow(`Malformed BMLSc ${reason}`);
  expect(original).toEqual(unchanged);
});
