/** University-wide events, plus the venues and organizers behind them.
 *
 * Source: the REST API of The Events Calendar on events.ubc.ca, which UBC
 * documents for developers at https://events.ubc.ca/resources/webdev/. Venues
 * carry street addresses but no coordinates, so joining events to a point on the
 * map means matching a venue address against the geospatial address data.
 */

import type { Http } from "../core/http.ts";
import type { Output } from "../core/output.ts";
import { register } from "../core/registry.ts";

export const BASE = "https://events.ubc.ca/wp-json/tribe/events/v1";

// The events endpoint defaults to upcoming only; reach back for the archive too.
export const ARCHIVE_START = "2000-01-01";
export const MAX_PAGES = 400;

export async function collection(
  http: Http,
  key: string,
  params: Record<string, unknown> | undefined = undefined,
): Promise<Array<Record<string, unknown>>> {
  const url = `${BASE}/${key}`;
  const records: Array<Record<string, unknown>> = [];
  let page = 1;
  let pages = 1;

  while (page <= Math.min(pages, MAX_PAGES)) {
    const payload = (await http.getJson(url, {
      params: { ...(params ?? {}), per_page: 50, page },
    })) as Record<string, unknown>;
    let batch = payload[key];
    if (batch === undefined || batch === null) {
      // Fall back to whichever key holds the list for this endpoint.
      batch = Object.values(payload).find((v) => Array.isArray(v)) ?? [];
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    records.push(...(batch as Array<Record<string, unknown>>));
    pages = Number(payload["total_pages"] ?? 1);
    page += 1;
  }

  return records;
}

export const Events = register(
  class {
    name = "events";
    folder = "events";
    title = "UBC events calendar";
    description =
      "Public events with start/end times, cost, website, description and category, " +
      "plus the venue directory (street address, city, coordinates) and the organizer " +
      "directory (contact email, phone, website).";
    sources = ["https://events.ubc.ca/resources/webdev/", `${BASE}/events`];

    async collect(http: Http, out: Output): Promise<void> {
      out.describe("events", {
        grain: "one public event",
        columns: {
          title: "event title",
          start_date: "local start, `YYYY-MM-DD HH:MM:SS`",
          end_date: "local end",
          utc_start_date: "the same instant in UTC",
          all_day: "true for all-day events, where the times mean nothing",
          cost: "as published; free text, often empty or `Free`",
          venue: "the venue object, inlined; `venue.id` joins to the venue table",
          organizer: "the organizer object(s), inlined",
          categories: "category objects, inlined",
          url: "the event page",
          is_virtual: "true for online events, which have no useful venue",
        },
        joins: ["venue.id -> events/venues.id", "organizer.id -> events/organizers.id"],
      });
      out.describe("venues", {
        grain: "one venue in the events directory",
        columns: {
          venue: "the venue name",
          address: "street address",
          city: "city -- the only campus proxy events have",
          province: "province",
          zip: "postal code",
        },
        joins: [
          "id -> events/events.venue.id",
          "address ~ geospatial/ubcv/locations (no coordinates here; join to place on a map)",
        ],
      });
      const events = await collection(http, "events", { start_date: ARCHIVE_START });
      await out.table("events", events, { source: `${BASE}/events` });

      for (const key of ["venues", "organizers", "categories", "tags"]) {
        let records: Array<Record<string, unknown>>;
        try {
          records = await collection(http, key);
        } catch {
          continue; // endpoint is optional on some Tribe versions
        }
        if (records.length > 0) {
          await out.table(key, records, { source: `${BASE}/${key}` });
        }
      }

      // The iCal feed is the canonical subscribable form; keep a copy alongside.
      await out.raw("events.ics", await http.getBytes("https://events.ubc.ca/?ical=1"), {
        source: "https://events.ubc.ca/?ical=1",
      });
    }
  },
);
