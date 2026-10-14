/** Mirror Campus + Community Planning's UBCGeodata geometry and field definitions
 * for both campuses. Some `ubcv/locations/csv/` files put longitude in LAT and
 * latitude in LONG. Sampled values identify these files; only headers change,
 * preserving data rows and GeoJSON. `_source.json` lists corrections. */

import { wants } from "../core/campus.ts";
import type { Http } from "../core/http.ts";
import type { Output } from "../core/output.ts";
import { register } from "../core/registry.ts";
import { compareStrings, utcnow } from "../core/utils.ts";
import { githubSnapshot } from "../scraping/github.ts";

export const ORG = "UBCGeodata";

// Mounts under `data/geospatial/` preserve the `<campus>/<theme>/<format>/`
// layout used by `_index`. Parking's flat `csv/`, `geojson/`, `metadata/`
// directories need a campus/theme prefix; the consolidated repository does not.
export const REPOS: Record<string, string> = {
  "ubc-geospatial-opendata": "",
  "ubcv-parking": "ubcv/parking",
};

export const DATA_SUFFIXES = new Set([".geojson", ".json", ".csv", ".kml", ".gpkg", ".zip"]);
export const SKIP_PREFIXES = [".github/"];

export const CAMPUS_DIRS: Record<string, string> = { ubcv: "vancouver", ubco: "okanagan" };

export const COORDINATE_COLUMNS = ["LAT", "LONG"];
export const COORDINATE_SAMPLE = 400;

function medianOf(rows: string[][], index: number): number | null {
  const values: number[] = [];
  for (const row of rows) {
    if (index < row.length) {
      const raw = row[index];
      // Number("") is 0; exclude blank cells so they do not count as coordinates.
      const value = Number(raw);
      if (raw !== undefined && raw.trim() !== "" && !Number.isNaN(value)) values.push(value);
    }
  }
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return sorted[mid] ?? null;
  return sorted.length % 2 === 0 ? (lo + hi) / 2 : hi;
}

function stripBom(bytes: Uint8Array): Uint8Array {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.slice(3) : bytes;
}

/** Read CSV headers and coordinate samples, supporting doubled quotes,
 * multiline fields and LF/CRLF line breaks. */
function csvRead(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
        i += 1;
      } else {
        cell += ch;
      }
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function fixSwappedCoordinates(path: string, content: Uint8Array): [Uint8Array, boolean] {
  if (!path.toLowerCase().endsWith(".csv")) return [content, false];

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stripBom(content));
  } catch {
    return [content, false];
  }

  const rows = csvRead(text);
  const header = rows[0] ?? [];
  if (!COORDINATE_COLUMNS.every((column) => header.includes(column))) return [content, false];

  const latAt = header.indexOf("LAT");
  const longAt = header.indexOf("LONG");
  const sample = rows.slice(1, 1 + COORDINATE_SAMPLE);
  const lat = medianOf(sample, latAt);
  const long = medianOf(sample, longAt);
  if (lat === null || long === null) return [content, false];
  if (!(Math.abs(lat) > 90 && Math.abs(long) <= 90)) return [content, false];

  // Rewrite the header line alone, leaving every data byte where it was.
  [header[latAt], header[longAt]] = [header[longAt]!, header[latAt]!];
  const newHeader = `${csvField(header)}\n`;
  // Preserve everything after the first newline; a header-only file has no rest.
  const nl = text.indexOf("\n");
  const rest = nl >= 0 ? text.slice(nl + 1) : "";
  return [new TextEncoder().encode(newHeader + rest), true];
}

/** Write a minimally quoted CSV header with doubled embedded quotes and no
 * line terminator; quote a lone empty cell when `singleColumn` is true. */
function csvField(cells: string[], singleColumn = false): string {
  return cells
    .map((cell) => {
      const quote =
        cell.includes(",") ||
        cell.includes('"') ||
        cell.includes("\r") ||
        cell.includes("\n") ||
        (singleColumn && cell === "");
      return quote ? `"${cell.replaceAll('"', '""')}"` : cell;
    })
    .join(",");
}

