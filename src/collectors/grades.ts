/** Course grade distributions, by section, for UBC Vancouver.
 *
 * Source: the DonneyF/ubc-pair-grade-data GitHub repository, which mirrors the
 * distribution data behind UBC's public grade dashboard. The raw per-subject
 * CSVs are mirrored verbatim under `raw/`, then parsed into one
 * `distributions.json` table: one row per section, with the grade histogram
 * buckets as columns. UBCV rows only, matching the dashboard's coverage.
 */

import type { Http, Output } from "../base.ts";
import { register } from "../base.ts";

export const ORG = "DonneyF";
export const REPO = "ubc-pair-grade-data";
export const SRC_DIR = "tableau-dashboard-v2/UBCV";

export const BUCKETS = [
  "<50",
  "50-54",
  "55-59",
  "60-63",
  "64-67",
  "68-71",
  "72-75",
  "76-79",
  "80-84",
  "85-89",
  "90-100",
];

function toInt(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

function toFloat(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

/** Simple CSV parse: split on newlines, handle quoted fields and `""` inside
 * them. Good enough for the grade CSVs, whose quoted cells never span a
 * newline. */
export function parseCSV(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCSVLine(lines[0]!);
  const out: Array<Record<string, string>> = [];
  for (const line of lines.slice(1)) {
    const values = splitCSVLine(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]!] = values[i] ?? "";
    out.push(row);
  }
  return out;
}

export function splitCSVLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = "";
      i += 1;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i += 1;
          break;
        } else {
          value += line[i];
          i += 1;
        }
      }
      fields.push(value);
      i += 1;
    } else {
      const next = line.indexOf(",", i);
      if (next === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, next));
      i = next + 1;
    }
  }
  return fields;
}

/** One parsed grade row: the flat CSV record plus the histogram. */
export interface GradeRow extends Record<string, unknown> {
  subject: string;
  course: string;
  section: string;
  year: number | null;
  session: string;
  title: string;
  professor: string;
  enrolled: number | null;
  avg: number | null;
  std_dev: null;
  median: number | null;
  percentile_25: number | null;
  percentile_75: number | null;
  high: number | null;
  low: number | null;
  distribution: Record<string, number>;
}

export function gradeRow(row: Record<string, string>): GradeRow | null {
  if (row["Campus"] !== "UBCV") return null;
  if (row["Section"] === "OVERALL") return null;
  if ((row["Detail"] ?? "").trim()) return null;
  const distribution: Record<string, number> = {};
  for (const bucket of BUCKETS) distribution[bucket] = toInt(row[bucket]) ?? 0;
  return {
    subject: row["Subject"] ?? "",
    course: row["Course"] ?? "",
    section: row["Section"] ?? "",
    year: toInt(row["Year"]),
    session: row["Session"] ?? "",
    title: row["Title"] ?? "",
    professor: row["Professor"] ?? "",
    enrolled: toInt(row["Reported"]),
    avg: toFloat(row["Avg"]),
    // Upstream does not publish the population standard deviation; always null.
    std_dev: null,
    median: toFloat(row["Median"]) ?? null,
    percentile_25: toFloat(row["Percentile (25)"]) ?? null,
    percentile_75: toFloat(row["Percentile (75)"]) ?? null,
    high: toInt(row["High"]) ?? toFloat(row["High"]),
    low: toInt(row["Low"]) ?? toFloat(row["Low"]),
    distribution,
  };
}

export const Grades = register(
  class {
    name = "grades";
    folder = "grades";
    title = "Course grade distributions (sections, averages, histograms)";
    description =
      "Every UBC Vancouver course section with a reported grade distribution: " +
      "enrolment, average, median, percentiles, high/low, and the count of " +
      "grades in each of the dashboard's percentage buckets, per term.";
    sources = [`https://github.com/${ORG}/${REPO}`];

    async collect(http: Http, out: Output): Promise<void> {
      const slug = `${ORG}/${REPO}`;
      const meta = (await http.getJson(`https://api.github.com/repos/${slug}`)) as Record<string, unknown>;
      const branch = (meta["default_branch"] as string | undefined) ?? "master";
      const head = (await http.getJson(`https://api.github.com/repos/${slug}/commits/${branch}`)) as Record<
        string,
        unknown
      >;
      const sha = head["sha"] as string;

      const tree = (await http.getJson(`https://api.github.com/repos/${slug}/git/trees/${sha}`, {
        params: { recursive: "1" },
      })) as Record<string, unknown>;
      if (tree["truncated"]) {
        throw new Error(`GitHub truncated ${slug}'s file tree; it outgrew one listing`);
      }

      const paths: string[] = [];
      for (const node of (tree["tree"] as Array<Record<string, unknown>>) ?? []) {
        const path = (node["path"] as string) ?? "";
        if ((node["type"] as string) !== "blob") continue;
        if (!path.startsWith(`${SRC_DIR}/`) || !path.endsWith(".csv")) continue;
        paths.push(path);
      }

      const fetchOne = async (path: string): Promise<[string, string]> => {
        const bytes = await http.getBytes(`https://raw.githubusercontent.com/${slug}/${sha}/${path}`);
        // This raw mirror uses LF, so normalize upstream CRLF before both
        // writing the file and parsing its rows.
        return [path, new TextDecoder("utf-8", { fatal: false }).decode(bytes).replaceAll("\r\n", "\n")];
      };

      const rows: GradeRow[] = [];
      for (const [path, text] of await http.map(fetchOne, paths, 8)) {
        const dest = `raw/${path.slice(SRC_DIR.length + 1)}`;
        await out.raw(dest, text, { source: `https://github.com/${slug}/blob/${sha}/${path}` });
        for (const record of parseCSV(text)) {
          const row = gradeRow(record);
          if (row) rows.push(row);
        }
      }

      rows.sort(
        (a, b) =>
          (a.year ?? 0) - (b.year ?? 0) ||
          String(a.session).localeCompare(String(b.session)) ||
          a.subject.localeCompare(b.subject) ||
          a.course.localeCompare(b.course) ||
          a.section.localeCompare(b.section),
      );
      await out.json("distributions.json", rows, {
        source: `https://github.com/${slug}/tree/${sha}/${SRC_DIR}`,
        itemsPerLine: true,
      });
    }
  },
);
