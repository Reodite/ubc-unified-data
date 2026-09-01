/** Academic Calendar: the official course catalogue and academic structure.
 *
 * Source: the Drupal JSON:API behind vancouver.calendar.ubc.ca and
 * okanagan.calendar.ubc.ca. This is the catalogue rather than the schedule -- what
 * a course *is*, not when it runs. Pair it with the `courses` collector for both.
 *
 * Caveat worth knowing: the dedicated `field_course_prerequisite`,
 * `field_course_co_requistite`, `field_course_vector` and
 * `field_course_equivalency` fields exist in the schema but are empty on every
 * record sampled. UBC writes all of that into `field_course_description` as prose,
 * which is also how its own pages render it. `coursetext.parseCourseText` splits
 * it back out into `prerequisite`, `corequisite`, `equivalency`,
 * `credit_exclusion` and `hours_vector` columns; the raw description is kept.
 *
 * The calendar is more than courses, though. Everything else it publishes --
 * degree and specialization requirements, faculty and school overviews, admission
 * rules, academic regulations, the dates-and-deadlines tables -- is a `ubc_page`
 * node with a body of HTML. Those come down here too, and `calendarpages` works
 * out what each one is and where it sits in the hierarchy.
 */

import type { Http, Output } from "../base.ts";
import { jsonapiCollection, jsonapiIndex, register, wants } from "../base.ts";
import * as calendarpages from "../calendarpages.ts";
import { enrich as enrichCourseText } from "../coursetext.ts";
import * as cogsmodules from "./cogsmodules.ts";

export const CAMPUSES: Record<string, string> = {
  vancouver: "vancouver.calendar.ubc.ca",
  okanagan: "okanagan.calendar.ubc.ca",
};

export const RESOURCES: Record<string, string> = {
  courses: "node/course",
  academic_years: "node/academic_year",
  pages: "node/ubc_page",
  landing_pages: "node/ubc_landing_page",
  faculties: "taxonomy_term/faculty",
  schools: "taxonomy_term/school",
  departments: "taxonomy_term/department",
  departments_or_units: "taxonomy_term/department_or_unit",
  subjects: "taxonomy_term/subject",
  course_codes: "taxonomy_term/course_code",
  academic_year_terms: "taxonomy_term/academic_year",
};

// Both node types are calendar prose hung off a path alias, and a landing page
// is often the parent of an ordinary one, so they are enriched as one pool --
// otherwise half the hierarchy would have gaps where the parent isn't in scope.
export const PAGE_DATASETS = ["pages", "landing_pages"];

export function subjectCodes(fetched: Record<string, Array<Record<string, unknown>>>): Set<string> | null {
  const codes = new Set<string>();
  for (const record of fetched["subjects"] ?? []) {
    const name = (record["name"] as string) ?? "";
    const code = name.split("_", 1)[0]!.trim();
    if (code) codes.add(code);
  }
  return codes.size > 0 ? codes : null;
}

