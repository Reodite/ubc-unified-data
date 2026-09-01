/** Make the Academic Calendar's page nodes queryable.
 *
 * `node--ubc_page` is where UBC keeps everything the calendar says that isn't a
 * course: degree and specialization requirements, faculty and school overviews,
 * admission rules, academic regulations, and the dates-and-deadlines tables.
 * The API hands back a title, a path alias and a blob of body HTML -- no
 * hierarchy, no breadcrumbs, no indication of what kind of page you are
 * holding.
 *
 * The alias is the hierarchy, though. Ancestry is recovered by matching each
 * alias prefix back to the page that owns it, which yields real titles rather
 * than de-slugified guesses. Everything else (`kind`, `level`, `faculty`,
 * `program`, `referenced_courses`) is derived from that chain plus the title.
 */

import { plainText } from "./coursetext.ts";
import { blocks, headings } from "./htmldoc.ts";

export const FACULTIES_SECTION = "faculties-colleges-and-schools";

// --------------------------------------------------------------------------
// Degree detection
// --------------------------------------------------------------------------

// UBC mixes long forms ("Bachelor of Science") with abbreviations ("M.Sc.",
// "Ph.D.", "MBA"), so a degree title is matched against both.
const DEGREE_TITLE_RE =
  /^(Bachelor of\b|UBC Bachelor of\b|Master of\b|UBC Master of\b|Doctor of\b|(?:Graduate|Undergraduate) Certificate\b|Certificate in\b|Diploma in\b|B\.[A-Z]+(?:\.[A-Z]+)*\.|M\.[A-Z]+(?:\.[A-Z]+)*\.|D\.[A-Z]+(?:\.[A-Z]+)*\.|Ph\.?\s?D\.?|MBA\b|MFA\b|MEd\b|MEng\b|MASc\b|MSc\b|MA\b|MArch\b)/i;

// "Data Science (M.D.S.)" -- the degree trails the program name instead of
// leading it, so a title-prefix match alone would miss the page.
const TRAILING_ABBREV_RE = /\(\s*(B|M|D|Ph)\.?\s?[A-Z]+(?:\.\s?[A-Z]+)*\.?\s*\)\s*$/i;

// Slug prefixes that mark a degree *root* page.
const DEGREE_SLUG_PREFIXES = [
  "bachelor-",
  "basc-",
  "bsc-",
  "bsf-",
  "bils-",
  "b-i-l-s",
  "buf-",
  "b-u-f",
  "master-",
  "masters-",
  "mba-",
  "mfa-",
  "med-",
  "meng-",
  "masc-",
  "ma-",
  "msc-",
  "m-arch",
  "m-ed",
  "m-eng",
  "m-sc",
  "m-a",
  "m-asc",
  "doctor-",
  "doctoral-",
  "phd-",
  "ph-d",
  "d-m-a",
  "graduate-certificate-",
  "undergraduate-certificate-",
  "certificate-",
  "diploma-",
];

const DEGREE_SLUG_SUFFIXES_BY_LEVEL: Array<[string, string]> = [
  ["-mds", "masters"],
  ["-msc", "masters"],
  ["-meng", "masters"],
  ["-masc", "masters"],
  ["-mba", "masters"],
  ["-mfa", "masters"],
  ["-med", "masters"],
  ["-march", "masters"],
  ["-mmm", "masters"],
  ["-mpp", "masters"],
  ["-mppga", "masters"],
  ["-mph", "masters"],
  ["-mhsc", "masters"],
  ["-mn", "masters"],
  ["-mlis", "masters"],
  ["-mhlp", "masters"],
  ["-mhrm", "masters"],
  ["-phd", "doctoral"],
  ["-dma", "doctoral"],
  ["-edd", "doctoral"],
  // Programs titled "<X> Degree Program" whose slug carries no credential
  // abbreviation at all -- the Dental Hygiene Degree Program (B.D.Sc.) is the
  // one live example, and its subtree was invisible without this.
  ["-degree-program", "undergraduate"],
];

// "<X> Degree Program" -- a title shape UBC uses when the credential name
// doesn't lead (e.g. "Dental Hygiene Degree Program"). Paired with the
// "-degree-program" slug suffix above so an ordinary prose page that merely
// mentions the words can't qualify on title alone.
const DEGREE_PROGRAM_TITLE_RE = /\bdegree program\s*$/i;

