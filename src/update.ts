/** Refresh selected structured datasets and rebuild their manifest and catalog.
 * Record each group's failure without stopping the remaining collectors.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import "./collectors/index.ts";
import { CAMPUS_CHOICES, setCampus } from "./core/campus.ts";
import { Http } from "./core/http.ts";
import { DATA_DIR, Output } from "./core/output.ts";
import { REGISTRY } from "./core/registry.ts";
import { utcnow } from "./core/utils.ts";

const MANIFEST = path.join(DATA_DIR, "manifest.json");
const CATALOG = path.join(DATA_DIR, "catalog.json");

const CATALOG_NOTE =
  "Index of every table in this dataset. One entry per table, not per file: " +
  "`json` and `csv` hold the same rows, the JSON keeping nested values intact and " +
  "the CSV encoding them into the cell. `grain` says what a single row is, `columns` " +
  "describes the ones worth knowing about (not always all of them), and `joins` names " +
  "the other tables a row can be linked to and on which column. Start here rather " +
  "than guessing from filenames. manifest.json has the same information plus per-file " +
  "sizes, sources and run status.";

interface GroupInfo {
  title?: string;
  description?: string;
  folder?: string;
  status?: string;
  updated_at?: string;
  sources?: string[];
  duration_seconds?: number;
  records?: number;
  bytes?: number;
  removed_stale?: string[];
  datasets?: Array<Record<string, unknown>>;
  error?: string;
}

interface Manifest {
  name?: string;
  description?: string;
  generated_at?: string;
  campus?: string;
  groups?: Record<string, GroupInfo>;
}

/** Pair JSON and CSV files into tables with shared grain, column and join metadata. */
function buildCatalog(manifest: Manifest): Record<string, unknown> {
  const groups: Record<string, Record<string, unknown>> = {};

  for (const [name, group] of Object.entries(manifest.groups ?? {})) {
    const tables = new Map<string, Record<string, unknown>>();
    for (const dataset of group.datasets ?? []) {
      const p = String(dataset.path);
      const dot = p.lastIndexOf(".");
      const stem = dot > 0 ? p.slice(0, dot) : p;
      const suffix = dot > 0 ? p.slice(dot + 1) : "";
      // Anything that isn't a .json/.csv pair (GeoJSON, iCal, the raw
      // mirrors) is a table of one file and keyed by its whole path.
      const key = suffix === "json" || suffix === "csv" ? stem : p;
      const table = tables.get(key) ?? {
        name: key.split("/").at(-1),
        path: key,
        records: dataset.records ?? null,
      };
      if (suffix === "json" || suffix === "csv") {
        table[suffix] = p;
      } else {
        table.file = p;
      }
      for (const field of ["grain", "columns", "joins", "source"]) {
        if (dataset[field] && !table[field]) table[field] = dataset[field];
      }
      tables.set(key, table);
    }

    groups[name] = {
      title: group.title,
      description: group.description,
      folder: group.folder,
      status: group.status,
      updated_at: group.updated_at,
      sources: group.sources ?? [],
      tables: [...tables.values()].sort((a, b) => String(a.path).localeCompare(String(b.path))),
    };
  }

  return {
    name: manifest.name,
    generated_at: manifest.generated_at,
    campus: manifest.campus,
    how_to_read: CATALOG_NOTE,
    groups,
  };
}

function humanBytes(size: number): string {
  let value = size;
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (value < 1024 || unit === "GB") {
      return unit === "B" ? `${value}B` : `${value.toFixed(1)}${unit}`;
    }
    value /= 1024;
  }
  return `${value.toFixed(1)}GB`;
}

