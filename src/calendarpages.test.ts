import { describe, expect, it } from "vitest";
import { courseCodes, datesPages, enrich, parseDates } from "./calendarpages.ts";

function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "",
    alias: "",
    body: "",
    ...overrides,
  };
}

describe("enrich", () => {
  it("derives hierarchy and classification from aliases and titles", () => {
    const pages = [
      page({
        title: "The Faculty of Forestry and Environmental Stewardship",
        alias: "/faculties-colleges-and-schools/faculty-forestry-and-environmental-stewardship",
      }),
      page({
        title: "Bachelor of Science in Forestry",
        alias:
          "/faculties-colleges-and-schools/faculty-forestry-and-environmental-stewardship/bsf-bachelor-science-forestry",
      }),
      page({
        title: "Forest Resources Management Major",
        alias:
          "/faculties-colleges-and-schools/faculty-forestry-and-environmental-stewardship/bsf-bachelor-science-forestry/forest-resources-management-major",
        body: "Requires MATH 100 and CPSC 110.",
      }),
    ];
    enrich(pages, { host: "vancouver.calendar.ubc.ca" });

    const faculty = pages[0]!;
    const degree = pages[1]!;
    const major = pages[2]!;

    expect(faculty["section"]).toBe("faculties-colleges-and-schools");
    expect(faculty["depth"]).toBe(2);
    expect(faculty["kind"]).toBe("faculty_overview");
    expect(faculty["is_degree_root"]).toBe(false);

    expect(degree["is_degree_root"]).toBe(true);
    expect(degree["level"]).toBe("undergraduate");
    expect(degree["kind"]).toBe("degree_overview");
    expect(degree["program"]).toBe("Bachelor of Science in Forestry");
    expect(degree["program_url"]).toBe(
      "https://vancouver.calendar.ubc.ca/faculties-colleges-and-schools/faculty-forestry-and-environmental-stewardship/bsf-bachelor-science-forestry",
    );

    // Child inherits program and level from the nearest enclosing degree.
    expect(major["program"]).toBe("Bachelor of Science in Forestry");
    expect(major["level"]).toBe("undergraduate");
    expect(major["kind"]).toBe("major");
    expect(major["faculty"]).toBe("The Faculty of Forestry and Environmental Stewardship");
    expect(major["breadcrumbs"]).toEqual([
      "The Faculty of Forestry and Environmental Stewardship",
      "Bachelor of Science in Forestry",
    ]);
    expect(major["parent_title"]).toBe("Bachelor of Science in Forestry");
    expect(major["referenced_courses"]).toEqual(["MATH 100", "CPSC 110"]);
    expect(major["word_count"]).toBe(6);
  });

  it("detects a trailing degree abbreviation and masters level", () => {
    const pages = [page({ title: "Data Science (M.D.S.)", alias: "/data-science-mds" })];
    enrich(pages, { host: "vancouver.calendar.ubc.ca" });
    expect(pages[0]!["is_degree_root"]).toBe(true);
    expect(pages[0]!["level"]).toBe("masters");
  });

  it("derives doctor of philosophy from level rules", () => {
    const pages = [page({ title: "Doctor of Philosophy in Computer Science", alias: "/doctor-philosophy" })];
    enrich(pages, { host: "vancouver.calendar.ubc.ca" });
    expect(pages[0]!["level"]).toBe("doctoral");
  });

  it("detects a '<X> Degree Program' root with no credential in slug or title", () => {
    const pages = [
      page({
        title: "Dental Hygiene Degree Program",
        alias: "/faculties-colleges-and-schools/faculty-dentistry/dental-hygiene-degree-program",
      }),
      page({
        title: "Degree Requirements",
        alias: "/faculties-colleges-and-schools/faculty-dentistry/dental-hygiene-degree-program/degree-requirements",
      }),
    ];
    enrich(pages, { host: "vancouver.calendar.ubc.ca" });
    expect(pages[0]!["is_degree_root"]).toBe(true);
    expect(pages[0]!["level"]).toBe("undergraduate");
    expect(pages[1]!["program"]).toBe("Dental Hygiene Degree Program");
  });

  it("resolves a program across UBC's dual alias trees via the terminal slug", () => {
    const pages = [
      page({
        title: "B.U.F. (Bachelor of Urban Forestry)",
        alias:
          "/faculties-colleges-and-schools/faculty-forestry-and-environmental-stewardship/buf-bachelor-urban-forestry",
      }),
      // The requirements page lives under the short-form faculty alias, where
      // no degree-root ancestor exists.
      page({
        title: "Degree Requirements",
        alias: "/faculties-colleges-and-schools/faculty-forestry/buf-bachelor-urban-forestry/degree-requirements",
      }),
    ];
    enrich(pages, { host: "vancouver.calendar.ubc.ca" });
    expect(pages[1]!["program"]).toBe("B.U.F. (Bachelor of Urban Forestry)");
    expect(pages[1]!["level"]).toBe("undergraduate");
  });

  it("keeps a minor under a bachelor from being a degree itself", () => {
    const pages = [
      page({ title: "Bachelor of Arts", alias: "/bachelor-arts" }),
      page({ title: "Minor in Statistics", alias: "/bachelor-arts/minor-statistics" }),
    ];
    enrich(pages, { host: "vancouver.calendar.ubc.ca" });
    expect(pages[0]!["is_degree_root"]).toBe(true);
    expect(pages[1]!["is_degree_root"]).toBe(false);
    expect(pages[1]!["kind"]).toBe("minor");
  });
});

