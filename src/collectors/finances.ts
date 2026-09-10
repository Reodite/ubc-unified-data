/** What UBC costs a student: tuition rates, fees, and first-year estimates.
 *
 * Three sources, because UBC publishes cost in three unrelated places and none of
 * them is an API:
 *
 * - **The Academic Calendar's `/fees/` pages** carry the authoritative rates as
 *   HTML tables -- per-credit tuition by program for domestic and international
 *   students, the latter split across seven cohort columns because international
 *   tuition is fixed at the rate of the year you started. Also flat-rate programs
 *   (Dentistry, Medicine, Vantage), certificates, graduate programs, and the
 *   Board- and society-approved student fees.
 * - **you.ubc.ca's cost estimator** carries UBC's own first-year estimate per
 *   program area -- tuition, student fees, lab fees, books -- plus what it assumes
 *   housing, meals, rent and groceries cost. Its tuition figures are already
 *   computed on a 30-credit load, which is what makes them estimates rather than
 *   rates.
 * - **The program finder** supplies the programs those estimates get attached to.
 *
 * The tables are read into one long format rather than mirrored column-for-column.
 * UBC's fee tables have between one and eight value columns and change shape from
 * page to page; a row per (item, column) cell survives that, keeps the column
 * header verbatim, and derives `student_type`, `cohort_year` and `unit` from it.
 * Anything on those pages that isn't a money cell -- footnotes, conditions,
 * instalment counts -- goes to `fee_notes` rather than being dropped.
 *
 * `program_cost_estimates` is the one derived table: each program joined to the
 * estimator area that covers it, with the year-one total added up. The join is
 * UBC's own data matched on names, not a mapping typed out here, so every row
 * records how it was matched and `_unmatched.json` lists what didn't.
 */

import type { Http, Output } from "../base.ts";
import { jsLiteral, jsonapiCollection, register, wants } from "../base.ts";
import * as htmldoc from "../htmldoc.ts";
import { campusIds, onCampus, programFinderDatasets } from "./admissions.ts";

export const CAMPUSES: Record<string, string> = {
  vancouver: "vancouver.calendar.ubc.ca",
  okanagan: "okanagan.calendar.ubc.ca",
};

export const YOU_HOST = "you.ubc.ca";
export const PROGRAMS_URL = `https://${YOU_HOST}/programs/`;

export const FEES_SECTION = "/fees";

export const MONEY_RE = /\$\s*([\d,]+(?:\.\d{1,2})?)/;

// "commenced in 2023S or 2023W" on a column header, and the bare "2025S or
// 2025W" the graduate tables use as an in-table divider instead.
export const COHORT_RE = /commenc\w*\s+in\s+(\d{4})|\b(\d{4})[SW]\b/i;

// A footnote marker opening a cell: "1 Offered by the Faculty of Pharmacy".
// Distinguishable from a cohort divider, which runs digits into a letter.
export const FOOTNOTE_RE = /^\d+\s+\S/;

// Longest a single-cell row can be and still be read as a divider labelling the
// rows beneath it rather than a note written under the table.
export const DIVIDER_LIMIT = 80;

// What a figure is charged against. Checked in order, so "per credit" wins over
// a bare "credit" appearing elsewhere in a long header.
export const UNITS: ReadonlyArray<[string, RegExp]> = [
  ["per_credit", /per[- ]credit/i],
  // "Instalments per year: 3" says how a year is split, not what is charged
  // annually, so it must not read as a per-year rate.
  ["per_year", /(?<!instalments?\s)per\s+(year|annum)|annually|per\s+session/i],
  ["per_term", /per\s+term/i],
  ["per_month", /per\s+month|monthly/i],
  // Graduate tables often name the unit nowhere but the row label ("Instalment
  // 1") or the preamble ("Instalments per year: 3"), so this one is loose. It
  // is checked last, and only against a text no earlier pattern matched.
  ["per_instalment", /inst[ai]lment/i],
];