const LEVEL_RULES: Array<[RegExp, string]> = [
  [/^(bachelor|ubc bachelor|b\.[a-z])/i, "undergraduate"],
  [/^(undergraduate certificate)/i, "undergraduate"],
  [/^(master|ubc master|m\.[a-z]|mba|mfa|med|meng|masc|msc|ma|march)\b/i, "masters"],
  [/^(graduate certificate)/i, "masters"],
  [/^(doctor|ph\.?\s?d|d\.[a-z])/i, "doctoral"],
  [/^(certificate|diploma) /i, "certificate"],
];

// What sort of page this is within a degree subtree. Most specific first.
const KIND_RULES: Array<[RegExp, string]> = [
  [/degree-requirements?\b|graduation-requirements?\b/, "degree_requirements"],
  [/\bhonours\b/, "honours"],
  [/\bminor[s]?\b/, "minor"],
  [/\bmajor[s]?\b/, "major"],
  [/\bspecializ(ation|ed)\b/, "specialization"],
  [/\b(combined|dual)[-_]?degree\b/, "dual_degree"],
  [/co-?operative|co-?op/, "coop"],
  [/\badmission|transfer\b/, "admission"],
  [/academic-regulations|general-academic|promotion|standing/, "regulations"],
  [/thesis|comprehensive-exam|qualifying-exam|candidacy/, "regulations"],
  [/curriculum|first-year|year-one|second-year/, "curriculum"],
  [/advising|academic-information/, "advising"],
];

// Subject codes are 2-4 letters (AI, BA ... CPSC, WRDS), never 5+, followed by
// a three-digit number and an optional letter. The campus suffix is stripped.
const COURSE_CODE_RE = /\b([A-Z]{2,4})(?:_[VO])?\s?(\d{3}[A-Z]?)\b/g;

function slug(alias: string): string {
  return alias.slice(alias.lastIndexOf("/") + 1).toLowerCase();
}

/** Is this page a degree root, and at what level? */
function degree(alias: string, title: string): [boolean, string] {
  const slugText = slug(alias);
  const prefixHit = DEGREE_SLUG_PREFIXES.some((prefix) => slugText.startsWith(prefix));
  const suffixLevel = DEGREE_SLUG_SUFFIXES_BY_LEVEL.find(([suffix]) => slugText.endsWith(suffix))?.[1];
  if (!prefixHit && suffixLevel === undefined) return [false, ""];
  if (!title || (!DEGREE_TITLE_RE.test(title) && !TRAILING_ABBREV_RE.test(title) && !DEGREE_PROGRAM_TITLE_RE.test(title)))
    return [false, ""];
  for (const [pattern, level] of LEVEL_RULES) {
    if (pattern.test(title)) return [true, level];
  }
  return [true, suffixLevel ?? "other"];
}

function kindOf(alias: string, title: string, isDegree: boolean, depth: number, section: string): string {
  if (isDegree) return "degree_overview";
  if (depth === 2 && section === FACULTIES_SECTION) {
    const lowered = title.toLowerCase();
    if (lowered.includes("school")) return "school_overview";
    if (lowered.includes("college")) return "college_overview";
    return "faculty_overview";
  }
  const haystack = `${alias} ${title}`.toLowerCase();
  for (const [pattern, kind] of KIND_RULES) {
    if (pattern.test(haystack)) return kind;
  }
  return "other";
}

export function courseCodes(text: string, subjects?: Set<string> | null): string[] {
  /** Course codes mentioned in a page, in the order they appear. */
  const found = new Map<string, true>();
  for (const match of text.matchAll(COURSE_CODE_RE)) {
    const subject = match[1]!;
    const number = match[2]!;
    if (subjects !== null && subjects !== undefined && !subjects.has(subject)) continue;
    if (subjects === null || subjects === undefined) if (subject.length < 3) continue;
    found.set(`${subject} ${number}`, true);
  }
  return [...found.keys()];
}

function bodyHtml(page: Record<string, unknown>): string {
  const body = page["body"];
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    return (record["processed"] as string) || (record["value"] as string) || "";
  }
  return typeof body === "string" ? body : "";
}

