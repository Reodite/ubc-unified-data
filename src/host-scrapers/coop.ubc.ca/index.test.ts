import { readFileSync } from "node:fs";
import { load, type CheerioAPI } from "cheerio";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../host-crawl/contracts.ts";
import { pageExclusion, UNSUPPORTED_DOCUMENT } from "../../host-crawl/urls.ts";
import { assertSafeMarkdown, toSafeMarkdown } from "../../prose/markdown.ts";
import { coopScraper as scraper } from "./index.ts";

const HOME = "https://coop.ubc.ca/";
const PARAMETER = "field_faq_type_value";
const FAQ = "/about-us/faqs";
const employer = `${FAQ}?${PARAMETER}=Employer%20Section`;
const student = `${FAQ}?${PARAMETER}=Student%20Section`;
const text = (value: string) => value.replace(/\s+/g, " ").trim();

function snapshot(fixture: string, path = "/"): Snapshot {
  const body = readFileSync(
    new URL(`../../../test/fixtures/host-scrapers/coop.ubc.ca/${fixture}.html`, import.meta.url),
    "utf8",
  );
  return {
    requested_url: new URL(path, HOME).href,
    url: new URL(path, HOME).href,
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
    body,
    bytes: Buffer.byteLength(body),
    retrieved_at: "2026-06-03T12:00:00Z",
  };
}

function changed(observation: Snapshot, change: ($: CheerioAPI) => void): Snapshot {
  const $ = load(observation.body);
  change($);
  const body = $.html();
  return { ...observation, body, bytes: Buffer.byteLength(body) };
}

function extract(observation: Snapshot) {
  const result = scraper.extract(observation);
  if (result.kind !== "document") throw new Error(`Unexpected exclusion: ${result.reason}`);
  const converted = toSafeMarkdown(result.input.html, result.input.url);
  assertSafeMarkdown(converted.markdown);
  const rendered = load(new MarkdownIt({ html: true }).render(converted.markdown));
  return { input: result.input, ...converted, rendered, prose: text(rendered.text()) };
}

function expectSourceBlocks(observation: Snapshot, selector: string): void {
  const source = load(observation.body);
  const result = extract(observation);
  const blocks = source(selector)
    .toArray()
    .map((node) => text(source(node).text()))
    .filter(Boolean);
  expect(blocks.length).toBeGreaterThan(0);
  let position = -1;
  for (const block of blocks) {
    const next = result.prose.indexOf(block, position + 1);
    expect(next, block).toBeGreaterThan(position);
    position = next;
  }
}