// Which page a rate came off, which is the only place its level is recorded.
export const LEVELS: ReadonlyArray<[string, string]> = [
  ["masters", "/fees/tuition-fees/graduate/masters"],
  ["doctoral", "/fees/tuition-fees/graduate/doctoral"],
  ["graduate", "/fees/tuition-fees/graduate"],
  ["certificate_diploma", "/fees/tuition-fees/certificate-and-diploma-programs"],
  ["vantage_college", "/fees/tuition-fees/vantage-college"],
  ["dual_degree", "/fees/tuition-fees/undergraduatemaster-management-dual-degree"],
  ["undergraduate", "/fees/tuition-fees/undergraduate"],
];

export const TUITION_PREFIX = "/fees/tuition-fees";

// A full-time year at UBC, and the load the cost estimator states its own
// tuition figures on. Used to turn a per-credit rate into an annual one.
export const CREDITS_PER_YEAR = 30;

// Tokens that say nothing about which program a name refers to.
export const STOPWORDS = new Set(["bachelor", "of", "the", "in", "and", "a", "option", "program", "degree"]);

type AnyJson = Record<string, any>;

export function money(text: string): number | null {
  const match = MONEY_RE.exec(text ?? "");
  return match ? Number(match[1]!.replace(",", "")) : null;
}

export function unit(...texts: Array<string | undefined>): string | null {
  /** What a figure is charged against, from the most specific text that says. */
  for (const text of texts) {
    for (const [name, pattern] of UNITS) {
      if (pattern.test(text ?? "")) return name;
    }
  }
  return null;
}

export function studentType(...texts: Array<string | undefined>): string | null {
  const joined = (texts.join(" ") ?? "").toLowerCase();
  if (joined.includes("international")) return "international";
  if (joined.includes("domestic") || joined.includes("canadian")) return "domestic";
  return null;
}

export function cohort(...texts: Array<string | undefined>): [number | null, string | null] {
  /** The intake a rate applies to, from the first text that names one. */
  for (const text of texts) {
    const match = COHORT_RE.exec(text ?? "");
    if (!match) continue;
    const year = Number(match[1] ?? match[2] ?? 0);
    const lowered = (text ?? "").toLowerCase();
    if (lowered.includes("or later")) return [year, "or_later"];
    if (lowered.includes("or earlier")) return [year, "or_earlier"];
    return [year, "exactly"];
  }
  return [null, null];
}

export function level(alias: string): string | null {
  return LEVELS.find(([, prefix]) => alias.startsWith(prefix))?.[0] ?? null;
}

export function tokens(text: string): Array<string> {
  const words = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  return words.filter((word) => !STOPWORDS.has(word));
}

export function numberFrom(value: unknown): number | null {
  const parsed = Number(String(value).replace(",", "").trim());
  return Number.isNaN(parsed) ? null : parsed;
}

export interface Shape {
  headers: string[];
  context: string[];
  body: Array<string[]>;
  label: string | null;
}

export function shape(table: htmldoc.Table): Shape {
  /** Work out a table's header row, its preamble, and where its data starts. */
  let headers = table.headers;
  let rows = table.rows;

  // A one-cell <th> row is the table's title, not its header -- "Doctor of
  // Pharmacy Flexible Program" sits above the real header three rows down.
  // Push it back into the body so the search below can find the real one.
  if (headers.length > 0 && headers.filter(Boolean).length <= 1) {
    rows = [headers, ...rows];
    headers = [];
  }
  if (headers.length > 0) {
    return { headers, context: [], body: rows, label: null };
  }

  const label = rows[0]?.[0] ?? null;

  const first = rows.findIndex((row) => row.some((cell) => money(cell) !== null));
  if (first < 0) {
    return { headers: [], context: [], body: rows, label };
  }

  const preamble = rows.slice(0, first);
  const widths = preamble.map((row) => row.slice(1).filter(Boolean).length);
  const best = Math.max(...widths, 0);
  if (best < 2) {
    return { headers: [], context: preamble.map(join), body: rows.slice(first), label };
  }

  const headerAt = widths.indexOf(best);
  return {
    headers: preamble[headerAt] ?? [],
    context: preamble.slice(0, headerAt).map(join),
    body: rows.slice(headerAt + 1),
    label,
  };
}

