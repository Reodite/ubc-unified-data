import { describe, expect, it } from "vitest";
import { articleLinks, extractArticle, needsRenderedHtml } from "./html.ts";
import { makeArticle } from "./model.ts";
import { commonExclusion, LIVE_PROSE_SOURCES } from "./sources.ts";

const source = LIVE_PROSE_SOURCES.find((item) => item.key === "science-coop")!;
function response(body: string) {
  return {
    body,
    url: "https://sciencecoop.ubc.ca/students",
    requested_url: "https://sciencecoop.ubc.ca/students",
    status: 200,
    headers: {},
    retrieved_at: "2026-09-11T00:00:00Z",
  };
}

describe("whole article extraction", () => {
  it("preserves landing-page guidance outside the Drupal body field", () => {
    const input = extractArticle(
      response(
        `<html><head><title>Student guide | UBC</title></head><body><header>Global chrome</header><div id="unit-content"><main><nav>Site menu</nav><h1>Student guide</h1><article><p>Initial guidance.</p></article><section id="prefooter-content"><h2>During your work term</h2><p>Retain this additional requirement.</p></section></main></div><footer>Global legal footer</footer></body></html>`,
      ),
      source,
    );
    const article = makeArticle(source, input)!;
    expect(article.content_markdown).toContain("Retain this additional requirement");
    expect(article.content_markdown).toContain("During your work term");
    expect(article.content_markdown).not.toMatch(/Global chrome|Site menu|Global legal footer/);
  });

  it("preserves supporting fields and every collapsed FAQ answer", () => {
    const panels = Array.from(
      { length: 13 },
      (_, index) =>
        `<section><h3>Question ${index}</h3><div hidden aria-hidden="true"><p>Answer ${index} remains available.</p></div></section>`,
    ).join("");
    const input = extractArticle(
      response(
        `<title>Questions</title><div id="unit-content"><main><h1>Questions</h1><div class="field--name-body">${panels}</div><div class="field--name-field-page-supporting-content"><p>Final eligibility condition.</p></div></main></div>`,
      ),
      source,
    );
    const article = makeArticle(source, input)!;
    for (let index = 0; index < 13; index++)
      expect(article.content_markdown).toContain(`Answer ${index} remains available`);
    expect(article.content_markdown).toContain("Final eligibility condition");
  });

  it("extracts all myBCom text panes rather than only the initial body", () => {
    const sauder = LIVE_PROSE_SOURCES.find((item) => item.key === "sauder-undergraduate")!;
    const input = extractArticle(
      {
        ...response(
          `<title>Registration</title><h1>Registration</h1><section class="main-content"><div class="panel-content"><div class="field-name-body"><p>Introduction.</p></div><div class="pane-bundle-text"><p>Registration exceptions.</p></div><div class="pane-bundle-text"><p>Fee qualifications.</p></div></div></section>`,
        ),
        url: "https://mybcom.sauder.ubc.ca/registration",
      },
      sauder,
    );
    expect(input.html).toContain("Registration exceptions");
    expect(input.html).toContain("Fee qualifications");
  });

  it("rejects access interstitials and soft error pages", () => {
    expect(() => extractArticle(response("<title>Just a moment</title><main>Checking browser</main>"), source)).toThrow(
      "interstitial",
    );
    expect(() => extractArticle(response("<title>Page not found</title><main>Missing</main>"), source)).toThrow(
      "interstitial",
    );
  });

  it("excludes student-listing records exposed at non-descriptive URLs", () => {
    expect(() =>
      extractArticle(
        response(
          '<title>Listing</title><div id="primary-content"><article class="node--view-mode-full node--type-student-listing">Individual listing</article></div>',
        ),
        source,
      ),
    ).toThrow("student listing");
  });

  it("recognizes an empty body without importing bylines and comment forms", () => {
    const commons = LIVE_PROSE_SOURCES.find((item) => item.key === "learning-commons")!;
    const input = extractArticle(
      {
        ...response(
          '<title>Toolkit</title><div id="content"><h1>Toolkit</h1><p>By an author</p><div class="entry-content"></div><form>Leave a comment</form></div>',
        ),
        url: "https://learningcommons.ubc.ca/toolkit/",
      },
      commons,
    );
    expect(makeArticle(commons, input)).toBeNull();
  });

  it("preserves admissions campaign page-builder sections", () => {
    const admissions = { ...source, key: "admissions", host: "you.ubc.ca", selectors: ["#container"] };
    const input = extractArticle(
      {
        ...response(
          '<title>Admissions</title><div id="container"><h1>Admissions</h1><div class="notice-header"><p>Application context.</p></div><div class="pagebuilder"><section><h2>Requirements</h2><p>Keep every condition.</p></section></div></div>',
        ),
        url: "https://you.ubc.ca/guide/",
      },
      admissions,
    );
    const article = makeArticle(admissions, input)!;
    expect(article.content_markdown).toContain("Application context");
    expect(article.content_markdown).toContain("Keep every condition");
  });

  it("recognizes empty and unrendered shortcode bodies", () => {
    expect(needsRenderedHtml("")).toBe(true);
    expect(needsRenderedHtml("[vc_row][vc_column_text]Instructions[/vc_column_text][/vc_row]")).toBe(true);
    expect(needsRenderedHtml("<p>Complete instructions.</p>")).toBe(false);
  });

  it("follows only article links without arbitrary searches, assets or authentication", () => {
    const links = articleLinks(
      `<a href="/students/guide#steps">Guide</a><a href="/students/guide?utm_source=test">Tracked alias</a><a href="/students/guide?search=private">Search</a><a href="/students/guide.pdf">PDF</a><a href="https://outside.example/">External</a><a href="/user/login">Log in</a><a href="javascript:alert(1)">Script</a>`,
      source,
      "https://sciencecoop.ubc.ca/students",
    );
    expect(links).toEqual(["https://sciencecoop.ubc.ca/students/guide"]);
  });
});

describe("undergraduate source scope", () => {
  it("retains graduation instructions and shared eligibility", () => {
    expect(
      commonExclusion("https://workday.students.ubc.ca/degree-planning/applying-to-graduate/", "Applying to graduate"),
    ).toBeNull();
    expect(
      commonExclusion(
        "https://science.ubc.ca/graduate-courses/undergraduate-eligibility",
        "Undergraduate eligibility for graduate courses",
      ),
    ).toBeNull();
    expect(
      commonExclusion("https://students.ubc.ca/post-graduation-work-permit", "Post-graduation work permit"),
    ).toBeNull();
  });

  it("excludes explicit graduate-only, staff-only and other-campus material", () => {
    expect(commonExclusion("https://science.ubc.ca/graduate-students/awards", "Graduate students")).toContain(
      "Graduate-only",
    );
    expect(commonExclusion("https://goglobal.ubc.ca/go-global/faculty-staff-resources/help")).toContain("Faculty");
    expect(commonExclusion("https://you.ubc.ca/programs/biology-okanagan/")).toContain("Okanagan");
  });

  it("retains unaliased Science student resources and exceptional co-op routes", () => {
    const science = LIVE_PROSE_SOURCES.find((item) => item.key === "science-advising")!;
    expect(science.scope("https://science.ubc.ca/node/17757", "Peer support", "student_resource")).toBeNull();
    expect(source.scope("https://sciencecoop.ubc.ca/Entrepreneurial-Co-op")).toBeNull();
    expect(source.scope("https://sciencecoop.ubc.ca/effective-resume-design")).toBeNull();
    expect(source.scope("https://sciencecoop.ubc.ca/prospective/apply/prodigy")).toContain("graduate-only");
  });
});
