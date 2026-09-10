/** Shared plumbing for every collector: HTTP, pagination helpers, and disk output.
 *
 * Byte-for-byte stability of the committed `data/` output is the contract; the
 * writers here reproduce those exact bytes rather than `JSON.stringify`.
 *
 * A number that went through a float transformation writes `1186.0`, a plain
 * integer writes `1186`, and both are plain JS numbers. Wrap such values with
 * `floatValue()` at the point of creation; the writers render those with a
 * trailing `.0` when integral. Everything else stays a plain number and writes
 * like an integer. All arithmetic is IEEE-754 doubles.
 */

import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");

export function utcnow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Byte-order comparison: codepoint order, not collation. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `error.name`, the prefix error messages carry in the manifest. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Exception";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Number and string serialization

export interface FloatValue {
  __float: true;
  value: number;
}
export function floatValue(value: number): FloatValue {
  return { __float: true, value };
}
export function isFloatValue(value: unknown): value is FloatValue {
  return typeof value === "object" && value !== null && (value as { __float?: unknown }).__float === true;
}

/** A non-integral double writes as its shortest round trip, with two-digit
 * exponent padding (`1e-07` rather than `1e-7`). */
function floatRepr(value: number): string {
  return String(value).replace(/e([+-])(\d)$/, "e$10$2");
}

/** Float serialization for the magnitudes in this dataset (0.01-70000, two
 * decimals): integral floats keep `.0`, the rest are shortest round trip. */
function floatToJson(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  if (Number.isInteger(value)) return `${value}.0`;
  return floatRepr(value);
}

export function numberToJson(value: number, isFloat = false): string {
  return isFloat ? floatToJson(value) : Object.is(value, -0) ? "-0" : String(value);
}

export function stringToJson(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default:
        // Escapes only the C0 controls; everything else including non-ASCII
        // stays literal.
        if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
        else out += char;
    }
  }
  return `${out}"`;
}

/** Serialize to JSON: `indent` is 2 for pretty, null for compact. Compact
 * separators default to (",", ":"); indented output keeps the ": " key
 * separator. Non-ASCII characters stay literal. */
export function stringifyJson(
  value: unknown,
  indent: number | null = 0,
  separators: [string, string] = [",", ":"],
): string {
  return serialize(value, indent ?? 0, separators, 0);
}

/** Serialize a list with one compact item per line, the shape large tables
 *  want: readable and diff-able without the byte bloat of a key per line. */
export function stringifyJsonItems(value: unknown[]): string {
  if (value.length === 0) return "[]";
  const body = value.map((item) => serialize(item, 0, [",", ":"], 1));
  return `[\n${body.map((item) => `  ${item}`).join(",\n")}\n]`;
}