describe("coopScraper institutional identity", () => {
  it("declares HTML discovery and two finite FAQ views without download support", () => {
    expect(scraper.hostname).toBe("coop.ubc.ca");
    expect(scraper.adapter).toEqual({
      kind: "html",
      allowedTypes: [],
      views: [
        {
          path: FAQ,
          parameter: PARAMETER,
          values: ["Employer Section", "Student Section"],
          placeholder: "All",
        },
      ],
      optionalAbsent: ["/jsonapi"],
      sitemaps: [
        {
          path: "/sitemap.xml",
          rootOnlyLocation: "https://master-7rqtwti-d5a7pezenil4q.ca-1.platformsh.site//",
        },
      ],
    });
    expect(scraper.documentFormats).toBeUndefined();
    expect(scraper.vetHomepage(snapshot("homepage")).accepted).toBe(true);
  });

  it("checks institutional identity without imposing a prose-usefulness threshold", () => {
    const observation = changed(snapshot("homepage"), ($) => {
      $("main").empty();
      $("#featured,.programs,.view-announcements").remove();
    });
    expect(scraper.vetHomepage(observation).accepted).toBe(true);
  });

  it.each(["#ubc7-wordmark", "#ubc7-unit-identifier", "#ubc7-address-unit-name", "main#main-content"])(
    "requires institutional boundary %s",
    (selector) => {
      const observation = changed(snapshot("homepage"), ($) => {
        $(selector).remove();
      });
      expect(scraper.vetHomepage(observation).accepted).toBe(false);
    },
  );

  it.each([
    ["#ubc7-wordmark a", "https://www.ubc.ca.example.org/"],
    ["#ubc7-wordmark a", "https://www.ubc.ca@evil.example/"],
    ["#ubc7-wordmark a", "https://www.ubc.ca/?site=coop"],
    ["#ubc7-unit-name a", "https://coop.ok.ubc.ca/"],
    ["#ubc7-unit-name a", "/about-us"],
  ])("rejects misleading identity link %s %s", (selector, href) => {
    expect(
      scraper.vetHomepage(
        changed(snapshot("homepage"), ($) => {
          $(selector).attr("href", href);
        }),
      ).accepted,
    ).toBe(false);
  });

  it.each(["#ubc7-wordmark a", "#ubc7-unit-name a"])("requires explicit href on %s", (selector) => {
    expect(
      scraper.vetHomepage(
        changed(snapshot("homepage"), ($) => {
          $(selector).removeAttr("href");
        }),
      ).accepted,
    ).toBe(false);
  });

  it("rejects personal branding without borrowing a matching unit name from prose", () => {
    const observation = changed(snapshot("homepage"), ($) => {
      $("#ubc7-unit-identifier").text("Synthetic personal co-op journal");
      $("main").append("<p>UBC Co-op Programs</p>");
    });
    expect(scraper.vetHomepage(observation).accepted).toBe(false);
  });

  it.each<Partial<Snapshot>>([
    { requested_url: `${HOME}about-us` },
    { url: `${HOME}about-us` },
    { requested_url: "https://coop.ok.ubc.ca/" },
    { url: "https://coop.ok.ubc.ca/" },
    { url: "http://coop.ubc.ca/" },
    { status: 404 },
    { status: 503 },
    { headers: { "content-type": "text/plain" } },
  ])("rejects an invalid homepage observation %j", (change) => {
    expect(scraper.vetHomepage({ ...snapshot("homepage"), ...change }).accepted).toBe(false);
  });
});

