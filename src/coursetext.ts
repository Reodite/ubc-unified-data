/** Derive prerequisite, corequisite, equivalency and contact-hour columns from course prose.
 * The Calendar's dedicated fields are empty in sampled records. Keep the source
 * description alongside these derived values.
 */

import { unescapeHtml as htmlUnescape } from "./htmldoc.ts";

// "Prerequisite:" / "Pre-requisites:" / "Corequisite:" / "Equivalency:"
const LABEL_RE = /(?<![A-Za-z-])(?<label>pre-?requisite[s]?|co-?requisite[s]?|equivalency|equivalent)\s*:/gi;

// Contact-hours vector, e.g. [3-2-1] or [3-0-0*] or [2.5-0-0]
const VECTOR_RE = /\[\s*(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?\*?){1,3})\s*\]/;

// "Credit will be granted for only one of X, Y or Z."
const EXCLUSION_RE = /credit will (?:be granted|only be granted)[^.]*\./i;

const TAG_RE = /<[^>]+>/g;

const CANONICAL: Record<string, keyof CourseText> = {
  pre: "prerequisite",
  co: "corequisite",
  eq: "equivalency",
};

function canonical(label: string): keyof CourseText {
  label = label.toLowerCase();
  if (label.startsWith("pre")) return CANONICAL["pre"]!;
  if (label.startsWith("co")) return CANONICAL["co"]!;
  return CANONICAL["eq"]!;
}

/** Read plain text from a string or a Drupal {value, processed} field. */
export function plainText(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    value = record["processed"] ?? record["value"] ?? "";
  }
  if (typeof value !== "string") return "";
  let text = value.replace(TAG_RE, " ");
  text = htmlUnescape(text);
  return text.replace(/\s+/g, " ").replaceAll("\u00a0", " ").trim();
}

export interface CourseText {
  description_text: string;
  prerequisite: string;
  corequisite: string;
  equivalency: string;
  credit_exclusion: string;
  hours_vector: string;
}

/** Split course prose into derived columns; missing clauses produce empty strings. */
export function parseCourseText(value: unknown): CourseText {
  const text = plainText(value);
  const result: CourseText = {
    description_text: "",
    prerequisite: "",
    corequisite: "",
    equivalency: "",
    credit_exclusion: "",
    hours_vector: "",
  };
  if (!text) return result;

  const vector = VECTOR_RE.exec(text);
  if (vector) result["hours_vector"] = vector[1]!.replace(/\s+/g, "");

  const exclusion = EXCLUSION_RE.exec(text);
  if (exclusion) result["credit_exclusion"] = exclusion[0]!.trim();

  const labels = [...text.matchAll(LABEL_RE)];
  for (let index = 0; index < labels.length; index++) {
    const match = labels[index]!;
    const end = index + 1 < labels.length ? labels[index + 1]!.index : text.length;
    const chunk = text.slice(match.index! + match[0].length, end).replace(/^[. ;]+|[. ;]+$/g, "");
    const key = canonical(match.groups?.["label"] ?? "");
    // Keep the first occurrence; later duplicates are usually cross-references.
    if (chunk && !result[key]) result[key] = chunk + (chunk.endsWith(".") ? "" : ".");
  }

  // The description is whatever comes before the first structured clause.
  let cut = text.length;
  if (labels.length > 0) cut = Math.min(cut, labels[0]!.index!);
  if (exclusion) cut = Math.min(cut, exclusion.index!);
  let description = text.slice(0, cut);
  if (vector && vector.index < cut) description = description.replaceAll(vector[0]!, " ");
  result["description_text"] = description.replace(/\s+/g, " ").replace(/^[. ;]+|[. ;]+$/g, "");
  if (result["description_text"]) result["description_text"] += ".";

  return result;
}

/** Add the derived columns to every record, in place. Returns rows parsed. */
export function enrich(records: Array<Record<string, unknown>>, sourceField: string): number {
  let parsed = 0;
  for (const record of records) {
    const fields = parseCourseText(record[sourceField]);
    Object.assign(record, fields);
    if (fields["prerequisite"] || fields["corequisite"] || fields["hours_vector"]) parsed += 1;
  }
  return parsed;
}
