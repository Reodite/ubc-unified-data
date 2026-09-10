/** Campus geospatial data: buildings, addresses, trees, roads, land use, POIs.
 *
 * Source: the UBCGeodata/ubc-geospatial-opendata GitHub repository, which UBC
 * Campus + Community Planning publishes as the authoritative wayfinding and
 * operational geometry for both campuses. Files are mirrored verbatim so the
 * GeoJSON stays valid and the accompanying field-definition CSVs come along.
 *
 * Some CSVs under `ubcv/locations/csv/` label their coordinate columns the
 * wrong way round: `LAT` holds longitude and `LONG` holds latitude.
 * `fixSwappedCoordinates` identifies these from sampled values rather than
 * filenames and swaps only the header names, preserving every data byte.
 * `_source.json` names each corrected file under `corrections`, so the
 * divergence from upstream is explicit. The GeoJSON stays untouched.
 */

import type { Http, Output } from "../base.ts";
import { compareStrings, register, utcnow, wants } from "../base.ts";

export const ORG = "UBCGeodata";

// Repository -> where its files are mounted in `data/geospatial/`.
//
// `ubc-geospatial-opendata` is UBC's consolidated publication and uses
// the `<campus>/<theme>/<format>/` layout this directory mirrors, so it mounts at
// the root. The separate `ubcv-parking` repository has a flat layout
// (`csv/`, `geojson/`, `metadata/`), so it mounts under `ubcv/parking/` to keep
// the campus/theme structure consistent across this directory. `_index` derives
// campus and theme from these paths.
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

/** Parse CSV text into rows: `,` delimiter, `""` escapes, quoting that may
 * span newlines, and `\r\n` treatable as a line break. Only used to read the
 * header and a coordinate sample, so correctness on unusual rows matters
 * more than speed. */
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
  // Split on the first newline: header, newline, rest. With no newline in the
  // file, rest is empty (the whole file, header included, is replaced).
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
      const meta = (await http.getJson(`https://api.github.com/repos/${slug}`)) as Record<string, unknown>;
      const branch = (meta["default_branch"] as string | undefined) ?? "master";
      const head = (await http.getJson(`https://api.github.com/repos/${slug}/commits/${branch}`)) as Record<
        string,
        unknown
      >;
      const sha = head["sha"] as string;

      const tree = (await http.getJson(`https://api.github.com/repos/${slug}/git/trees/${sha}`, {
        params: { recursive: "1" },
      })) as Record<string, unknown>;
      if (tree["truncated"]) {
        throw new Error(`GitHub truncated ${slug}'s file tree; it outgrew one listing`);
      }

      const mountPath = mount ? mount.split("/").filter(Boolean) : null;
      const pairs: Array<[string, string]> = [];
      for (const node of (tree["tree"] as Array<Record<string, unknown>>) ?? []) {
        const path = (node["path"] as string) ?? "";
        if ((node["type"] as string) !== "blob" || SKIP_PREFIXES.some((p) => path.startsWith(p))) continue;
        if (!path.toLowerCase().match(/\.(geojson|json|csv|kml|gpkg|zip)$/)) continue;
        const dest = mountPath ? [...mountPath, ...path.split("/")].join("/") : path;
        const first = dest.split("/")[0] ?? "";
        if (!wants(CAMPUS_DIRS[first])) continue;
        pairs.push([path, dest]);
      }

      const fetchPair = async (pair: [string, string]): Promise<[string, string, Uint8Array]> => {
        const [path, dest] = pair;
        const url = `https://raw.githubusercontent.com/${slug}/${sha}/${path}`;
        return [path, dest, await http.getBytes(url)];
      };

      for (const [path, dest, content] of await http.map(fetchPair, pairs, 8)) {
        const [fixed, corrected] = fixSwappedCoordinates(dest, content);
        if (corrected) corrections.push(dest);
        await out.raw(dest, fixed, { source: `https://github.com/${slug}/blob/${sha}/${path}` });
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
        branch,
        commit: sha,
        commit_date: (
          (head["commit"] as Record<string, unknown> | undefined)?.["committer"] as Record<string, unknown> | undefined
        )?.["date"],
        mounted_at: mount || "/",
        files: pairs.length,
      };
    }
  },
);
