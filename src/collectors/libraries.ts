import { load } from "cheerio";
import type { Http, Output } from "../base.ts";
import { InvalidValueError, register, utcnow, wants } from "../base.ts";
import { FACT_COLUMNS, publishFacts } from "../public-facts.ts";
import { contentLinks, document, plainText, uniqueRows, type Row, type SourceDocument } from "../source-documents.ts";

export const LIBRARY_HOURS = "https://hours.library.ubc.ca/";
export const CALENDAR_ENDPOINT = `${LIBRARY_HOURS}includes/calendar.inc.php`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CATEGORIES = ["regular", "exception", "holiday", "exam"];
const BOOKING_LOCATIONS: Record<string, number> = {
  ikblc: 2174,
  library: 1811,
  koerner: 1788,
  woodward: 1789,
  researchcommons: 1821,
};

export interface LibraryBranch extends SourceDocument {
  hours_id: number;
  slug: string;
}
export interface HoursRule extends Row {
  category: string;
  heading: string;
  selector: string;
  hours_text: string;
}

export function libraryBranches(html: string, at: string): LibraryBranch[] {
  const $ = load(html);
  const result: LibraryBranch[] = [];
  $(".branch").each((_, element) => {
    const branch = $(element);
    const slug = branch.attr("id");
    const hoursId = Number(branch.find(".next-month").first().attr("value"));
    const bio = branch.find(".bio").first();
    const address = branch.find(".contact address").first();
    const addressText = plainText(address.html() ?? "");
    const campus = /\bKelowna\b/i.test(addressText)
      ? "okanagan"
      : /\bVancouver\b/i.test(addressText)
        ? "vancouver"
        : null;
    if (!slug || !Number.isSafeInteger(hoursId) || hoursId < 1 || !bio.find("h1").text().trim())
      throw new InvalidValueError("Library branch is missing its public identity");
    const mapUrl = address.find("a[href]").attr("href") ?? null;
    const coordinates = mapUrl
      ? /(?:^|\s)(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(new URL(mapUrl).searchParams.get("q") ?? "")
      : null;
    const latitude = coordinates ? Number(coordinates[1]) : null;
    const longitude = coordinates ? Number(coordinates[2]) : null;
    const page = document({
      sourceId: "library_hours",
      upstreamId: hoursId,
      url: `${LIBRARY_HOURS}#${slug}`,
      campus,
      title: bio.find("h1").first().html() ?? "",
      html: `${bio.find(".quiet").html() ?? ""}<h2>Address</h2>${address.html() ?? ""}`,
      retrievedAt: at,
    });
    result.push({
      ...page,
      hours_id: hoursId,
      slug,
      website: bio.find(".theurl a").attr("href") ?? null,
      address_text: addressText || null,
      contact_text: plainText(branch.find(".contact .visible-desktop").html() ?? "") || null,
      accessibility_url: branch.find(".contact a[title='Disability Access']").attr("href") ?? null,
      latitude,
      longitude,
      map_url: mapUrl,
      location_type: addressText ? "physical" : "virtual_or_unlabelled",
      booking_lid: BOOKING_LOCATIONS[slug] ? String(BOOKING_LOCATIONS[slug]) : null,
    });
  });
  if (!result.length) throw new InvalidValueError("No library branches found");
  uniqueRows(result, LIBRARY_HOURS);
  return result;
}

/** Match the source's weekday or month/day selectors; unknown syntax remains unresolved. */
export function hoursSelector(selector: string, year: number, month: number, day: number): boolean | null {
  const normalized = selector.replace(/[–—]/g, "-").trim();
  const weekday = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:\s*-\s*(Sun|Mon|Tue|Wed|Thu|Fri|Sat))?$/i.exec(normalized);
  if (weekday) {
    const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const start = DAYS.findIndex((name) => name.toLowerCase() === weekday[1]!.toLowerCase());
    const end = weekday[2] ? DAYS.findIndex((name) => name.toLowerCase() === weekday[2]!.toLowerCase()) : start;
    return end >= start ? index >= start && index <= end : index >= start || index <= end;
  }
  const date = /^([A-Za-z]{3})\s+(\d{1,2})(?:\s*-\s*(?:([A-Za-z]{3})\s+)?(\d{1,2}))?$/.exec(normalized);
  if (!date) return null;
  const startMonth = MONTHS.findIndex((name) => name.toLowerCase() === date[1]!.toLowerCase()) + 1;
  const endMonth = date[3] ? MONTHS.findIndex((name) => name.toLowerCase() === date[3]!.toLowerCase()) + 1 : startMonth;
  if (!startMonth || !endMonth) return null;
  const start = startMonth * 100 + Number(date[2]);
  const end = date[4] ? endMonth * 100 + Number(date[4]) : start;
  const current = month * 100 + day;
  return end >= start ? current >= start && current <= end : current >= start || current <= end;
}

