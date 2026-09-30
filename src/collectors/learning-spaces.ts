/** Teaching and study spaces: classrooms, lounges and the buildings holding them.
 *
 * Source: the Find a Space tool on learningspaces.ubc.ca (UBC Facilities / VPFO).
 * The React front end talks to an admin-ajax endpoint that proxies an Airtable
 * base, so we drive the same three actions it does. The nonce is short-lived and
 * page-scoped, so it is scraped fresh on every run.
 *
 * Which spaces you get back is decided by a `data-config` blob on the block that
 * mounts the app -- `{"campus": ..., "formal": true}` for bookable classrooms,
 * `formal: false` for informal study space. Those configs are discovered by
 * scanning the site's pages rather than hard-coded, so an added campus or tab is
 * picked up on the next run.
 *
 * `filters.json` is the controlled vocabulary the tool filters on -- room
 * features, A/V and accessibility amenities, furniture styles, capacity range --
 * which doubles as the schema for what UBC records about a space.
 *
 * Two things are worked out here rather than fetched:
 *
 * - **Floor.** Airtable has no floor field. Informal spaces usually say it in
 *   words ("B Block 2nd Floor Lounge"); classrooms encode it in the room number.
 *   `floorFrom` reads the first and falls back to the second. Nonstandard room
 *   numbers, such as those at IRC and FNH, stay null unless the text states a floor.
 * - **Buildings carry their rooms.** The buildings endpoint returns counts and a
 *   name and nothing else, so each building is given the rooms collected for it,
 *   their floors and capacities, and a cover photo, which is what makes the table
 *   answerable on its own.
 */

import type { Http, Output } from "../base.ts";
import { register, wants, wpCollection } from "../base.ts";
import { unescapeHtml } from "../htmldoc.ts";

export const HOST = "learningspaces.ubc.ca";
export const BASE = `https://${HOST}`;
export const AJAX = `${BASE}/wp-admin/admin-ajax.php`;
export const FIND_A_SPACE = `${BASE}/find-a-space/`;

export const NONCE_RE = /find_a_space_script_vars\s*=\s*\{.*?"_nonce"\s*:\s*"([A-Za-z0-9]+)"/s;
export const CONFIG_RE = /id="ubc-vpfo-find-a-space-root"[^>]*data-config="([^"]*)"/g;

// Fallback if page discovery turns up nothing (e.g. the block markup changes).
export const DEFAULT_CONFIGS = [
  { campus: "vancouver", formal: true },
  { campus: "vancouver", formal: false },
];

// Cap room pagination to bound a runaway cursor.
export const MAX_PAGES = 500;

// "2nd Floor Lounge", "B Block 3rd Floor Lounge" -- the floor written out.
const ORDINAL_FLOOR_RE = /(\d+)\s*(?:st|nd|rd|th)\s*floor/i;

// A room number in UBC's usual scheme: an optional block or wing letter, three
// or four digits whose first is the floor, an optional suffix. "B101" is Block
// B room 101 on floor 1, not a basement, as in Buchanan.
const ROOM_NUMBER_RE = /^[A-Z]?(\d{3,4})[A-Z]?$/i;

// "(Room 101)" inside a longer informal name.
const EMBEDDED_ROOM_RE = /\broom\s+(\d{3,4})\b/i;

const BASEMENT_RE = /\bbasement\b/i;
const GROUND_RE = /\bground floor\b|\bmain floor\b/i;

// Airtable signs attachment URLs with an expiry epoch in the path.
export const EXPIRY_RE = /(\d{13})\//;

type AnyJson = Record<string, any>;

export async function nonce(http: Http): Promise<string> {
  const page = await http.getText(FIND_A_SPACE);
  const match = NONCE_RE.exec(page);
  if (!match) {
    throw new Error("could not find the find_a_space nonce; the page markup changed");
  }
  return match[1]!;
}