export const Geospatial = register(
  class {
    name = "geospatial";
    folder = "geospatial";
    title = "Campus geospatial open data";
    description =
      "Buildings, building entrances, sub-buildings, complexes, addresses, points of " +
      "interest, parking facilities with rates and permits, trees, hard/soft landscape, " +
      "water features, roads, routes, bollards, land use, neighbourhoods and legal " +
      "boundaries for UBC Vancouver, UBC Okanagan and off-campus UBC locations.";
    sources = Object.keys(REPOS).map((repo) => `https://github.com/${ORG}/${repo}`);

    async collect(http: Http, out: Output): Promise<void> {
      const index: Array<Record<string, unknown>> = [];
      const corrections: string[] = [];
      const repositories: Array<Record<string, unknown>> = [];

      for (const [repo, mount] of Object.entries(REPOS)) {
        repositories.push(await this.mirror(http, out, repo, mount, index, corrections));
      }

      await out.table("_index", index);
      await out.json("_source.json", {
        repositories,
        retrieved_at: utcnow(),
        corrections: corrections.length
          ? {
              swapped_lat_long_headers: [...corrections].sort(compareStrings),
              note:
                "Upstream labels these files' coordinate columns the wrong way " +
                "round: LAT held longitude and LONG held latitude. The two column " +
                "names are swapped here so each holds what it says; the data rows " +
                "are byte-identical to upstream, so the columns now read LONG,LAT " +
                "in that order. The GeoJSON versions were already correct and are " +
                "untouched.",
            }
          : {},
      });
    }

    async mirror(
      http: Http,
      out: Output,
      repo: string,
      mount: string,
      index: Array<Record<string, unknown>>,
      corrections: string[],
    ): Promise<Record<string, unknown>> {
      const slug = `${ORG}/${repo}`;
      const snapshot = await githubSnapshot(http, slug);

      const mountPath = mount ? mount.split("/").filter(Boolean) : null;
      const pairs: Array<[string, string]> = [];
      for (const path of snapshot.paths) {
        if (SKIP_PREFIXES.some((p) => path.startsWith(p))) continue;
        if (!path.toLowerCase().match(/\.(geojson|json|csv|kml|gpkg|zip)$/)) continue;
        const dest = mountPath ? [...mountPath, ...path.split("/")].join("/") : path;
        const first = dest.split("/")[0] ?? "";
        if (!wants(CAMPUS_DIRS[first])) continue;
        pairs.push([path, dest]);
      }

      const fetchPair = async (pair: [string, string]): Promise<[string, string, Uint8Array]> => {
        const [path, dest] = pair;
        return [path, dest, await http.getBytes(snapshot.rawUrl(path))];
      };

      for (const [path, dest, content] of await http.map(fetchPair, pairs, 8)) {
        const [fixed, corrected] = fixSwappedCoordinates(dest, content);
        if (corrected) corrections.push(dest);
        await out.raw(dest, fixed, { source: snapshot.blobUrl(path) });
      }

      const indexRows: Array<Record<string, string>> = pairs.map(([, dest]) => {
        const parts = dest.split("/");
        const last = parts[parts.length - 1] ?? "";
        const dot = last.lastIndexOf(".");
        return {
          path: dest,
          campus: parts[0] ?? "",
          theme: parts[1] ?? "",
          format: (dot >= 0 ? last.slice(dot + 1) : "").toLowerCase(),
          name: dot >= 0 ? last.slice(0, dot) : last,
          repository: repo,
        };
      });
      index.push(...indexRows);

      return {
        repository: `https://github.com/${slug}`,
        branch: snapshot.branch,
        commit: snapshot.sha,
        commit_date: snapshot.commitDate,
        mounted_at: mount || "/",
        files: pairs.length,
      };
    }
  },
);
