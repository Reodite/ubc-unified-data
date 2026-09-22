import { defineWordpressHost } from "../../host-crawl/adapters/wordpress-page.ts";
import type { HostScraper } from "../../host-crawl/contracts.ts";
import { normalizeArticle } from "./normalize.ts";

const HOME = "https://bmlscpathology.med.ubc.ca/";
const PROGRAM = "Bachelor of Medical Laboratory Science (BMLSc) Program";
const CONTENT = "#content > .hentry > .entry-content";
const FAQ = "#faq.faq-section > .faq-container > .faq-panels > .faq-panel > .faq-grid > .faq-item";
const text = (value: string) => value.replace(/\s+/g, " ").trim();

const base = defineWordpressHost({
  hostname: "bmlscpathology.med.ubc.ca",
  title: `UBC ${PROGRAM}`,
  scope: "Public BMLSc program, curriculum, admissions, prerequisite, laboratory training and student guidance prose.",
  selectors: [CONTENT],
  documentFormats: ["pdf", "docx", "pptx"],
  officialHomepage($, snapshot) {
    const wordmark = $("#ubc7-header #ubc7-wordmark a").first();
    const unit = $("#ubc7-unit-name a").first();
    if (
      text(wordmark.text()) !== "The University of British Columbia" ||
      new URL(wordmark.attr("href") ?? "", snapshot.url).href !== "https://www.ubc.ca/" ||
      text(unit.find("#ubc7-unit-faculty").text()) !== "Faculty of Medicine" ||
      text(unit.find("#ubc7-unit-identifier").text()) !== PROGRAM ||
      !unit.attr("href") ||
      new URL(unit.attr("href") ?? "", snapshot.url).href !== HOME
    )
      return false;

    const content = $(CONTENT).clone();
    content
      .find(
        "a,h1,h2,h3,h4,h5,h6,nav,header,footer,aside,script,style,noscript,template,form,[role=navigation],.site-header,.site-footer,.entry-meta,.entry-utility",
      )
      .remove();
    // Inactive tabs and collapsed answers are substantive content, not navigation labels.
    const answers = content
      .find(FAQ)
      .toArray()
      .map((element) => ({
        question: text($(element).children("button.faq-question").children("span:not(.faq-icon)").text()),
        answer: text($(element).children("div.faq-answer-content").text()),
      }));
    const has = (question: RegExp, clauses: RegExp[]) =>
      answers.some((item) => question.test(item.question) && clauses.every((clause) => clause.test(item.answer)));

    return (
      has(/where are classes held/i, [
        /Department of Pathology and Laboratory Medicine at UBC Hospital/i,
        /Vancouver campus/i,
        /taught by department faculty/i,
      ]) &&
      has(/missing CHEM 211/i, [
        /CHEM 211 before entering/i,
        /take it in term one of Year 3/i,
        /prerequisite for the CHEM 315 lab in term two/i,
        /seating limits in CHEM 211/i,
        /encouraged to finish it before entering/i,
      ]) &&
      has(/PATH courses while completing prerequisites/i, [
        /PATH\) courses are restricted to students enrolled in the program/i,
        /(?:aren.t|are not) offered during the Summer session/i,
      ]) &&
      has(/take electives/i, [
        /Year 3 curriculum follows a standard timetable with no room for electives/i,
        /Year 4, you may take additional courses that fit the standard timetable/i,
      ]) &&
      has(/already have a degree.*international student/i, [
        /eligible if you.ve completed the prerequisites/i,
        /Priority goes to qualified applicants who don.t yet hold an undergraduate degree/i,
        /Canadian citizens and permanent residents/i,
        /Degree holders and international applicants are considered only if seats remain/i,
      ]) &&
      has(/BMLSc the same as an MLT program/i, [
        /Completing an MLT diploma lets you write/i,
        /Canadian Society for Medical Laboratory Science \(CSMLS\) certification exam/i,
        /BMLSc does not award the MLT diploma and does not prepare you to write that exam/i,
        /MLT diploma programs are offered separately/i,
      ])
    );
  },
});

export const bmlscScraper: HostScraper = {
  ...base,
  adapter: { ...base.adapter, apiContentFallback: true },
  normalizeArticle,
  extract(snapshot) {
    const result = base.extract(snapshot);
    return result.kind === "document" ? { ...result, input: normalizeArticle(result.input) } : result;
  },
};
