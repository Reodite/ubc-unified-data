import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "./cogsmodules.ts";

const html = readFileSync(join(import.meta.dirname, "../../test/fixtures/cogs-modules.html"), "utf8");

describe("parse", () => {
  const rows = parse(html);
  const byCode = new Map(rows.map((r) => [r["code"], r]));

  it("reads the module table off the live page shape", () => {
    // The 2026 list carries ~116 active modules; anything far below that
    // means the table walk broke, far above means header rows leaked in.
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.length).toBeLessThan(160);
  });

  it("canonicalizes codes wherever the _V marker drifts", () => {
    // "AI_V 322", "STAT 302_V" and lettered "PHIL_V 320/320A" all normalize.
    expect(byCode.has("AI 322")).toBe(true);
    expect(byCode.has("STAT 302")).toBe(true);
    expect(byCode.has("PHIL 320")).toBe(true);
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

const CODE_SHAPE = /^[A-Z]{2,4} \d{3}$/;
