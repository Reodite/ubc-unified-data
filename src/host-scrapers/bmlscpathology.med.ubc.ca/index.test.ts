import { readFileSync } from "node:fs";
import { load, type CheerioAPI } from "cheerio";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { defineWordpressHost } from "../../host-crawl/adapters/wordpress-page.ts";
import type { Snapshot } from "../../host-crawl/contracts.ts";
import { assertSafeMarkdown, toSafeMarkdown } from "../../prose/markdown.ts";
import { bmlscScraper } from "./index.ts";

const HOME = "https://bmlscpathology.med.ubc.ca/";
const PROGRAM = "Bachelor of Medical Laboratory Science (BMLSc) Program";
const CONTENT = "#content > .hentry > .entry-content";
const TRACK = "#student-stories .pura-col--text > .pura-track.pura-down";
const CARDS = `${TRACK} > figure.pura-qcard`;
const text = (value: string) => value.replace(/\s+/g, " ").trim();
const shared = defineWordpressHost({
  hostname: bmlscScraper.hostname,
  title: bmlscScraper.title,
  scope: bmlscScraper.scope,
  selectors: [CONTENT],
  officialHomepage: () => true,
});

function snapshot(fixture: string, pathname = "/"): Snapshot {
  const body = readFileSync(
    new URL(`../../../test/fixtures/host-scrapers/bmlscpathology.med.ubc.ca/${fixture}.html`, import.meta.url),
    "utf8",
  );
  return {
    requested_url: new URL(pathname, HOME).href,
    url: new URL(pathname, HOME).href,
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
    body,
    retrieved_at: "2026-06-03T12:00:00Z",
    bytes: Buffer.byteLength(body),
  };
}

function changed(observation: Snapshot, change: ($: CheerioAPI) => void): Snapshot {
  const $ = load(observation.body);
  change($);
  const body = $.html();
  return { ...observation, body, bytes: Buffer.byteLength(body) };
}

function homepage(change: ($: CheerioAPI) => void): Snapshot {
  return changed(snapshot("homepage"), change);
}

function extract(observation: Snapshot) {
  const result = bmlscScraper.extract(observation);
  if (result.kind !== "document") throw new Error(`Unexpected exclusion: ${result.reason}`);
  return { input: result.input, ...toSafeMarkdown(result.input.html, result.input.url) };
}

function render(markdown: string) {
  return load(new MarkdownIt({ html: true }).render(markdown));
}

const EVIDENCE = [
  "Where are classes held",
  "I am missing CHEM 211",
  "Can I take BMLSc PATH courses",
  "Can I take electives",
  "Can I apply if I already have a degree",
  "Is the BMLSc the same as an MLT program",
];

function item($: CheerioAPI, phrase: string) {
  const selected = $(".faq-item").filter((_, element) =>
    text($(element).children("button.faq-question").text()).includes(phrase),
  );
  expect(selected.length).toBe(1);
  return selected;
}

