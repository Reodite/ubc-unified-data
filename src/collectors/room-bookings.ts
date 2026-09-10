/** Bookable library spaces and when they are actually free.
 *
 * Source: the Spaces module of UBC Library's LibCal (Springshare) at
 * libcal.library.ubc.ca. It is the only public UBC surface that publishes
 * room-level *occupancy* rather than room-level description, which makes it the
 * missing half of `learning-spaces`: that collector says what a room is, this one
 * says whether anyone is in it.
 *
 * Three things are fetched, in the order the site's own front end does it:
 *
 * - **Locations** come from the location `<select>` on `/spaces`, so a library
 *   added or retired by UBC is picked up rather than hard-coded.
 * - **Rooms** come from the `resources.push({...})` literals the page inlines for
 *   whichever group it is showing. That list is paginated and group-scoped, so it
 *   can omit rooms at a location. The availability grid enumerates the location;
 *   any room it returns that the page does not describe is filled in from
 *   `/space/<eid>`.
 * - **Availability** comes from `POST /spaces/availability/grid`, which returns
 *   15-minute slots. `itemId` on a slot is the `eid` of a room; those are the same
 *   identifier despite the different names, which is what lets the two join.
 *
 * Two things are worked out here rather than fetched:
 *
 * - **Slot state.** The grid marks a slot with a CSS class or leaves it bare, and
 *   bare means free. `stateFrom` maps the classes UBC currently emits and treats
 *   anything unrecognised as not-free -- see the note on that function for why the
 *   default matters.
 * - **Intervals.** Consecutive slots in the same state are merged, because "free
 *   09:00-19:00" is the answerable form of forty consecutive quarter-hours. The
 *   raw grid is not written because the merged form preserves the same availability:
 *   every slot is recoverable by subdividing the interval that covers it. The
 *   omitted `checksum` is a per-request booking token rather than an identifier
 *   and is meaningless when the request that issued it ends.
 */

import type { Http, Output } from "../base.ts";
import { register, utcnow, wants } from "../base.ts";
import { unescapeHtml } from "../htmldoc.ts";

export const HOST = "libcal.library.ubc.ca";
export const BASE = `https://${HOST}`;
export const SPACES = `${BASE}/spaces`;
export const GRID = `${BASE}/spaces/availability/grid`;

// Every LibCal space in this instance is on the Vancouver campus.
export const CAMPUS = "vancouver";

// How far ahead to ask for. LibCal clamps the answer to its own booking window
// (currently about a week), so asking for more than that is harmless and keeps
// working if UBC widens it -- but the endpoint 400s on a range of about a month,
// so this cannot simply be set large.
export const DAYS_AHEAD = 14;

// Which building each LibCal location sits in, as `BLDG_CODE` in the geospatial
// buildings layer. LibCal names a *library*, not a building, and three of them
// share one: the Music/Art/Architecture branch and the Research Commons are both
// inside Irving K. Barber. Without this the rooms cannot be put on a map.
export const BUILDING_CODES: Record<string, string> = {
  "Irving K. Barber Learning Centre": "IBLC",
  "Music, Art & Architecture Library (IKB)": "IBLC",
  "Research Commons": "IBLC",
  "Koerner Library": "KLIB",
  "Woodward Library": "WLIB",
};

// The class LibCal puts on a slot -> what that slot is. A bare slot is bookable.
export const SLOT_STATES: Record<string, string> = {
  free: "free",
  "": "free",
  "s-lc-eq-checkout": "booked",
  "s-lc-eq-r-unavailable": "unavailable",
};

// `<option value="2174">Irving K. Barber Learning Centre</option>`
export const OPTION_RE = /<option[^>]*\bvalue="(\d+)"[^>]*>\s*([^<]+?)\s*<\/option>/g;

// The location dropdown ends at this entry; the options after it belong to the
// group and capacity filters and are not locations.
export const LOCATIONS_END = "View All Locations";