export function join(cells: Array<string>): string {
  return cells.filter(Boolean).join(" ").trim();
}

export function parsePage(page: AnyJson, opts: { campus: string; host: string }): [Array<AnyJson>, Array<AnyJson>] {
  /** Melt every table on a fee page into one row per money cell. */
  const { campus, host } = opts;
  const alias = page["alias"] as string;
  const common = {
    campus,
    level: level(alias),
    page: page["title"],
    url: `https://${host}${alias}`,
  };

  const rows: Array<AnyJson> = [];
  const notes: Array<AnyJson> = [];
  let section = "";

  for (const block of htmldoc.blocks(page["html"] ?? "")) {
    if ((block as htmldoc.Heading).level !== undefined) {
      section = (block as htmldoc.Heading).text;
      continue;
    }

    const tab = shape(block as htmldoc.Table);
    const headers = tab.headers;
    const context = tab.context;
    const where = { ...common, section, context, table_label: tab.label };
    let divider = "";

    for (const cells of tab.body) {
      const amounts: Array<[number, string]> = [];
      cells.forEach((cell, index) => {
        // A footnote can carry a dollar sign without being a rate.
        if (money(cell) !== null && !FOOTNOTE_RE.test(cell)) amounts.push([index, cell]);
      });
      if (amounts.length === 0) {
        const noteText = join(cells);
        if (!noteText) continue;
        const filled = cells.filter(Boolean).length;
        let kind: string = "note";
        if (filled === 1 && noteText.length <= DIVIDER_LIMIT && !FOOTNOTE_RE.test(noteText)) {
          divider = noteText;
          kind = "divider";
        }
        notes.push({ ...where, kind, note: noteText });
        continue;
      }

      // When the first cell is itself an amount the row has no label, and
      // the divider or preamble above it is the only thing naming it.
      const item = amounts[0]![0] !== 0 ? cells[0] : "";

      for (const [index, cell] of amounts) {
        const header = index < headers.length ? headers[index] : "";
        const [year, rule] = cohort(header, divider, item);
        rows.push({
          ...where,
          divider,
          item,
          student_type: studentType(header, divider, section, headers[0]),
          cohort_year: year,
          cohort_rule: rule,
          unit: unit(header, cell, item, join(context), divider, section),
          amount: money(cell),
          amount_text: cell,
          column: header,
        });
      }
    }
  }

  return [rows, notes];
}

export const YEARS_RE = /\((Years?\s[^)]*)\)/gi;

// A footnote marker welded onto the end of a name: "Unclassified1", "Visiting2".
export const TRAILING_MARKER_RE = /(?<=[a-z)])\d{1,2}$/;

export function name(row: AnyJson): [string, string | null] {
  /** The program a tuition row is about, and the year band it applies to. */
  const rawName = row["table_label"] || row["context"]?.[0] || row["item"] || "";
  // reset so a previous call's match doesn't move lastIndex past this one
  YEARS_RE.lastIndex = 0;
  const match = YEARS_RE.exec(String(rawName ?? ""));
  const program = String(rawName ?? "")
    .replace(YEARS_RE, "")
    .trim();
  const cleaned = program.replace(TRAILING_MARKER_RE, "").trim();
  return [cleaned, match ? match[1]!.trim() : null];
}

