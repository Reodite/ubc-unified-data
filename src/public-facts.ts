import { createHash } from "node:crypto";
import { InvalidValueError, type Output } from "./base.ts";
import type { Row } from "./source-documents.ts";

const METADATA = ["id", "source_id", "source_url", "api_url", "campus", "title", "source_modified_at", "retrieved_at"];
const TAXONOMY = ["name", "type", "parent_ids"];

/** Field allowlists keep fetched page bodies separate from structured fact tables. */
export const PUBLIC_FIELDS = {
  "housing/residences": [
    "slug",
    "beds",
    "undergraduate_audience",
    "front_desk_text",
    "fee_urls",
    "fee_page_ids",
    "room_type_ids",
  ],
  "housing/room_types": ["slug", "residence_ids"],
  "housing/fee_pages": ["upstream_id", "parent_id", "slug"],
  "housing/guidance": ["upstream_id", "parent_id", "slug"],
  "housing/fee_tables": [
    "page_id",
    "residence_ids",
    "table_index",
    "section_labels",
    "values",
    "source_context_required",
  ],
  "libraries/branches": [
    "hours_id",
    "slug",
    "website",
    "address_text",
    "contact_text",
    "accessibility_url",
    "latitude",
    "longitude",
    "map_url",
    "location_type",
    "booking_lid",
  ],
  "libraries/monthly_schedules": [
    "branch_id",
    "month",
    "rules",
    "additional_hours_urls",
    "request_url",
    "request_parameters",
  ],
  "libraries/hours": [
    "branch_id",
    "hours_id",
    "date",
    "timezone",
    "category",
    "hours_text",
    "status",
    "opens",
    "closes",
    "closes_next_day",
    "schedule_id",
  ],
  "student-support/it_services": ["upstream_id", "related", "unavailable_relationships", "audiences", "categories"],
  "student-support/wellbeing_resources": [
    "upstream_id",
    "related",
    "unavailable_relationships",
    "campus_labels",
    "audiences",
    "student_populations",
    "categories",
  ],
  "student-support/learning_commons_pages": ["upstream_id", "parent_id", "slug"],
  "student-support/it_audiences": TAXONOMY,
  "student-support/it_categories": TAXONOMY,
  "student-support/wellbeing_campuses": TAXONOMY,
  "student-support/wellbeing_audiences": TAXONOMY,
  "student-support/wellbeing_categories": TAXONOMY,
  "student-support/wellbeing_populations": TAXONOMY,
  "policies/index": [
    "upstream_id",
    "related",
    "unavailable_relationships",
    "policy_number",
    "legacy_policy_number",
    "long_title",
    "policy_date",
    "procedures_date",
    "guidelines_date",
    "rules_date",
    "lifecycle",
    "linked_from_search",
    "content_kind",
  ],
} as const;
export type PublicTable = keyof typeof PUBLIC_FIELDS;

const PROSE_FIELDS = new Set([
  "body",
  "content",
  "content_html",
  "content_text",
  "content_sha256",
  "processed",
  "rendered",
  "table_html",
  "preceding_text",
  "quick_facts_text",
  "pricing_text",
  "eligibility_text",
  "description",
  "headings",
]);

function inspectValue(value: unknown, location: string): void {
  if (typeof value === "string") {
    if (/<\/?[a-z][^>]*>/i.test(value)) throw new InvalidValueError(`HTML in public facts: ${location}`);
    if (!/^https?:\/\//.test(value) && (value.length > 600 || value.trim().split(/\s+/).length > 60)) {
      throw new InvalidValueError(`Long text is not a factual label: ${location}`);
    }
  } else if (typeof value === "number" && !Number.isFinite(value)) {
    throw new InvalidValueError(`Non-finite public fact: ${location}`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      inspectValue(item, `${location}[${index}]`);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (PROSE_FIELDS.has(key)) throw new InvalidValueError(`Prose field in public facts: ${location}.${key}`);
      inspectValue(item, `${location}.${key}`);
    }
  }
}

export function factsHash(row: Row): string {
  const stable = Object.fromEntries(
    Object.entries(row).filter(([key]) => !["record_sha256", "retrieved_at"].includes(key)),
  );
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function assertPublicFacts(table: PublicTable, row: Row): void {
  const allowed = new Set<string>([...METADATA, ...PUBLIC_FIELDS[table], "record_sha256"]);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) throw new InvalidValueError(`Unapproved public field: ${table}.${key}`);
  }
  inspectValue(row, table);
  if (row.record_sha256 !== factsHash(row)) throw new InvalidValueError(`Fact hash mismatch: ${table}:${row.id}`);
}

export function publicFacts(table: PublicTable, row: Row): Row {
  const selected: Row = {};
  for (const key of [...METADATA, ...PUBLIC_FIELDS[table]]) {
    if (row[key] !== undefined) selected[key] = row[key];
  }
  selected.record_sha256 = factsHash(selected);
  assertPublicFacts(table, selected);
  return selected;
}

export async function publishFacts(out: Output, table: PublicTable, rows: Row[], source: string): Promise<void> {
  await out.table(
    table.slice(table.indexOf("/") + 1),
    rows.map((row) => publicFacts(table, row)),
    { source },
  );
}

export const FACT_COLUMNS = {
  id: "Stable identifier used for joins and ingestion",
  source_url: "Official source page to consult and cite; page bodies are not republished",
  api_url: "Public source record endpoint, when available",
  source_modified_at: "Publisher modification timestamp, not necessarily a fee's effective date",
  retrieved_at: "UTC collection time; factual snapshots can become stale",
  record_sha256: "SHA-256 of published fact fields excluding retrieval time and this hash",
  campus: "vancouver, okanagan, or null for shared/unlabelled information",
};
