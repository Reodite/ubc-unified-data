/** Admissions: the undergraduate degree/program finder and its supporting pages.
 *
 * Source: you.ubc.ca. The program finder inlines its full dataset into /programs/
 * as `var programsListData = { programs, taxonomies }`, with slug-keyed taxonomies,
 * so we parse that literal rather than driving the search UI. Separate dataset
 * literals such as `var programs = [...]` and `var degrees = {...}` with WP term
 * ids are also supported. Admission requirement, cost and deadline content lives
 * in the WP REST pages collection.
 *
 * `admissionreqs` collects curriculum-specific requirements. Province and country
 * rules are fetched over AJAX for the program page's location dropdowns; the IB
 * tab is rendered in the page HTML. That module collects both forms and writes
 * the answers as tables.
 */

import type { Http, Output } from "../base.ts";
import { jsLiteral, register, wants, wpCollection } from "../base.ts";
import { collect as collectAdmissionreqs, ENDPOINT as REQS_ENDPOINT } from "./admissionreqs.ts";

export const HOST = "you.ubc.ca";
export const PROGRAMS_URL = `https://${HOST}/programs/`;

export const VAR_RE = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*[[{]/g;

// Front-end plumbing that happens to be declared the same way as the data.
export const IGNORE_VARS = /(Loc|Settings|Bundle|Vars|Strings)$|recaptcha|ajax|dataLayer|analytics|shim|nonce/i;

export const TAXONOMIES = ["program-areas", "student-groups", "ubc-life-topics", "cycle-stages", "content-types"];

// Written as a nested object rather than a row per program, so flattening it to
// rows the way every other literal here is flattened produces four unlabelled
// blobs. `finances` reshapes it properly; keep the original next to that.
export const NESTED_VARS = new Set(["costEstimatorData"]);

// The finder inlines programs and slug-keyed taxonomies in one object;
// per-dataset literals with WP term ids are also supported.
export const FINDER_VAR = "programsListData";

// Finder taxonomy key -> output dataset stem.
export const FINDER_TAXONOMIES: Readonly<Record<string, string>> = {
  campuses: "campuses",
  degree: "degrees",
  topic_areas: "topics",
  interests: "interests",
};

// Stable term id from a taxonomy slug. Both sides of the joins below
// (`programs` -> `finances`/`admissionreqs`) must use the same slug mapping.
export function termIdFor(slug: string): number {
  let hash = 2166136261;
  for (let i = 0; i < slug.length; i += 1) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Reshape `programsListData` into program and taxonomy tables.
 * Return null when the literal is missing or cannot be parsed. */
export function programFinderDatasets(html: string): Record<string, Array<AnyJson>> | null {
  let raw: AnyJson;
  try {
    raw = jsLiteral(html, FINDER_VAR) as AnyJson;
  } catch {
    return null;
  }

  const taxonomies = (raw["taxonomies"] ?? {}) as AnyJson;
  const idBySlug: Record<string, number> = {};
  const datasets: Record<string, Array<AnyJson>> = {};
  for (const [inKey, outName] of Object.entries(FINDER_TAXONOMIES)) {
    const terms = (taxonomies[inKey] as AnyJson[] | undefined) ?? [];
    datasets[outName] = terms.map((term) => {
      const slug = String(term["slug"] ?? "");
      const id = termIdFor(slug);
      idBySlug[`${inKey}:${slug}`] = id;
      return { term_id: id, name: term["name"] ?? slug, slug, taxonomy: inKey };
    });
  }

  const toIds = (inKey: string, values: unknown): Array<number> => {
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      const slug = String(value !== null && typeof value === "object" ? ((value as AnyJson)["slug"] ?? "") : value);
      const id = idBySlug[`${inKey}:${slug}`] ?? termIdFor(slug);
      return slug && id !== 0 ? [id] : [];
    });
  };

  const programs = (raw["programs"] as AnyJson[] | undefined) ?? [];
  datasets["programs"] = programs.map((program) => ({
    id: program["id"],
    post_title: program["title"],
    link: program["link"],
    summary: program["overview"] ?? "",
    is_new: program["is_new"] ?? false,
    campuses: toIds("campuses", program["campuses"]),
    degrees: toIds("degree", program["degrees"]),
    topics: toIds("topic_areas", program["topics"]),
    interests: toIds("interests", program["interests"]),
  }));
  return datasets;
}

export function campusIds(campuses: Array<AnyJson>): Set<string> {
  /** Campus term ids in scope, selected by campus name rather than numeric id. */
  const ids = new Set<string>();
  for (const term of campuses) {
    if (
      wants(
        String(term["name"] ?? "")
          .trim()
          .toLowerCase() || null,
      )
    ) {
      ids.add(String(term["term_id"]));
    }
  }
  return ids;
}

export function onCampus(programs: Array<AnyJson>, wantedIds: Set<string>): Array<AnyJson> {
  /** Programs offered on a campus in scope; one offered on both is kept. */
  if (wantedIds.size === 0) return programs;
  const kept: Array<AnyJson> = [];
  for (const program of programs) {
    const raw = program["campuses"];
    const ids = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    if (ids.length === 0 || ids.some((id: unknown) => wantedIds.has(String(id)))) kept.push(program);
  }
  return kept;
}

export function filterByCampus(datasets: Record<string, Array<AnyJson>>): void {
  /** Drop programs not offered on the selected campus. */
  const campuses = datasets["campuses"] ?? [];
  const wantedIds = campusIds(campuses);
  if (wantedIds.size === 0) return;

  datasets["campuses"] = campuses.filter((c) => wantedIds.has(String(c["term_id"])));
  datasets["programs"] = onCampus(datasets["programs"] ?? [], wantedIds);
}

export function asRows(value: unknown): Array<AnyJson> {
  /** Normalise either a list or an index-keyed object into a list of rows. */
  if (Array.isArray(value)) {
    return value.filter((row): row is AnyJson => row !== null && typeof row === "object" && !Array.isArray(row));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).filter(
      (row): row is AnyJson => row !== null && typeof row === "object" && !Array.isArray(row),
    );
  }
  return [];
}