describe("coopScraper URL policy", () => {
  it.each([
    "/",
    "/about-us",
    FAQ,
    "/about-us/program-spotlight",
    "/contact-us",
    "/post-job",
    "/program/applied-science",
    "/students/international",
    "/employers/funding",
    "/node/243",
    employer,
    student,
    `${FAQ}?${PARAMETER}=Employer+Section`,
  ])("allows the bounded public URL %s", (path) => {
    expect(scraper.excludeUrl!(new URL(path, HOME).href)).toBeNull();
  });

  it.each([
    "/antibot",
    "/antibot/",
    "/%61ntibot",
    "/media/oembed",
    "/media/oembed?url=https://example.org/",
    "/admin",
    "/admin/structure",
    "/user/login",
    "/core/assets/test.js",
    "/modules/custom/example",
    "/themes/custom/clf/font",
    "/libraries/example",
    "/jsonapi",
    "/views/ajax",
    "/system/files/example",
    "/node/144/edit",
    "/node/144/delete",
    "/node/144/revisions",
    "/update.php",
    "/install.php",
    "/sites/default/files/css/example",
    "/sites/default/files/js/example",
    "/sites/default/private/example.pdf",
    "/sites/default/files/2024-06/synthetic-responsibilities.pdf",
    "/files/Synthetic%20Guide.PDF",
    "/files/example.docx",
    "/files/example.csv",
    "/files/example.pdf/extra",
    "/files/example.pdf/",
    "/files/example.pdf?download=1",
    "/admin/example.pdf",
    "/core/example.pdf",
    "/wp-admin/example.pdf",
    "/wp-json/example.pdf",
    "/feed/example.pdf",
    "/wp-content/example.pdf",
    "/files/example.js.pdf",
    "/wp-login.php",
    "/feed/",
    "/assets/example.js",
    "/image.png",
    "/robots.txt",
    "/post-job?a=1&programs_to_submit_to_Science=Science",
    "/post-job?page=1",
    "/?page=1",
    `${FAQ}?${PARAMETER}=All`,
    `${FAQ}?${PARAMETER}=Employer`,
    `${FAQ}?${PARAMETER}=employer%20Section`,
    `${FAQ}?${PARAMETER}=Employer%20Section%20`,
    `${FAQ}?${PARAMETER}=`,
    `${employer}&${PARAMETER}=Employer%20Section`,
    `${employer}&${PARAMETER}=Student%20Section`,
    `${employer}&page=1`,
    `${employer}&op=Show`,
    `${employer}&utm_source=test`,
    `${FAQ}?field_faq_type_value[]=Employer%20Section`,
    `${FAQ}?wrong=Student%20Section`,
    `${FAQ}/?${PARAMETER}=Student%20Section`,
    `/node/146?${PARAMETER}=Student%20Section`,
    `/students/testimonials?${PARAMETER}=Student%20Section`,
    "/%2561ntibot",
    "/%2fantibot",
    "/files/%5cexample.pdf",
    "/bad%GG.pdf",
  ])("excludes unsupported routes and form spaces %s", (path) => {
    expect(scraper.excludeUrl!(new URL(path, HOME).href)).not.toBeNull();
  });

  it.each([
    "https://coop.ok.ubc.ca/files/example.pdf",
    "https://www.coop.ubc.ca/files/example.pdf",
    "https://coop.ubc.ca.evil.example/files/example.pdf",
    "https://coop.ubc.ca@evil.example/files/example.pdf",
    "https://user:secret@coop.ubc.ca/files/example.pdf",
    "http://coop.ubc.ca/files/example.pdf",
    "https://coop.ubc.ca:444/files/example.pdf",
    "file:///files/example.pdf",
  ])("never opens document exceptions outside the exact host: %s", (url) => {
    expect(scraper.excludeUrl!(url)).toBe("Different or unsafe host destination");
  });

  it("does not widen traversal scope to the sitemap deployment marker", () => {
    expect(scraper.excludeUrl!(scraper.adapter.sitemaps![0]!.rootOnlyLocation!)).toBe(
      "Different or unsafe host destination",
    );
    expect(scraper.excludeUrl!("https://coop.ubc.ca/sitemap.xml")).toBe("Static asset or machine-readable resource");
  });

  it("uses shared host normalization while keeping downloads outside article traversal", () => {
    expect(scraper.excludeUrl!("https://COOP.UBC.CA.:443/files/example.pdf#section")).toBe(UNSUPPORTED_DOCUMENT);
    const pdf = `${HOME}files/example.pdf`;
    expect(pageExclusion(pdf, scraper.hostname)).toBe(UNSUPPORTED_DOCUMENT);
    expect(scraper.excludeUrl!(pdf)).toBe(UNSUPPORTED_DOCUMENT);
    expect(scraper.excludeUrl!(`${pdf}?download=1`)).toBe(UNSUPPORTED_DOCUMENT);
    expect(scraper.excludeUrl!(`${HOME}files/example.docx`)).toBe(UNSUPPORTED_DOCUMENT);
  });
});