describe("courseCodes", () => {
  it("keeps 2-4 letter subjects, validating against subjects when given", () => {
    const text = "Requires OR 100, AI 101, CPSC 110, CPSC 210, or WRDS 150.";
    expect(courseCodes(text, null)).toEqual(["CPSC 110", "CPSC 210", "WRDS 150"]);
    expect(courseCodes(text, new Set(["CPSC", "AI"]))).toEqual(["AI 101", "CPSC 110", "CPSC 210"]);
  });
  it("returns on first mention, preserving order", () => {
    expect(courseCodes("CPSC 110 then CPSC 110 again", null)).toEqual(["CPSC 110"]);
  });
});

describe("parseDates", () => {
  function datesPage(
    tables: Array<{ headers: string[]; rows: string[][] }>,
    headings: Array<[string, number]> = [],
  ): Record<string, unknown> {
    let body = headings.map(([text, level]) => `<h${level}>${text}</h${level}>`).join("");
    for (const { headers, rows } of tables) {
      body += `<table><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
      body += rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
      body += `</table>`;
    }
    return page({ title: "Dates and Deadlines", alias: "/dates-and-deadlines", body: { processed: body } });
  }

  it("parses events-as-rows terms-as-columns tables", () => {
    const p = datesPage(
      [
        {
          headers: ["", "Term 1 (September - December, 2026)", "Term 2 (January - April, 2027)"],
          rows: [
            ["Last Day of Classes", "December 4, 2026", "April 9, 2027"],
            ["Winter Break", "December 23, 2026", ""],
          ],
        },
      ],
      [["Term Dates", 3]],
    );
    const rows = parseDates(p);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      event: "Last Day of Classes",
      applies_to: "Term 1 (September - December, 2026)",
      section: "Term Dates",
      start: "2026-12-04",
      span_days: null,
    });
  });

  it("parses events-as-columns (transposed) tables", () => {
    const p = datesPage([
      {
        headers: ["", "Last day to drop without a W standing"],
        rows: [["Term 1 Course", "October 30, 2026"]],
      },
    ]);
    const rows = parseDates(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "Last day to drop without a W standing",
      applies_to: "Term 1 Course",
      start: "2026-10-30",
    });
  });

  it("uses the fallback year from the header when cells omit it", () => {
    const p = datesPage([
      {
        headers: ["", "2026", "2027"],
        rows: [
          ["Start", "September 8", "January 5"],
          ["End", "December 4, 2026", ""],
        ],
      },
    ]);
    const rows = parseDates(p);
    expect(rows.some((r) => r["applies_to"] === "2026" && r["event"] === "Start" && r["start"] === "2026-09-08")).toBe(
      true,
    );
    expect(rows.some((r) => r["applies_to"] === "2027" && r["event"] === "Start" && r["start"] === "2027-01-05")).toBe(
      true,
    );
  });

  it("peels glued footnote digits off the day", () => {
    const p = datesPage([{ headers: ["", "2026"], rows: [["Reading Week", "November 9 - 111"]] }]);
    const rows = parseDates(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["start"]).toBe("2026-11-09");
  });

  it("handles a range crossing years", () => {
    const p = datesPage([{ headers: ["", "2026"], rows: [["Winter Break", "December 20 - January 3, 2027"]] }]);
    const rows = parseDates(p);
    expect(rows[0]).toMatchObject({ start: "2026-12-20", end: "2027-01-03", span_days: 14 });
  });

  it("deduplicates on (applies_to, event, start) and sorts by start", () => {
    const p = datesPage([
      {
        headers: ["A", "2026"],
        rows: [
          ["X", "May 1, 2026"],
          ["X", "May 1, 2026"],
        ],
      },
    ]);
    const rows = parseDates(p);
    expect(rows).toHaveLength(1);
  });

  it("skips unparseable cells", () => {
    const p = datesPage([
      {
        headers: ["A", "2026"],
        rows: [
          ["X", "TBD"],
          ["Y", ""],
        ],
      },
    ]);
    expect(parseDates(p)).toHaveLength(0);
  });
});

describe("datesPages", () => {
  it("finds pages by either alias variant", () => {
    const pages = [
      page({ alias: "/dates-and-deadlines" }),
      page({ alias: "/dates-deadlines-okanagan" }),
      page({ alias: "/winter-session" }),
    ];
    expect(datesPages(pages)).toHaveLength(2);
  });
});