function serialize(value: unknown, indent: number, separators: [string, string], level: number): string {
  if (isFloatValue(value)) return floatToJson(value.value);
  if (typeof value === "number") return numberToJson(value);
  if (typeof value === "string") return stringToJson(value);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const body = value.map((item) => serialize(item, indent, separators, level + 1));
    if (indent) {
      const pad = " ".repeat((level + 1) * indent);
      const inner = body.map((item) => `${pad}${item}`).join(",\n");
      return `[\n${inner}\n${" ".repeat(level * indent)}]`;
    }
    return `[${body.join(separators[0])}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) return "{}";
    // Default separators give ": " between keys and values; compact mode
    // overrides both.
    const keySep = indent ? ": " : separators[1];
    const body = keys.map(
      (key) => `${stringToJson(key)}${keySep}${serialize(record[key], indent, separators, level + 1)}`,
    );
    if (indent) {
      const pad = " ".repeat((level + 1) * indent);
      const inner = body.map((item) => `${pad}${item}`).join(",\n");
      return `{\n${inner}\n${" ".repeat(level * indent)}}`;
    }
    return `{${body.join(separators[0])}}`;
  }
  return "null";
}

/** Serialize non-primitive CSV cells as compact JSON. Primitives and float
 * values pass through unchanged so `cellText` formats them. */
export function csvScalar(value: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    isFloatValue(value)
  ) {
    return value;
  }
  return stringifyJson(value, 0, [", ", ": "]);
}

// CSV: minimal quoting, empty-line terminator, CRLF rows

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (isFloatValue(value)) return floatToJson(value.value);
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (isFloatValue(value)) return floatToJson(value.value);
  return String(value);
}

/** Minimal quoting: quote the cell only when it contains a comma, a quote, or
 * \r/\n -- with the quirk that a lone empty cell in a single-column row is
 * written `""`. Embedded quotes are doubled. */
function csvField(value: unknown, singleColumn: boolean): string {
  const text = cellText(value);
  const quote =
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\r") ||
    text.includes("\n") ||
    (singleColumn && text === "");
  if (!quote) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/** One CSV document: header row then data rows, CRLF terminated. `columns`
 * overrides the header row. */
export function stringifyCsv(rows: Array<Record<string, unknown>>, options: { columns?: string[] } = {}): string {
  const cells =
    options.columns ??
    (() => {
      const seen: string[] = [];
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          if (!seen.includes(key)) seen.push(key);
        }
      }
      return seen;
    })();
  const single = cells.length === 1;
  const lines = [cells.map((c) => csvField(c, single)).join(",")];
  for (const row of rows) {
    lines.push(cells.map((c) => csvField(csvScalar(row[c]), single)).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

// Exceptions. Their `name` strings are part of the committed output contract
// and must not change; the `HTTPError`/`ConnectionError` labels appear verbatim
// in `data/people/_sites`, so those classes keep their names exactly.

/** "403 Client Error: Forbidden for url: ..." */
export class HTTPError extends Error {
  override name = "HTTPError";
}
export class ConnectionError extends Error {
  override name = "ConnectionError";
}
export class RequestTimeoutError extends Error {
  override name = "RequestTimeoutError";
}
export class ResourceNotFoundError extends Error {
  override name = "ResourceNotFoundError";
}
export class InvalidValueError extends Error {
  override name = "InvalidValueError";
}
export class MissingKeyError extends Error {
  override name = "MissingKeyError";
}

export function throwForStatus(status: number, url: string): never {
  const reason = REASON[status] ?? "Client Error";
  if (status >= 500) throw new HTTPError(`${status} Server Error: ${REASON[status] ?? "Server Error"} for url: ${url}`);
  throw new HTTPError(`${status} Client Error: ${status === 404 ? "Not Found" : reason} for url: ${url}`);
}

const REASON: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

// Campus selection

export const CAMPUS_CHOICES = ["vancouver", "okanagan", "both"] as const;
export type Campus = (typeof CAMPUS_CHOICES)[number];

let _selected: Campus = "vancouver";

export function setCampus(value: string): void {
  if (!(CAMPUS_CHOICES as readonly string[]).includes(value)) {
    const shown = CAMPUS_CHOICES.map((c) => `'${c}'`).join(", ");
    throw new InvalidValueError(`campus must be one of ${shown}, got '${value}'`);
  }
  _selected = value as Campus;
}

export function selectedCampus(): Campus {
  return _selected;
}

/** True if data belonging to `campus` should be collected. `null` means the
 * record carries no campus marker, which is always kept -- dropping unlabelled
 * rows would silently lose data on a naming change. */
export function wants(campus: string | null | undefined): boolean {
  if (campus === null || campus === undefined || _selected === "both") return true;
  return campus === _selected;
}

// Output

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

  /** Record what a dataset means, so the manifest can say so. Call with the
   * same stem passed to `table()`; both the .json and .csv pick the doc up. */
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
    // Docs are registered per table stem; both `x.json` and `x.csv` are the
    // same table, so strip the suffix and the folder prefix to look it up.
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

  /** Delete files in this folder that the current run did not write. Always
   * called only after a collector succeeds, so a failed run never deletes the
   * previous good data. Deepest-first so directories prune after their files. */
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

// HTTP

export const USER_AGENT = "ubc-data/1.0 (public UBC institutional open-data mirror)";
export const PRETTY_LIMIT = 2000;

// Statuses that warrant a retry; everything else passes through immediately.
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface ResponseLike {
  status: number;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpRetryOptions {
  timeout?: number;
  retries?: number;
  minInterval?: number;
  workers?: number;
  /** Called from `map()` as each item completes. */
  onProgress?: (done: number, total: number) => void;
}

export class Http {
  timeout: number;
  retries: number;
  minInterval: number;
  workers: number;
  onProgress?: (done: number, total: number) => void;

  /** Replaceable for tests: the closure receives (method, url, body) and must
   * return a ResponseLike or undefined to fall through to real fetch. */
  responder?: (
    method: string,
    url: string,
    body?: string | null,
  ) => Promise<ResponseLike | undefined> | ResponseLike | undefined;
  nowFn: () => number = () => Date.now();

  private nextSlot = 0;
  private throttleTail: Promise<void> = Promise.resolve();

  constructor(opts: HttpRetryOptions = {}) {
    this.timeout = opts.timeout ?? 60;
    this.retries = opts.retries ?? 4;
    this.minInterval = opts.minInterval ?? 0;
    this.workers = Math.max(1, opts.workers ?? 8);
    this.onProgress = opts.onProgress;
  }

  private async _throttle(): Promise<void> {
    if (this.minInterval <= 0) return;
    // Serialise slot reservation across concurrent calls (`map`).
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const previous = this.throttleTail;
    this.throttleTail = gate;
    await previous;
    const now = this.nowFn();
    const wait = this.nextSlot - now;
    if (wait > 0) await this.sleep(wait);
    this.nextSlot = this.nowFn() + this.minInterval;
    release!();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request(
    method: string,
    url: string,
    init: { body?: string | null; headers?: Record<string, string> } = {},
  ): Promise<ResponseLike> {
    await this._throttle();

    const agents = [...(init.headers ? Object.entries(init.headers) : [])];
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, ...Object.fromEntries(agents) };
    const body = init.body ?? null;

    for (let attempt = 0; ; attempt++) {
      let response: ResponseLike;
      try {
        const replayed = await this.responder?.(method, url, body);
        if (replayed) {
          response = replayed;
        } else {
          response = await fetch(url, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(this.timeout * 1000),
            redirect: "follow",
          });
        }
      } catch (error) {
        // Retry network errors on GET/POST only.
        if (attempt < this.retries && (method === "GET" || method === "POST")) {
          await this.sleep(this.backoff(attempt + 1));
          continue;
        }
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new RequestTimeoutError("(read timeout)");
        }
        throw new ConnectionError(messageOf(error));
      }

      if (response.status >= 200 && response.status < 300) return response;
      if (!RETRY_STATUSES.has(response.status) || (method !== "GET" && method !== "POST")) {
        throwForStatus(response.status, url);
      }
      if (attempt >= this.retries) {
        throwForStatus(response.status, url);
      }
      const retryAfter = readRetryAfter(response.headers.get("retry-after"));
      const delay = retryAfter ?? this.backoff(attempt + 1);
      await this.sleep(delay);
    }
  }

  /** Exponential backoff: factor * 2 ** (retry - 1), capped at 120 seconds. */
  private backoff(retry: number): number {
    const value = 1.0 * 2 ** (retry - 1);
    return Math.min(value * 1000, 120 * 1000);
  }

  async get(url: string, opts: { params?: Params } = {}): Promise<ResponseLike> {
    return this.request("GET", withParams(url, opts.params));
  }

  async getText(url: string, opts: { params?: Params } = {}): Promise<string> {
    return (await this.request("GET", withParams(url, opts.params))).text();
  }

  async getJson(url: string, opts: { params?: Params } = {}): Promise<unknown> {
    const response = await this.request("GET", withParams(url, opts.params));
    return response.json();
  }

  async getBytes(url: string, opts: { params?: Params } = {}): Promise<Uint8Array> {
    const response = await this.request("GET", withParams(url, opts.params));
    return new Uint8Array(await response.arrayBuffer());
  }

  /** POST with a form-encoded body. Omits null and undefined values. */
  async postJson(
    url: string,
    data: Record<string, unknown>,
    opts: { headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null) continue;
      search.append(key, String(value));
    }
    const response = await this.request("POST", url, {
      body: search.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...opts.headers },
    });
    return response.json();
  }

  /** POST a public form-encoded request and return its HTML/text response. */
  async postText(url: string, data: Record<string, unknown>): Promise<string> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) search.append(key, String(value));
    }
    const response = await this.request("POST", url, {
      body: search.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return response.text();
  }

  /** Run `fn` over `items` in a pool of `workers`, preserving input order. */
  async map<A, B>(fn: (item: A) => Promise<B>, items: readonly A[], workers?: number): Promise<B[]> {
    const list = [...items];
    if (list.length === 0) return [];
    const limit = Math.max(1, Math.min(workers ?? this.workers, list.length));
    const out = new Array<B>(list.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= list.length) return;
        try {
          out[index] = await fn(list[index]!);
        } finally {
          // Report as soon as the slot frees even if the item failed: the
          // caller waits on the result, seeing less than `done` is the
          // misleading state, not seeing the failure.
          this.onProgress?.(index + 1, list.length);
        }
      }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return out;
  }
}

export type Params = Record<string, string | number | boolean | undefined>;

function withParams(url: string, params?: Params): string {
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.append(key, String(value));
  }
  const suffix = search.toString();
  if (!suffix) return url;
  return url.includes("?") ? `${url}&${suffix}` : `${url}?${suffix}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Retry-After as a whole number of seconds, or undefined when absent or
 * not a positive integer. */
function readRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && Number.isInteger(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}

// Collector registry

/** One logical group of UBC data. Collectors implement this shape and register
 * themselves with `register()`. */
export interface CollectorDescriptor {
  name: string;
  folder: string;
  title: string;
  description: string;
  sources: readonly string[];
  collect(http: Http, out: Output): Promise<void>;
}

export type CollectorClass = new () => CollectorDescriptor;

export const REGISTRY: Record<string, CollectorClass> = {};

export function register<T extends CollectorClass>(cls: T): T {
  const instance = new cls();
  if (!instance.name) throw new InvalidValueError(`${cls.name} needs a name`);
  REGISTRY[instance.name] = cls;
  return cls;
}

// Drupal JSON:API

/** Editorial/revision noise that adds bulk without telling a student anything.
 * `path` is dropped but not lost: its alias is promoted to a column of its own. */
export const JSONAPI_DROP = new Set([
  "metatag",
  "path",
  "promote",
  "sticky",
  "default_langcode",
  "revision_translation_affected",
  "revision_timestamp",
  "vid",
  "publish_on",
  "unpublish_on",
  "langcode",
]);

export function simplifyJsonapi(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: record["id"], type: record["type"] };
  const attrs = (record["attributes"] ?? {}) as Record<string, unknown>;
  for (const [rawKey, value] of Object.entries(attrs)) {
    const key = rawKey.startsWith("drupal_internal__") ? rawKey.slice("drupal_internal__".length) : rawKey;
    if (key === "path") {
      const alias = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["alias"] : null;
      if (alias) out["alias"] = alias;
      continue;
    }
    if (JSONAPI_DROP.has(key)) continue;
    out[key] = value;
  }

  const related: Record<string, unknown> = {};
  const relationships = (record["relationships"] ?? {}) as Record<string, unknown>;
  for (const [rawKey, value] of Object.entries(relationships)) {
    const data = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["data"] : null;
    if (data === null || data === undefined) continue;
    const key = rawKey.startsWith("field_") ? rawKey.slice("field_".length) : rawKey;
    if (Array.isArray(data)) {
      related[key] = data
        .filter((item) => typeof item === "object" && item !== null)
        .map((item) => (item as Record<string, unknown>)["id"]);
    } else if (typeof data === "object") {
      related[key] = (data as Record<string, unknown>)["id"];
    }
  }
  if (Object.keys(related).length > 0) out["related"] = related;
  return out;
}