describe("coopScraper genuine HTML boundaries", () => {
  it("preserves finite FAQ audience choices as usable source-derived links", () => {
    for (const [fixture, path] of [
      ["faq-base", FAQ],
      ["faq-employer-synthetic", employer],
      ["faq-student-synthetic", student],
    ]) {
      const result = extract(snapshot(fixture!, path!));
      expect(result.links).toEqual(
        expect.arrayContaining([
          { text: "Employer", url: `${HOME.slice(0, -1)}${employer}` },
          { text: "Student", url: `${HOME.slice(0, -1)}${student}` },
        ]),
      );
      expect(result.rendered("form,input,select")).toHaveLength(0);
    }
  });
  it("preserves FAQ headings inside toggle buttons without orphan emphasis markers", () => {
    const observation = changed(snapshot("faq-employer-synthetic", employer), ($) => {
      $(".accordion__trigger h3").wrap('<button tabindex="-1"></button>');
    });
    const result = extract(observation);
    expect(result.rendered("h3")).toHaveLength(2);
    expect(result.prose).not.toContain("**");
    expect(result.markdown).not.toMatch(/^\s*(?:-\s+)?\*\*\s*$/m);
    expect(result.prose).toContain("The synthetic employer provides paid work and qualified supervision.");
    expect(result.prose).toContain("Respond by the agreed date, unless an extension is approved.");
  });
  it("retains homepage programs and dated announcements outside the parser-closed main", () => {
    const observation = snapshot("homepage");
    const source = load(observation.body);
    expect(source("main .programs,main .view-announcements").length).toBe(0);
    const result = extract(observation);
    expect(result.input.title).toBe("UBC Co-op Programs");
    for (const phrase of [
      "Synthetic homepage invitation",
      "Programs",
      "Synthetic Science",
      "Announcements",
      "Feb 3, 2026",
      "Jan 14, 2026",
      "A synthetic program update includes both campuses.",
    ])
      expect(result.prose).toContain(phrase);
    expect(result.links).toEqual(
      expect.arrayContaining([
        { text: "Synthetic Science", url: `${HOME}program/science` },
        { text: "MORE >", url: `${HOME}node/9901` },
      ]),
    );
    expect(result.prose).not.toMatch(/sentinel/i);
    expect(result.input.sourceModifiedAt).toBeNull();
  });

  it("retains well-formed homepage regions once without duplicating descendant selectors", () => {
    const observation = changed(snapshot("homepage"), ($) => {
      $("main").append($("#unit-content > .programs,#unit-content > section"));
    });
    const result = extract(observation);
    expect(result.prose.match(/A synthetic program update includes both campuses\./g)).toHaveLength(1);
  });

  it("does not use homepage-only sibling regions on ordinary pages", () => {
    const observation = changed(snapshot("guidance", "/students/how-co-op-works"), ($) => {
      $("#unit-content").append(
        '<div class="programs">Extra program sentinel</div><section><div class="view-announcements">Extra announcement sentinel</div></section>',
      );
    });
    expect(extract(observation).prose).not.toMatch(/sentinel/i);
  });

  it("retains sibling tabs, inactive accordions, qualifiers, source dates and sidebar testimony", () => {
    const observation = snapshot("guidance", "/students/how-co-op-works");
    const result = extract(observation);
    expect(result.input).toMatchObject({
      title: "Synthetic guidance",
      url: `${HOME}students/how-co-op-works`,
      retrievedAt: "2026-06-03T12:00:00Z",
      sourceModifiedAt: "2026-02-02T09:00:00Z",
    });
    expectSourceBlocks(observation, "main p:not(:has(sup)),#sidebar-second blockquote p");
    expect(result.prose).toContain("Some programs use a shorter maximum.");
    expect(result.prose).toContain("Synthetic survey, 2025.");
    expect(result.prose).toContain("Fixture speaker, Synthetic discipline");
    expect(result.rendered("ol").attr("start")).toBe("3");
    expect(
      result
        .rendered("table td")
        .map((_, node) => result.rendered(node).text())
        .get(),
    ).toEqual(["January", "September to December"]);
    expect(result.prose).not.toMatch(/sentinel/i);
    expect(result.links).toEqual(
      expect.arrayContaining([
        {
          text: "responsibilities (PDF)",
          url: `${HOME}sites/default/files/2024-06/synthetic-responsibilities.pdf`,
        },
        { text: "POST A JOB", url: `${HOME}post-job?a=1&programs_to_submit_to_Science=Science` },
      ]),
    );
  });

  it.each(["program", "spotlight", "testimonials", "announcement"])(
    "preserves source prose from %s without replacement text",
    (fixture) => {
      expectSourceBlocks(
        snapshot(fixture, `/${fixture}`),
        fixture === "spotlight" ? "main li > a,main .programs-offered" : "main p",
      );
    },
  );

  it("retains program qualifications and campus contact blocks outside main", () => {
    const result = extract(snapshot("program", "/node/9990"));
    expect(result.input.url).toBe(`${HOME}program/synthetic-program`);
    for (const phrase of [
      "Bachelors",
      "Masters",
      "PhD",
      "Vancouver",
      "Okanagan",
      "123 Fixture Street",
      "Tel: 604 555 0100",
      "Second synthetic campus office",
    ])
      expect(result.prose).toContain(phrase);
    expect(result.links).toEqual(
      expect.arrayContaining([
        { text: "fixture@example.org", url: "mailto:fixture@example.org" },
        { text: "Website", url: "https://coop.ok.ubc.ca/" },
      ]),
    );
    expect(result.prose).not.toMatch(/sentinel/i);
  });

  it("preserves contact headings and repairs only unambiguous template link whitespace", () => {
    const result = extract(snapshot("program", "/program/synthetic-program"));
    expect(
      result
        .rendered("h3")
        .map((_, node) => result.rendered(node).text())
        .get(),
    ).toEqual(["Vancouver", "Okanagan"]);
    expect(result.links).toContainEqual({ text: "fixture@example.org", url: "mailto:fixture@example.org" });
    expect(result.links).toContainEqual({ text: "Website", url: "https://coop.ok.ubc.ca/" });
    for (const href of [
      "java\nscript:alert(1)",
      "\nhttps://user:secret@example.org/",
      "mailto:\nuser:secret@example.org",
    ]) {
      const observation = changed(snapshot("program", "/program/synthetic-program"), ($) => {
        $(".node--view-mode-contact a").first().attr("href", href);
      });
      expect(extract(observation).links.some(({ url }) => /javascript:|secret/.test(url))).toBe(false);
    }
  });

  it("retains spotlight campus legends, degree levels and program links even when article is empty", () => {
    const result = extract(snapshot("spotlight", "/about-us/program-spotlight"));
    for (const phrase of ["Program Information", "CAMPUS: Vancouver Okanagan", "Bachelors Masters", "PhD"])
      expect(result.prose).toContain(phrase);
    expect(result.links).toHaveLength(2);
  });

  it("retains all testimonial slides and speaker attributions but drops carousel controls", () => {
    const result = extract(snapshot("testimonials", "/students/testimonials"));
    expect(result.rendered("blockquote")).toHaveLength(3);
    for (const phrase of [
      "Fixture Employer",
      "Research Manager",
      "Example Organization",
      "Fixture Student",
      "Synthetic Arts Co-op",
      "Fixture Mentor",
    ])
      expect(result.prose).toContain(phrase);
    expect(result.prose).not.toMatch(/sentinel/i);
  });

  it("keeps announcement titles and source dates without inventing modification evidence", () => {
    const result = extract(snapshot("announcement", "/node/9901"));
    expect(text(load(result.input.title, {}, false).text())).toBe("Synthetic student announcement");
    expect(result.prose).toContain("February 3, 2026");
    expect(result.input.sourceModifiedAt).toBe("2026-02-05T10:00:00Z");
    const withoutMeta = changed(snapshot("announcement", "/node/9901"), ($) => {
      $("meta").remove();
    });
    expect(extract(withoutMeta).input.sourceModifiedAt).toBeNull();
    expect(result.prose).not.toContain("Synthetic student announcement");
  });

  it("preserves posting prose, qualifications and HTML tooltips while removing form fields and actions", () => {
    const result = extract(snapshot("post-job", "/post-job"));
    for (const phrase of [
      "Use the source form to submit a synthetic job posting.",
      "Organization Details",
      "Co-op Job Description",
      "Salary guidance",
      "Synthetic employers must disclose expected pay from November 1, 2023",
      "Duration guidance",
      "exceptions vary by program.",
      "If grant funding restricts eligibility, indicate the restriction and funding source.",
      "One attachment is allowed in this synthetic example.",
      "Posting Options",
      "Indicate the programs from which you wish to receive applications.",
      "Selected programs send separate application bundles in this synthetic example.",
    ])
      expect(result.prose).toContain(phrase);
    expect(result.prose).not.toMatch(/sentinel/i);
    expect(result.input.html).not.toMatch(/<form|<input|<select|<textarea|formaction|antibot_key|data-webform-help/i);
    expect(result.links).toEqual(
      expect.arrayContaining([
        { text: "synthetic pay rule", url: "https://example.org/synthetic-pay-rule" },
        {
          text: "Employer Expectations and Responsibilities (PDF)",
          url: `${HOME}sites/default/files/2024-06/synthetic-responsibilities.pdf`,
        },
      ]),
    );
    expect(result.links.some(({ url }) => url.includes("antibot"))).toBe(false);
  });

  it("sanitizes tooltip source markup through shared Markdown rather than executing it", () => {
    const observation = changed(snapshot("post-job", "/post-job"), ($) => {
      $(".webform-element-help")
        .first()
        .attr(
          "data-webform-help",
          '<div class="webform-element-help--content"><p onclick="bad()">Synthetic tooltip qualifier.</p><script>Malicious sentinel</script><input value="control"><a href="javascript:bad()">Inert tooltip label</a></div>',
        );
    });
    const result = extract(observation);
    expect(result.prose).toContain("Synthetic tooltip qualifier.");
    expect(result.prose).toContain("Inert tooltip label");
    expect(result.prose).not.toContain("Malicious sentinel");
    expect(result.rendered("[onclick],script,input,form").length).toBe(0);
  });

  it("uses shared media links and warnings without embedded HTML or invented transcripts", () => {
    const result = extract(snapshot("guidance", "/students/how-co-op-works"));
    expect(result.rendered("iframe,script,form,img,button").length).toBe(0);
    expect(result.links.some(({ url }) => url.startsWith("javascript:"))).toBe(false);
    expect(result.links.some(({ text }) => text === "Embedded content: Synthetic guidance video")).toBe(true);
    expect(result.warnings).toContain(
      "Embedded content is linked rather than embedded; consult the source for its full content.",
    );
    expect(result.prose).not.toMatch(/invented transcript|OCR output/);
  });

  it("keeps recognized empty content empty without falling back to unrelated containers", () => {
    expect(extract(snapshot("empty", "/empty")).markdown).toBe("");
    const missing = changed(snapshot("empty", "/empty"), ($) => {
      $("main").removeAttr("id");
    });
    expect(() => scraper.extract(missing)).toThrow("No unique recognized prose container");
    const multiple = changed(snapshot("empty", "/empty"), ($) => {
      $("body").append('<main id="main-content">Ambiguous sentinel</main>');
    });
    expect(() => scraper.extract(multiple)).toThrow("No unique recognized prose container");
  });
});