export function hoursInterval(value: string | null): {
  status: string;
  opens: string | null;
  closes: string | null;
  closes_next_day: boolean | null;
} {
  const unknown = { status: "unknown", opens: null, closes: null, closes_next_day: null };
  if (!value) return unknown;
  if (/^closed\*?\s*(?:\([^)]*\))?$/i.test(value)) return { ...unknown, status: "closed" };
  if (/^(?:open\s+)?24\s+hours$/i.test(value))
    return { status: "open", opens: "00:00", closes: "00:00", closes_next_day: true };
  const match =
    /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\*?\s*(?:\([^)]*\))?$/i.exec(value);
  if (!match) return unknown;
  const time = (hour: string, minute: string | undefined, meridiem: string): number | null => {
    const h = Number(hour);
    const m = Number(minute ?? 0);
    return h < 1 || h > 12 || m > 59 ? null : ((h % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0)) * 60 + m;
  };
  const start = time(match[1]!, match[2], match[3]!);
  const end = time(match[4]!, match[5], match[6]!);
  if (start === null || end === null || start === end) return unknown;
  const format = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { status: "open", opens: format(start), closes: format(end), closes_next_day: end < start };
}

export function monthlyHours(
  html: string,
  branch: LibraryBranch,
  year: number,
  month: number,
  at: string,
): { schedule: Row; days: Row[] } {
  const $ = load(html, {}, false);
  const heading = $(".monthheading").first().text().trim();
  const displayed = /^([A-Za-z]+)\s+(\d{4})$/.exec(heading);
  if (!displayed || Number(displayed[2]) !== year || displayed[1]!.slice(0, 3) !== MONTHS[month - 1])
    throw new InvalidValueError(`Library returned the wrong month: ${heading}, expected ${year}-${month}`);
  const rules: HoursRule[] = [];
  $(".hours-table dl").each((_, element) => {
    const dl = $(element);
    const category = CATEGORIES.find((name) => dl.hasClass(name));
    if (!category) throw new InvalidValueError(`Unknown library hours category for ${branch.slug}`);
    const ruleHeading = plainText(dl.prevAll("h6").first().html() ?? "");
    dl.children("dt").each((_, term) => {
      const dt = $(term);
      const dd = dt.next("dd");
      if (!dd.length) throw new InvalidValueError(`Library hours rule is missing its value: ${branch.slug}`);
      rules.push({
        category,
        heading: ruleHeading,
        selector: plainText(dt.html() ?? ""),
        hours_text: plainText(dd.html() ?? ""),
      });
    });
  });
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const expected = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: Row[] = [];
  $("table.month tbody td").each((_, element) => {
    const cell = $(element);
    const label = cell.text().trim();
    if (!label) return;
    if (!/^\d{1,2}$/.test(label)) throw new InvalidValueError(`Unrecognized library calendar day: ${label}`);
    const day = Number(label);
    if (day < 1 || day > expected) throw new InvalidValueError(`Invalid library calendar day: ${label}`);
    const category = CATEGORIES.find((name) => cell.hasClass(name)) ?? null;
    const applicable = rules.filter((rule) => {
      if (rule.category !== category || hoursSelector(rule.selector, year, month, day) !== true) return false;
      const range = /\(([^)]+)\)/.exec(rule.heading)?.[1];
      return !range || hoursSelector(range, year, month, day) === true;
    });
    const values = [...new Set(applicable.map((rule) => rule.hours_text))];
    const hours = values.length === 1 ? values[0]! : null;
    days.push({
      id: `${branch.id}:${period}-${String(day).padStart(2, "0")}`,
      branch_id: branch.id,
      hours_id: branch.hours_id,
      campus: branch.campus,
      date: `${period}-${String(day).padStart(2, "0")}`,
      timezone: "America/Vancouver",
      category,
      hours_text: hours,
      ...hoursInterval(hours),
      schedule_id: `${branch.id}:${period}`,
      source_url: branch.source_url,
      retrieved_at: at,
    });
  });
  if (
    days.length !== expected ||
    new Set(days.map((day) => day.date)).size !== expected ||
    days.some((day) => Number(String(day.date).slice(-2)) > expected)
  )
    throw new InvalidValueError(`Incomplete library calendar for ${branch.slug} ${period}`);
  return {
    schedule: {
      id: `${branch.id}:${period}`,
      branch_id: branch.id,
      campus: branch.campus,
      month: period,
      heading,
      rules,
      additional_hours_urls: contentLinks(
        $(".calendar p")
          .map((_, element) => $.html(element))
          .get()
          .join("\n"),
        LIBRARY_HOURS,
      ).map((link) => link.url),
      source_url: branch.source_url,
      request_url: CALENDAR_ENDPOINT,
      request_parameters: { location_id: branch.hours_id, year, month },
      retrieved_at: at,
    },
    days,
  };
}