export const AcademicCalendar = register(
  class {
    name = "calendar";
    folder = "academic-calendar";
    title = "Academic Calendar (course catalogue, programs, faculties, deadlines)";
    description =
      "Official course catalogue entries with descriptions and credit values, plus " +
      "prerequisites, corequisites, equivalencies, credit exclusions and hours " +
      "vectors parsed out of the description prose; every calendar page with its " +
      "body text, place in the hierarchy and the courses it references; the degree " +
      "and specialization requirement pages on their own; the term dates and " +
      "drop deadlines; and the faculty, school, department and subject hierarchy " +
      "for both campuses.";
    sources = [...Object.values(CAMPUSES).map((host) => `https://${host}/jsonapi`), cogsmodules.URL];

    async collect(http: Http, out: Output): Promise<void> {
      const unavailable: Record<string, string[]> = {};

      for (const [campus, host] of Object.entries(CAMPUSES)) {
        if (!wants(campus)) continue;
        describeCal(out, campus);
        const available = await jsonapiIndex(http, host);
        const missing: string[] = [];
        const fetched: Record<string, Array<Record<string, unknown>>> = {};

        for (const [dataset, resource] of Object.entries(RESOURCES)) {
          if (!available.has(resource.replace("/", "--"))) {
            missing.push(resource);
            continue;
          }
          const records = await jsonapiCollection(http, host, resource);
          if (records.length === 0) continue;
          for (const record of records) record["campus"] = campus;
          fetched[dataset] = records;
        }

        if (fetched["courses"]) {
          // UBC leaves field_course_prerequisite empty and writes the
          // prerequisites, corequisites and hours vector into the description
          // prose instead; recover them into columns.
          enrichCourseText(fetched["courses"], "field_course_description");
        }

        const pages = PAGE_DATASETS.flatMap((name) => fetched[name] ?? []);
        if (pages.length > 0) {
          calendarpages.enrich(pages, { host, subjects: subjectCodes(fetched) });
        }

        for (const [dataset, records] of Object.entries(fetched)) {
          await out.table(`${campus}/${dataset}`, records, {
            source: `https://${host}/jsonapi/${RESOURCES[dataset]}`,
          });
        }

        await this.derived(out, pages, campus, host);

        // The COGS module-course list is calendar-adjacent (the calendar's own
        // COGS pages defer to it) but lives on cogsys.ubc.ca, Vancouver only.
        if (campus === "vancouver") {
          try {
            const modules = await cogsmodules.fetch(http);
            if (modules.length > 0) {
              await out.table(`${campus}/cogs_module_courses`, modules, { source: cogsmodules.URL });
            }
          } catch {
            // The site's bot challenge or an outage; the dataset simply isn't
            // refreshed this run.
            missing.push(cogsmodules.URL);
          }
        }

        if (missing.length > 0) unavailable[campus] = missing;
      }

      if (Object.keys(unavailable).length > 0) {
        await out.json("_unavailable.json", unavailable);
      }
    }

    async derived(out: Output, pages: Array<Record<string, unknown>>, campus: string, host: string): Promise<void> {
      if (pages.length === 0) return;

      const programs = pages.filter((page) => page["program"]);
      if (programs.length > 0) {
        await out.table(`${campus}/programs`, programs, {
          source: `https://${host}/${calendarpages.FACULTIES_SECTION}`,
        });
      }

      for (const page of calendarpages.datesPages(pages)) {
        const rows = calendarpages.parseDates(page);
        if (rows.length > 0) {
          await out.table(`${campus}/dates`, rows, {
            source: (page["url"] as string | undefined) ?? `https://${host}`,
          });
          break;
        }
      }
    }
  },
);

function describeCal(out: Output, campus: string): void {
  out.describe(`${campus}/courses`, {
    grain:
      "one course in the catalogue -- what a course IS, not when it runs. " + "Join to courses/sections for offerings",
    columns: {
      field_course_title: "course title",
      field_course_number: "the number, e.g. `110`",
      field_course_credit: "credit value",
      field_course_description: "the description, with requirement prose inside it",
      description_text: "derived: the description with that prose removed",
      prerequisite: "derived from the description; UBC's own field is empty on every row",
      corequisite: "derived from the description",
      equivalency: "derived from the description",
      credit_exclusion: "derived from the description",
      hours_vector: "derived, e.g. `[3-2-1]` -- lecture/lab/tutorial hours",
      alias: "path on the calendar host; prefix the host for the URL",
    },
    joins: ["related.subject -> academic-calendar/*/subjects.id"],
  });
  out.describe(`${campus}/pages`, {
    grain:
      "one calendar page -- degree requirements, faculty overviews, admission " +
      "rules, regulations. Everything the calendar publishes that is not a course",
    columns: {
      title: "page title",
      kind:
        "derived: degree_requirements, major, minor, admission, regulations, " +
        "coop, advising, faculty_overview... what the page is",
      level: "derived: undergraduate, masters, doctoral or certificate",
      faculty: "derived from the alias chain",
      program: "derived: the degree this page sits inside, if any",
      breadcrumbs: "derived: the ancestor titles, recovered by matching alias prefixes",
      parent_url: "the page above this one",
      referenced_courses:
        "course codes the page mentions, in order, validated " + "against this campus's subject vocabulary",
      text: "body as plain text",
      headings: "the page's heading outline",
      body: "body HTML",
      url: "the public URL",
    },
    joins: [
      "referenced_courses ~ academic-calendar/*/courses (subject + number)",
      "parent_url -> academic-calendar/*/pages.url",
    ],
  });
  out.describe(`${campus}/dates`, {
    grain: "one dated event -- a term boundary, exam period or drop/withdrawal deadline",
    columns: {
      event: "what happens, e.g. `Start`, `Last day to withdraw`",
      applies_to: "which term or session it applies to",
      start: "ISO date",
      end: "ISO date; set only for multi-day windows",
      span_days: "length of the window; null for single-day deadlines",
      table: "the table on the page it came from",
    },
    joins: [],
  });
}
