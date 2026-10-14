/** Faculty and staff profiles published by UBC faculties, schools and units.
 *
 * Source: the `node--ubc_profile` resource on the shared UBC Drupal platform.
 * Most faculty and unit sites run on it, so we probe a list of known hosts and
 * take profiles from whichever expose them -- names, titles, units and profile
 * URLs, as each unit publishes them.
 *
 * This is public directory-style information only. No student data is collected.
 */

import { errorName, type Http } from "../core/http.ts";
import type { Output } from "../core/output.ts";
import { register } from "../core/registry.ts";
import { jsonapiCollection, jsonapiIndex } from "../scraping/drupal.ts";

// UBC units known to run the shared Drupal platform. Hosts that are absent,
// offline or not on the platform are skipped without failing the run.
export const HOSTS = [
  "science.ubc.ca",
  "apsc.ubc.ca",
  "arts.ubc.ca",
  "grad.ubc.ca",
  "forestry.ubc.ca",
  "landfood.ubc.ca",
  "sauder.ubc.ca",
  "educ.ubc.ca",
  "law.ubc.ca",
  "nursing.ubc.ca",
  "pharmsci.ubc.ca",
  "dentistry.ubc.ca",
  "med.ubc.ca",
  "spph.ubc.ca",
  "sppga.ubc.ca",
  "music.ubc.ca",
  "sala.ubc.ca",
  "ires.ubc.ca",
  "chbe.ubc.ca",
  "civil.ubc.ca",
  "ece.ubc.ca",
  "mech.ubc.ca",
  "cs.ubc.ca",
  "math.ubc.ca",
  "stat.ubc.ca",
  "phas.ubc.ca",
  "chem.ubc.ca",
  "zoology.ubc.ca",
  "botany.ubc.ca",
  "eoas.ubc.ca",
  "economics.ubc.ca",
  "psych.ubc.ca",
  "geog.ubc.ca",
  "history.ubc.ca",
  "english.ubc.ca",
  "philosophy.ubc.ca",
  "linguistics.ubc.ca",
  "anth.ubc.ca",
  "soci.ubc.ca",
  "politics.ubc.ca",
  "library.ubc.ca",
  "parking.ubc.ca",
  "courses.students.ubc.ca",
];

export const RESOURCE = "node/ubc_profile";

export const People = register(
  class {
    name = "people";
    folder = "people";
    title = "Faculty and staff profiles by unit";
    description =
      "Public faculty and staff profiles from UBC units on the shared Drupal " +
      "platform, tagged with the site they came from. Coverage is partial -- most " +
      "faculties run other platforms and expose no API, so `_sites.json` records " +
      "which hosts answered. Public directory information only -- no student data.";
    sources = HOSTS.slice(0, 3)
      .map((host) => `https://${host}/jsonapi/${RESOURCE}`)
      .concat("...");

    async collect(http: Http, out: Output): Promise<void> {
      const gather = async (host: string): Promise<[string, Array<Record<string, unknown>>, string | null]> => {
        let records: Array<Record<string, unknown>>;
        try {
          if (!(await jsonapiIndex(http, host)).has(RESOURCE.replace("/", "--"))) {
            return [host, [], "no ubc_profile resource"];
          }
          records = await jsonapiCollection(http, host, RESOURCE, { workers: 4 });
        } catch (error) {
          return [host, [], `${errorName(error)}: ${error instanceof Error ? error.message : String(error)}`];
        }
        for (const record of records) record["site"] = host;
        return [host, records, null];
      };

      const results = await http.map(gather, HOSTS, 8);

      const profiles: Array<Record<string, unknown>> = [];
      const sites: Array<Record<string, unknown>> = [];
      for (const [host, records, error] of results) {
        profiles.push(...records);
        sites.push({ site: host, profiles: records.length, skipped: error });
      }

      out.describe("profiles", {
        grain: "one published faculty or staff profile on one UBC site",
        columns: {
          title: "the person's name as the site publishes it",
          field_profile_job_title: "their title in the unit",
          field_profile_email: "public contact email",
          field_profile_phone: "public contact phone",
          field_profile_office: "office location, where published",
          body: "biography HTML",
          site: "which UBC host published it -- the only unit marker there is",
          alias: "path on that host; prefix the host for the URL",
        },
        joins: [
          "title ~ courses/sections.field_instructors (by name; there is no shared id)",
          "site -> people/_sites.site",
        ],
      });
      out.describe("_sites", {
        grain: "one host that was probed for profiles, whether or not it had any",
        columns: {
          site: "the host",
          profiles: "how many it returned; 0 means it is not on the shared platform",
          skipped: "why nothing came back, when nothing did",
        },
        joins: ["site -> people/profiles.site"],
      });
      await out.table("profiles", profiles);
      await out.table("_sites", sites);
    }
  },
);
