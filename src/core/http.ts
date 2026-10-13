import { RETRYABLE_HTTP_STATUSES } from "./response.ts";

/** `error.name`, the prefix error messages carry in the manifest. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Exception";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Error names are serialized verbatim in manifests and must remain stable.
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

export const USER_AGENT = "ubc-data/1.0 (public UBC institutional open-data mirror)";

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

  /** Test hook returning a response, or undefined to use real fetch. */
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
        throw new ConnectionError(errorMessage(error));
      }

      if (response.status >= 200 && response.status < 300) return response;
      if (!RETRYABLE_HTTP_STATUSES.has(response.status) || (method !== "GET" && method !== "POST")) {
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
          // Report the released slot even on failure; Promise.all carries the error.
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

/** Parse non-negative integer Retry-After seconds as milliseconds. */
function readRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && Number.isInteger(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}