describe("bmlscScraper homepage evidence", () => {
  it("declares the exact hostname and shared WordPress adapter", () => {
    expect(bmlscScraper.hostname).toBe("bmlscpathology.med.ubc.ca");
    expect(bmlscScraper.title).toBe(`UBC ${PROGRAM}`);
    expect(bmlscScraper.adapter).toEqual({ kind: "wordpress", allowedTypes: ["page", "post"] });
  });

  it("accepts institutional identity with substantive non-paragraph FAQ answers", () => {
    const observation = snapshot("homepage");
    const $ = load(observation.body);
    expect($(".faq-answer-content p").length).toBe(0);
    expect(bmlscScraper.vetHomepage(observation).accepted).toBe(true);
  });

  it.each(["thin", "portal", "personal", "empty", "index", "article"])("rejects the %s homepage", (fixture) => {
    expect(bmlscScraper.vetHomepage(snapshot(fixture)).accepted).toBe(false);
  });

  it.each(["#ubc7-wordmark", "#ubc7-unit-faculty", "#ubc7-unit-identifier"])("requires %s", (selector) => {
    const observation = homepage(($) => {
      expect($(selector).length).toBe(1);
      $(selector).remove();
    });
    expect(bmlscScraper.vetHomepage(observation).accepted).toBe(false);
  });

  it.each([
    ["#ubc7-wordmark a", "https://www.ubc.ca.example.org/"],
    ["#ubc7-wordmark a", "https://www.ubc.ca@evil.example/"],
    ["#ubc7-unit-name a", "https://pathology.ubc.ca/"],
    ["#ubc7-unit-name a", `${HOME}about/`],
  ])("rejects misleading institutional links: %s %s", (selector, href) => {
    expect(bmlscScraper.vetHomepage(homepage(($) => $(selector!).attr("href", href!))).accepted).toBe(false);
  });

  it("requires an explicit unit homepage link", () => {
    expect(bmlscScraper.vetHomepage(homepage(($) => $("#ubc7-unit-name a").removeAttr("href"))).accepted).toBe(false);
  });

  it("rejects personal identity even with all developed answers, but accepts the minimal identity repair", () => {
    const personal = changed(snapshot("personal"), ($) => {
      const source = load(snapshot("homepage").body);
      $(CONTENT).html(source(CONTENT).html()!);
    });
    expect(bmlscScraper.vetHomepage(personal).accepted).toBe(false);
    expect(bmlscScraper.vetHomepage(changed(personal, ($) => $("#ubc7-unit-identifier").text(PROGRAM))).accepted).toBe(
      true,
    );
  });

  it.each(EVIDENCE)("requires the answer to %s, not the question alone", (phrase) => {
    const observation = homepage(($) => item($, phrase).children(".faq-answer-content").remove());
    expect(bmlscScraper.vetHomepage(observation).accepted).toBe(false);
  });

  it.each(["heading", "link", "question", "marketing"])("does not count %s-only answer evidence", (kind) => {
    const observation = homepage(($) => {
      const answers = $(".faq-answer-content");
      expect(answers.length).toBe(11);
      answers.each((_, element) => {
        const answer = $(element);
        if (kind === "heading") answer.wrapInner("<h3>");
        if (kind === "link") answer.wrapInner('<a href="/faqs/">');
        if (kind === "question") {
          answer.siblings("button.faq-question").append($("<span>").text(answer.text()));
          answer.empty();
        }
        if (kind === "marketing") $("#about").append(answer);
      });
    });
    expect(bmlscScraper.vetHomepage(observation).accepted).toBe(false);
  });

  it("rejects a link portal even with full answer labels, and accepts unlinked answers", () => {
    const portal = homepage(($) => {
      const existing = $(".faq-answer-content a");
      expect(existing.length).toBe(2);
      existing.each((_, element) => {
        $(element).replaceWith($(element).contents());
      });
      $(".faq-answer-content").wrapInner('<a href="/faqs/">');
    });
    expect(bmlscScraper.vetHomepage(portal).accepted).toBe(false);
    const prose = changed(portal, ($) => {
      const links = $(".faq-answer-content > a");
      expect(links.length).toBe(11);
      links.each((_, element) => {
        $(element).replaceWith($(element).contents());
      });
    });
    expect(bmlscScraper.vetHomepage(prose).accepted).toBe(true);
  });

  it.each(["nav", "footer", "aside", "form"])("does not borrow FAQ evidence from %s", (wrapper) => {
    expect(bmlscScraper.vetHomepage(homepage(($) => $("#faq").wrap(`<${wrapper}>`))).accepted).toBe(false);
  });

  it("does not borrow answers from outside the observed entry boundary", () => {
    expect(bmlscScraper.vetHomepage(homepage(($) => $("main").append($("#faq")))).accepted).toBe(false);
  });

  it.each([
    ["I am missing CHEM 211", "prerequisite for the CHEM 315 lab in term two"],
    ["Can I take BMLSc PATH courses", "they aren’t offered during the Summer session"],
    ["Can I take electives", "In Year 4, you may take additional courses that fit the standard timetable."],
    [
      "Can I apply if I already have a degree",
      "Degree holders and international applicants are considered only if seats remain.",
    ],
    [
      "Is the BMLSc the same as an MLT program",
      "does not award the MLT diploma and does not prepare you to write that exam",
    ],
  ])("requires substantive constraints in %s", (question, clause) => {
    const observation = homepage(($) => {
      const answer = item($, question!).children(".faq-answer-content");
      const before = text(answer.text());
      expect(before).toContain(clause);
      answer.text(before.replace(clause!, "See the program website for details."));
    });
    expect(bmlscScraper.vetHomepage(observation).accepted).toBe(false);
  });

  it("requires paired question labels rather than unattached answer fragments", () => {
    expect(bmlscScraper.vetHomepage(homepage(($) => $(".faq-question").remove())).accepted).toBe(false);
  });

  it.each<Partial<Snapshot>>([
    { requested_url: "https://pathology.ubc.ca/" },
    { url: "https://pathology.ubc.ca/" },
    { requested_url: `${HOME}about/` },
    { url: `${HOME}about/` },
    { url: "http://bmlscpathology.med.ubc.ca/" },
    { status: 503 },
    { headers: { "content-type": "text/plain" } },
  ])("requires a successful exact HTML homepage observation: %j", (change) => {
    expect(bmlscScraper.vetHomepage({ ...snapshot("homepage"), ...change }).accepted).toBe(false);
  });
});

