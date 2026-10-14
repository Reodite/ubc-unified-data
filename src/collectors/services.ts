/** Campus services students actually use: food outlets, parking, facilities info.
 *
 * Sources are a mix of Drupal JSON:API and WordPress REST endpoints across UBC
 * service sites. Each dataset is optional -- a site that moves or retires an
 * endpoint is recorded in `_sources.json` rather than failing the run.
 */

import { errorMessage, errorName, ResourceNotFoundError, type Http } from "../core/http.ts";
import type { Output } from "../core/output.ts";
import { register } from "../core/registry.ts";
import { jsonapiCollection, jsonapiIndex } from "../scraping/drupal.ts";
import { wpCollection } from "../scraping/wordpress.ts";
import { fetch as fetchHolidays, URL as HOLIDAYS_URL } from "./holidays.ts";

type Fetcher = ((http: Http) => Promise<Array<Record<string, unknown>>>) & { source?: string };

function drupal(host: string, resource: string): Fetcher {
  const fetcher = (async (http: Http): Promise<Array<Record<string, unknown>>> => {
    if (!(await jsonapiIndex(http, host)).has(resource.replace("/", "--"))) {
      throw new ResourceNotFoundError(`${host} does not expose ${resource}`);
    }
    return jsonapiCollection(http, host, resource);
  }) as Fetcher;
  fetcher.source = `https://${host}/jsonapi/${resource}`;
  return fetcher;
}

function wordpress(host: string, path: string): Fetcher {
  const fetcher = (async (http: Http): Promise<Array<Record<string, unknown>>> => {
    return (await wpCollection(http, host, path)) as Array<Record<string, unknown>>;
  }) as Fetcher;
  fetcher.source = `https://${host}/wp-json/${path}`;
  return fetcher;
}

export const DATASETS: Record<string, Fetcher> = {
  food_outlets: wordpress("food.ubc.ca", "wp/v2/places"),
  food_events: wordpress("food.ubc.ca", "wp/v2/event"),
  parking_locations: drupal("parking.ubc.ca", "node/parking_location"),
  parking_permits: drupal("parking.ubc.ca", "node/permits"),
  parking_maps: drupal("parking.ubc.ca", "node/map_page"),
  facilities_resources: wordpress("facilities.ubc.ca", "wp/v2/resources"),
  learning_space_resources: wordpress("learningspaces.ubc.ca", "wp/v2/resources"),
  recreation_pages: wordpress("recreation.ubc.ca", "wp/v2/pages"),
  student_services_pages: wordpress("students.ubc.ca", "wp/v2/pages"),
  news: wordpress("news.ubc.ca", "wp/v2/posts"),
  // The one entry here that isn't an API: HR publishes the holiday list as a
  // page, so `holidays` reads the tables off it.
  statutory_holidays: fetchHolidays as Fetcher,
};

export const Services = register(
  class {
    name = "services";
    folder = "campus-services";
    title = "Campus services (food, parking, facilities, student services, news)";
    description =
      "Food outlets and their hours, parking locations, permits and parking maps, " +
      "facilities and learning-space resource libraries, recreation and student " +
      "services pages, UBC news posts, and the statutory holidays UBC observes.";
    sources = ["https://food.ubc.ca", "https://parking.ubc.ca", "https://facilities.ubc.ca", HOLIDAYS_URL];

    async collect(http: Http, out: Output): Promise<void> {
      const status: Array<Record<string, unknown>> = [];

      for (const [name, fetchDataset] of Object.entries(DATASETS)) {
        const source = fetchDataset.source ?? null;
        let records: Array<Record<string, unknown>>;
        try {
          records = await fetchDataset(http);
        } catch (error) {
          status.push({
            dataset: name,
            source,
            records: 0,
            skipped: `${errorName(error)}: ${errorMessage(error)}`,
          });
          continue;
        }
        if (records.length > 0) {
          await out.table(name, records, { source: source ?? undefined });
        }
        status.push({ dataset: name, source, records: records.length, skipped: null });
      }

      await out.json("_sources.json", status);
    }
  },
);