async function loadManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(MANIFEST, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

interface CliOptions {
  groups: string[];
  list?: boolean;
  skip: string[];
  campus: string;
  workers: number;
  timeout: number;
  minInterval: number;
}

// Progress belongs to the current collector and resets between groups.
let progressDone = 0;
let progressTotal = 0;
let progressLabel = "";
let progressDirty = false;
let progressStarted = 0;

/** Overwrite the current progress line and clear any trailing characters. */
function drawProgress(): void {
  if (!progressDirty) {
    // Parsing and disk writes have no item count; show elapsed time instead.
    const secs = Math.floor((Date.now() - progressStarted) / 1000);
    process.stdout.write(`\r  [${progressLabel}] ... ${secs}s\x1b[K`);
    return;
  }
  const secs = Math.floor((Date.now() - progressStarted) / 1000);
  const pct = progressTotal > 0 ? Math.min(100, Math.round((progressDone / progressTotal) * 100)) : 0;
  const width = 24;
  const filled = Math.round((width * pct) / 100);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  const count = progressTotal > 0 ? `${progressDone}/${progressTotal}` : "";
  process.stdout.write(`\r  [${progressLabel}] ${bar} ${String(pct).padStart(3)}% ${count} ${secs}s\x1b[K`);
}

/** Clear the current progress line. */
function clearProgressLine(): void {
  process.stdout.write("\r\x1b[K");
}

function parseArgsCLI(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      list: { type: "boolean" },
      skip: { type: "string", multiple: true },
      campus: { type: "string", default: "vancouver" },
      workers: { type: "string", default: "8" },
      timeout: { type: "string", default: "60" },
      "min-interval": { type: "string", default: "0" },
    },
  });
  if (!CAMPUS_CHOICES.includes(values.campus as (typeof CAMPUS_CHOICES)[number])) {
    throw new Error(`invalid campus ${values.campus}; choose from ${CAMPUS_CHOICES.join(", ")}`);
  }
  return {
    groups: [...positionals],
    list: values.list ?? false,
    skip: values.skip ?? [],
    campus: values.campus as string,
    workers: Number(values.workers),
    timeout: Number(values.timeout),
    minInterval: Number(values["min-interval"]),
  };
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgsCLI(argv);

  if (options.list) {
    console.log("Available groups:\n");
    for (const [name, cls] of Object.entries(REGISTRY)) {
      const collector = new cls();
      console.log(`  ${name.padEnd(12)} ${collector.title}`);
      console.log(`  ${" ".padEnd(12)} ${collector.description}\n`);
    }
    return 0;
  }

  const unknown = [...options.groups, ...options.skip].filter((name) => !(name in REGISTRY));
  if (unknown.length > 0) {
    console.error(`unknown group(s): ${unknown.join(", ")}`);
    console.error(`available: ${Object.keys(REGISTRY).join(", ")}`);
    return 2;
  }

  let selected = options.groups.length > 0 ? options.groups : Object.keys(REGISTRY);
  selected = selected.filter((name) => !options.skip.includes(name));

  setCampus(options.campus);

  const http = new Http({
    timeout: options.timeout,
    minInterval: options.minInterval,
    workers: options.workers,
    onProgress: (done, total) => {
      progressDone = done;
      progressTotal = total;
      progressDirty = true;
    },
  });
  const manifest = await loadManifest();
  const groups = manifest.groups ?? {};

  console.log(`Updating ${selected.length} group(s) into ${DATA_DIR}  [campus: ${options.campus}]\n`);
  let failures = 0;

  for (const [index, name] of selected.entries()) {
    const cls = REGISTRY[name];
    if (!cls) continue;
    const collector = new cls();
    const out = new Output(collector.folder);
    const started = Date.now();
    console.log(`[${index + 1}/${selected.length}] ${name} -- ${collector.title}`);
    progressLabel = `${index + 1}/${selected.length} ${name}`;
    progressStarted = Date.now();
    progressDone = 0;
    progressTotal = 0;
    progressDirty = false;

    const ticker = setInterval(drawProgress, 1000);
    try {
      await collector.collect(http, out);
    } catch (error) {
      failures += 1;
      const elapsed = (Date.now() - started) / 1000;
      const label = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
      clearInterval(ticker);
      clearProgressLine();
      console.error(`    FAILED after ${elapsed.toFixed(1)}s: ${label}\n`);
      if (error instanceof Error && error.stack) console.error(error.stack.split("\n").slice(1, 4).join("\n"));
      groups[name] = {
        title: collector.title,
        status: "failed",
        error: label,
        updated_at: utcnow(),
        datasets: groups[name]?.datasets ?? [],
      };
      continue;
    }
    clearInterval(ticker);
    clearProgressLine();

    const elapsed = (Date.now() - started) / 1000;
    const records = out.datasets.reduce((sum, d) => sum + (d.records ?? 0), 0);
    const size = out.datasets.reduce((sum, d) => sum + d.bytes, 0);
    // Safe only because we got here without an exception: a partial run must
    // never delete the previous good data.
    const removed = await out.prune();
    console.log(
      `    ${out.datasets.length} file(s), ${records.toLocaleString()} records, ` +
        `${humanBytes(size)} in ${elapsed.toFixed(1)}s`,
    );
    if (removed.length > 0) {
      console.log(
        `    removed ${removed.length} stale file(s): ` +
          `${removed
            .slice(0, 6)
            .map((r) => r.split("/").at(-1))
            .join(", ")}` +
          `${removed.length > 6 ? " ..." : ""}`,
      );
    }
    console.log("");

    groups[name] = {
      title: collector.title,
      description: collector.description,
      sources: [...collector.sources],
      folder: collector.folder,
      status: "ok",
      updated_at: utcnow(),
      duration_seconds: Math.round(elapsed),
      records,
      bytes: size,
      removed_stale: removed,
      datasets: out.datasets.map((d) => ({ ...d })),
    };
  }

  const updated: Manifest = {
    name: "UBC open data",
    description: "Public institutional data about UBC, gathered from official sources.",
    generated_at: utcnow(),
    campus: options.campus,
    groups,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MANIFEST, JSON.stringify(updated, null, 2), "utf8");
  await writeFile(CATALOG, JSON.stringify(buildCatalog(updated), null, 2), "utf8");

  const totalRecords = Object.values(groups).reduce((sum, g) => sum + (g.records ?? 0), 0);
  const totalBytes = Object.values(groups).reduce((sum, g) => sum + (g.bytes ?? 0), 0);
  console.log(`Dataset totals: ${totalRecords.toLocaleString()} records, ${humanBytes(totalBytes)}`);
  console.log(`Manifest: ${MANIFEST}`);
  console.log(`Catalog:  ${CATALOG}`);

  if (failures > 0) console.error(`\n${failures} group(s) failed.`);
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
