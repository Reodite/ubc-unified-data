import { readFileSync } from "node:fs";
import { load, type CheerioAPI } from "cheerio";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { defineWordpressHost } from "../../host-crawl/adapters/wordpress-page.ts";
import type { Snapshot } from "../../host-crawl/contracts.ts";
import { assertSafeMarkdown, toSafeMarkdown } from "../../prose/markdown.ts";
import { bullyingAndHarassmentScraper as scraper } from "./index.ts";

const HOME = "https://bullyingandharassment.ubc.ca/";
const UNIT = "Bullying and Harassment Prevention at UBC";
const CONTENT = "#content > .hentry > .entry-content";
const FRONT = `${CONTENT} > .frontpage`;
const REPORTING = `${FRONT} > .row-fluid > .span6 > div`;
const SUPERVISOR = `${FRONT} > .row-fluid:first-of-type > .span6:nth-child(2)`;
const text = (value: string) => value.replace(/\s+/g, " ").trim();
const QUESTIONS = [
  "What led to the complaint?",
  "What behaviour does the complainant consider harassing or bullying?",
  "Did this behaviour occur more than once?",
  "Has this happened to anybody else?",
  "If the complaint was not filed right away, what were the reasons for delay?",
  "How has the behaviour affected you?",
  "What does resolution look like?",
  "Is there anything else I need to know?",
];
const shared = defineWordpressHost({
  hostname: scraper.hostname,
  title: scraper.title,
  scope: scraper.scope,
  selectors: [CONTENT],
  officialHomepage: () => true,
});

