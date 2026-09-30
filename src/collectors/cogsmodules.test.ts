import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "./cogsmodules.ts";

const html = readFileSync(join(import.meta.dirname, "../../test/fixtures/cogs-modules.html"), "utf8");

describe("parse", () => {
  const rows = parse(html);
  const byCode = new Map(rows.map((r) => [r["code"], r]));

  it("reads the module table off the live page shape", () => {
    expect(rows).toHaveLength(139);
  });

  it("canonicalizes codes wherever the _V marker drifts", () => {
    // "AI_V 322", "STAT 302_V" and lettered "PHIL_V 320/320A" all normalize.
    expect(byCode.has("AI 322")).toBe(true);
    expect(byCode.has("STAT 302")).toBe(true);
    expect(byCode.has("PHIL 320")).toBe(true);
    expect(byCode.has("PHIL 320A")).toBe(true);
    expect(byCode.has("PHIL 441A")).toBe(true);
    expect(byCode.has("PHIL 441B")).toBe(true);
  });

  it("retains both historical cross-listed codes separately from the active numeric course", () => {
    expect(byCode.get("THTR 399")).toMatchObject({ course_name: "Production II", active: true });
    for (const code of ["THTR 399E", "MDIA 470A"])
      expect(byCode.get(code)).toMatchObject({
        code_raw: "THTR 399E/ MDIA 470A",
        course_name: "Special Topics",
        section: "Historic Modules",
        active: false,
      });
    expect(byCode.get("ANTH 417B")).toMatchObject({ number: "417B", active: false });
  });

  it("does not retire Historical Linguistics", () => {
    expect(byCode.get("LING 319")).toMatchObject({ course_name: "Historical Linguistics", active: true });
  });

  it("keeps retired modules but marks them inactive", () => {
    const retired = rows.filter((r) => r["active"] === false);
    expect(retired.length).toBeGreaterThan(0);
    for (const r of rows.filter((x) => /no longer offered/i.test(String(x["notes"])))) {
      expect(r["active"]).toBe(false);
    }
  });

  it("does not emit the header row as a course", () => {
    expect(rows.every((r) => r["code"] !== "Course Code" && CODE_SHAPE.test(String(r["code"])))).toBe(true);
  });
});

const CODE_SHAPE = /^[A-Z]{2,4} \d{3}[A-Z]?$/;

function modulePage(code = "AI_V 322", historicCode = "THTR 399E/ MDIA 470A"): string {
  const table = (headers: string[], row: string[]) =>
    `<table><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr><tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr></table>`;
  return (
    "<h4>Module List</h4>" +
    table(["Faculty", "Course Code", "Course Name", "Notes"], ["Science", code, "Module course", ""]) +
    "<h4>Historic Modules</h4>" +
    table(["Faculty", "Course Code", "Course Name"], ["Arts", historicCode, "Historical module"])
  );
}

describe("module source validation", () => {
  it.each(["", "<h1>Checking your browser</h1>", "<h1>Module Courses</h1>", "<h4>Module List</h4>"])(
    "refuses unavailable or incomplete source HTML: %s",
    (html) => expect(() => parse(html)).toThrow(/module/i),
  );

  it.each([
    (html: string) => html.replace("<h4>Historic Modules</h4>", "<h4>Unrelated courses</h4>"),
    (html: string) => html.replace("<h4>Module List</h4>", "<h4>Unrelated courses</h4>"),
    (html: string) => html.replace("Course Code", "Course Name"),
    (html: string) => html.replace("<td>Module course</td>", "<td></td>"),
    (html: string) => html.replace("<td>Science</td>", ""),
    (html: string) => html.replace(/<tr><td>Science[\s\S]*?<\/tr>/, ""),
    (html: string) => html + html,
  ])("rejects changed module-table structure %#", (mutate) => {
    expect(() => parse(mutate(modulePage()))).toThrow(/module/i);
  });

  it.each(["TBD", "322", "CPSC 1234", "CPSC 123AB", "CPSC_O 322", "AI 322 / unknown", "CPSC 322 / 323 typo"])(
    "refuses an unrecognized code cell rather than dropping it: %s",
    (code) => expect(() => parse(modulePage(code))).toThrow(/module.*code/i),
  );

  it("expands shorthand and explicit cross-listing without borrowing a subject from another row", () => {
    const rows = parse(modulePage("PHIL_V 441 (or 441A or 441B)"));
    expect(rows.map((row) => row["code"])).toEqual(["PHIL 441", "PHIL 441A", "PHIL 441B", "THTR 399E", "MDIA 470A"]);
    expect(() => parse(modulePage("PHIL 441", "470A"))).toThrow(/module.*code/i);
  });

  it("preserves distinct active and historical listings even when their codes are identical", () => {
    const rows = parse(modulePage("PSYC_V 321", "PSYC 321"));
    expect(rows.map((row) => [row["code"], row["active"]])).toEqual([
      ["PSYC 321", true],
      ["PSYC 321", false],
    ]);
  });

  it("ignores unrelated tables outside the two module sections", () => {
    const unrelated = "<h4>Other courses</h4><table><tr><td>Science</td><td>CPSC 110</td></tr></table>";
    expect(parse(modulePage() + unrelated)).toEqual(parse(modulePage()));
  });
});