/** Add the derived hierarchy and classification columns, in place. */
export function enrich(
  pages: Array<Record<string, unknown>>,
  opts: { host: string; subjects?: Set<string> | null },
): void {
  const { host, subjects } = opts;
  // Alias -> page. First writer wins: aliases are unique in practice, and a
  // duplicate would be a redirect stub we'd rather not treat as the ancestor.
  const byAlias: Record<string, Record<string, unknown>> = {};
  for (const page of pages) {
    const alias = (page["alias"] as string) || "";
    if (alias && !(alias in byAlias)) byAlias[alias] = page;
  }

  // Degree roots first and separately: resolving a page's program means asking
  // its ancestors whether they are one, and they may not have been visited yet.
  for (const page of pages) {
    const alias = (page["alias"] as string) || "";
    const [isDegree, level] = degree(alias, ((page["title"] as string) || "").trim());
    page["is_degree_root"] = isDegree;
    page["level"] = isDegree ? level : "";
  }

  // Degree roots by terminal slug. UBC publishes some subtrees under two
  // alias spellings (e.g. /faculty-forestry/buf-bachelor-urban-forestry/... vs
  // /faculty-forestry-and-environmental-stewardship/buf-bachelor-urban-forestry),
  // and the root page exists in only one of them -- walking the other tree's
  // aliases finds no ancestor. The terminal slug is the same in both trees, so
  // it bridges them. First writer wins, matching byAlias.
  const rootsBySlug: Record<string, Record<string, unknown>> = {};
  for (const page of pages) {
    if (!page["is_degree_root"]) continue;
    const parts = ((page["alias"] as string) || "").split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && !(last in rootsBySlug)) rootsBySlug[last] = page;
  }

  for (const page of pages) {
    const alias = (page["alias"] as string) || "";
    const title = ((page["title"] as string) || "").trim();
    const segments = alias.split("/").filter(Boolean);

    const ancestors = [];
    for (let n = 1; n < segments.length; n++) {
      const candidate = `/${segments.slice(0, n).join("/")}`;
      if (candidate in byAlias) ancestors.push(byAlias[candidate]!);
    }

    // The nearest enclosing degree, which for a degree root is itself.
    let programPage = page["is_degree_root"] ? page : null;
    if (programPage === null) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        if (ancestors[i]!["is_degree_root"]) {
          programPage = ancestors[i]!;
          break;
        }
      }
    }
    if (programPage === null) {
      // No degree root up this alias tree: try the same path segments against
      // roots known by terminal slug from the sibling alias tree.
      for (let i = segments.length - 1; i >= 0; i--) {
        const twin = rootsBySlug[segments[i]!];
        if (twin) {
          programPage = twin;
          break;
        }
      }
    }

    let faculty = "";
    if (segments.length > 0 && segments[0] === FACULTIES_SECTION && segments.length >= 2) {
      const root = byAlias[`/${segments[0]}/${segments[1]}`];
      if (root !== undefined) faculty = (root["title"] as string) || "";
    }

    const text = plainText(page["body"]);
    const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1]! : null;

    page["url"] = alias ? `https://${host}${alias}` : "";
    page["section"] = segments[0] ?? "";
    page["depth"] = segments.length;
    page["parent_title"] = parent ? (parent["title"] as string) || "" : "";
    page["parent_url"] = parent ? `https://${host}${(parent["alias"] as string) || ""}` : "";
    page["breadcrumbs"] = ancestors.map((ancestor) => (ancestor["title"] as string) || "");
    page["faculty"] = faculty;
    page["program"] = programPage ? (programPage["title"] as string) || "" : "";
    page["program_url"] = programPage ? `https://${host}${(programPage["alias"] as string) || ""}` : "";
    // A page inside a degree subtree inherits that degree's level.
    page["level"] = programPage ? (programPage["level"] as string) || "" : "";
    page["kind"] = kindOf(alias, title, Boolean(page["is_degree_root"]), segments.length, page["section"] as string);
    page["headings"] = headings(bodyHtml(page)).map((heading) => heading.text);
    page["text"] = text;
    page["word_count"] = text.split(/\s+/).filter(Boolean).length;
    page["referenced_courses"] = courseCodes(text, subjects ?? null);
  }
}

// --------------------------------------------------------------------------
// Dates and deadlines
// --------------------------------------------------------------------------

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December" +
  "|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

// "Tuesday, May 12, 2026" / "May 12-August 14, 2026" / "May 12 to June 2, 2026"
//
// Days are matched three digits wide even though no day needs three, because
// UBC glues footnote markers straight onto the number ("November 9 - 111").
// Two digits would fail to match the cell at all rather than mis-read the day;
// `day` peels the marker back off.
const DATE_RE = new RegExp(
  `(?<m1>${MONTHS})\\s+(?<d1>\\d{1,3})` +
    `(?:\\s*(?:[–—\\-]|to)\\s*(?:(?<m2>${MONTHS})\\s+)?(?<d2>\\d{1,3}))?` +
    `,?\\s+(?<y>\\d{4})`,
  "i",
);