export async function configs(http: Http): Promise<Array<AnyJson>> {
  /** Find every Find a Space instance published on the site, deduplicated. */
  const found = new Map<string, AnyJson>();
  let pages: unknown[];
  try {
    pages = await wpCollection(http, HOST, "wp/v2/pages");
  } catch {
    pages = [];
  }

  for (const page of pages) {
    const rendered = (page as AnyJson)["content"]?.["rendered"] ?? "";
    for (const match of rendered.matchAll(CONFIG_RE)) {
      const raw = match[1] ?? "";
      let config: unknown;
      try {
        config = JSON.parse(unescapeHtml(raw));
      } catch {
        continue;
      }
      if (config !== null && typeof config === "object" && !Array.isArray(config)) {
        found.set(JSON.stringify(stableStringify(config as AnyJson)), config as AnyJson);
      }
    }
  }

  const list = found.size > 0 ? [...found.values()] : DEFAULT_CONFIGS;
  return list.filter((c) => wants(String(c["campus"] ?? "").toLowerCase() || null));
}

/** Serialize with sorted keys; the canonical form duplicated configs share. */
function stableStringify(value: AnyJson): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const out: AnyJson = {};
  for (const key of Object.keys(value).sort()) out[key] = stableStringify(value[key]);
  return out;
}

export function params(config: AnyJson): AnyJson {
  /** Encode booleans as the strings `"true"` and `"false"` that admin-ajax expects. */
  const out: AnyJson = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value === true ? "true" : value === false ? "false" : value;
  }
  return out;
}

export async function ajax(http: Http, actionCalls: string, nonceValue: string, data: AnyJson): Promise<AnyJson> {
  const body: AnyJson = { action: actionCalls, _nonce: nonceValue };
  for (const [key, value] of Object.entries(data)) body[`data[${key}]`] = value;
  const payload = await http.postJson(AJAX, body);
  if (payload !== null && typeof payload === "object" && (payload as AnyJson)["success"] === false) {
    throw new Error(`${actionCalls} failed: ${String((payload as AnyJson)["data"])}`);
  }
  return (payload ?? {}) as AnyJson;
}

export function body(payload: AnyJson): AnyJson {
  /** Rooms come back at the top level; buildings and meta nest under `data`. */
  if (payload !== null && typeof payload === "object") {
    const inner = payload["data"];
    if (inner !== null && typeof inner === "object" && ("records" in inner || "offset" in inner)) {
      return inner as AnyJson;
    }
    return payload;
  }
  return {};
}

export function floorFrom(...texts: Array<string | undefined | null>): [number | null, string | null] {
  for (const raw of texts) {
    const text = (raw ?? "").trim();
    if (!text) continue;
    const match = ORDINAL_FLOOR_RE.exec(text);
    if (match) return [Number(match[1]), "stated"];
    if (BASEMENT_RE.test(text)) return [-1, "stated"];
    if (GROUND_RE.test(text)) return [0, "stated"];
  }

  for (const raw of texts) {
    const text = (raw ?? "").trim();
    const match = ROOM_NUMBER_RE.exec(text) ?? EMBEDDED_ROOM_RE.exec(text);
    if (match) return [Number(match[1]![0]), "room_number"];
  }

  return [null, null];
}

export function photo(gallery: unknown): AnyJson {
  /** The first image UBC lists for a space, as flat columns. */
  const images = Array.isArray(gallery) ? gallery : [];
  const out: AnyJson = {
    photo_count: images.length,
    cover_photo_url: null,
    cover_photo_thumbnail_url: null,
    cover_photo_id: null,
    cover_photo_filename: null,
    cover_photo_width: null,
    cover_photo_height: null,
    cover_photo_expires: null,
  };
  const first = images.find((image) => image !== null && typeof image === "object") as AnyJson | undefined;
  if (!first) return out;

  const thumbnails = (first["thumbnails"] as AnyJson) ?? {};
  const large = (thumbnails["large"] as AnyJson) ?? (thumbnails["full"] as AnyJson) ?? {};
  const url = first["url"];
  out["cover_photo_url"] = url ?? null;
  out["cover_photo_thumbnail_url"] = large["url"] ?? null;
  out["cover_photo_id"] = first["id"] ?? null;
  out["cover_photo_filename"] = unescapeHtml(first["filename"] ?? "") || null;
  out["cover_photo_width"] = first["width"] ?? null;
  out["cover_photo_height"] = first["height"] ?? null;
  out["cover_photo_expires"] = expiry(url) ?? null;
  return out;
}

