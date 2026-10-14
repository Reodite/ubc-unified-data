import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvScalar, stringifyCsv, stringifyJson, stringifyJsonItems } from "./serialization.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = path.join(ROOT, "data");
export const PRETTY_LIMIT = 2000;

export interface DatasetInfo {
  path: string;
  records: number | null;
  bytes: number;
  source?: string | null;
  grain?: string | null;
  columns?: Record<string, string> | null;
  joins?: string[] | null;
}

export interface DocSpec {
  grain: string;
  columns: Record<string, string>;
  joins?: readonly string[];
}

export class Output {
  root: string;
  base: string;
  datasets: DatasetInfo[] = [];
  docs: Record<string, { grain: string; columns: Record<string, string>; joins: string[] }> = {};

  constructor(folder: string, root: string = DATA_DIR) {
    this.root = root;
    this.base = path.join(root, folder);
  }

  /** Register manifest documentation for both JSON and CSV at the table stem. */
  describe(stem: string, spec: DocSpec): void {
    this.docs[stem] = {
      grain: spec.grain,
      columns: { ...spec.columns },
      joins: [...(spec.joins ?? [])],
    };
  }

  private async _target(relpath: string): Promise<string> {
    const target = path.join(this.base, relpath);
    await mkdir(path.dirname(target), { recursive: true });
    return target;
  }

  private async _track(basename: string, records: number | null, source: string | null | undefined): Promise<void> {
    const relative = path.relative(this.root, basename).split(path.sep).join("/");
    const folder = path.relative(this.root, this.base).split(path.sep).join("/");
    const stem = relative.startsWith(`${folder}/`) ? relative.slice(folder.length + 1) : relative;
    // JSON and CSV share documentation keyed by the table stem.
    const key = stem.split(".").slice(0, -1).join(".");
    const doc = this.docs[key] ?? { grain: null, columns: null, joins: null };
    const info = await stat(basename);
    this.datasets.push({
      path: relative,
      records,
      bytes: info.size,
      source: source ?? null,
      grain: doc.grain ?? null,
      columns: doc.columns ?? null,
      joins: doc.joins ?? null,
    });
    return;
  }

  async json(
    relpath: string,
    payload: unknown,
    opts: { source?: string | null; indent?: number | null; itemsPerLine?: boolean } = {},
  ): Promise<string> {
    const target = await this._target(relpath);
    const content =
      opts.itemsPerLine && Array.isArray(payload)
        ? stringifyJsonItems(payload)
        : stringifyJson(payload, opts.indent ?? (Array.isArray(payload) && payload.length > PRETTY_LIMIT ? null : 2));
    await writeFile(target, content, "utf8");
    await this._track(target, Array.isArray(payload) ? payload.length : null, opts.source);
    return relPath(this.root, target);
  }

  async csv(
    relpath: string,
    rows: Array<Record<string, unknown>>,
    opts: { columns?: string[]; source?: string | null } = {},
  ): Promise<string> {
    const target = await this._target(relpath);
    const prepared = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) out[key] = csvScalar(value);
      return out;
    });
    await writeFile(target, stringifyCsv(prepared, { columns: opts.columns }), "utf8");
    await this._track(target, rows.length, opts.source);
    return relPath(this.root, target);
  }

  /** Write the same records as both JSON (fidelity) and CSV (convenience). */
  async table(
    stem: string,
    rows: Array<Record<string, unknown>>,
    opts: { source?: string | null } = {},
  ): Promise<void> {
    await this.json(`${stem}.json`, rows, opts);
    if (rows.length > 0) await this.csv(`${stem}.csv`, rows, opts);
  }

  async raw(
    relpath: string,
    content: ArrayBuffer | Uint8Array | string,
    opts: { source?: string | null } = {},
  ): Promise<string> {
    const target = await this._target(relpath);
    await writeFile(
      target,
      typeof content === "string" ? content : new Uint8Array(content as ArrayBuffer | Uint8Array),
    );
    await this._track(target, null, opts.source);
    return relPath(this.root, target);
  }

  /** Delete unwritten files and prune empty directories deepest-first.
   * Call only after collection succeeds to preserve previous data on failure. */
  async prune(): Promise<string[]> {
    let baseIsDir = false;
    try {
      baseIsDir = (await stat(this.base)).isDirectory();
    } catch {
      return [];
    }
    if (!baseIsDir) return [];

    const written = new Set(this.datasets.map((d) => path.resolve(path.join(this.root, d.path))));
    const removed: string[] = [];
    const all: Array<{ full: string; depth: number }> = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        all.push({ full, depth });
        if (entry.isDirectory()) await walk(full, depth + 1);
      }
    };
    await walk(this.base, 0);
    all.sort((a, b) => b.depth - a.depth);

    for (const { full } of all) {
      const info = await stat(full);
      if (info.isFile()) {
        if (!written.has(path.resolve(full))) {
          removed.push(relPath(this.root, full));
          await rm(full);
        }
      } else if (info.isDirectory()) {
        const remaining = await readdir(full);
        if (remaining.length === 0) await rmdir(full);
      }
    }
    return removed;
  }
}

function relPath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}