export function estimateRow(campus: string, key: string, label: string, values: AnyJson): AnyJson {
  const row: AnyJson = { campus, area_key: key, area: label };
  for (const field of ESTIMATE_FIELDS) {
    row[field] = numberFrom(values[field]);
  }
  row["custom_tuition_message"] = htmldoc.text(values["custom_tuition_message"] ?? "");

  for (const studentType of ["domestic", "international"] as const) {
    const parts = [
      row[`tuition_${studentType}`],
      row["student_fees"],
      row[`lab_clinic_fees_${studentType}`],
      row["books_supplies"],
    ];
    row[`educational_total_${studentType}`] =
      row[`tuition_${studentType}`] !== null
        ? Math.round((parts as Array<number | null>).reduce((sum: number, p) => sum + (p ?? 0), 0) * 100) / 100
        : null;
  }
  return row;
}

export const ESTIMATE_FIELDS = [
  "tuition_domestic",
  "tuition_international",
  "student_fees",
  "lab_clinic_fees_domestic",
  "lab_clinic_fees_international",
  "books_supplies",
];

// The estimator states housing and meal plans as a year and everything else as
// a month; nothing in the payload says so, only the copy around it.
export const LIVING_BASIS: Record<string, string> = { rent: "per_month", groceries: "per_month" };

export function livingRows(campus: string, expenses: AnyJson): Array<AnyJson> {
  const rows: Array<AnyJson> = [];
  for (const [item, value] of Object.entries(expenses)) {
    const variants = value !== null && typeof value === "object" ? value : { standard: value };
    for (const [variant, amount] of Object.entries(variants)) {
      rows.push({
        campus,
        item,
        variant,
        amount: numberFrom(amount),
        basis: LIVING_BASIS[item] ?? "per_academic_year",
      });
    }
  }
  return rows;
}

/** Attach each program to the estimator area that prices it. */
export function matchPrograms(
  programs: unknown,
  degrees: unknown,
  estimates: Array<AnyJson>,
): [Array<AnyJson>, Array<AnyJson>] {
  const rows = Array.isArray(programs)
    ? programs
    : programs !== null && typeof programs === "object"
      ? Object.values(programs)
      : [];
  const degreeNames: Record<string, string> = {};
  const degreeList = Array.isArray(degrees)
    ? degrees
    : degrees !== null && typeof degrees === "object"
      ? Object.values(degrees)
      : [];
  for (const term of degreeList) {
    if (term !== null && typeof term === "object") {
      degreeNames[String((term as AnyJson)["term_id"])] = String((term as AnyJson)["name"]);
    }
  }

  const exact = new Map<string, AnyJson>();
  const vocabulary: Array<[Set<string>, AnyJson]> = [];
  for (const estimate of estimates) {
    const keys = [tokens(String(estimate["area"])), tokens(String(estimate["area_key"]))];
    for (const key of keys) {
      const joined = key.join(" ");
      if (!exact.has(joined)) exact.set(joined, estimate);
    }
    vocabulary.push([new Set(keys.flat()), estimate]);
  }

  const overlap = (parts: Array<string>): AnyJson | null => {
    const wanted = new Set(parts);
    if (wanted.size === 0) return null;
    const scored: Array<[number, AnyJson]> = vocabulary.map(([words, estimate]) => [
      intersectionSize(wanted, words),
      estimate,
    ]);
    const best = Math.max(...scored.map(([score]) => score));
    // One shared word is noise -- "science" alone sits in six area names.
    if (best < 2) return null;
    const winners = scored.filter(([score]) => score === best).map(([, estimate]) => estimate);
    return winners.length === 1 ? winners[0]! : null;
  };

  const matched: Array<AnyJson> = [];
  const unmatched: Array<AnyJson> = [];
  for (const program of rows) {
    if (program === null || typeof program !== "object") continue;
    const programRow = program as AnyJson;
    const names: Array<string> = [];
    for (const term of (programRow["degrees"] as unknown[] | undefined) ?? []) {
      const degreeName = degreeNames[String(term)];
      if (degreeName) names.push(degreeName);
    }
    const candidates: ReadonlyArray<[string, string | null]> = [
      ["title", programRow["post_title"] ?? null],
      ...names.map((n) => ["degree", n] as [string, string]),
    ];

    let estimate: AnyJson | null = null;
    let how: string | null = null;
    for (const [source, name] of candidates) {
      if (name === null) continue;
      const found = exact.get(tokens(name).join(" "));
      if (found) {
        estimate = found;
        how = `exact:${source}`;
        break;
      }
    }
    if (!estimate) {
      for (const [source, name] of candidates) {
        if (name === null) continue;
        const found = overlap(tokens(name));
        if (found) {
          estimate = found;
          how = `overlap:${source}`;
          break;
        }
      }
    }

    const identity = {
      program_id: programRow["id"] ?? null,
      program: programRow["post_title"] ?? null,
      degrees: names,
      url: programRow["link"] ?? null,
    };
    if (!estimate) {
      unmatched.push({ ...identity, reason: "no unique cost-estimator area" });
      continue;
    }

    matched.push({
      ...identity,
      campus: estimate["campus"],
      area_key: estimate["area_key"],
      area: estimate["area"],
      matched_by: how,
      ...Object.fromEntries(ESTIMATE_FIELDS.map((field) => [field, estimate[field] ?? null])),
      educational_total_domestic: estimate["educational_total_domestic"] ?? null,
      educational_total_international: estimate["educational_total_international"] ?? null,
      custom_tuition_message: estimate["custom_tuition_message"] ?? null,
    });
  }

  return [matched, unmatched];
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const value of a) if (b.has(value)) count += 1;
  return count;
}

