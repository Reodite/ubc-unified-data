/** What each undergraduate program actually requires you to have taken.
 *
 * The program finder tells you a degree exists; it does not tell you that Commerce
 * wants Pre-Calculus 12. That lives behind the "Program requirements" section of
 * each program page, and it is not in the page source either -- the page ships a
 * dropdown of provinces and countries and calls `admin-ajax.php` for the rules
 * that apply to whichever one you pick, because the answer genuinely differs by
 * curriculum. Ontario's requirement for Arts is "ENG4U"; British Columbia's is
 * "English Studies 12 or English First Peoples 12"; China's is written as prose
 * about Upper Middle School years.
 *
 * So this drives the same endpoint the page does. Two things make that tractable:
 *
 * - Requirements are shared, not per-program. Every program page declares a
 *   `requirement` key in `programRequirementsSettings`, and many programs
 *   resolve to the same key. Fetching per key rather than per program cuts the
 *   request count to the number of distinct requirements, and
 *   `program_requirements` keeps the program-to-key mapping so nothing is lost.
 * - The IB tab is rendered server-side. Unlike the province and country tabs,
 *   it sits in the page HTML already, so it costs no extra request.
 *
 * The output is deliberately two-layered: `by_location` keeps UBC's own prose per
 * group and location, and `required_courses` explodes the `<li>` lists inside it
 * into one row per requirement, which is the form an actual question -- "what do I
 * need for Engineering from Alberta?" -- can be answered from directly.
 */

import { wants } from "../core/campus.ts";
import { errorMessage, errorName, type Http } from "../core/http.ts";
import type { Output } from "../core/output.ts";
import { clean, text as htmldocText, items, sections } from "../htmldoc.ts";

export const HOST = "you.ubc.ca";
export const ENDPOINT = `https://${HOST}/wp-admin/admin-ajax.php`;

