import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { document } from "../source-documents.ts";
import { hoursInterval, hoursSelector, libraryBranches, monthlyHours, type LibraryBranch } from "./libraries.ts";

const AT = "2026-09-10T00:00:00Z";
const OCTOBER = readFileSync(new URL("../../test/fixtures/library-koerner-october.txt", import.meta.url), "utf8");
const DECEMBER = readFileSync(new URL("../../test/fixtures/library-ikblc-december.txt", import.meta.url), "utf8");
const BRANCH: LibraryBranch = {
  ...document({
    sourceId: "library_hours",
    upstreamId: 2,
    url: "https://hours.library.ubc.ca/#koerner",
    title: "Koerner Library",
    html: "<p>Library</p>",
    campus: "vancouver",
    retrievedAt: AT,
  }),
  hours_id: 2,
  slug: "koerner",
};

describe("library branch geography", () => {
  it("uses source map coordinates and a separate booking namespace", () => {
    const html = `<div class="branch" id="koerner"><section class="bio"><h1>Koerner Library</h1><p class="theurl"><a href="https://koerner.library.ubc.ca/">Website</a></p><div class="quiet">Study services</div></section><button class="next-month" value="2"></button><section class="contact"><address><a href="https://maps.google.com/maps?q=49.2666,-123.255143+(Koerner)">1958 Main Mall<br>Vancouver, BC</a></address><p class="visible-desktop">604 822 2406</p><a title="Disability Access" href="https://services.library.ubc.ca/access">Access</a></section></div>`;
    expect(libraryBranches(html, AT)[0]).toMatchObject({
      hours_id: 2,
      booking_lid: "1788",
      campus: "vancouver",
      latitude: 49.2666,
      longitude: -123.255143,
      address_text: "1958 Main Mall Vancouver, BC",
    });
    expect(() => libraryBranches("<h1>Verification required</h1>", AT)).toThrow(/No library branches/);
  });
});

describe("library schedule selectors", () => {
  it("matches weekday and holiday/exam date ranges including cross-year ranges", () => {
    expect(hoursSelector("Mon-Thu", 2026, 10, 1)).toBe(true);
    expect(hoursSelector("Mon-Thu", 2026, 10, 2)).toBe(false);
    expect(hoursSelector("Oct 12", 2026, 10, 12)).toBe(true);
    expect(hoursSelector("Dec 23-31", 2026, 12, 24)).toBe(true);
    expect(hoursSelector("Dec 23-Jan 4", 2027, 1, 3)).toBe(true);
    expect(hoursSelector("By arrangement", 2026, 12, 24)).toBeNull();
  });

  it("distinguishes midnight, noon, overnight, closed and unparseable schedules", () => {
    expect(hoursInterval("6am - 12am")).toEqual({
      status: "open",
      opens: "06:00",
      closes: "00:00",
      closes_next_day: true,
    });
    expect(hoursInterval("6am - 1am")).toMatchObject({ closes: "01:00", closes_next_day: true });
    expect(hoursInterval("12pm - 5pm")).toMatchObject({ opens: "12:00", closes: "17:00", closes_next_day: false });
    expect(hoursInterval("Closed* (Thanksgiving)").status).toBe("closed");
    expect(hoursInterval("By appointment").status).toBe("unknown");
    expect(hoursInterval("9am - 9am").status).toBe("unknown");
    expect(hoursInterval(null).status).toBe("unknown");
  });
});

describe("published monthly calendars", () => {
  it("applies Thanksgiving closure instead of ordinary Monday hours", () => {
    const { days, schedule } = monthlyHours(OCTOBER, BRANCH, 2026, 10, AT);
    expect(days).toHaveLength(31);
    expect(days.find((day) => day.date === "2026-10-12")).toMatchObject({
      category: "holiday",
      status: "closed",
      opens: null,
      hours_text: "Closed* (Thanksgiving)",
    });
    expect(days.find((day) => day.date === "2026-10-01")).toMatchObject({
      status: "open",
      opens: "08:00",
      closes: "20:00",
    });
    expect(schedule.additional_hours_urls).toContain("https://koerner.library.ubc.ca/koerner-library/hours/");
  });

  it("keeps extended exam closings and does not assume holidays are closed", () => {
    const { days } = monthlyHours(
      DECEMBER,
      { ...BRANCH, id: "library_hours:6", slug: "ikblc", hours_id: 6 },
      2026,
      12,
      AT,
    );
    expect(days.find((day) => day.date === "2026-12-12")).toMatchObject({
      category: "exam",
      status: "open",
      opens: "06:00",
      closes: "01:00",
      closes_next_day: true,
    });
    expect(days.find((day) => day.date === "2026-12-23")).toMatchObject({
      category: "holiday",
      status: "open",
      opens: "08:00",
      closes: "20:00",
    });
  });

  it("fails when the source month or calendar day coverage is wrong", () => {
    expect(() => monthlyHours(OCTOBER, BRANCH, 2026, 11, AT)).toThrow(/wrong month/);
    expect(() =>
      monthlyHours(OCTOBER.replace('class="regular">1</td>', 'class="regular"></td>'), BRANCH, 2026, 10, AT),
    ).toThrow(/Incomplete/);
    expect(() =>
      monthlyHours(OCTOBER.replace('class="regular">1</td>', 'class="regular">0</td>'), BRANCH, 2026, 10, AT),
    ).toThrow();
  });

  it("leaves missing or ambiguous rules unknown instead of treating them as closed", () => {
    const missing = OCTOBER.replace('class="holiday"', 'class="unsupported"');
    expect(() => monthlyHours(missing, BRANCH, 2026, 10, AT)).toThrow(/Unknown library/);
    const noRule = OCTOBER.replace("<dt>Oct 12</dt>", "<dt>By arrangement</dt>");
    expect(monthlyHours(noRule, BRANCH, 2026, 10, AT).days.find((day) => day.date === "2026-10-12")).toMatchObject({
      status: "unknown",
      hours_text: null,
    });
  });
});