export function expiry(urlValue: unknown): string | null {
  const match = EXPIRY_RE.exec(String(urlValue ?? ""));
  if (!match) return null;
  const stamp = new Date(Number(match[1]) as number);
  if (Number.isNaN(stamp.getTime())) return null;
  return stamp.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function flatten(record: AnyJson, config: AnyJson): AnyJson {
  /** Airtable rows nest everything under `fields`; lift it to the top level. */
  const flat: AnyJson = {
    id: record["id"] ?? null,
    campus: config["campus"],
    formal: config["formal"],
    space_type: config["formal"] ? "classroom" : "study space",
    created_time: record["createdTime"],
  };
  for (const [key, value] of Object.entries((record["fields"] as AnyJson) ?? {})) {
    // Airtable linked-record fields arrive as single-item lists.
    if (Array.isArray(value) && value.length === 1 && (typeof value[0] === "string" || typeof value[0] === "number")) {
      flat[key] = value[0];
    } else {
      flat[key] = value;
    }
  }
  return flat;
}

// What each room contributes to its building's `rooms` list. Enough to pick a
// room without opening the rooms table; the full record is still there on it.
export const ROOM_SUMMARY: Array<[string, string]> = [
  ["name", "Name"],
  ["room_number", "Room Number"],
  ["capacity", "Capacity"],
  ["space_type", "space_type"],
  ["room_link", "Room Link"],
];

export function enrichRoom(room: AnyJson): void {
  const [floor, floorSource] = floorFrom(room["Room Number"], room["Name"], room["Title"]);
  room["floor"] = floor;
  room["floor_source"] = floorSource;
  Object.assign(room, photo(room["Image Gallery"]));
}

export function attachRooms(buildings: Array<AnyJson>, rooms: Array<AnyJson>): Array<AnyJson> {
  const byCode = new Map<string, AnyJson[]>();
  for (const room of rooms) {
    const code = room["Building Code"];
    if (code === undefined || code === null || code === "") continue;
    const list = byCode.get(String(code)) ?? [];
    list.push(room);
    byCode.set(String(code), list);
  }

  for (const building of buildings) {
    const held = [...(byCode.get(String(building["Building Code"])) ?? [])].sort(
      (a, b) =>
        (a["floor"] === null || a["floor"] === undefined ? 1 : 0) -
          (b["floor"] === null || b["floor"] === undefined ? 1 : 0) ||
        (a["floor"] ?? 0) - (b["floor"] ?? 0) ||
        -((a["Capacity"] as number) ?? 0) - -((b["Capacity"] as number) ?? 0),
    );
    const capacities = held
      .filter((room) => typeof room["Capacity"] === "number")
      .map((room) => room["Capacity"] as number);
    const floors = [
      ...new Set(
        held
          .filter((room) => room["floor"] !== null && room["floor"] !== undefined)
          .map((room) => room["floor"] as number),
      ),
    ].sort((a, b) => a - b);

    building["rooms"] = held.map((room) => {
      const summary: AnyJson = {};
      for (const [key, field] of ROOM_SUMMARY) {
        summary[key] = room[field] ?? null;
      }
      summary["floor"] = room["floor"] ?? null;
      summary["cover_photo_url"] = room["cover_photo_url"] ?? null;
      return summary;
    });
    building["rooms_collected"] = held.length;
    building["formal_collected"] = held.filter((room) => room["formal"]).length;
    building["informal_collected"] = held.filter((room) => !room["formal"]).length;
    building["total_capacity"] = capacities.reduce((sum, n) => sum + n, 0) || null;
    building["largest_room_capacity"] = capacities.length > 0 ? Math.max(...capacities) : null;
    building["smallest_room_capacity"] = capacities.length > 0 ? Math.min(...capacities) : null;
    building["floors"] = floors;
    building["building_link"] = held.find((room) => room["Building Link"])?.["Building Link"] ?? null;

    // The building's cover photo is its largest room's.
    const withPhoto = held.filter((room) => room["cover_photo_url"]);
    const best = withPhoto.reduce<AnyJson | null>((acc, room) => {
      if (acc === null || (room["Capacity"] as number) > ((acc["Capacity"] as number) ?? 0)) return room;
      return acc;
    }, null);
    building["cover_photo_url"] = best?.["cover_photo_url"] ?? null;
    building["cover_photo_thumbnail_url"] = best?.["cover_photo_thumbnail_url"] ?? null;
    building["cover_photo_expires"] = best?.["cover_photo_expires"] ?? null;
    building["cover_photo_room"] = best?.["Name"] ?? null;
  }

  return buildings.sort((a, b) => String(a["Building Code"] ?? "").localeCompare(String(b["Building Code"] ?? "")));
}

export const LearningSpaces = register(
  class {
    name = "spaces";
    folder = "learning-spaces";
    title = "Learning spaces (classrooms, study space, bookable rooms)";
    description =
      "Bookable classrooms and informal study spaces with capacity, building code, " +
      "room number, photos and links, the per-building formal/informal room counts, " +
      "and the full filter vocabulary UBC records for a space (A/V, accessibility, " +
      "furniture style, room features).";
    sources = [FIND_A_SPACE, `${BASE}/find-a-space-informal/`];

    async collect(http: Http, out: Output): Promise<void> {
      const found = await nonce(http);
      const discovered = await configs(http);
      const allConfigs = discovered.length > 0 ? discovered : DEFAULT_CONFIGS.filter((c) => wants(String(c.campus)));

      const rooms: Array<AnyJson> = [];
      const filters: AnyJson = {};
      const seenRooms = new Set<string>();

      for (const config of allConfigs) {
        const configParams = params(config);
        for (const room of await this.rooms(http, found, configParams, config)) {
          const key = `${room["id"] ?? ""}|${room["space_type"] ?? ""}`;
          if (seenRooms.has(key)) continue;
          seenRooms.add(key);
          rooms.push(room);
        }

        const label = `${config["campus"] ?? "unknown"}-${config["formal"] ? "formal" : "informal"}`;
        const meta = await ajax(http, "find_a_space_meta", found, configParams);
        filters[label] = body(meta)["data"] ?? {};
      }

      for (const room of rooms) enrichRoom(room);

      const buildings: Array<AnyJson> = [];
      const seenBuildings = new Set<string>();
      // Query every config, not just one per campus: the endpoint only returns
      // buildings for the requested tab. An informal-only request excludes
      // buildings that contain classrooms but no informal study space.
      for (const config of allConfigs) {
        const payload = await ajax(http, "find_a_space_buildings", found, params(config));
        for (const record of body(payload)["records"] ?? []) {
          if (record["id"] === undefined || seenBuildings.has(String(record["id"]))) continue;
          seenBuildings.add(String(record["id"]));
          buildings.push(flatten(record, config));
        }
      }

      const sortedBuildings = attachRooms(buildings, rooms);

      describeSpaces(out);
      await out.table("rooms", rooms, { source: FIND_A_SPACE });
      await out.table("buildings", sortedBuildings, { source: FIND_A_SPACE });
      await out.json("filters.json", filters, { source: FIND_A_SPACE });
      await out.json("_configs.json", allConfigs, { source: FIND_A_SPACE });
    }

    async rooms(http: Http, nonceValue: string, configParams: AnyJson, config: AnyJson): Promise<Array<AnyJson>> {
      const rooms: Array<AnyJson> = [];
      let offset: string | null = null;
      const seenOffsets = new Set<string>();

      for (let _ = 0; _ < MAX_PAGES; _++) {
        const data: AnyJson = { ...configParams };
        if (offset) data["offset"] = offset;
        const payload = body(await ajax(http, "find_a_space_rooms", nonceValue, data));

        const batch = payload["records"] ?? [];
        for (const record of batch) rooms.push(flatten(record, config));

        offset = payload["offset"] ?? null;
        if (!offset || batch.length === 0 || seenOffsets.has(offset)) break;
        seenOffsets.add(offset);
      }

      return rooms;
    }
  },
);

function describeSpaces(out: Output): void {
  out.describe("rooms", {
    grain: "one bookable classroom or informal study space",
    columns: {
      Name: "short name, e.g. `AERL 120`",
      Title: "room title as Find a Space shows it",
      "Building Code": "e.g. `SWNG`; the building this room is in",
      "Room Number": "room number within the building, verbatim",
      Capacity: "seats",
      floor:
        "derived: -1 basement, 0 ground, 1 and up. Null where UBC's number " +
        "does not say -- IRC and FNH number rooms on schemes of their own and are " +
        "left null rather than guessed",
      floor_source:
        "`stated` if UBC wrote the floor in words, `room_number` if it came from " +
        "the leading digit, null if unknown",
      formal: "true for bookable classrooms, false for informal study space",
      space_type: "the tab it came from",
      Formatted_Furniture: "furniture, as published",
      Formatted_Room_Layout_Type: "layout style",
      photo_count: "how many images UBC publishes for the room",
      cover_photo_url: "first image. A SIGNED URL THAT EXPIRES -- see cover_photo_expires",
      cover_photo_thumbnail_url: "the ~768px version of the same image",
      cover_photo_expires: "when cover_photo_url stops working, UTC",
      cover_photo_id: "Airtable attachment id; stable, unlike the URL",
      cover_photo_filename: "original filename",
      cover_photo_width: "pixels",
      cover_photo_height: "pixels",
      "Room Link":
        "the page for this room. The durable way to an image -- it re-renders a " + "fresh signed URL on load",
      "Image Gallery": "every image, with all thumbnail sizes, as UBC returns it",
    },
    joins: [
      "Building Code -> spaces/buildings.Building Code",
      "Building Code ~ geospatial/ubcv/locations building code",
    ],
  });
  out.describe("buildings", {
    grain: "one building with teaching or study space, and the rooms in it",
    columns: {
      "Building Code": "e.g. `IKBLC`; unique within this table",
      "Building Name": "the building's name",
      rooms:
        "the rooms collected for this building, floor order then largest first: " +
        "name, room_number, floor, capacity, space_type, cover_photo_url, room_link",
      rooms_collected: "how many rooms that is",
      formal_collected: "of those, bookable classrooms",
      informal_collected: "of those, informal study spaces",
      "Formal Count": "UBC's own classroom count for the building",
      "Informal Count": "UBC's own informal count, same caveat",
      floors: "distinct floors with a space on them, ascending",
      total_capacity: "seats across the collected rooms",
      largest_room_capacity: "the biggest room in the building",
      smallest_room_capacity: "the smallest",
      cover_photo_url: "the largest room's first image. EXPIRES -- see cover_photo_expires",
      cover_photo_expires: "when that URL stops working, UTC",
      cover_photo_room: "which room the cover photo is of",
      building_link: "the building's page on learningspaces.ubc.ca",
      formal:
        "which tab the building record was first seen on; not a property of the " +
        "building -- use formal_collected/Formal Count instead",
    },
    joins: ["Building Code <- spaces/rooms.Building Code"],
  });
}