export const SETTINGS_RE = /\bvar\s+programRequirementsSettings\s*=\s*(\{.*?\});/s;
export const OPTIONS_RE = /data-taxonomy="([^"]+)"(.*?)<\/select>/gs;
export const OPTION_RE = /value="(\d+)"\s+data-slug="([^"]*)"\s+data-select="([^"]*)"/g;
export const IB_TAB_RE = /id="requirement_ib">(.*?)(?=<div class="tabs-content-item"|<\/section>)/s;

// The IB tab is one static block; give it the same shape as an AJAX answer so a
// reader does not have to special-case the curriculum they are asking about.
export const IB_TAXONOMY = "requirement_ib";
export const IB_LOCATION = { term_id: null, slug: "ib-diploma", name: "International Baccalaureate" };

// UBC keys the specific requirements by grade band, and uses a different key
// when a curriculum has no grade bands to speak of. `kind` in the output names
// which one a row came from so the distinction survives. Order matters:
// `course_suggestions` and `related_courses` are the same thing under two names
// and UBC's own script takes the first that is set, so the first wins here too.
export const SPECIFIC_FIELDS: ReadonlyArray<[string, string]> = [
  ["minimum_requirements", "minimum"],
  ["grade_12", "grade_12"],
  ["grade_11", "grade_11"],
  ["recommended_grade_range", "recommended_grade_range"],
  ["course_suggestions", "suggested_subjects"],
  ["related_courses", "suggested_subjects"],
];

// Every kind a summary row can carry, so all rows have the same columns whether
// or not a given curriculum states that kind.
export const KINDS = [...new Set(SPECIFIC_FIELDS.map(([, kind]) => kind))];

// Requirements are advice on these two; everything else is a hard gate.
export const ADVISORY = new Set(["suggested_subjects", "recommended_grade_range"]);

// Headings the IB tab uses, mapped onto the AJAX response's field names.
export const IB_HEADINGS: ReadonlyArray<[string, string]> = [
  ["english", "english-language"],
  ["general", "general admission"],
  ["specific", "degree-specific"],
  ["related_courses", "related courses"],
];

type AnyJson = Record<string, any>;

function text(value: any): string {
  return typeof value === "string" ? htmldocText(value) : "";
}

export function summary(values: Record<string, any> = {}): AnyJson {
  /** A `by_location` row with every column present, unset ones null. */
  const row: AnyJson = {
    available: false,
    specific_name: null,
    english: null,
    general: null,
    profile_note: null,
    note: null,
  };
  for (const kind of KINDS) row[kind] = null;
  Object.assign(row, values);
  return row;
}

export function settings(html: string): AnyJson | null {
  const match = SETTINGS_RE.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as AnyJson;
  } catch {
    return null;
  }
}

export function locationsFrom(html: string): Record<string, Array<AnyJson>> {
  /** The province and country dropdowns a program page offers. */
  const found: Record<string, Array<AnyJson>> = {};
  for (const match of html.matchAll(OPTIONS_RE)) {
    const taxonomy = match[1]!;
    const rows: Array<AnyJson> = [];
    for (const option of match[2]!.matchAll(OPTION_RE)) {
      rows.push({
        term_id: Number(option[1]),
        slug: option[2],
        name: clean(option[3]!),
      });
    }
    found[taxonomy] = rows;
  }
  return found;
}

export function ibSectionsFrom(html: string): AnyJson | null {
  /** The pre-rendered IB tab, reshaped to look like an AJAX response. */
  const match = IB_TAB_RE.exec(html);
  if (!match) return null;

  let specificName = "";
  const buckets: Record<string, string[]> = {};
  const prose: Record<string, string> = {};

  for (const section of sections(match[1]!)) {
    const heading = section.heading.toLowerCase();
    const field = IB_HEADINGS.find(([, marker]) => heading.includes(marker))?.[0];
    if (field === undefined) continue;
    if (field === "specific") {
      // "Degree-specific requirements: Commerce (UBC Sauder School of Business)"
      specificName = section.heading.split(":")[1]?.trim() ?? "";
    }
    if (!(field in buckets)) buckets[field] = [];
    (buckets[field] as unknown[]).push(...section.items);
    if (section.text) prose[field] = section.text;
  }

  if (Object.keys(buckets).length === 0) return null;

  return {
    result: true,
    english: prose["english"] ?? "",
    english_items: buckets["english"] ?? [],
    general: prose["general"] ?? "",
    general_items: buckets["general"] ?? [],
    specific_name: specificName,
    specific_items: buckets["specific"] ?? [],
    related_items: buckets["related_courses"] ?? [],
    related_text: prose["related_courses"] ?? "",
  };
}

export function rowsFromAjax(payload: AnyJson): [AnyJson, Array<AnyJson>] {
  /** Split one AJAX answer into its summary row and its requirement lines. */
  const specific = payload["specific"];
  if (!(specific !== null && typeof specific === "object") || Object.keys(specific).length === 0) {
    return [summary(), []];
  }

  const name = Object.keys(specific)[0]!;
  let fields = specific[name];
  if (!(fields !== null && typeof fields === "object")) fields = {};

  const row = summary({
    available: true,
    specific_name: clean(name),
    english: text(payload["english"]),
    general: text(payload["general"]),
    profile_note: text(payload["profile"]?.["description"]),
  });

  const lines: Array<AnyJson> = [];
  for (const [field, kind] of SPECIFIC_FIELDS) {
    const value = fields[field];
    if (typeof value !== "string" || !value.trim() || (row[kind] ?? null) !== null) continue;
    row[kind] = htmldocText(value);
    items(value).forEach((item, position) => {
      lines.push({ kind, position: position + 1, requirement: item });
    });
  }

  // General admission rules are a requirement too, and asking "what do I need"
  // should not silently drop "graduation from high school".
  for (const [field, kind] of [
    ["general", "general"],
    ["english", "english_language"],
  ] as const) {
    const value = payload[field];
    if (typeof value === "string" && value.trim()) {
      items(value).forEach((item, position) => {
        lines.push({ kind, position: position + 1, requirement: item });
      });
    }
  }

  return [row, lines];
}

export function rowsFromIb(payload: AnyJson): [AnyJson, Array<AnyJson>] {
  const row = summary({
    available: true,
    specific_name: payload["specific_name"],
    english: payload["english"] || (payload["english_items"] as string[]).join(" "),
    general: (payload["general_items"] as string[]).join(" ") || payload["general"],
    // The IB tab states one block of degree-specific rules with no grade bands,
    // which is the same thing `minimum_requirements` is elsewhere.
    minimum: (payload["specific_items"] as string[]).join(" ") || null,
    suggested_subjects: (payload["related_items"] as string[]).join(" ") || null,
  });
  const lines: Array<AnyJson> = [];
  for (const [kind, payloadItems] of [
    ["minimum", payload["specific_items"]],
    ["general", payload["general_items"]],
    ["english_language", payload["english_items"]],
    ["suggested_subjects", payload["related_items"]],
  ] as const) {
    (payloadItems as string[]).forEach((item, position) => {
      lines.push({ kind, position: position + 1, requirement: item });
    });
  }
  return [row, lines];
}

export async function collect(
  http: Http,
  out: Output,
  opts: { programs: Array<AnyJson>; degrees: Record<string, string> },
): Promise<void> {
  /** Fetch every requirement group against every curriculum location. */
  const { programs, degrees } = opts;
  const pages = await http.map((program) => readProgram(http, program), programs);

  const programRows: Array<AnyJson> = [];
  const groups: Map<string, AnyJson> = new Map();
  const locations: Map<string, AnyJson> = new Map();
  const ibPayloads: Map<string, AnyJson> = new Map();

  for (const [program, page] of pair(programs, pages)) {
    const names = ((program["degrees"] as unknown[]) ?? []).map((term) => degrees[String(term)]).filter(Boolean);
    const row: AnyJson = {
      program_id: program["id"] ?? null,
      program: program["post_title"] ?? null,
      degrees: names,
      url: program["link"] ?? null,
      campus: null,
      requirement_key: null,
      has_requirements: false,
      note: null,
    };

    const pageSettings = page?.["settings"] as AnyJson | undefined;
    if (!pageSettings) {
      row["note"] = page?.["error"] ?? "no requirements widget on the program page";
      programRows.push(row);
      continue;
    }

    const rawCampus = pageSettings["campus"];
    const campus = (rawCampus ? String(rawCampus) : "").toLowerCase() || null;
    const key = pageSettings["requirement"] ?? null;
    row["campus"] = campus;
    row["requirement_key"] = key;
    row["has_requirements"] = Boolean(key);
    programRows.push(row);

    if (!key) continue;
    if (!wants(campus as string | null)) {
      // A program can reach this run through the finder's campus filter while
      // its page declares the other campus. Say so, rather than leaving a row
      // that claims requirements exist and points nowhere.
      row["note"] = `program page declares the ${campus} campus, out of scope for this run`;
      continue;
    }

    const groupKey = `${campus}|${key}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = {
        campus,
        requirement_key: key,
        name: null,
        programs: [],
        program_count: 0,
      };
      groups.set(groupKey, group);
    }
    group["programs"].push(program["post_title"]);
    group["program_count"] += 1;

    for (const [taxonomy, terms] of Object.entries(
      (page?.["locations"] as Record<string, Array<AnyJson>> | undefined) ?? {},
    )) {
      for (const term of terms) {
        const locationKey = `${taxonomy}|${term["term_id"]}`;
        if (!locations.has(locationKey)) {
          locations.set(locationKey, { taxonomy, ...term });
        }
      }
    }

    if (page?.["ib"] && !ibPayloads.has(groupKey)) {
      ibPayloads.set(groupKey, (page as AnyJson)["ib"]);
    }
  }

  const locationRows = [...locations.values()].sort((a, b) =>
    a["taxonomy"] < b["taxonomy"]
      ? -1
      : a["taxonomy"] > b["taxonomy"]
        ? 1
        : a["name"] < b["name"]
          ? -1
          : a["name"] > b["name"]
            ? 1
            : 0,
  );

  const [summaries, requirementRows] = await fetchRows(http, groups, locationRows, ibPayloads);

  for (const group of groups.values()) {
    const identity = `${group["campus"]}|${group["requirement_key"]}`;
    const answered = summaries.filter(
      (row) => `${row["campus"]}|${row["requirement_key"]}` === identity && row["available"],
    );
    group["programs"] = [...(group["programs"] as string[])].sort();
    group["locations"] = answered.length;
    // UBC only names the group inside the answers, and every answer for a group
    // names it the same way, so take it from the first one that came back.
    group["name"] = answered[0]?.["specific_name"] ?? null;
  }

  const base = "requirements";
  describeReq(out, base);
  await out.table(`${base}/program_requirements`, programRows, { source: ENDPOINT });
  await out.table(
    `${base}/requirement_groups`,
    [...groups.values()].sort((a, b) => b["program_count"] - a["program_count"]),
    { source: ENDPOINT },
  );
  await out.table(`${base}/locations`, locationRows.concat([{ taxonomy: IB_TAXONOMY, ...IB_LOCATION }]), {
    source: ENDPOINT,
  });
  await out.table(`${base}/by_location`, summaries, { source: ENDPOINT });
  await out.table(`${base}/required_courses`, requirementRows, { source: ENDPOINT });
}

function pair<A, B>(a: A[], b: B[]): Array<[A, B]> {
  return a.map((item, i) => [item, b[i]!] as [A, B]);
}

export async function readProgram(http: Http, program: AnyJson): Promise<AnyJson> {
  /** One program page: its requirement key, its dropdowns and its IB tab. */
  const link = program["link"];
  if (!link) return { error: "program has no link" };
  let htmlPage: string;
  try {
    htmlPage = await http.getText(String(link));
  } catch (error) {
    return { error: `${errorName(error)}: ${errorMessage(error)}` };
  }
  return {
    settings: settings(htmlPage),
    locations: locationsFrom(htmlPage),
    ib: ibSectionsFrom(htmlPage),
  };
}

export async function fetchRows(
  http: Http,
  groups: Map<string, AnyJson>,
  locationRows: Array<AnyJson>,
  ibPayloads: Map<string, AnyJson>,
): Promise<[Array<AnyJson>, Array<AnyJson>]> {
  /** Every (requirement group x location) pair, plus the free IB rows. */
  const jobs: Array<[string, string, AnyJson]> = [];
  for (const [groupKey] of groups) {
    const [campus, key] = groupKey.split("|") as [string, string];
    for (const location of locationRows) jobs.push([campus, key, location]);
  }

  const ask = async (job: [string, string, AnyJson]): Promise<AnyJson | null> => {
    const [campus, key, location] = job;
    try {
      const payload = await http.postJson(ENDPOINT, {
        action: "requirements_load_programs",
        type: location["taxonomy"],
        location: location["term_id"],
        campus,
        requirement: key,
      });
      return (payload ?? {}) as AnyJson;
    } catch {
      return null;
    }
  };

  const summaries: Array<AnyJson> = [];
  const requirements: Array<AnyJson> = [];
  const results = await http.map(ask, jobs);
  jobs.forEach(([campus, key, location], index) => {
    const payload = results[index];
    let row: AnyJson;
    let lines: Array<AnyJson>;
    if (payload == null) {
      [row, lines] = [summary({ note: "request failed" }), []];
    } else if (!payload["result"]) {
      [row, lines] = [summary(), []];
    } else {
      [row, lines] = rowsFromAjax(payload);
    }
    record(summaries, requirements, campus, key, location, row, lines);
  });

  for (const [groupKey, payload] of ibPayloads) {
    const [campus, key] = groupKey.split("|") as [string, string];
    const [row, lines] = rowsFromIb(payload);
    record(summaries, requirements, campus, key, { taxonomy: IB_TAXONOMY, ...IB_LOCATION }, row, lines);
  }

  return [summaries, requirements];
}

export function record(
  summaries: Array<AnyJson>,
  requirements: Array<AnyJson>,
  campus: string,
  key: string,
  location: AnyJson,
  row: AnyJson,
  lines: Array<AnyJson>,
): void {
  const identity: AnyJson = {
    campus,
    requirement_key: key,
    curriculum: String(location["taxonomy"]).replace(/^requirement_/, ""),
    location: location["name"] ?? null,
    location_slug: location["slug"] ?? null,
    location_term_id: location["term_id"] ?? null,
  };
  summaries.push({ ...identity, ...row });
  for (const line of lines) {
    requirements.push({
      ...identity,
      program_group: row["specific_name"] ?? null,
      ...line,
      advisory: ADVISORY.has(line["kind"]),
    });
  }
}

function describeReq(out: Output, base: string): void {
  out.describe(`${base}/program_requirements`, {
    grain: "one undergraduate program in the program finder",
    columns: {
      program_id: "you.ubc.ca post id; joins to admissions/programs.json `id`",
      program: "program name as the finder lists it",
      degrees: "degree names this program leads to",
      url: "the program page",
      campus: "campus the program page declares",
      requirement_key: "the requirement group this program uses; null if it has none",
      has_requirements: "false for graduate-entry and second-degree programs which publish no direct-entry rules",
      note: "why requirements are absent, when they are",
    },
    joins: [
      "requirement_key -> requirements/requirement_groups.requirement_key",
      "requirement_key -> requirements/by_location.requirement_key",
      "program_id -> admissions/programs.id",
    ],
  });
  out.describe(`${base}/requirement_groups`, {
    grain: "one set of degree-specific requirements, shared by every program that uses it",
    columns: {
      campus: "campus the group applies to",
      requirement_key: "UBC's slug for the group, e.g. `engineering`",
      name: "the name UBC shows, e.g. `Applied Science (Engineering)`",
      programs: "program names mapped to this group",
      program_count: "how many programs that is",
      locations: "how many curriculum locations returned rules for this group",
    },
    joins: ["(campus, requirement_key) -> requirements/by_location"],
  });
  out.describe(`${base}/locations`, {
    grain: "one curriculum a student can apply from",
    columns: {
      taxonomy: "requirement_province, requirement_countries or requirement_ib",
      term_id: "UBC's term id; null for the IB row, which is not a taxonomy term",
      slug:
        "stable identifier, e.g. `british-columbia`; `basic` is the fallback UBC applies " +
        "when a location is not listed separately. NOT unique on its own -- `basic` exists " +
        "in both the province and country taxonomies, so key on (taxonomy, slug) or on term_id",
      name: "display name",
    },
    joins: [
      "(taxonomy, slug) -> requirements/by_location.(curriculum, location_slug), with `requirement_` " +
        "stripped from the taxonomy name",
      "term_id -> requirements/by_location.location_term_id",
    ],
  });
  const identity: Record<string, string> = {
    campus: "campus the rules apply to",
    requirement_key: "the requirement group, e.g. `engineering`",
    curriculum: "province, countries or ib -- which dropdown the location came from",
    location: "the province, country or IB, as UBC names it",
    location_slug:
      "stable identifier for the location, e.g. `british-columbia`. Pair it with `curriculum` " +
      "-- `basic` is a slug in both the province and the country list and means a different thing in each",
    location_term_id: "UBC's term id for the location; unique on its own, null only for the IB row",
  };
  out.describe(`${base}/by_location`, {
    grain: "one requirement group as it applies to one curriculum location",
    columns: {
      ...identity,
      available: "false when the program is not open to students from there",
      specific_name: "the degree the rules are stated for",
      english: "English-language competency rule, as prose",
      general: "general admission rule (graduation, minimum English grade...)",
      minimum: "degree-specific rule where UBC states no grade bands",
      grade_12: "required Grade 12 (or equivalent senior) courses",
      grade_11: "required Grade 11 courses",
      recommended_grade_range:
        "the grade range UBC says is competitive. The field exists upstream " +
        "but came back empty on all combinations, so expect null",
      suggested_subjects: "subject areas UBC recommends but does not require",
      profile_note: "extra note UBC attaches to this location",
    },
    joins: [
      "(campus, requirement_key) -> requirements/requirement_groups",
      "(curriculum, location_slug) -> requirements/locations.(taxonomy, slug)",
      "location_term_id -> requirements/locations.term_id",
    ],
  });
  out.describe(`${base}/required_courses`, {
    grain:
      "one requirement line -- the exploded form of by_location, and the table to query " +
      "when the question is 'what do I need to have taken?'",
    columns: {
      ...identity,
      program_group: "the degree the requirement is stated for",
      kind: "grade_12, grade_11, minimum, general, english_language, suggested_subjects or recommended_grade_range",
      position: "order within its kind, as UBC lists it",
      requirement: "the requirement itself, e.g. `Pre-Calculus 12`",
      advisory: "true for suggestions and grade ranges; false for hard requirements",
    },
    joins: [
      "(campus, requirement_key) -> requirements/requirement_groups",
      "(curriculum, location_slug) -> requirements/locations.(taxonomy, slug)",
      "location_term_id -> requirements/locations.term_id",
    ],
  });
}