export const RESOURCE_RE = /resources\.push\(/g;
export const H1_RE = /<h1[^>]*>(.*?)<\/h1>/s;
export const CAPACITY_RE = /Capacity:\s*(\d+)/;
export const PARENTHETICAL_RE = /\(([^)]+)\)/;

type AnyJson = Record<string, any>;

/** The `{...}` beginning at `start`, respecting strings and escapes. */
export function balanced(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = "";

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** Parse one JS object literal that is JSON apart from its syntax sugar.
 * LibCal writes these with bare keys and a trailing comma, neither of which JSON
 * allows. `jsLiteral` cannot be used because these arrive as `resources.push({...})`
 * calls rather than one assignable literal. */
export function jsObject(body: string): AnyJson {
  body = body.replace(/^(\s*)(\w+)(\s*):/gm, (_m, a, b) => `${a}"${b}":`);
  body = body.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(body);
}

export function resources(page: string): Array<AnyJson> {
  /** Every room the page describes inline, in the order it lists them. */
  const found: Array<AnyJson> = [];
  for (const match of page.matchAll(RESOURCE_RE)) {
    const opener = page.indexOf("{", match.index + match[0].length);
    if (opener < 0) continue;
    const body = balanced(page, opener);
    if (body) {
      try {
        found.push(jsObject(body));
      } catch {}
    }
  }
  return found;
}

export function locations(page: string): Array<AnyJson> {
  /** The libraries the location dropdown offers, in page order. */
  const found: Array<AnyJson> = [];
  for (const match of page.matchAll(OPTION_RE)) {
    const value = match[1]!;
    const label = unescapeHtml(match[2]!).trim();
    if (label === LOCATIONS_END) break;
    if (value === "0" || found.some((item) => item["lid"] === value)) continue;
    found.push({
      lid: value,
      name: label,
      campus: CAMPUS,
      building_code: BUILDING_CODES[label] ?? null,
      url: `${SPACES}?lid=${value}`,
    });
  }
  return found;
}

export function stateFrom(className: string | null | undefined): string {
  /** Anything UBC emits that is not in the table is reported as `unavailable`
   * rather than `free`. The two errors are not symmetric: hiding a room that was
   * actually free wastes a walk across campus, while showing an occupied room as
   * free sends someone into a seminar in progress. */
  if (className !== null && className !== undefined && SLOT_STATES[className] !== undefined) {
    return SLOT_STATES[className]!;
  }
  if (className === null || className === undefined || className === "") return "free";
  return "unavailable";
}

/** Parse `YYYY-MM-DD HH:MM:SS` as local time without a UTC offset; return null on failure. */
function time(stamp: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function roomFromPage(page: string, eid: number): AnyJson {
  /** Name and capacity for a room absent from the browsable list. */
  const match = H1_RE.exec(page);
  const heading = unescapeHtml(match ? match[1]!.replace(/<[^>]+>/g, "") : "") || "";
  const lines = heading
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "");
  const name = heading.trim() !== "" ? (lines[0]?.trim() ?? null) : null;
  const capacity = CAPACITY_RE.exec(heading);
  const location = PARENTHETICAL_RE.exec(heading);

  return {
    eid,
    title: name,
    capacity: capacity ? Number(capacity[1]) : null,
    grouping: location ? location[1]!.trim() : null,
    url: `${BASE}/space/${eid}`,
    described_by: "space_page",
  };
}

export function room(resource: AnyJson, loc: AnyJson): AnyJson {
  /** One row of the rooms table, from a resource literal. */
  return {
    eid: resource["eid"] ?? null,
    lid: loc["lid"],
    location: loc["name"],
    campus: CAMPUS,
    building_code: loc["building_code"],
    gid: resource["gid"] ?? null,
    grouping: resource["grouping"] ?? null,
    title: resource["title"] ?? null,
    capacity: resource["capacity"] ?? null,
    url: resource["url"] ? BASE + String(resource["url"]) : null,
    thumbnail: resource["thumbnail"] ?? null,
    filter_ids: resource["filterIds"] ?? null,
    booking_selectable_time: resource["gBookingSelectableTime"] ?? null,
    described_by: "spaces_page",
  };
}

type Slot = Record<string, unknown> & { _start?: Date; _end?: Date };

/** Collapse a room's consecutive same-state slots into the intervals they form. */
export function merge(slots: Array<AnyJson>): Array<AnyJson> {
  const intervals: Array<Slot> = [];
  const ordered = [...slots].sort(
    (a, b) => cmp(a["eid"], b["eid"]) ?? cmp(a["state"], b["state"]) ?? strcmp(a["start"] ?? "", b["start"] ?? ""),
  );

  for (const slot of ordered) {
    const start = time(String(slot["start"] ?? ""));
    const end = time(String(slot["end"] ?? ""));
    if (!start || !end) continue;
    const last = intervals[intervals.length - 1];
    if (
      last &&
      last["eid"] === slot["eid"] &&
      last["state"] === slot["state"] &&
      last["_end"]?.getTime() === start.getTime()
    ) {
      last["_end"] = end;
      last["end"] = slot["end"];
      last["minutes"] = Math.floor((end.getTime() - last["_start"]!.getTime()) / 60000);
      continue;
    }
    intervals.push({
      eid: slot["eid"],
      lid: slot["lid"],
      location: slot["location"],
      building_code: slot["building_code"],
      campus: CAMPUS,
      room: slot["room"] ?? null,
      capacity: slot["capacity"] ?? null,
      state: slot["state"],
      date: String(slot["start"] ?? "").slice(0, 10),
      start: slot["start"] ?? "",
      end: slot["end"] ?? "",
      minutes: Math.floor((end.getTime() - start.getTime()) / 60000),
      collected_at: slot["collected_at"],
      _start: start,
      _end: end,
    });
  }

  const out = intervals.map(({ _start: _a, _end: _b, ...rest }) => rest as unknown as AnyJson);
  return out.sort(
    (a, b) =>
      strcmp(a["lid"] ?? "", b["lid"] ?? "") ?? cmp(a["eid"], b["eid"]) ?? strcmp(a["start"] ?? "", b["start"] ?? ""),
  );
}

function cmp(a: unknown, b: unknown): number | null {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return null;
}
function strcmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const Bookings = register(
  class {
    name = "bookings";
    folder = "room-bookings";
    title = "Library room availability (bookable spaces and free time)";
    description =
      "Every bookable space in UBC Library's LibCal with its location, capacity and " +
      "photo, and when each one is free, booked or unavailable over UBC's booking " +
      "window -- the 15-minute grid UBC publishes, merged into intervals. Availability " +
      "is a snapshot taken at `collected_at`, not a standing fact; see _snapshot.json " +
      "for the window covered.";
    sources = [SPACES];

    async collect(http: Http, out: Output): Promise<void> {
      if (!wants(CAMPUS)) {
        await out.json("_snapshot.json", { skipped: `campus filter excludes ${CAMPUS}` });
        return;
      }

      describeBookings(out);
      const collectedAt = utcnow();
      const today = new Date();
      const todayIso = isoDate(today);
      const windowEnd = addDays(today, DAYS_AHEAD);
      const windowEndIso = isoDate(windowEnd);

      const found = locations(await http.getText(SPACES));
      if (found.length === 0) {
        throw new Error("no locations in the LibCal dropdown; the page markup changed");
      }

      const rooms = await this.rooms(http, found);
      const slots = await this.slots(http, found, rooms, todayIso, windowEndIso, collectedAt);
      await this.fillGaps(http, rooms, slots, found);

      for (const location of found) {
        const held = Object.values(rooms).filter((room) => room["lid"] === location["lid"]);
        location["rooms_collected"] = held.length;
        location["total_capacity"] =
          held.reduce((sum, room) => sum + (typeof room["capacity"] === "number" ? room["capacity"] : 0), 0) || null;
      }

      const availability = merge(slots);
      const served = [...new Set(slots.map((slot) => String(slot["start"]).slice(0, 10)))].sort(strcmp);

      await out.table("locations", found, { source: SPACES });
      await out.table(
        "rooms",
        Object.values(rooms).sort(
          (a, b) => strcmp(a["lid"] ?? "", b["lid"] ?? "") ?? strcmp(a["title"] ?? "", b["title"] ?? ""),
        ),
        { source: SPACES },
      );
      await out.table("availability", availability, { source: GRID });
      await out.json(
        "_snapshot.json",
        {
          collected_at: collectedAt,
          requested_from: todayIso,
          requested_to: windowEndIso,
          days_served: served,
          locations: found.length,
          rooms: Object.keys(rooms).length,
          intervals: availability.length,
          slots_seen: slots.length,
          free_slots_seen: slots.filter((slot) => slot["state"] === "free").length,
          slot_minutes: 15,
          note:
            "Availability is a point-in-time snapshot. A booking made after " +
            "collected_at is not reflected here; re-run before relying on it.",
        },
        { source: GRID },
      );
    }

    async rooms(http: Http, found: Array<AnyJson>): Promise<Record<string, AnyJson>> {
      /** Every room the location pages describe, keyed by eid. */
      const fetch = async (location: AnyJson): Promise<[AnyJson, string]> => {
        return [location, await http.getText(SPACES, { params: { lid: location["lid"], gid: 0 } })];
      };
      const roomsOut: Record<string, AnyJson> = {};
      for (const [location, page] of await http.map(fetch, found)) {
        for (const resource of resources(page)) {
          const r = room(resource, location);
          if (r["eid"] !== null && r["eid"] !== undefined) {
            const key = String(r["eid"]);
            if (roomsOut[key] === undefined) roomsOut[key] = r;
          }
        }
      }
      return roomsOut;
    }

    async slots(
      http: Http,
      found: Array<AnyJson>,
      rooms: Record<string, AnyJson>,
      start: string,
      end: string,
      collectedAt: string,
    ): Promise<Array<AnyJson>> {
      /** The availability grid for every location, one request each. */
      const fetch = async (location: AnyJson): Promise<[AnyJson, AnyJson]> => {
        const payload = await http.postJson(
          GRID,
          {
            lid: location["lid"],
            gid: 0,
            eid: -1,
            seat: 0,
            seatId: 0,
            zone: 0,
            start,
            end,
            pageIndex: 0,
            pageSize: 500,
          },
          {
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              Referer: `${SPACES}?lid=${location["lid"]}`,
            },
          },
        );
        return [location, (payload as AnyJson) ?? {}];
      };

      const slotsOut: Array<AnyJson> = [];
      for (const [location, payload] of await http.map(fetch, found)) {
        for (const slot of (payload["slots"] as Array<AnyJson> | undefined) ?? []) {
          const eid = slot["itemId"] ?? null;
          const roomEntry = (eid !== null && eid !== undefined && rooms[String(eid)]) || {};
          slotsOut.push({
            eid,
            lid: location["lid"],
            location: location["name"],
            building_code: location["building_code"],
            campus: CAMPUS,
            room: roomEntry["title"] ?? null,
            capacity: roomEntry["capacity"] ?? null,
            date: (slot["start"] ?? "").slice(0, 10),
            start: slot["start"] ?? null,
            end: slot["end"] ?? null,
            state: stateFrom(slot["className"] as string | null | undefined),
            checksum: slot["checksum"] ?? null,
            collected_at: collectedAt,
          });
        }
      }
      return slotsOut;
    }

    async fillGaps(
      http: Http,
      rooms: Record<string, AnyJson>,
      slots: Array<AnyJson>,
      found: Array<AnyJson>,
    ): Promise<void> {
      /** Describe rooms present only in the grid, and label the slots. */
      const byLid = new Map(found.map((location) => [String(location["lid"]), location]));
      const missing = [
        ...new Set(
          slots
            .filter(
              (slot) => slot["eid"] !== null && slot["eid"] !== undefined && rooms[String(slot["eid"])] === undefined,
            )
            .map((slot) => String(slot["eid"])),
        ),
      ].sort((a, b) => Number(a) - Number(b));
      if (missing.length === 0) return;

      const fetch = async (eid: string): Promise<[string, string | null]> => {
        try {
          return [eid, await http.getText(`${BASE}/space/${eid}`)];
        } catch {
          return [eid, null];
        }
      };

      const lidOf = new Map(
        slots
          .filter((s) => s["eid"] !== null && s["eid"] !== undefined)
          .map((s) => [String(s["eid"]), String(s["lid"])]),
      );
      for (const [eid, page] of await http.map(fetch, missing)) {
        const location = byLid.get(lidOf.get(eid) ?? "") ?? {};
        const row: AnyJson = {
          eid: Number(eid),
          lid: location["lid"] ?? null,
          location: location["name"] ?? null,
          campus: CAMPUS,
          building_code: location["building_code"] ?? null,
          gid: null,
          grouping: null,
          title: null,
          capacity: null,
          url: `${BASE}/space/${eid}`,
          thumbnail: null,
          filter_ids: null,
          booking_selectable_time: null,
          described_by: "space_page",
        };
        if (page) {
          const fromPage = roomFromPage(page, Number(eid));
          for (const [key, value] of Object.entries(fromPage)) {
            if (value !== null && value !== undefined) row[key] = value;
          }
        }
        rooms[eid] = row;
      }

      for (const slot of slots) {
        if (slot["room"] === null || slot["room"] === undefined) {
          const roomEntry = rooms[String(slot["eid"])] ?? {};
          slot["room"] = roomEntry["title"] ?? null;
          slot["capacity"] = roomEntry["capacity"] ?? null;
        }
      }
    }
  },
);

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function describeBookings(out: Output): void {
  out.describe("locations", {
    grain: "One LibCal location -- a UBC library or branch that publishes bookable space.",
    columns: {
      lid: "LibCal location id; the key rooms and slots carry.",
      name: "Library name as UBC's own dropdown gives it.",
      building_code: "BLDG_CODE of the building it sits in, for the geospatial join.",
      rooms_collected: "Rooms found for this location on this run.",
      total_capacity: "Seats across those rooms, where capacity is published.",
    },
    joins: [
      "geospatial/ubcv/locations/geojson/ubcv_buildings.geojson on building_code = BLDG_CODE",
      "learning-spaces/buildings on building_code = `Building Code`",
    ],
  });
  out.describe("rooms", {
    grain: "One bookable space -- a group study room, project room or seating area.",
    columns: {
      eid: "LibCal space id. The same number the availability grid calls `itemId`.",
      lid: "The location this room belongs to.",
      capacity: "Seats, where UBC publishes them; null for spaces that are not individually bookable.",
      building_code: "Inherited from the location, for the geospatial join.",
      described_by:
        "`spaces_page` if the browsable list described this room, `space_page` " +
        "if it only appeared in the grid and was filled in from its own page.",
      filter_ids: "LibCal's internal amenity filter ids, kept as sent.",
    },
    joins: ["slots on eid", "openings on eid", "locations on lid"],
  });
  out.describe("availability", {
    grain:
      "One uninterrupted stretch of one room in one state, as it stood at " +
      "`collected_at` -- UBC's consecutive 15-minute slots merged.",
    columns: {
      eid: "The room. Joins to rooms.eid.",
      state:
        "`free`, `booked`, or `unavailable`. Anything UBC marks in a way this " +
        "collector does not recognise is reported `unavailable`, never `free`. " +
        "Filter on `free` to find bookable time.",
      start:
        "First moment in this state, `YYYY-MM-DD HH:MM:SS` local, as UBC sends " +
        "it; `end` is the first moment no longer in it.",
      minutes: "Length of the stretch, so a usable block can be picked without subtracting timestamps.",
      collected_at: "When this snapshot was taken. Availability moves; this does not.",
    },
    joins: ["rooms on eid", "locations on lid"],
  });
}