type AnyJson = Record<string, unknown>;

export const Admissions = register(
  class {
    name = "admissions";
    folder = "admissions";
    title = "Admissions: degree and program finder";
    description =
      "Every undergraduate program in UBC's program finder with its degree, campus, " +
      "faculty, areas of interest and links, the degree list, and the you.ubc.ca " +
      "content pages covering admission requirements, costs, deadlines and how to apply.";
    sources = [PROGRAMS_URL, `https://${HOST}/wp-json/wp/v2/pages`, REQS_ENDPOINT];

    async collect(http: Http, out: Output): Promise<void> {
      const html = await http.getText(PROGRAMS_URL);

      const datasets: Record<string, Array<AnyJson>> = {};

      // Prefer the slug-keyed finder object; per-dataset literals below supply
      // datasets that are absent from that object.
      const finder = programFinderDatasets(html);
      if (finder) {
        for (const [name, rows] of Object.entries(finder)) datasets[name] = rows;
      }

      const names = [...new Set([...html.matchAll(VAR_RE)].map((m) => m[1]!))];
      for (const name of names) {
        if (name === FINDER_VAR || IGNORE_VARS.test(name) || NESTED_VARS.has(name)) continue;
        try {
          const rows = asRows(jsLiteral(html, name));
          if (rows.length > 0 && datasets[name] === undefined) datasets[name] = rows;
        } catch {}
      }

      if (datasets["programs"] === undefined) {
        throw new Error("no `programs` dataset found on the program finder page");
      }

      filterByCampus(datasets);

      out.describe("programs", {
        grain: "one undergraduate program in the program finder",
        columns: {
          id: "you.ubc.ca post id -- the key everything else here joins on",
          post_title: "program name",
          link: "the program page",
          summary: "one-paragraph description",
          degrees: "degree term ids; resolve against degrees.json",
          campuses: "campus term ids; resolve against campuses.json",
          interests: "interest term ids; resolve against interests.json",
          topics: "topic term ids; resolve against topics.json",
        },
        joins: [
          "id -> admissions/requirements/program_requirements.program_id",
          "id -> finances/program_cost_estimates.program_id",
          "degrees -> admissions/degrees.term_id",
          "campuses -> admissions/campuses.term_id",
        ],
      });
      for (const [name, rows] of Object.entries(datasets)) {
        await out.table(name, rows, { source: PROGRAMS_URL });
      }

      const pages = (await wpCollection(http, HOST, "wp/v2/pages", {
        params: { _embed: "0" },
      })) as Array<AnyJson>;
      await out.table("pages", pages, { source: `https://${HOST}/wp-json/wp/v2/pages` });

      for (const taxonomy of TAXONOMIES) {
        let terms: Array<AnyJson>;
        try {
          terms = (await wpCollection(http, HOST, `wp/v2/${taxonomy}`)) as Array<AnyJson>;
        } catch {
          continue;
        }
        if (terms.length > 0) {
          await out.table(`taxonomies/${taxonomy}`, terms, {
            source: `https://${HOST}/wp-json/wp/v2/${taxonomy}`,
          });
        }
      }

      const degrees: Record<string, string> = {};
      for (const term of datasets["degrees"] ?? []) {
        degrees[String(term["term_id"])] = String(term["name"] ?? "");
      }
      await collectAdmissionreqs(http, out, {
        programs: datasets["programs"],
        degrees,
      });
    }
  },
);
