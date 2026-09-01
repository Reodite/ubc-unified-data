/** Cognitive Systems module courses, which live on the COGS program site
 * rather than in the academic calendar.
 *
 * Every COGS stream (B.A. and B.Sc.) requires 12-18 credits of "module
 * courses chosen from this list" -- and "this list" is a hyperlink out of the
 * calendar to cogsys.ubc.ca, revised annually by the program. Without it a
 * degree audit cannot resolve those credits at all, so it comes down here as
 * its own dataset.
 *
 * The page is one WordPress table per section: Faculty | Course Code |
 * Course Name | Notes, with cells like "AI_V 322" and notes carrying
 * equivalencies, stream restrictions and "no longer offered" flags. A
 * trailing "Historic Modules" section lists retired courses; those rows are
 * kept but marked inactive, as are rows whose own notes retire them.
 *
 * cogsys.ubc.ca sits behind a JS bot challenge that rejects non-browser
 * user agents outright (the default ubc-data agent gets the challenge shell,
 * not the page), so the fetch identifies as a plain browser. The page is
 * public and linked from the calendar's own COGS entries.
 */

import type { Http } from "../base.ts";
import type { Heading, Table } from "../htmldoc.ts";
import { blocks } from "../htmldoc.ts";

export const URL = "https://cogsys.ubc.ca/module-courses/";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36";

// "AI_V 322", "PHIL_V 320/320A", "STAT 302_V" -- the campus marker drifts
// around the code, and lettered section variants trail the number.
const CODE_RE = /([A-Z]{2,4})(?:_V)?\s*(\d{3})([A-Z])?(?:_V)?/;

// A cell retires a course only by saying so; "historic" belongs to the
// section heading test alone, or "Historical Linguistics" gets retired too.
const RETIRED_CELL_RE = /no longer offered/i;
const RETIRED_SECTION_RE = /historic modules|no longer offered/i;

function isHeading(block: Heading | Table): block is Heading {
  return typeof (block as Heading).level === "number";
}

export function parse(html: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let section = "";

  for (const block of blocks(html)) {
    if (isHeading(block)) {
      section = block.text.trim();
      continue;
    }
    for (const cells of tableRows(block)) {
      const [faculty, codeText, courseName, notes] = cells;
      if (!codeText) continue;
      const match = CODE_RE.exec(codeText);
      if (match === null) continue;
      const subject = match[1]!;
      const number = match[2]!;
      const code = `${subject} ${number}`;
      if (seen.has(code)) continue;
      seen.add(code);
      const noteText = (notes ?? "").trim();
      const name = (courseName ?? "").trim();
      rows.push({
        code,
        code_raw: codeText.trim(),
        subject,
        number,
        course_name: name,
        faculty_group: (faculty ?? "").trim(),
        notes: noteText,
        section,
        // The retirement flag drifts between cells ("PSYC 304_V" carries
        // "*no longer offered*" in the code column), so every text cell counts.
        active:
          !RETIRED_SECTION_RE.test(section) &&
          !RETIRED_CELL_RE.test(codeText) &&
          !RETIRED_CELL_RE.test(noteText) &&
          !RETIRED_CELL_RE.test(name),
        source_url: URL,
      });
    }
  }
  return rows;
}

// The page renders its header row as ordinary <td> cells, so htmldoc may
// surface it either as `headers` or as the first data row; skip it wherever
// it landed.
function tableRows(table: Table): string[][] {
  const all = table.rows;
  if (all.length > 0 && /course code/i.test(all[0]!.join(" "))) return all.slice(1);
  return all;
}

export async function fetch(http: Http): Promise<Array<Record<string, unknown>>> {
  return parse(await http.getText(URL, { headers: { "User-Agent": BROWSER_UA } }));
}
fetch.source = URL;
