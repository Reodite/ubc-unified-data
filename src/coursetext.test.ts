import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { enrich, parseCourseText, plainText } from "./coursetext.ts";

describe("parseCourseText", () => {
  it("splits description from prereq/coreq/vector", () => {
    const result = parseCourseText(
      "Physical and mathematical structures of computation. [3-2-1] Prerequisite: Principles of Mathematics 12 or Pre-calculus 12. Corequisite: One of CPSC 107, CPSC 110.",
    );
    expect(result).toEqual({
      description_text: "Physical and mathematical structures of computation.",
      prerequisite: "Principles of Mathematics 12 or Pre-calculus 12.",
      corequisite: "One of CPSC 107, CPSC 110.",
      equivalency: "",
      credit_exclusion: "",
      hours_vector: "3-2-1",
    });
  });

  it("takes the first occurrence of each label, later ones ignored", () => {
    const result = parseCourseText("Study. Prerequisite: A. [2-1-0] Corequisite: B. Corequisite: C?");
    expect(result.prerequisite).toBe("A. [2-1-0].");
    expect(result.corequisite).toBe("B.");
  });

  it("removes the vector from the description when it precedes the first clause", () => {
    const result = parseCourseText("[2.5-0-0]Intro to X & Y. Prerequisite: MATH 100.");
    expect(result.description_text).toBe("Intro to X & Y.");
    expect(result.hours_vector).toBe("2.5-0-0");
  });

  it("extracts the credit exclusion clause", () => {
    const result = parseCourseText(
      "Some course. Credit will be granted for only one of A, B or C. Prerequisite: PHYS 100.",
    );
    expect(result.credit_exclusion).toBe("Credit will be granted for only one of A, B or C.");
    expect(result.description_text).toBe("Some course.");
    expect(result.prerequisite).toBe("PHYS 100.");
  });

  it("returns empty strings for any absent clause, keeping shapes stable", () => {
    expect(parseCourseText("")).toEqual({
      description_text: "",
      prerequisite: "",
      corequisite: "",
      equivalency: "",
      credit_exclusion: "",
      hours_vector: "",
    });
    expect(parseCourseText(undefined)).toEqual({
      description_text: "",
      prerequisite: "",
      corequisite: "",
      equivalency: "",
      credit_exclusion: "",
      hours_vector: "",
    });
  });
});

describe("plainText", () => {
  it("handles Drupal {processed} fields", () => {
    expect(plainText({ processed: "<p>Hello &amp; goodbye</p>", value: "<p>raw</p>" })).toBe("Hello & goodbye");
  });
  it("prefers processed over value, falls back to plain strings", () => {
    expect(plainText("flat text &amp; more")).toBe("flat text & more");
  });
  it("returns empty for non-text values", () => {
    expect(plainText(null)).toBe("");
    expect(plainText(123)).toBe("");
  });
  it("decodes entity references once, preserving escaped literal references", () => {
    expect(plainText("&#0")).toBe("\uFFFD");
    expect(plainText("&copy")).toBe("©");
    expect(plainText("&amp;#0")).toBe("&#0");
    expect(plainText("&amp;copy")).toBe("&copy");
  });
});

describe("enrich", () => {
  it("adds columns in place and counts parsed rows", () => {
    const records = [
      { id: 1, body: "Course. Prerequisite: CPSC 110." },
      { id: 2, body: "Plain description, no structure." },
    ];
    const parsed = enrich(records, "body");
    expect(parsed).toBe(1);
    expect(records[0]).toMatchObject({ prerequisite: "CPSC 110." });
    expect(records[1]).toMatchObject({ prerequisite: "" });
  });
});

// Generated clauses are literal text, not HTML entity references.
// Escape ampersands so source-HTML decoding preserves the intended clause.
describe("generated course-text clauses", () => {
  const label = fc.record({
    name: fc.constantFrom("Prerequisite", "Pre-requisite", "Corequisite", "Equivalency"),
    body: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/[<\s;.]/.test(s)),
  });
  const description = fc.record({
    lead: fc
      .array(fc.constantFrom("Study", "Analysis", "Introduction", "Field", "Theory"), {
        minLength: 0,
        maxLength: 3,
      })
      .map((words) => words.join(" ")),
    vector: fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 2, maxLength: 3 }).map((parts) => parts.join("-")),
    label,
  });

  it("preserves generated vectors and literal label clauses", () => {
    fc.assert(
      fc.property(description, ({ lead, vector, label }) => {
        const text = `${lead} [${vector}] ${label.name}: ${label.body.replaceAll("&", "&amp;")}.`;
        const parsed = parseCourseText(text);
        expect(parsed.hours_vector).toBe(vector);
        const key = label.name.startsWith("Pre")
          ? "prerequisite"
          : label.name.startsWith("Co")
            ? "corequisite"
            : "equivalency";
        expect(parsed[key]).toBe(`${label.body}.`);
      }),
      {
        numRuns: 200,
        seed: 921659461,
        examples: [[{ lead: "", vector: "0-0", label: { name: "Prerequisite", body: "&#0" } }]],
      },
    );
  });
});