export const Finances = register(
  class {
    name = "finances";
    folder = "finances";
    title = "Tuition, student fees and first-year cost estimates";
    description =
      "What studying at UBC costs: per-credit tuition rates by program for domestic " +
      "and international students including the cohort year each rate applies to, " +
      "flat-rate and per-instalment programs, Board- and society-approved student " +
      "fees, UBC's own first-year cost estimate for every program area with the " +
      "housing, meal, rent and grocery figures behind it, and a per-program estimate " +
      "derived by joining the two.";
    sources = [`https://${CAMPUSES["vancouver"]}${FEES_SECTION}`, PROGRAMS_URL];

    async collect(http: Http, out: Output): Promise<void> {
      describeFinances(out);

      const tuition: Array<AnyJson> = [];
      const fees: Array<AnyJson> = [];
      const notes: Array<AnyJson> = [];
      const sources: Array<AnyJson> = [];

      for (const [campus, host] of Object.entries(CAMPUSES)) {
        if (!wants(campus)) continue;
        const pages = await this.feePages(http, host);
        sources.push({ campus, host, fee_pages: pages.length });
        for (const page of pages) {
          const [rows, pageNotes] = parsePage(page, { campus, host });
          const target = String(page["alias"]).startsWith(TUITION_PREFIX) ? tuition : fees;
          target.push(...rows);
          notes.push(...pageNotes);
        }
      }

      // `program` only means something on the tuition pages; a fee row's label
      // names a fee, not a program, so it keeps `item` and nothing more.
      for (const row of tuition) {
        const [programName, appliesTo] = name(row);
        row["program"] = programName;
        row["applies_to"] = appliesTo;
        const perCredit = row["unit"] === "per_credit" && row["amount"] !== null;
        row["annual_at_30_credits"] = perCredit ? Math.round(row["amount"] * CREDITS_PER_YEAR * 100) / 100 : null;
      }

      const feesUrl = `https://${CAMPUSES["vancouver"]}${FEES_SECTION}`;
      await out.table("tuition", tuition, { source: feesUrl });
      await out.table("student_fees", fees, { source: feesUrl });
      await out.table("fee_notes", notes, { source: feesUrl });

      const [estimates, living, programs, unmatched] = await this.estimates(http);
      await out.table("cost_estimates", estimates, { source: PROGRAMS_URL });
      await out.table("living_costs", living, { source: PROGRAMS_URL });
      await out.table("program_cost_estimates", programs, { source: PROGRAMS_URL });

      await out.json("_sources.json", {
        calendar: sources,
        estimator: { url: PROGRAMS_URL, areas: estimates.length },
        credits_per_year: CREDITS_PER_YEAR,
      });
      if (unmatched.length > 0) {
        await out.json("_unmatched.json", unmatched);
      }
    }

    async feePages(http: Http, host: string): Promise<Array<AnyJson>> {
      /** Calendar pages under /fees, with their body HTML. */
      const pages: Array<AnyJson> = [];
      for (const record of await jsonapiCollection(http, host, "node/ubc_page")) {
        const alias = record["alias"] ?? "";
        if (!String(alias).startsWith(FEES_SECTION)) continue;
        const body = record["body"];
        pages.push({
          title: record["title"],
          alias,
          html: body !== null && typeof body === "object" ? (body as AnyJson)["value"] : body,
        });
      }
      return pages.sort((a, b) => (a["alias"] < b["alias"] ? -1 : a["alias"] > b["alias"] ? 1 : 0));
    }

    async estimates(http: Http): Promise<[Array<AnyJson>, Array<AnyJson>, Array<AnyJson>, Array<AnyJson>]> {
      const html = await http.getText(PROGRAMS_URL);
      const data = jsLiteral(html, "costEstimatorData") as AnyJson;
      const costs = (data["estimatorCosts"] ?? {}) as AnyJson;

      const estimates: Array<AnyJson> = [];
      const living: Array<AnyJson> = [];

      for (const [campus, payload] of Object.entries(costs)) {
        if (!campus || !(payload !== null && typeof payload === "object") || !wants(campus as string)) continue;
        const labels = (data[`${campus}ProgramLabels`] ?? {}) as AnyJson;
        const programs = (payload["programs"] ?? {}) as AnyJson;
        for (const [key, values] of Object.entries(programs)) {
          if (values !== null && typeof values === "object") {
            estimates.push(estimateRow(campus as string, key, String(labels[key] ?? key), values as AnyJson));
          }
        }
        living.push(...livingRows(campus as string, (payload["expenses"] ?? {}) as AnyJson));
      }

      // The page ships both campuses; filter programs to the same campus scope
      // as their estimates. Read program, campus and degree datasets from
      // `programsListData`, with individual `var` literals as the fallback for
      // pages that publish each dataset separately.
      const finder = programFinderDatasets(html);
      const programsLiteral = finder?.["programs"];
      const campusesLiteral = finder?.["campuses"];
      const degreesLiteral = finder?.["degrees"];
      const programs = onCampus(
        programsLiteral ?? (jsLiteral(html, "programs") as unknown as AnyJson[]),
        campusIds(campusesLiteral ?? (jsLiteral(html, "campuses") as unknown as AnyJson[])),
      );
      const [matched, unmatched] = matchPrograms(programs, degreesLiteral ?? jsLiteral(html, "degrees"), estimates);
      return [estimates, living, matched, unmatched];
    }
  },
);