function snapshot(fixture: string, pathname = "/"): Snapshot {
  const body = readFileSync(
    new URL(`../../../test/fixtures/host-scrapers/bullyingandharassment.ubc.ca/${fixture}.html`, import.meta.url),
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
  const result = scraper.extract(observation);
  if (result.kind !== "document") throw new Error(`Unexpected exclusion: ${result.reason}`);
  return { input: result.input, ...toSafeMarkdown(result.input.html, result.input.url) };
}

function render(markdown: string) {
  return load(new MarkdownIt({ html: true }).render(markdown));
}

function block($: CheerioAPI, phrase: string) {
  const found = $(`${FRONT} p, ${FRONT} li`).filter((_, element) => text($(element).text()).includes(phrase));
  expect(found.length).toBe(1);
  return found;
}

function graftHomepage(fixture: string) {
  return changed(snapshot(fixture), ($) => {
    const source = load(snapshot("homepage").body);
    $(CONTENT).html(source(CONTENT).html()!);
  });
}

describe("bullyingAndHarassmentScraper homepage evidence", () => {
  it("declares an exact hostname and explicitly opts into shared public API fallback", () => {
    expect(scraper.hostname).toBe("bullyingandharassment.ubc.ca");
    expect(scraper.title).toBe(UNIT);
    expect(scraper.adapter).toEqual({ kind: "wordpress", allowedTypes: ["page", "post"] });
    expect(scraper.normalizeArticle).toBeUndefined();
    expect(scraper.vetHomepage(snapshot("homepage")).accepted).toBe(true);
  });

  it.each(["thin", "portal", "personal", "empty", "index", "article"])("rejects the %s homepage", (fixture) => {
    expect(scraper.vetHomepage(snapshot(fixture)).accepted).toBe(false);
  });

  it.each(["#ubc7-wordmark", "#ubc7-unit-identifier", "#ubc7-address-unit-name"])(
    "requires %s identity evidence",
    (selector) => {
      expect(
        scraper.vetHomepage(
          homepage(($) => {
            expect($(selector).length).toBe(1);
            $(selector).remove();
          }),
        ).accepted,
      ).toBe(false);
    },
  );

  it.each([
    ["#ubc7-wordmark a", "https://www.ubc.ca.example.org/"],
    ["#ubc7-wordmark a", "https://www.ubc.ca@evil.example/"],
    ["#ubc7-unit-name a", "https://hr.ubc.ca/"],
    ["#ubc7-unit-name a", `${HOME}about/`],
  ])("rejects misleading institutional links: %s %s", (selector, href) => {
    expect(scraper.vetHomepage(homepage(($) => $(selector!).attr("href", href!))).accepted).toBe(false);
  });

  it("requires explicit links rather than resolving missing hrefs as home", () => {
    expect(scraper.vetHomepage(homepage(($) => $("#ubc7-unit-name a").removeAttr("href"))).accepted).toBe(false);
    expect(scraper.vetHomepage(homepage(($) => $("#ubc7-wordmark a").removeAttr("href"))).accepted).toBe(false);
  });

  it("rejects personal identity despite complete procedures and accepts only the minimal identity repair", () => {
    const personal = graftHomepage("personal");
    expect(scraper.vetHomepage(personal).accepted).toBe(false);
    const repaired = changed(personal, ($) => $("#ubc7-unit-identifier").text(UNIT));
    expect(scraper.vetHomepage(repaired).accepted).toBe(true);
  });

  it("rejects linked procedure text and accepts the minimal prose repair", () => {
    const portal = changed(graftHomepage("portal"), ($) => {
      const existing = $(FRONT).find("a");
      expect(existing.length).toBeGreaterThan(10);
      existing.each((_, element) => {
        $(element).replaceWith($(element).contents());
      });
      $(FRONT).find("p,li").wrapInner('<a href="/procedure/">');
    });
    expect(scraper.vetHomepage(portal).accepted).toBe(false);
    const prose = changed(portal, ($) => {
      const links = $(FRONT).find("p > a,li > a");
      expect(links.length).toBe($(FRONT).find("p,li").length);
      expect(links.length).toBeGreaterThan(30);
      links.each((_, element) => {
        $(element).replaceWith($(element).contents());
      });
    });
    expect(scraper.vetHomepage(prose).accepted).toBe(true);
  });

  it.each(["heading", "link", "empty"])("does not count %s-only supervisor steps", (kind) => {
    const observation = homepage(($) => {
      const items = $(`${SUPERVISOR} > ul > li`);
      expect(items.length).toBe(9);
      items.find("a").each((_, element) => {
        $(element).replaceWith($(element).contents());
      });
      if (kind === "heading") items.wrapInner("<h5>");
      if (kind === "link") items.wrapInner('<a href="/supervisors/">');
      if (kind === "empty") items.empty();
    });
    expect(scraper.vetHomepage(observation).accepted).toBe(false);
  });

  it.each(["nav", "footer", "aside", "form", "div hidden", 'div aria-hidden="true"'])(
    "does not borrow procedures from %s",
    (wrapper) => {
      expect(scraper.vetHomepage(homepage(($) => $(FRONT).wrap(`<${wrapper}>`))).accepted).toBe(false);
    },
  );

  it("does not borrow procedures from outside the observed strict boundary", () => {
    expect(scraper.vetHomepage(homepage(($) => $("[role=main]").append($(FRONT)))).accepted).toBe(false);
  });

  it("requires worker reporting independently of the supervisor procedure", () => {
    const observation = homepage(($) => {
      expect($(REPORTING).length).toBe(1);
      $(REPORTING).remove();
    });
    expect(scraper.vetHomepage(observation).accepted).toBe(false);
  });

  it("requires both procedures in the same observed row rather than disconnected fragments", () => {
    const observation = homepage(($) => {
      expect($(SUPERVISOR).length).toBe(1);
      $(FRONT).append($('<div class="row-fluid">').append($(SUPERVISOR)));
    });
    expect(scraper.vetHomepage(observation).accepted).toBe(false);
  });

  it("requires procedure labels to be adjacent to their own steps", () => {
    const observation = homepage(($) => {
      const label = block($, "If you are not comfortable approaching the alleged bully");
      expect(label.next("ul").children("li").length).toBe(2);
      label.insertAfter(label.next("ul"));
    });
    expect(scraper.vetHomepage(observation).accepted).toBe(false);
  });

  it("requires connected sentences rather than distributing their clauses between items", () => {
    const observation = homepage(($) => {
      const step = block($, "Agree to treat the complaint with the utmost confidentiality");
      const value = text(step.text());
      expect(value).toContain(" Reassure the complainant");
      const [first, second] = value.split(" Reassure");
      step.text(first!).after($("<li>").text(`Reassure${second}`));
    });
    expect(scraper.vetHomepage(observation).accepted).toBe(false);
  });

  it.each([
    "At UBC, we strive to provide a safe, respectful and productive work environment",
    "faculty, staff and student employees. The",
    "without reasonable justification",
    "including students who are employed by the University",
    "If you feel comfortable doing so",
    "contact the HR advisor to initiate an investigation",
    "Contact your administrative head of unit, Union/Association representative",
    "Report what you have observed to your immediate supervisor",
    "If your employer or supervisor is the alleged harasser, then report",
    "names of those who directly observed each incident",
    "Acknowledge the difficulties bringing such a complaint forward",
    "If you are not at the management level, bring the complaint forward",
    "Investigations of complaints must be conducted at a management level",
    "to the extent possible",
    "retaliatory action for filing a complaint will not be tolerated",
    "In some cases, it may be advisable",
    "Offer support resources information to the employee",
    "Investigation lead must follow-up with affected employee",
    "Corrective actions should be developed and implemented",
    ...QUESTIONS,
  ])("requires substantive evidence: %s", (clause) => {
    const observation = homepage(($) => {
      const selected = block($, clause);
      selected.text(text(selected.text()).replace(clause, ""));
    });
    expect(scraper.vetHomepage(observation).accepted).toBe(false);
  });

  it.each<Partial<Snapshot>>([
    { requested_url: "https://hr.ubc.ca/" },
    { url: "https://hr.ubc.ca/" },
    { requested_url: `${HOME}resources/` },
    { url: `${HOME}resources/` },
    { url: "http://bullyingandharassment.ubc.ca/" },
    { status: 403 },
    { status: 503 },
    { headers: { "content-type": "text/plain" } },
  ])("requires a successful exact HTTPS homepage: %j", (change) => {
    expect(scraper.vetHomepage({ ...snapshot("homepage"), ...change }).accepted).toBe(false);
  });
});

describe("bullyingAndHarassmentScraper extraction", () => {
  it("preserves every source paragraph, step, qualifier, question and heading in order", () => {
    const observation = snapshot("homepage");
    const source = load(observation.body);
    const result = extract(observation);
    expect(result.input).toMatchObject({
      title: "Home",
      url: HOME,
      upstreamId: "133",
      sourceModifiedAt: null,
      retrievedAt: "2026-06-03T12:00:00Z",
    });
    const $ = render(result.markdown);
    const prose = text($.text());
    const blocks = source(FRONT)
      .find("p,li")
      .toArray()
      .map((node) => text(source(node).text()));
    expect(blocks.length).toBeGreaterThan(30);
    let previous = -1;
    for (const value of blocks) {
      const position = prose.indexOf(value, previous + 1);
      expect(position, value).toBeGreaterThan(previous);
      previous = position;
    }
    expect(
      $("h2,h3,h4")
        .toArray()
        .map((node) => text($(node).text())),
    ).toEqual(
      source(CONTENT)
        .find("h2,h3,h4")
        .toArray()
        .map((node) => text(source(node).text())),
    );
    expect(
      $("li")
        .toArray()
        .map((node) => text($(node).text())),
    ).toEqual(
      source(FRONT)
        .find("li")
        .toArray()
        .map((node) => text(source(node).text())),
    );
    expect(prose).toContain(QUESTIONS.join(" "));
    expect(prose).not.toMatch(/sentinel|legal advice|recommended correction|outdated|editorial clarification/i);
    expect(() => assertSafeMarkdown(result.markdown)).not.toThrow();
  });

  it("retains institutional statements and every citation without rewriting policy names or destinations", () => {
    const observation = snapshot("homepage");
    const source = load(observation.body);
    const result = extract(observation);
    const citations = source(FRONT)
      .find("a")
      .toArray()
      .map((node) => ({
        text: text(source(node).text()),
        url: new URL(source(node).attr("href")!, HOME).href,
      }));
    expect(result.links).toEqual(citations);
    const prose = text(render(result.markdown).text());
    for (const clause of [
      "Bullying or harassment are not acceptable and will not be tolerated at UBC.",
      "At UBC we distinguish discriminatory harassment from bullying or harassment that is not discriminatory based on the protected grounds in the BC Human Rights Code.",
      "Policy SC7 – Discrimination sets out a process for dealing with such harassment",
      "If the behaviour is of a discriminatory nature, related to one of the protected grounds under Human Rights legislation, please contact the Equity and Inclusion office.",
      "Human Resources Advisor for the Vancouver campus and the Director of HR for the Okanagan campus.",
      "Try and be as accurate as possible.",
      "be conscious of your body language and tone of voice.",
      "Ask the complainant to check your notes to ensure that they are accurate.",
    ])
      expect(prose).toContain(clause);
  });

  it("retains all ordered and nested procedure steps without flattening or renumbering", () => {
    const observation = snapshot("article", "/procedure-excerpt/");
    const source = load(observation.body);
    const result = extract(observation);
    expect(result.input).toMatchObject({
      title: "Synthetic procedure excerpt",
      url: `${HOME}procedure-excerpt/`,
      upstreamId: "208",
      sourceModifiedAt: "2026-01-12T10:00:00Z",
      retrievedAt: "2026-06-03T12:00:00Z",
    });
    const $ = render(result.markdown);
    expect($("ol").length).toBe(2);
    const steps = $("ol").first().children("li");
    expect(steps.length).toBe(9);
    expect(steps.toArray().map((node) => text($(node).text()))).toEqual(
      source(`${CONTENT} > ol > li`)
        .toArray()
        .map((node) => text(source(node).text())),
    );
    expect(
      steps
        .eq(4)
        .find("ol > li")
        .toArray()
        .map((node) => text($(node).text())),
    ).toEqual(QUESTIONS);
    expect(
      $("table th")
        .toArray()
        .map((node) => $(node).text()),
    ).toEqual(["Source", "Statement"]);
    expect(text($("blockquote").text())).toBe(text(source(`${CONTENT} > blockquote`).text()));
    expect(result.markdown).toContain("**Information for Supervisors**");
    expect(text($.text())).toContain(text(source("details p").text()));
    expect(result.markdown).not.toMatch(/^# Synthetic procedure excerpt/m);
  });

  it("retains explicit starts on block-separated nested ordered lists through shared Markdown", () => {
    const observation = changed(snapshot("article", "/procedure-excerpt/"), ($) => {
      $(`${CONTENT} > ol`).attr("start", "3");
      const nested = $(`${CONTENT} > ol > li > ol`);
      expect(nested.length).toBe(1);
      const introduction = nested.parent().contents().first();
      expect(text(introduction.text())).toBe(
        "Ask the complainant to describe what happened in detailed, chronological order.",
      );
      introduction.wrap("<p>");
      nested.attr("start", "4");
    });
    const $ = render(extract(observation).markdown);
    expect($("ol").first().attr("start")).toBe("3");
    expect($("ol ol").attr("start")).toBe("4");
    expect(
      $("ol ol > li")
        .toArray()
        .map((node) => text($(node).text())),
    ).toEqual(QUESTIONS);
  });

  it("uses shared safe Markdown and media warnings without embeddings or invented transcripts", () => {
    const result = extract(snapshot("article", "/procedure-excerpt/"));
    expect(() => assertSafeMarkdown(result.markdown)).not.toThrow();
    expect(result.links).toEqual(
      expect.arrayContaining([
        { text: "Resources", url: `${HOME}resources/#policies` },
        {
          text: "Policy SC7 – Discrimination",
          url: "https://universitycounsel.ubc.ca/policies/discrimination-policy/",
        },
        { text: "Synthetic email", url: "mailto:fixture@example.org" },
        { text: "Synthetic telephone", url: "tel:+16045550123" },
        { text: "Synthetic image label", url: `${HOME}files/synthetic-image.png` },
        { text: "Image", url: `${HOME}files/without-alt.png` },
        { text: "Embedded content: Synthetic player", url: "https://media.example.org/synthetic-player" },
        { text: "Embedded content: Synthetic video", url: `${HOME}files/synthetic-video.mp4` },
      ]),
    );
    const $ = render(result.markdown);
    expect($("script,form,input,iframe,video,img,button,[onclick]").length).toBe(0);
    for (const label of ["Unsafe script label", "Unsafe data label", "Credentialed label", "Event attribute sample."])
      expect($.text()).toContain(label);
    expect(result.links.some(({ url }) => /javascript:|data:|secret|user:/.test(url))).toBe(false);
    expect(result.markdown).not.toContain("![");
    expect(result.markdown).not.toMatch(/sentinel|transcript|OCR output/i);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Removed an unsafe or unsupported link URL.",
        "Removed executable markup, form controls, or event attributes.",
        "An image has no text alternative; any instructions or data within it are not transcribed or OCR-extracted.",
        "Embedded content is linked rather than embedded; consult the source for its full content.",
      ]),
    );
  });

  it.each(["homepage", "article"])(
    "preserves the shared extractor output for %s without a host-specific rewrite",
    (fixture) => {
      const observation = snapshot(fixture, fixture === "homepage" ? "/" : "/procedure-excerpt/");
      const before = scraper.extract(observation);
      expect(before).toEqual(shared.extract(observation));
      scraper.vetHomepage(observation);
      expect(scraper.extract(observation)).toEqual(before);
      expect(extract(observation).input.html).not.toMatch(
        /Header sentinel|Navigation sentinel|Byline sentinel|Footer sentinel|Sidebar sentinel|Unrelated entry sentinel|Share sentinel/i,
      );
    },
  );

  it("supports ordinary posts using the same strict container", () => {
    const observation = changed(snapshot("article", "/procedure-excerpt/"), ($) => {
      $("body").attr("class", "single single-post postid-309");
      $("#post-208").attr("class", "hentry post publish");
    });
    expect(extract(observation).input.upstreamId).toBe("309");
    expect(scraper.extract(observation)).toEqual(shared.extract(observation));
  });

  it("excludes publisher indexes and keeps archive bodies empty", () => {
    expect(scraper.extract(snapshot("index", "/updates/"))).toEqual({
      kind: "excluded",
      reason: "Publisher post index; individual entries are discovered separately",
    });
    const archive = changed(snapshot("index", "/category/updates/"), ($) => $("body").attr("class", "archive"));
    expect(extract(archive).markdown).toBe("");
  });

  it("does not fall back from an empty or unrecognized entry to generic main or unrelated entries", () => {
    const observation = snapshot("empty", "/empty/");
    expect(extract(observation).input.html).toBe("");
    expect(extract(observation).markdown).toBe("");
    const unrecognized = changed(observation, ($) => $("#content > .hentry").removeClass("hentry"));
    expect(() => scraper.extract(unrecognized)).toThrow("No recognized prose container");
  });

  it.each(["/wp-login.php", "/wp-json/", "/feed/", "/guide.pdf", "/?search=report"])(
    "honors shared page exclusions for %s",
    (pathname) => {
      expect(scraper.extract(snapshot("article", pathname)).kind).toBe("excluded");
    },
  );

  it.each(["requested_url", "url"] as const)("rejects cross-host %s observations", (field) => {
    expect(() => scraper.extract({ ...snapshot("article"), [field]: "https://hr.ubc.ca/" })).toThrow(
      "outside the exact HTTPS host scope",
    );
  });

  it("rejects cross-host canonical URLs", () => {
    expect(() => scraper.extract(homepage(($) => $("link[rel=canonical]").attr("href", "https://hr.ubc.ca/")))).toThrow(
      "outside the exact HTTPS host scope",
    );
  });

  it.each<Partial<Snapshot>>([
    { status: 403 },
    { status: 404 },
    { status: 503 },
    { headers: { "content-type": "application/json" } },
  ])("rejects incomplete or denied observations despite opting into transport-only API fallback: %j", (change) => {
    expect(() => scraper.extract({ ...snapshot("article"), ...change })).toThrow(
      "A complete HTML observation is required",
    );
  });
});