describe("coopScraper selected FAQ answers", () => {
  it("keeps the unselected FAQ descriptive without inventing answers", () => {
    const result = extract(snapshot("faq-base", FAQ));
    expect(result.prose).toContain("Select whether you are an employer or student to see answers.");
    expect(result.prose).not.toMatch(/Show Results|- Any -|sentinel/);
  });

  it.each([
    ["faq-employer-synthetic", employer],
    ["faq-student-synthetic", student],
  ])("preserves explicit synthetic answer pairs in %s without merging selected canonicals", (fixture, path) => {
    const observation = snapshot(fixture, path);
    const result = extract(observation);
    expect(result.input.url).toBe(new URL(path, HOME).href);
    expect(result.input.upstreamId).toBeUndefined();
    expectSourceBlocks(observation, ".view-faqs > .view-content p");
    expect(result.prose).not.toMatch(/Filter sentinel|Footer sentinel/);
    expect(result.input.html).not.toContain("<form");
  });

  it.each([employer, student])("fails a selected view with only the retained base-page structure: %s", (path) => {
    expect(() => scraper.extract(snapshot("faq-base", path))).toThrow("Selected FAQ view contains no actual answers");
  });

  it.each(["empty", "headings", "links", "form", "script", "notice", "textarea", "select", "xmp", "video"])(
    "does not mistake %s for answers",
    (kind) => {
      const observation = changed(snapshot("faq-employer-synthetic", employer), ($) => {
        const replacements: Record<string, string> = {
          empty: "",
          headings: "<h3>Question without an answer?</h3>",
          links: '<a href="/students/why-co-op">Answer link only</a>',
          form: "<form><p>Form response sentinel</p></form>",
          script: "<script>Answer script sentinel</script>",
          notice: '<div class="view-empty">No matching answers</div>',
          textarea: "<textarea>Control value, not an answer</textarea>",
          select: "<select><option>Filter value, not an answer</option></select>",
          xmp: "<xmp>Sanitized content, not an answer</xmp>",
          video: '<video src="/sample.mp4">Media fallback, not answer prose</video>',
        };
        $(".accordion__content").html(replacements[kind]!);
      });
      expect(() => scraper.extract(observation)).toThrow("Selected FAQ view contains no actual answers");
    },
  );

  it.each(["main", "footer", "nav"])("does not borrow unrelated answer text from %s", (where) => {
    const observation = changed(snapshot("faq-employer-synthetic", employer), ($) => {
      const rows = $(".view-faqs .widget-accordion").remove();
      if (where === "nav") $(".view-content").append($("<nav>").append(rows));
      else $(where).append(rows);
    });
    expect(() => scraper.extract(observation)).toThrow("Selected FAQ view contains no actual answers");
  });

  it("requires a question paired with an answer rather than unrelated introductory prose", () => {
    const observation = changed(snapshot("faq-employer-synthetic", employer), ($) => {
      $(".accordion__trigger").remove();
    });
    expect(() => scraper.extract(observation)).toThrow("Selected FAQ view contains no actual answers");
  });

  it("rejects a redirect that loses or changes the requested FAQ selection", () => {
    const observation = snapshot("faq-employer-synthetic", employer);
    for (const path of [FAQ, student])
      expect(() => scraper.extract({ ...observation, url: new URL(path, HOME).href })).toThrow(
        "Selected FAQ observation loses its requested view",
      );
  });

  it("ignores a same-host selected canonical pointing to the other audience", () => {
    const observation = changed(snapshot("faq-employer-synthetic", employer), ($) => {
      $("link[rel=canonical]").attr("href", student);
    });
    expect(extract(observation).input.url).toBe(new URL(employer, HOME).href);
  });
});

