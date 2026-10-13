/** Course Schedule: every course, every scheduled section, and the code lists.
 *
 * Source: the Drupal JSON:API behind courses.students.ubc.ca (UBC's Workday-era
 * Course Schedule site). Sections carry days, start/end times, dates, instructors,
 * credits, delivery mode and status; courses carry credits, subject and course
 * number. Taxonomy files resolve the ids that courses and sections point at.
 *
 * The API serves both campuses from one collection with no campus field, so this
 * collector derives one -- from the `_V`/`_O` course-code suffix, the "(UBC-V)"
 * term label, the "(Vancouver)" subject label, or a standard timetable's campus
 * relationship -- writes it as a `campus` column, and then applies the campus
 * selection. Records with no campus marker are always kept.
 */

import { wants } from "../core/campus.ts";
import type { Http } from "../core/http.ts";
import type { Output } from "../core/output.ts";
import { register } from "../core/registry.ts";
import { enrich as enrichCourseText } from "../coursetext.ts";
import { jsonapiCollection, jsonapiIndex } from "../scraping/drupal.ts";

export const HOST = "courses.students.ubc.ca";

// dataset name -> JSON:API resource path
export const RESOURCES: Record<string, string> = {
  courses: "node/course",
  sections: "node/section",
  standard_timetables: "node/standard_timetable",
  subjects: "taxonomy_term/subject",
  campuses: "taxonomy_term/campus",
  terms: "taxonomy_term/term",
  // Named `year` upstream but it holds year *level* (1-4), not academic year.
  year_levels: "taxonomy_term/year",
  delivery_modes: "taxonomy_term/delivery_mode",
  instructional_methods: "taxonomy_term/instructional_method",
  departments: "taxonomy_term/department_or_unit",
  program_areas: "taxonomy_term/program_area",
  statuses: "taxonomy_term/status",
};

// "(Okanagan)", "UBC-O", "UBCO", and the "_O" in a code like "STAT_O 205".
const OKANAGAN_RE = /\(Okanagan\)|UBC[-_ ]?O\b|_O(?=\s|$)/i;
const VANCOUVER_RE = /\(Vancouver\)|UBC[-_ ]?V\b|_V(?=\s|$)/i;

export function campusOf(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    if (OKANAGAN_RE.test(value)) return "okanagan";
    if (VANCOUVER_RE.test(value)) return "vancouver";
  }
  return null;
}

export const Courses = register(
  class {
    name = "courses";
    folder = "courses";
    title = "Course Schedule (courses, sections, instructors, meeting times)";
    description =
      "Every course and scheduled section published on UBC's Course Schedule, " +
      "including meeting days and times, start/end dates, instructors, credits, " +
      "delivery mode, instructional method and section status, plus the subject, " +
      "campus, term and department code lists they reference. A derived `campus` " +
      "column is added to courses and sections.";
    sources = [`https://${HOST}/jsonapi`];

    async collect(http: Http, out: Output): Promise<void> {
      describeAll(out);
      const available = await jsonapiIndex(http, HOST);
      const missing: string[] = [];
      const data: Record<string, Array<Record<string, unknown>>> = {};

      for (const [dataset, resource] of Object.entries(RESOURCES)) {
        if (!available.has(resource.replace("/", "--"))) {
          missing.push(resource);
          continue;
        }
        data[dataset] = await jsonapiCollection(http, HOST, resource);
      }

      if (data["courses"]) {
        // `body` carries the description with prerequisites written into the
        // prose; split them into their own columns.
        enrichCourseText(data["courses"], "body");
      }

      tagAndFilter(data);

      for (const [dataset, records] of Object.entries(data)) {
        await out.table(dataset, records, {
          source: `https://${HOST}/jsonapi/${RESOURCES[dataset]}`,
        });
      }

      if (missing.length > 0) {
        await out.json("_unavailable.json", missing);
      }
    }
  },
);

export function tagAndFilter(data: Record<string, Array<Record<string, unknown>>>): void {
  // Taxonomies that name their campus directly.
  const campusById: Record<string, string | null> = {};
  for (const dataset of ["campuses", "terms", "subjects"]) {
    for (const record of data[dataset] ?? []) {
      record["campus"] = campusOf(record["name"], record["description"]);
      campusById[String(record["id"])] = record["campus"] as string | null;
    }
  }

  // Courses: the "_V"/"_O" in the course code is the reliable marker.
  const courseCampus: Record<string, string | null> = {};
  for (const record of data["courses"] ?? []) {
    const related = (record["related"] as Record<string, unknown>) ?? {};
    record["campus"] =
      campusOf(record["field_course_code"], record["title"]) ?? campusById[String(related["subject"])] ?? null;
    courseCampus[String(record["id"])] = record["campus"] as string | null;
  }

  // Sections: inherit from the course, else from the academic term label.
  for (const record of data["sections"] ?? []) {
    const related = (record["related"] as Record<string, unknown>) ?? {};
    record["campus"] =
      courseCampus[String(related["course"])] ??
      campusById[String(related["academic_term"])] ??
      campusOf(record["title"]);
  }

  // Standard timetables point straight at a campus taxonomy term.
  for (const record of data["standard_timetables"] ?? []) {
    const related = (record["related"] as Record<string, unknown>) ?? {};
    record["campus"] = campusById[String(related["stt_campus"])] ?? campusById[String(related["stt_term"])] ?? null;
  }

  for (const [dataset, records] of Object.entries(data)) {
    if (records.length > 0 && "campus" in records[0]!) {
      data[dataset] = records.filter((r) => wants(r["campus"] as string | null));
    }
  }
}

function describeAll(out: Output): void {
  /** The two tables anyone actually queries, and the trap between them. */
  out.describe("courses", {
    grain:
      "one course as offered in one academic year -- NOT one distinct course. " +
      "Deduplicate on field_course_code for the catalogue",
    columns: {
      field_course_code: "e.g. `CPSC_V 110`; the `_V`/`_O` suffix is the campus",
      field_course_number: "the number alone, e.g. `110`",
      field_credits: "credit value",
      field_course_instance_id: "why one course has several rows: one instance per year",
      body: "description prose, prerequisites written into it",
      description_text: "derived: the description with the requirement prose removed",
      prerequisite: "derived from `body`; UBC's own prerequisite field is empty",
      corequisite: "derived from `body`",
      equivalency: "derived from `body`",
      credit_exclusion: "derived from `body`",
      hours_vector: "derived from `body`, e.g. `[3-2-1]` -- lecture/lab/tutorial hours",
      campus: "derived: vancouver or okanagan. The API serves both with no campus field",
      alias: "path on courses.students.ubc.ca; prefix the host for the URL",
    },
    joins: [
      "id -> courses/sections.related.course",
      "related.subject -> courses/subjects.id",
      "field_course_code ~ academic-calendar/*/courses.field_course_number + subject",
    ],
  });
  out.describe("sections", {
    grain: "one scheduled section of one course in one term -- the actual offering",
    columns: {
      field_instructors: "who teaches it. Names only; `courses` has no instructor field",
      field_days: "meeting days",
      field_start_time: "SECONDS after midnight, e.g. 55800 = 15:30. Not a clock string",
      field_end_time: "seconds after midnight",
      field_start_date: "first meeting",
      field_end_date: "last meeting",
      field_section_number: "the section, e.g. `101`",
      campus: "derived; see `courses`",
    },
    joins: [
      "related.course -> courses/courses.id",
      "related.academic_term -> courses/terms.id",
      "field_instructors ~ people/profiles.title (by name; there is no shared id)",
    ],
  });
}