/** Resource types a Drupal site exposes, e.g. `node--course`. */
export async function jsonapiIndex(http: Http, host: string): Promise<Set<string>> {
  const payload = (await http.getJson(`https://${host}/jsonapi`)) as Record<string, unknown>;
  const links = (payload["links"] ?? {}) as Record<string, unknown>;
  return new Set(Object.keys(links).filter((key) => key.includes("--")));
}

/** Fetch every record of a Drupal JSON:API collection.
 *
 * Drupal caps `page[limit]` at 50. When the server reports a total we fan the
 * offsets out across the pool; otherwise we walk `links.next` page by page. */
export async function jsonapiCollection(
  http: Http,
  host: string,
  resource: string,
  opts: { params?: Params; workers?: number; pageSize?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const url = `https://${host}/jsonapi/${resource}`;
  const base: Params = { ...(opts.params ?? {}), "page[limit]": opts.pageSize ?? 50 };

  const first = (await http.getJson(url, { params: { ...base, "page[offset]": 0 } })) as AnyJson;
  const records = ((first["data"] as unknown[]) ?? []).map((item) => simplifyJsonapi(item as Record<string, unknown>));
  const total = (first["meta"] as Record<string, unknown> | undefined)?.["count"];

  if (typeof total === "number" && Number.isInteger(total) && (total as number) > records.length) {
    const fetch = async (offset: number): Promise<Array<Record<string, unknown>>> => {
      const payload = (await http.getJson(url, { params: { ...base, "page[offset]": offset } })) as AnyJson;
      return ((payload["data"] as unknown[]) ?? []).map((item) => simplifyJsonapi(item as Record<string, unknown>));
    };
    const offsets = [];
    for (let offset = opts.pageSize ?? 50; offset < (total as number); offset += opts.pageSize ?? 50)
      offsets.push(offset);
    for (const chunk of await http.map(fetch, offsets, opts.workers)) records.push(...chunk);
    return records;
  }

  let nextLink: string | undefined = (
    (first["links"] as Record<string, unknown> | undefined)?.["next"] as Record<string, unknown> | undefined
  )?.["href"] as string | undefined;
  while (nextLink) {
    const payload = (await http.getJson(nextLink)) as AnyJson;
    const batch = (payload["data"] as unknown[]) ?? [];
    if (batch.length === 0) break;
    records.push(...batch.map((item) => simplifyJsonapi(item as Record<string, unknown>)));
    nextLink = (
      (payload["links"] as Record<string, unknown> | undefined)?.["next"] as Record<string, unknown> | undefined
    )?.["href"] as string | undefined;
  }
  return records;
}

type AnyJson = Record<string, unknown>;

// WordPress REST

/** Read one `var <name> = [...]/{...}` literal out of a page. */
export function jsLiteral(html: string, name: string): unknown {
  const pattern = new RegExp(`\\bvar\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*`);
  const match = pattern.exec(html);
  if (!match) throw new MissingKeyError(name);

  let start = match.index + match[0].length;
  while (start < html.length && /\s/.test(html[start]!)) start += 1;
  const opener = html[start]!;
  const closer: string | undefined = { "[": "]", "{": "}" }[opener];
  if (!closer) throw new InvalidValueError(`${name} is not an array or object literal`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = "";

  for (let index = start; index < html.length; index += 1) {
    const char = html[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
    } else if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(html.slice(start, index + 1));
      }
    }
  }
  throw new InvalidValueError(`unterminated literal for ${name}`);
}

/** Fetch every page of a WP REST collection using X-WP-TotalPages. */
export async function wpCollection(
  http: Http,
  host: string,
  pathName: string,
  opts: { params?: Params; perPage?: number; workers?: number } = {},
): Promise<unknown[]> {
  const url = `https://${host}/wp-json/${pathName}`;
  const base: Params = { ...(opts.params ?? {}), per_page: opts.perPage ?? 100 };

  const first = await http.get(url, { params: { ...base, page: 1 } });
  const records = (await first.json()) as unknown[];
  const pages = Number(first.headers.get("X-WP-TotalPages") || 1);

  if (pages > 1) {
    const fetch = async (page: number): Promise<unknown[]> => {
      return (await http.getJson(url, { params: { ...base, page } })) as unknown[];
    };
    const rest = [];
    for (let page = 2; page <= pages; page += 1) rest.push(page);
    for (const chunk of await http.map(fetch, rest, opts.workers)) records.push(...chunk);
  }
  return records;
}
