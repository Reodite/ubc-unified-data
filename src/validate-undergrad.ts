import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, stringifyCsv } from "./base.ts";
import { assertPublicFacts, PUBLIC_FIELDS, type PublicTable } from "./public-facts.ts";
import { object, type Row } from "./source-documents.ts";

export const UNDERGRAD_GROUPS = ["support", "policies", "housing", "libraries"];

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function officialUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (url.hostname === "ubc.ca" || url.hostname.endsWith(".ubc.ca"))
    );
  } catch {
    return false;
  }
}

/** Check undergraduate fact tables, provenance fields and joins without contacting UBC. */
export async function validateUndergradData(root = DATA_DIR, groups = UNDERGRAD_GROUPS): Promise<Row> {
  const manifest = object(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")));
  const catalog = object(JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8")));
  const allTables = new Map<string, Row[]>();
  const totals: Row[] = [];
  let factRecords = 0;
  for (const name of groups) {
    const group = object(object(manifest.groups)[name]);
    const catalogGroup = object(object(catalog.groups)[name]);
    check(group.status === "ok", `Group ${name} is missing or not successful in the manifest`);
    check(catalogGroup.status === "ok", `Group ${name} is missing or not successful in the catalog`);
    const datasets = group.datasets as Row[];
    check(Array.isArray(datasets) && datasets.length, `No datasets recorded for ${name}`);
    const paths = new Set(datasets.map((dataset) => String(dataset.path)));
    const catalogTables = catalogGroup.tables as Row[];
    let records = 0;
    let tables = 0;
    for (const dataset of datasets) {
      const relative = String(dataset.path);
      const file = path.resolve(root, relative);
      check(file.startsWith(`${path.resolve(root)}${path.sep}`), `Unsafe manifest path: ${relative}`);
      check((await stat(file)).size === dataset.bytes, `Byte-size mismatch: ${relative}`);
      if (!relative.endsWith(".json")) continue;
      const payload: unknown = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(payload)) check(payload.length === dataset.records, `Record-count mismatch: ${relative}`);
      if (path.basename(relative).startsWith("_") || !Array.isArray(payload)) continue;
      const rows = payload as Row[];
      check(
        catalogTables.some((table) => table.json === relative && table.records === rows.length),
        `Catalog mismatch: ${relative}`,
      );
      const csv = relative.replace(/\.json$/, ".csv");
      if (rows.length) {
        check(paths.has(csv), `Missing CSV counterpart: ${relative}`);
        check(
          (await readFile(path.join(root, csv), "utf8")) === stringifyCsv(rows),
          `JSON/CSV content mismatch: ${relative}`,
        );
      }
      const table = relative.replace(/\.json$/, "");
      check(Object.hasOwn(PUBLIC_FIELDS, table), `Unknown public table: ${table}`);
      const ids = new Set<unknown>();
      for (const row of rows) {
        assertPublicFacts(table as PublicTable, row);
        factRecords++;
        check(
          row.id !== undefined && row.id !== null && String(row.id).length > 0,
          `Missing fact identity in ${relative}`,
        );
        check(officialUrl(row.source_url), `Missing official fact citation in ${relative}`);
        check(
          typeof row.retrieved_at === "string" && Number.isFinite(Date.parse(row.retrieved_at)),
          `Invalid retrieval timestamp: ${row.id}`,
        );
        if (row.id !== undefined) {
          check(!ids.has(row.id), `Duplicate id in ${relative}: ${row.id}`);
          ids.add(row.id);
        }
        if (row.source_url !== undefined)
          check(officialUrl(row.source_url), `Non-UBC citation in ${relative}: ${row.source_url}`);
        if (row.api_url) check(officialUrl(row.api_url), `Non-UBC API URL in ${relative}: ${row.api_url}`);
      }
      allTables.set(relative, rows);
      records += rows.length;
      tables++;
    }
    totals.push({ group: name, tables, records, updated_at: group.updated_at });
  }
  const residences = new Set((allTables.get("housing/residences.json") ?? []).map((row) => row.id));
  const feePages = new Set((allTables.get("housing/fee_pages.json") ?? []).map((row) => row.id));
  const roomTypes = new Set((allTables.get("housing/room_types.json") ?? []).map((row) => row.id));
  for (const row of allTables.get("housing/residences.json") ?? []) {
    check(row.undergraduate_audience === true, `Unverified undergraduate residence: ${row.id}`);
    const fees = row.fee_page_ids as string[];
    check(!(row.fee_urls as string[]).length || fees.length > 0, `Missing residence fee join: ${row.id}`);
    for (const id of fees) check(feePages.has(id), `Dangling residence fee page: ${id}`);
    for (const id of row.room_type_ids as string[]) check(roomTypes.has(id), `Dangling residence room type: ${id}`);
  }
  for (const row of allTables.get("housing/fee_tables.json") ?? []) {
    check(feePages.has(row.page_id), `Dangling housing fee page: ${row.page_id}`);
    check(row.source_context_required === true, `Missing fee context warning: ${row.id}`);
    check(Array.isArray(row.values) && row.values.length > 0, `Empty fee facts: ${row.id}`);
    for (const value of row.values as Row[]) {
      check(
        value.amount_cents === null || Number.isSafeInteger(value.amount_cents),
        `Invalid exact monetary value: ${row.id}`,
      );
      check(
        typeof value.row_label === "string" && typeof value.column_label === "string",
        `Missing fee labels: ${row.id}`,
      );
    }
    for (const id of row.residence_ids as string[]) check(residences.has(id), `Dangling residence reference: ${id}`);
  }
  for (const row of allTables.get("housing/room_types.json") ?? []) {
    for (const id of row.residence_ids as string[])
      check(residences.has(id), `Dangling room residence reference: ${id}`);
  }
  const branches = new Set((allTables.get("libraries/branches.json") ?? []).map((row) => row.id));
  const schedules = new Set((allTables.get("libraries/monthly_schedules.json") ?? []).map((row) => row.id));
  for (const row of allTables.get("libraries/hours.json") ?? []) {
    check(branches.has(row.branch_id), `Dangling library branch reference: ${row.branch_id}`);
    check(schedules.has(row.schedule_id), `Dangling library schedule reference: ${row.schedule_id}`);
    check(
      typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(Date.parse(row.date)),
      `Invalid library date: ${row.id}`,
    );
    check(["open", "closed", "unknown"].includes(String(row.status)), `Invalid library hours status: ${row.id}`);
  }
  for (const row of allTables.get("policies/index.json") ?? []) {
    check(["listed", "repealed", "retired"].includes(String(row.lifecycle)), `Unsupported policy lifecycle: ${row.id}`);
    check(row.content_kind === "policy_index", `Mislabelled policy content: ${row.id}`);
  }
  for (const stem of ["it_services", "wellbeing_resources"]) {
    const joins: Record<string, string> =
      stem === "it_services"
        ? { audience: "it_audiences", service_category: "it_categories" }
        : {
            resource_campus: "wellbeing_campuses",
            resource_audience_category: "wellbeing_audiences",
            resource_category: "wellbeing_categories",
            resource_student_pop: "wellbeing_populations",
          };
    for (const [relation, table] of Object.entries(joins)) {
      const ids = new Set((allTables.get(`student-support/${table}.json`) ?? []).map((row) => row.id));
      for (const row of allTables.get(`student-support/${stem}.json`) ?? []) {
        const value = object(row.related)[relation];
        const values = Array.isArray(value) ? value : value ? [value] : [];
        for (const id of values) {
          if (id === "missing")
            check(
              (row.unavailable_relationships as string[]).includes(relation),
              `Undocumented missing ${relation} target: ${row.id}`,
            );
          else check(ids.has(id), `Dangling ${relation} reference: ${id}`);
        }
      }
    }
  }
  return {
    groups: totals,
    records: totals.reduce((sum, group) => sum + Number(group.records), 0),
    fact_records_checked: factRecords,
    representation: "facts_and_links",
    note: "JSON rows counted once, including source-link indexes and derived facts. CSV counterparts and underscore metadata are excluded. Field allowlists, fact hashes and no-prose/no-HTML checks apply to every row.",
  };
}

if (import.meta.main) {
  validateUndergradData()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