describe("bmlscScraper extraction", () => {
  it("retains every question and complete answer across all tabs in document order", () => {
    const observation = snapshot("homepage");
    const source = load(observation.body);
    const result = extract(observation);
    const $ = render(result.markdown);
    const prose = text($.text());
    expect(result.input).toMatchObject({
      title: "BMLSc learning and admissions",
      url: HOME,
      upstreamId: "133",
      sourceModifiedAt: null,
      retrievedAt: "2026-06-03T12:00:00Z",
    });
    const questions = source(".faq-question")
      .map((_, node) => text(source(node).text()))
      .get();
    const answers = source(".faq-answer-content")
      .map((_, node) => text(source(node).text()))
      .get();
    expect(questions).toHaveLength(11);
    expect(
      $("strong")
        .map((_, node) => text($(node).text()))
        .get(),
    ).toEqual(expect.arrayContaining(questions));
    let previous = -1;
    for (const [index, question] of questions.entries()) {
      const start = prose.indexOf(question);
      const answer = answers[index]!;
      expect(start).toBeGreaterThan(previous);
      expect(prose).toContain(answer);
      previous = prose.indexOf(answer);
      expect(previous).toBeGreaterThan(start);
    }
    for (const label of ["Program Overview", "Admissions & Applying", "Medical Laboratory Technology"])
      expect(prose).toContain(label);
    expect(result.markdown).not.toContain("sentinel");
    expect(() => assertSafeMarkdown(result.markdown)).not.toThrow();
  });

  it("retains collapsed and explicitly hidden answers instead of treating them as boilerplate", () => {
    const observation = homepage(($) => {
      $(".faq-panel:not(.is-active)").attr("hidden", "").attr("aria-hidden", "true");
      $(".faq-answer-content").attr("style", "display:none");
    });
    expect(bmlscScraper.vetHomepage(observation).accepted).toBe(true);
    expect(extract(observation).markdown).toBe(extract(snapshot("homepage")).markdown);
  });

  it("preserves stated dates and apparent prerequisite/GPA inconsistencies without editorial repair", () => {
    const prose = text(render(extract(snapshot("homepage")).markdown).text());
    for (const statement of [
      "Fall 2027 applications open October 2026 · deadline Jan 15, 2027",
      "Applications for Fall 2027 open early October 2026.",
      "all courses listed as entrance requirements must be finished before you enter the program",
      "you’ll take it in term one of Year 3",
      "Entrance requirements: prerequisites and GPA requirements.",
      "There’s no minimum GPA requirement",
      "The minimum accepted GPA shifts each year with the applicant pool.",
      "Applicants are contacted in early to mid-May.",
    ])
      expect(prose).toContain(statement);
    expect(prose).not.toMatch(/except CHEM|outdated|contradictory|clarification|corrected/i);
  });

  it("removes exact carousel clones and pause UI while preserving the first quote cards byte-for-byte", () => {
    const observation = snapshot("homepage");
    const original = shared.extract(observation);
    if (original.kind !== "document") throw new Error("Expected shared document");
    const expected = load(original.input.html, {}, false);
    expect(expected(CARDS).length).toBe(16);
    const first = expected(CARDS)
      .slice(0, 8)
      .map((_, card) => expected.html(card))
      .get();
    expected(CARDS).slice(8).remove();
    expected(".pura-shot").slice(1).remove();
    expected("#puraPause").remove();
    const result = bmlscScraper.extract(observation);
    expect(result).toEqual({ ...original, input: { ...original.input, html: expected.root().html() } });
    const actual = load(extract(observation).input.html, {}, false);
    expect(
      actual(CARDS)
        .map((_, card) => actual.html(card))
        .get(),
    ).toEqual(first);
    expect(actual(".pura-shot").length).toBe(1);
    expect(actual(".faq-answer-content").length).toBe(11);
    const prose = text(render(extract(observation).markdown).text());
    for (const letter of "ABCDEFGH") expect(prose.split(`— Learner ${letter}`)).toHaveLength(2);
    expect(bmlscScraper.extract(observation)).toEqual(result);
    bmlscScraper.vetHomepage(observation);
    expect(bmlscScraper.extract(observation)).toEqual(result);
  });

  it("does not merge different quotes, attributions, linked destinations or cards outside the declared track", () => {
    const observation = homepage(($) => {
      const first = $(CARDS).first();
      const changedQuote = first.clone();
      changedQuote.find("blockquote").append(" I also studied microscopy.");
      const changedAuthor = first.clone();
      changedAuthor.find("figcaption").text("— Different learner");
      const linked = first.clone();
      linked.find("blockquote").wrapInner('<a href="/story-one/">');
      const otherLink = linked.clone();
      otherLink.find("a").attr("href", "/story-two/");
      $(TRACK).append(changedQuote, changedAuthor, linked, otherLink);
      $(CONTENT).append(first.clone(), first.clone());
      $(".faq-grid").first().append($(".faq-item").first().clone());
    });
    const $ = load(extract(observation).input.html);
    expect($(CARDS).length).toBe(12);
    expect($(".entry-content > figure.pura-qcard").length).toBe(2);
    expect($(".faq-answer-content").length).toBe(12);
    expect($(CARDS).find('a[href="/story-one/"]').length).toBe(1);
    expect($(CARDS).find('a[href="/story-two/"]').length).toBe(1);
  });

  it.each(["id", "track"])("does not deduplicate lookalike carousels with a different %s wrapper", (part) => {
    const observation = homepage(($) => {
      if (part === "id") $("#student-stories").attr("id", "unrelated-stories");
      else $(TRACK).removeClass("pura-down");
    });
    const original = shared.extract(observation);
    if (original.kind !== "document") throw new Error("Expected shared document");
    const source = load(original.input.html);
    const actual = load(extract(observation).input.html);
    expect(
      actual("figure.pura-qcard")
        .map((_, node) => actual.html(node))
        .get(),
    ).toEqual(
      source("figure.pura-qcard")
        .map((_, node) => source.html(node))
        .get(),
    );
    expect(actual("figure.pura-qcard").length).toBe(16);
  });

  it("extracts article metadata, lists, tables and collapsed questions through shared parsing", () => {
    const result = extract(snapshot("article", "/laboratory-study/"));
    expect(result.input).toMatchObject({
      title: "Planning laboratory study",
      url: `${HOME}laboratory-study/`,
      upstreamId: "208",
      sourceModifiedAt: "2025-11-06T10:00:00Z",
      retrievedAt: "2026-06-03T12:00:00Z",
    });
    expect(result.markdown).toContain("## Check the timetable");
    expect(result.markdown).toContain("**What should I check?**");
    const $ = render(result.markdown);
    expect($("ol li").first().text()).toBe("Record required laboratory sessions.");
    expect($.text()).toContain("Check scheduled sessions before selecting additional courses.");
    expect(text($("blockquote").text())).toBe("Keep the source's stated course sequence.");
    expect(
      $("table th")
        .map((_, node) => $(node).text())
        .get(),
    ).toEqual(["Year", "Guidance"]);
    expect(result.markdown).not.toMatch(/sentinel|^# Planning laboratory study/m);
    expect(result.input.html).not.toMatch(/Navigation sentinel|Byline sentinel|Footer sentinel|Sidebar sentinel/i);
    expect(bmlscScraper.extract(snapshot("article", "/laboratory-study/"))).toEqual(
      shared.extract(snapshot("article", "/laboratory-study/")),
    );
  });

  it("uses safe Markdown and links media with warnings, without embedded HTML or invented transcripts", () => {
    const result = extract(snapshot("article", "/laboratory-study/"));
    expect(() => assertSafeMarkdown(result.markdown)).not.toThrow();
    expect(result.links).toEqual(
      expect.arrayContaining([
        { text: "Course requirements", url: `${HOME}requirements/#courses` },
        { text: "Email the program", url: "mailto:bmlsc@example.org" },
        { text: "Call the office", url: "tel:+16045550123" },
        { text: "Department of Pathology", url: "https://pathology.ubc.ca/" },
        { text: "Teaching workbench", url: `${HOME}files/workbench.png` },
        { text: "Image", url: `${HOME}files/diagram.png` },
        { text: "Embedded content: Laboratory tour", url: "https://media.example.org/laboratory-tour" },
      ]),
    );
    const $ = render(result.markdown);
    expect($("script,form,input,iframe,img,button,[onclick]").length).toBe(0);
    for (const label of [
      "Unsafe script destination",
      "Unsafe data destination",
      "Credentialed destination",
      "Keep this explanation without its event handler.",
    ])
      expect($.text()).toContain(label);
    expect(result.links.some(({ url }) => /javascript:|data:|secret|user:/.test(url))).toBe(false);
    expect(result.markdown).not.toContain("![");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Removed an unsafe or unsupported link URL.",
        "Removed executable markup, form controls, or event attributes.",
        "An image has no text alternative; any instructions or data within it are not transcribed or OCR-extracted.",
        "Embedded content is linked rather than embedded; consult the source for its full content.",
      ]),
    );
  });

  it("supports ordinary posts through the same strict content boundary", () => {
    const observation = changed(snapshot("article", "/laboratory-study/"), ($) => {
      $("body").attr("class", "single single-post postid-309");
      $("#post-208").attr("class", "hentry post publish");
    });
    expect(extract(observation).input.upstreamId).toBe("309");
    expect(extract(observation).markdown).toContain("## Check the timetable");
  });

  it("excludes post indexes and leaves archive content empty", () => {
    expect(bmlscScraper.extract(snapshot("index", "/updates/"))).toEqual({
      kind: "excluded",
      reason: "Publisher post index; individual entries are discovered separately",
    });
    const archive = changed(snapshot("index", "/category/news/"), ($) => $("body").attr("class", "archive"));
    expect(extract(archive).markdown).toBe("");
  });

  it("keeps empty entries empty without borrowing generic main or unrelated content", () => {
    const result = extract(snapshot("empty", "/empty/"));
    expect(result.input.html).toBe("");
    expect(result.markdown).toBe("");
    const unrecognized = changed(snapshot("empty", "/empty/"), ($) => $("#content > .hentry").removeClass("hentry"));
    expect(() => bmlscScraper.extract(unrecognized)).toThrow("No recognized prose container");
  });

  it.each(["/wp-login.php", "/wp-json/", "/feed/", "/guide.pdf", "/?search=chem"])(
    "honors shared exclusions for %s",
    (pathname) => {
      expect(bmlscScraper.extract(snapshot("article", pathname)).kind).toBe("excluded");
    },
  );

  it.each(["requested_url", "url"] as const)("rejects cross-host %s observations", (field) => {
    expect(() => bmlscScraper.extract({ ...snapshot("article"), [field]: "https://pathology.ubc.ca/" })).toThrow(
      "outside the exact HTTPS host scope",
    );
  });

  it("rejects cross-host canonicals", () => {
    expect(() =>
      bmlscScraper.extract(homepage(($) => $("link[rel=canonical]").attr("href", "https://pathology.ubc.ca/"))),
    ).toThrow("outside the exact HTTPS host scope");
  });

  it.each<Partial<Snapshot>>([{ status: 404 }, { headers: { "content-type": "application/json" } }])(
    "rejects incomplete observations: %j",
    (change) => {
      expect(() => bmlscScraper.extract({ ...snapshot("article"), ...change })).toThrow(
        "A complete HTML observation is required",
      );
    },
  );
});