export const Libraries = register(
  class {
    name = "libraries";
    folder = "libraries";
    title = "Library locations and dated opening hours";
    description =
      "Official library locations, contact details and accessibility links, with four calendar months of opening hours, holiday/exam exceptions and overnight closing indicators. These shared student facilities serve undergraduates; hours are not room-booking availability.";
    sources = [LIBRARY_HOURS, CALENDAR_ENDPOINT];

    async collect(http: Http, out: Output): Promise<void> {
      const at = utcnow();
      const html = await http.getText(LIBRARY_HOURS);
      const allBranches = libraryBranches(html, at);
      const branches = allBranches.filter((branch) => wants(branch.campus));
      const localDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Vancouver",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(at));
      const [year, month] = localDate.split("-").map(Number);
      const periods = Array.from({ length: 4 }, (_, offset) => {
        const date = new Date(Date.UTC(year!, month! - 1 + offset, 1));
        return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
      });
      const initial = load(html);
      const requests = branches.flatMap((branch) => periods.map((period) => ({ branch, ...period })));
      const collected = await http.map(
        async ({ branch, year, month }) => {
          const first = initial(`#${branch.slug} .hours`).first();
          const sourceMonth = first.find(".monthheading").text().trim();
          const reuse = sourceMonth.startsWith(MONTHS[month - 1]!) && sourceMonth.endsWith(String(year));
          const body = reuse
            ? initial.html(first)
            : await http.postText(CALENDAR_ENDPOINT, { location_id: branch.hours_id, year, month });
          return monthlyHours(body, branch, year, month, at);
        },
        requests,
        Math.min(http.workers, 3),
      );
      const schedules = collected.map((entry) => entry.schedule);
      const hours = collected.flatMap((entry) => entry.days);
      uniqueRows(schedules, "library schedules");
      uniqueRows(hours, "library hours");
      out.describe("branches", {
        grain: "one physical library/service location or virtual service; several locations can share a building",
        columns: {
          ...FACT_COLUMNS,
          hours_id: "Identifier used by hours.library.ubc.ca, not a LibCal booking id",
          booking_lid: "Explicit name-verified LibCal location crosswalk; not a building-code join",
          latitude: "Latitude supplied in UBC's map link, not a geocoded inference",
          longitude: "Longitude supplied in UBC's map link",
          accessibility_url: "Official accessibility-guide link, not an assertion that all entrances are accessible",
        },
        joins: [
          "id -> libraries/hours.branch_id",
          "id -> libraries/monthly_schedules.branch_id",
          "booking_lid -> room-bookings/locations.lid (explicit crosswalk; verify building separately)",
        ],
      });
      await publishFacts(out, "libraries/branches", branches, LIBRARY_HOURS);
      out.describe("monthly_schedules", {
        grain: "one library location and calendar month",
        columns: {
          rules: "Verbatim heading, selector and hours-text rules; retain them when a daily value is unresolved",
          additional_hours_urls:
            "Official links for separate reference/service hours; page notes and prose are not republished",
          request_parameters: "Read-only calendar navigation form parameters for reproduction",
        },
        joins: ["branch_id -> libraries/branches.id"],
      });
      await publishFacts(out, "libraries/monthly_schedules", schedules, CALENDAR_ENDPOINT);
      out.describe("hours", {
        grain: "one library location and local calendar date, including closed or unresolved days",
        columns: {
          status: "open, closed or unknown; open means scheduled hours, not currently open",
          opens: "Derived local HH:mm opening time, or null",
          closes: "Derived local HH:mm closing time, or null",
          closes_next_day: "True for overnight closings (including midnight); never infer a zero-length interval",
          category: "regular, exception, holiday, exam, or null, copied from the source calendar cell",
          hours_text: "Exact applicable published rule, or null if absent/ambiguous",
          timezone: "America/Vancouver is the documented local-time interpretation, not an offset supplied by UBC",
          retrieved_at: "Snapshot time; refresh before answering time-sensitive questions",
        },
        joins: ["branch_id -> libraries/branches.id", "schedule_id -> libraries/monthly_schedules.id"],
      });
      await publishFacts(out, "libraries/hours", hours, CALENDAR_ENDPOINT);
      await out.json(
        "_source.json",
        {
          authority: "University of British Columbia Library",
          source: LIBRARY_HOURS,
          scope: "undergraduate-relevant shared student facilities",
          representation: "facts_and_links",
          retrieved_at: at,
          local_date: localDate,
          months: periods,
          branches: branches.length,
          schedules: schedules.length,
          dated_hours: hours.length,
          unknown_days: hours.filter((day) => day.status === "unknown").length,
          excluded_by_campus: allBranches.filter((branch) => !wants(branch.campus)).map((branch) => branch.slug),
          notes: [
            "The window is the current Vancouver calendar month plus three months. Dates outside it are not collected; unpublished or ambiguous hours remain unknown, not closed.",
            "This source reports opening hours, not room vacancy, occupancy or booking availability. A source label open does not mean currently open.",
            "Research Commons is listed at Koerner floors 4-5. The existing room-booking dataset's building code may differ; use the source address and do not infer a building-code crosswalk from matching location names.",
            "Only location/contact facts, calendar rules and links are published. Branch descriptions, other page prose and HTML are excluded. Linked accessibility pages are not automatically crawled.",
          ],
        },
        { source: LIBRARY_HOURS },
      );
    }
  },
);