function describeFinances(out: Output): void {
  const money = "amount in CAD";
  out.describe("tuition", {
    grain: "one tuition figure: a program, a column of the table it came from, and what that column charges",
    columns: {
      level:
        "undergraduate, certificate_diploma, masters, doctoral, vantage_college or dual_degree -- " +
        "from the page the rate is on",
      program: "program the rate applies to, with any year band removed",
      applies_to: "the year band, e.g. `Years 2 to 5`, when the rate is banded",
      student_type: "domestic or international",
      cohort_year: "intake year the rate is frozen at; international rates only",
      cohort_rule: "exactly, or_later or or_earlier -- how to read cohort_year",
      unit: "per_credit, per_year, per_instalment or per_term",
      amount: money,
      annual_at_30_credits:
        "derived: amount x 30, for per-credit rates only. 30 credits is a full-time year and the load " +
        "UBC's own estimator uses",
      amount_text: "the cell as UBC wrote it",
      column: "the column header, verbatim",
      section: "the heading above the table",
      item: "the row label, verbatim; empty when the row had no label",
      context:
        "rows above the header inside the same table -- on the graduate pages this is where the program " +
        "name and instalment count live",
      table_label: "the table's own first cell, which is what `program` is usually taken from",
      divider: "the in-table row heading the amount sits under, e.g. `2026S or 2026W`",
      url: "the calendar page",
    },
    joins: ["program ~ finances/program_cost_estimates.area (by name, not an id)"],
  });
  out.describe("student_fees", {
    grain: "one student fee as charged to one category of student",
    columns: {
      item: "the fee, e.g. `Athletics and Recreation Fee`",
      column: "who pays it, e.g. `Undergraduate and Certificates Full-Time`",
      unit: "per_year, per_credit or per_term",
      amount: money,
      section: "the heading above the table; says whether the Board of Governors or a student society sets the fee",
      url: "the calendar page",
    },
    joins: [],
  });
  out.describe("fee_notes", {
    grain:
      "one row from a fee table that carries no money -- footnotes, eligibility conditions and " +
      "instalment counts, kept because they qualify the rates",
    columns: { section: "the heading above the table", note: "the row's text", url: "the calendar page" },
    joins: ["url -> finances/tuition.url"],
  });
  out.describe("cost_estimates", {
    grain: "UBC's own first-year cost estimate for one program area",
    columns: {
      area_key: "the estimator's slug, e.g. `land_food_systems_applied_biology`",
      area: "the area as the estimator names it",
      tuition_domestic: "year-one tuition on a 30-credit load, CAD",
      tuition_international: "year-one tuition on a 30-credit load, CAD",
      student_fees: "year-one student fees (U-Pass, basic health insurance...)",
      lab_clinic_fees_domestic: "lab or clinic fees, where the area charges them",
      lab_clinic_fees_international: "lab or clinic fees, where the area charges them",
      books_supplies: "estimated books and supplies for the year",
      educational_total_domestic: "derived: tuition + fees + lab + books",
      educational_total_international: "derived: tuition + fees + lab + books",
      custom_tuition_message: "caveat UBC attaches to this area's figure",
    },
    joins: ["(campus, area_key) -> finances/program_cost_estimates"],
  });
  out.describe("living_costs", {
    grain: "one cost-of-living figure the estimator assumes",
    columns: {
      item: "campus_housing_single, meal_plan, rent, groceries...",
      variant: "standard, or vantage_one where Vantage College differs",
      amount: money,
      basis: "per_academic_year for housing and meal plans, per_month for the rest",
    },
    joins: [],
  });
  out.describe("program_cost_estimates", {
    grain: "one undergraduate program with the first-year cost of the area that prices it",
    columns: {
      program_id: "joins to admissions/programs.json `id`",
      program: "program name as the finder lists it",
      degrees: "degree names this program leads to; what the match usually ran on",
      campus: "campus the estimate is for",
      area: "the cost-estimator area, e.g. `Land and Food Systems: Applied Biology`",
      area_key: "the cost-estimator area matched to this program",
      tuition_domestic: "year-one tuition on a 30-credit load, CAD",
      tuition_international: "year-one tuition on a 30-credit load, CAD",
      student_fees: "year-one student fees",
      books_supplies: "estimated books and supplies for the year",
      matched_by:
        "how the match was made -- exact or overlap, on the program title or on one of its degrees. " +
        "Programs with no unique area are in _unmatched.json rather than here",
      educational_total_domestic: "derived: tuition + fees + lab + books for year one",
      educational_total_international: "derived: tuition + fees + lab + books for year one",
    },
    joins: [
      "program_id -> admissions/programs.id",
      "program_id -> admissions/requirements/program_requirements.program_id",
      "(campus, area_key) -> finances/cost_estimates",
    ],
  });
}