describe("coopScraper complete observation guards", () => {
  it.each(["requested_url", "url"] as const)("rejects cross-host %s", (field) => {
    expect(() => scraper.extract({ ...snapshot("guidance"), [field]: "https://coop.ok.ubc.ca/" })).toThrow(
      "outside the exact HTTPS host scope",
    );
  });

  it.each<Partial<Snapshot>>([
    { status: 403 },
    { status: 404 },
    { status: 503 },
    { headers: { "content-type": "application/json" } },
    { headers: { "content-type": "application/pdf" } },
    { headers: { "content-type": "text/plain; comment=html" } },
  ])("requires a complete HTML response %j", (change) => {
    expect(() => scraper.extract({ ...snapshot("guidance"), ...change })).toThrow(
      "A complete HTML observation is required",
    );
  });

  it.each(["/antibot", "/post-job?a=1", `${employer}&op=Show`])("excludes unsupported extraction URL %s", (path) => {
    expect(scraper.extract(snapshot("guidance", path)).kind).toBe("excluded");
  });

  it.each(["guidance", "faq-employer-synthetic"])("rejects unsafe canonical destinations in %s", (fixture) => {
    const observation = changed(snapshot(fixture, fixture === "guidance" ? "/guide" : employer), ($) => {
      $("link[rel=canonical]").attr("href", "https://coop.ok.ubc.ca/");
    });
    expect(() => scraper.extract(observation)).toThrow("outside the exact HTTPS host scope");
  });

  it("rejects an administrative canonical rather than publishing it", () => {
    const observation = changed(snapshot("guidance", "/guide"), ($) => {
      $("link[rel=canonical]").attr("href", "/admin");
    });
    expect(() => scraper.extract(observation)).toThrow("outside the public page policy");
  });

  it.each(["Access denied", "Page not found", "CWL login"])("rejects interstitial title %s", (title) => {
    const observation = changed(snapshot("guidance", "/guide"), ($) => {
      $("title").text(title);
    });
    expect(() => scraper.extract(observation)).toThrow("Access interstitial");
  });

  it("does not mutate snapshots or depend on prior homepage validation", () => {
    const observation = snapshot("homepage");
    const saved = structuredClone(observation);
    const before = scraper.extract(observation);
    scraper.vetHomepage(observation);
    expect(scraper.extract(observation)).toEqual(before);
    expect(observation).toEqual(saved);
  });
});