const MONTH_NUMBERS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

// Footnote markers UBC renders as superscripts next to a date.
const SUPERSCRIPTS = /[¹²³⁴⁵⁶⁷⁸⁹⁰*†‡]+/g;

function yearIn(text: string): number | null {
  const match = /(20\d{2})/.exec(text || "");
  return match ? Number(match[1]) : null;
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Read a day-of-month, peeling off a footnote marker glued to the number. */
function day(digits: string): number | null {
  let value = Number(digits);
  let rest = digits;
  while (value > 31 && rest.length > 1) {
    rest = rest.slice(0, -1);
    value = Number(rest);
  }
  return value >= 1 && value <= 31 ? value : null;
}

/** Parse a date or date range out of one cell. Returns (start, end). */
function parseDateCell(cell: string, fallbackYear: number | null): [string, string] | null {
  const text = cell.replace(SUPERSCRIPTS, "").trim();
  let match = DATE_RE.exec(text);
  if (match === null && fallbackYear !== null) {
    // Cells often omit the year because the column header carries it.
    match = DATE_RE.exec(`${text}, ${fallbackYear}`);
  }
  if (match === null) return null;

  const year = Number(match.groups?.y ?? 0);
  const month = MONTH_NUMBERS[(match.groups?.m1 ?? "").toLowerCase()] ?? 0;
  const startDay = day(match.groups?.d1 ?? "");
  if (startDay === null) return null;

  if (!match.groups?.d2) return [iso(year, month, startDay), ""];

  const endMonth = MONTH_NUMBERS[((match.groups?.m2 || match.groups?.m1) ?? "").toLowerCase()] ?? 0;
  const endDay = day(match.groups.d2);
  if (endDay === null) return [iso(year, month, startDay), ""];
  // A range written "December 20 - January 3, 2027" states the year once, at
  // the end, and it belongs to the end -- the range started the year before.
  const startYear = endMonth < month ? year - 1 : year;
  return [iso(startYear, month, startDay), iso(year, endMonth, endDay)];
}

function spanDays(start: string, end: string): number | null {
  if (!end) return null;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.round((endMs - startMs) / 86400000);
}

/** Turn the dates-and-deadlines page into one row per date UBC publishes. */
export function parseDates(page: Record<string, unknown>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const outline: Record<number, string> = {};

  for (const block of blocks(bodyHtml(page))) {
    if ("level" in block) {
      for (const level of Object.keys(outline)) {
        if (Number(level) >= block.level) delete outline[Number(level)];
      }
      outline[block.level] = block.text;
      continue;
    }

    const headers = block.headers;
    if (headers.length < 2) continue;
    const section = Object.keys(outline).length > 0 ? outline[Math.min(...Object.keys(outline).map(Number))]! : "";
    const tableHeading = Object.keys(outline).length > 0 ? outline[Math.max(...Object.keys(outline).map(Number))]! : "";
    // A term states its year; a deadline description doesn't.
    const columnsAreTerms = headers.slice(1).some((header) => yearIn(header) !== null);

    for (const row of block.rows) {
      if (row.length < 2 || !row[0]) continue;
      for (let index = 1; index < row.length; index++) {
        if (index >= headers.length || !row[index]) continue;
        const header = headers[index]!;
        const appliesTo = columnsAreTerms ? header : row[0]!;
        const event = columnsAreTerms ? row[0]! : header;
        const parsed = parseDateCell(row[index]!, yearIn(appliesTo) ?? yearIn(tableHeading));
        if (parsed === null) continue;
        const [start, end] = parsed;
        const key = JSON.stringify([appliesTo, event, start]);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          event,
          applies_to: appliesTo,
          section,
          table: tableHeading,
          date_text: row[index]!,
          start,
          end,
          span_days: spanDays(start, end),
          source_url: (page["url"] as string) || "",
        });
      }
    }
  }
  rows.sort((a, b) => {
    const byStart = String(a["start"]).localeCompare(String(b["start"]));
    if (byStart !== 0) return byStart;
    const byApplies = String(a["applies_to"]).localeCompare(String(b["applies_to"]));
    if (byApplies !== 0) return byApplies;
    return String(a["event"]).localeCompare(String(b["event"]));
  });
  return rows;
}

/** The calendar pages that hold the deadline tables, whatever they're called. */
export function datesPages(pages: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  return pages.filter(
    (page) =>
      ((page["alias"] as string) || "").includes("dates-and-deadlines") ||
      ((page["alias"] as string) || "").includes("dates-deadlines"),
  );
}
