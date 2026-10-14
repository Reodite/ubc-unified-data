/** Statutory holidays, which UBC publishes from HR rather than the calendar.
 *
 * There is no API and no feed for these -- hr.ubc.ca renders them as a page, and
 * the page is a year heading, then a month heading, then a two-column table for
 * each month that has one:
 *
 *     <h2>2026 statutory holidays</h2>
 *     <h4>JANUARY</h4>
 *     <table><tr><td>Thursday, January 1</td><td>New Year's Day</td></tr></table>
 *     <h4>MARCH</h4>
 *     <p><em>N/A</em></p>
 *
 * The year comes from the last heading that carried one; month and day come from
 * the date cell itself, which names its month and occasionally its year too. The
 * month headings are only navigation -- a row already says "January 1" -- so they
 * are read past. Months with no holiday have no table, which needs no handling:
 * there is simply nothing to read.
 *
 * Two of these are UBC's own rather than BC's (Easter Monday and Boxing Day, both
 * marked with an asterisk upstream). The asterisk is stripped from the name and
 * recorded as `ubc_specific` instead of being thrown away.
 */

import type { Http } from "../core/http.ts";
import type { Heading } from "../htmldoc.ts";
import { blocks } from "../htmldoc.ts";

export const URL = "https://hr.ubc.ca/working-ubc/statutory-holidays";

export const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const MONTH_ALTERNATION = Object.keys(MONTHS).join("|");

// "Thursday, January 1" / "Monday, December 28, 2026"
const DATE_RE = new RegExp(
  `(?:(?<weekday>[A-Za-z]+day),\\s*)?(?<month>${MONTH_ALTERNATION})\\s+(?<day>\\d{1,2})(?:,\\s*(?<year>\\d{4}))?`,
  "i",
);

const YEAR_RE = /\b(20\d{2})\b/;

export function parse(html: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let year: string | null = null;

  for (const block of blocks(html)) {
    if ((block as Heading).level !== undefined) {
      // Only a heading that carries a year matters, and it stays in force until
      // another one replaces it -- the month headings and the "Related
      // resources" heading at the foot are both read past.
      const found = YEAR_RE.exec((block as Heading).text);
      if (found && found[1] !== undefined) year = found[1];
      continue;
    }

    for (const row of (block as { rows: string[][] }).rows) {
      if (row.length < 2) continue;
      const dateText = row[0];
      const rawName = row[1];
      if (!dateText || !rawName) continue;
      const match = DATE_RE.exec(dateText);
      if (match === null) continue;

      const cellYear = match.groups?.year ?? year;
      if (cellYear === null) continue;
      const month = MONTHS[(match.groups?.month ?? "").toLowerCase()] ?? 0;
      const day = Number(match.groups?.day);
      const observed = new Date(Date.UTC(Number(cellYear), month - 1, day));
      if (Number.isNaN(observed.getTime()) || observed.getUTCDate() !== day || observed.getUTCMonth() !== month - 1)
        continue;

      // The asterisk marks a holiday UBC observes beyond BC's statutory list;
      // keep the fact, drop it from the name.
      const ubcSpecific = rawName.includes("*");
      const name = rawName.replace(/\s*\*+\s*$/, "").trim();
      const iso = observed.toISOString().slice(0, 10);
      const key = `${iso}|${name.toLowerCase()}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);

      rows.push({
        name,
        date: iso,
        weekday: WEEKDAYS[(observed.getUTCDay() + 6) % 7],
        year: observed.getUTCFullYear(),
        month: observed.getUTCMonth() + 1,
        date_text: dateText,
        ubc_specific: ubcSpecific,
        source_url: URL,
      });
    }
  }

  rows.sort((a, b) => String(a["date"]).localeCompare(String(b["date"])));
  return rows;
}

export async function fetch(http: Http): Promise<Array<Record<string, unknown>>> {
  return parse(await http.getText(URL));
}
fetch.source = URL;
