/** Read the Cognitive Systems module list linked from the Vancouver calendar.
 *
 * Each source listing yields one row per eligible course code. Lettered variants
 * and cross-listed codes retain their identities; historical listings remain
 * separate from active ones. Missing sections, changed tables and unrecognized
 * code cells fail collection rather than publishing a partial module list.
 */

import type { Http } from "../base.ts";
import { blocks, type Table } from "../htmldoc.ts";

export const URL = "https://cogsys.ubc.ca/module-courses/";

const MODULE_SECTION = "Module List";
const HISTORIC_SECTION = "Historic Modules";
const RETIRED_CELL_RE = /no longer offered/i;

function moduleCodes(text: string): Array<{ subject: string; number: string }> {
  // The campus marker occurs before or after the number; alternatives can inherit the subject within one cell.
  const normalized = text
    .replace(/_V\b/g, "")
    .replace(/\*?no longer offered\*?/gi, "")
    .replace(/[()]/g, "");
  const courses = new Map<string, { subject: string; number: string }>();
  let subject = "";
  for (const part of normalized.split(/\/|\bor\b/)) {
    const match = /^(?:([A-Z]{2,4})\s*)?(\d{3}[A-Z]?)$/.exec(part.trim());
    if (!match || !(match[1] || subject)) throw new Error(`Unrecognized COGS module code: ${text}`);
    subject = match[1] ?? subject;
    const number = match[2]!;
    courses.set(`${subject} ${number}`, { subject, number });
  }
  return [...courses.values()];
}

function tableRows(table: Table, historic: boolean): string[][] {
  // WordPress uses both ordinary cells and header cells for column labels.
  const headers = table.headers.length ? table.headers : table.rows[0];
  const rows = table.headers.length ? table.rows : table.rows.slice(1);
  const expected = historic
    ? ["Faculty", "Course Code", "Course Name"]
    : ["Faculty", "Course Code", "Course Name", "Notes"];
  if (!headers || headers.join("|") !== expected.join("|") || !rows.length)
    throw new Error("Missing or changed COGS module table");
  if (rows.some((row) => row.length !== headers.length || !row[0] || !row[1] || !row[2]))
    throw new Error("Incomplete COGS module row");
  return rows;
}

export function parse(html: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const sections = new Set<string>();
  let section = "";

  for (const block of blocks(html)) {
    if ("level" in block) {
      section = block.text;
      continue;
    }
    if (section !== MODULE_SECTION && section !== HISTORIC_SECTION) continue;
    if (sections.has(section)) throw new Error(`Repeated COGS module table: ${section}`);
    sections.add(section);
    const historic = section === HISTORIC_SECTION;
    for (const cells of tableRows(block, historic)) {
      const faculty = cells[0]!;
      const codeText = cells[1]!;
      const courseName = cells[2]!;
      const notes = cells[3] ?? "";
      // Retirement can appear in the code, title or notes; "Historical Linguistics" is not a retirement notice.
      const active = !historic && ![codeText, courseName, notes].some((cell) => RETIRED_CELL_RE.test(cell));
      for (const { subject, number } of moduleCodes(codeText)) {
        rows.push({
          code: `${subject} ${number}`,
          code_raw: codeText,
          subject,
          number,
          course_name: courseName,
          faculty_group: faculty,
          notes,
          section,
          active,
          source_url: URL,
        });
      }
    }
  }
  if (!sections.has(MODULE_SECTION) || !sections.has(HISTORIC_SECTION)) throw new Error("Missing COGS module sections");
  return rows;
}

export async function fetch(http: Http): Promise<Array<Record<string, unknown>>> {
  return parse(await http.getText(URL));
}
fetch.source = URL;
