import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { USER_AGENT } from "../base.ts";

interface RobotsRules {
  isDisallowed(url: string, agent: string): boolean | undefined;
  getCrawlDelay(agent: string): number | undefined;
  getSitemaps(): string[];
}

const robotsParser = createRequire(import.meta.url)("robots-parser") as (url: string, text: string) => RobotsRules;

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const PRIVATE_PATH =
  /^\/(?:wp-admin|wp-login\.php|admin|user|login|login_required|signin|logout|saml|idp|auth|Shibboleth\.sso)(?:\/|$)/i;
const PRIVATE_HOST = /^(?:authentication|shib|idp|cwl|sso|accounts|shibboleth)\./i;
const CACHE_HEADERS = ["content-type", "last-modified", "etag", "link", "x-wp-total", "x-wp-totalpages"];
const BINARY_PATH = /\.(?:pdf|docx?|xlsx?|pptx?|zip|gz|png|jpe?g|gif|webp|svg|ico|mp[34]|mov|avi|woff2?|ttf)$/i;

function nonArticleResponse(url: string, type = ""): boolean {
  return (
    BINARY_PATH.test(new URL(url).pathname) ||
    /^(?:image\/|audio\/|video\/|font\/|application\/(?:pdf|zip|octet-stream|vnd\.ms-|vnd\.openxmlformats-))/i.test(
      type,
    )
  );
}

export interface ProseResponse {
  url: string;
  requested_url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  retrieved_at: string;
}

export class ProseFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null = null,
    readonly kind: "http" | "access" | "network" | "invalid" | "nonarticle" = "http",
  ) {
    super(message);
    this.name = "ProseFetchError";
  }
}

export function fetchDisposition(error: ProseFetchError): "excluded" | "unavailable" | "failed" {
  if (error.kind === "nonarticle") return "excluded";
  if (error.kind === "access" || error.kind === "network" || (error.kind === "http" && error.status !== null))
    return "unavailable";
  return "failed";
}

interface Policy {
  robots: ReturnType<typeof robotsParser>;
  minimum: number;
}

/** Accept public UBC HTTPS endpoints, excluding authentication and administration paths. */
export function publicUbcUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "ubc.ca" && !url.hostname.endsWith(".ubc.ca")) ||
    url.username ||
    url.password ||
    url.port ||
    PRIVATE_HOST.test(url.hostname) ||
    PRIVATE_PATH.test(decodeURIComponent(url.pathname))
  ) {
    throw new ProseFetchError(`Not a public UBC content endpoint: ${url.href}`, url.href, null, "access");
  }
  url.hash = "";
  return url.href;
}

/** Cache source responses with their original retrieval times and throttle each origin, including redirects/retries. */
export class ProseClient {
  private policies = new Map<string, Promise<Policy>>();
  private tails = new Map<string, Promise<void>>();
  private lastStart = new Map<string, number>();
  private requests = new Map<string, Promise<ProseResponse>>();
  readonly journal: Array<{ url: string; status: number | null; retrieved_at: string; cached: boolean }> = [];

  constructor(
    readonly options: {
      cacheDir?: string;
      refresh?: boolean;
      minInterval?: number;
      timeout?: number;
      retries?: number;
      cacheMaxAge?: number;
      maxBytes?: number;
      blockedHosts?: string[];
      fetcher?: typeof fetch;
      now?: () => number;
      sleep?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async sleep(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;
    if (this.options.sleep) await this.options.sleep(milliseconds);
    else await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private async startRequest(origin: string, minimum: number, send: () => Promise<Response>): Promise<Response> {
    const previous = this.tails.get(origin) ?? Promise.resolve();
    let release!: () => void;
    this.tails.set(
      origin,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await previous;
    try {
      const last = this.lastStart.get(origin);
      if (last !== undefined) await this.sleep(last + minimum - this.now());
      this.lastStart.set(origin, this.now());
      return send();
    } finally {
      release();
    }
  }

  async policy(origin: string): Promise<Policy> {
    const normalized = new URL(publicUbcUrl(origin)).origin;
    let promise = this.policies.get(normalized);
    if (!promise) {
      promise = (async () => {
        let text = "";
        try {
          text = (await this.request(`${normalized}/robots.txt`, false)).body;
        } catch (error) {
          if (!(error instanceof ProseFetchError) || ![404, 410].includes(error.status ?? 0)) throw error;
        }
        const robots = robotsParser(`${normalized}/robots.txt`, text);
        const delay = robots.getCrawlDelay("ubc-data") ?? 0;
        return { robots, minimum: Math.max(this.options.minInterval ?? 500, delay * 1000) };
      })();
      this.policies.set(normalized, promise);
    }
    return promise;
  }

  async get(value: string): Promise<ProseResponse> {
    const url = publicUbcUrl(value);
    let pending = this.requests.get(url);
    if (!pending) {
      pending = this.request(url, true);
      this.requests.set(url, pending);
    }
    return pending;
  }

  async json<T = unknown>(url: string): Promise<{ response: ProseResponse; data: T }> {
    const response = await this.get(url);
    try {
      return { response, data: JSON.parse(response.body) as T };
    } catch {
      throw new ProseFetchError(`Expected JSON: ${url}`, url, response.status, "invalid");
    }
  }

  private async cached(url: string): Promise<ProseResponse | null> {
    if (!this.options.cacheDir || this.options.refresh) return null;
    try {
      const data = JSON.parse(await readFile(this.cachePath(url), "utf8")) as ProseResponse;
      const age = this.now() - Date.parse(data.retrieved_at);
      if (
        data.requested_url !== url ||
        data.status !== 200 ||
        typeof data.body !== "string" ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > (this.options.cacheMaxAge ?? 86_400_000)
      )
        return null;
      if (typeof data.url !== "string") return null;
      return data;
    } catch {
      return null;
    }
  }

  private cachePath(url: string): string {
    return path.join(this.options.cacheDir!, `${createHash("sha256").update(url).digest("hex")}.json`);
  }

  private async request(initial: string, enforceRobots: boolean): Promise<ProseResponse> {
    let url = initial;
    const visited = new Set<string>();
    for (;;) {
      publicUbcUrl(url);
      if (this.options.blockedHosts?.includes(new URL(url).hostname))
        throw new ProseFetchError(`Source host excluded from this run: ${url}`, url, null, "access");
      if (nonArticleResponse(url))
        throw new ProseFetchError(`Linked binary resource, not an HTML prose article: ${url}`, url, null, "nonarticle");
      if (visited.has(url) || visited.size >= 10)
        throw new ProseFetchError(`Repeated or excessive redirects: ${initial}`, url, null, "invalid");
      visited.add(url);
      const origin = new URL(url).origin;
      const policy = enforceRobots ? await this.policy(origin) : null;
      if (policy?.robots.isDisallowed(url, "ubc-data"))
        throw new ProseFetchError(`Disallowed by robots.txt: ${url}`, url, null, "access");
      const cache = await this.cached(url);
      if (cache) {
        publicUbcUrl(cache.url);
        if (this.options.blockedHosts?.includes(new URL(cache.url).hostname))
          throw new ProseFetchError(
            `Cached redirect host is excluded from this run: ${cache.url}`,
            cache.url,
            null,
            "access",
          );
        if (nonArticleResponse(cache.url, cache.headers["content-type"]))
          throw new ProseFetchError(
            `Cached destination is a binary resource, not prose: ${cache.url}`,
            cache.url,
            null,
            "nonarticle",
          );
        if (cache.url !== url) {
          const finalPolicy = enforceRobots ? await this.policy(new URL(cache.url).origin) : null;
          if (finalPolicy?.robots.isDisallowed(cache.url, "ubc-data"))
            throw new ProseFetchError(`Cached redirect is now disallowed: ${cache.url}`, cache.url, null, "access");
        }
        this.journal.push({ url, status: cache.status, retrieved_at: cache.retrieved_at, cached: true });
        return { ...cache, requested_url: initial };
      }
      let response: Response | undefined;
      for (let attempt = 0; attempt <= (this.options.retries ?? 2); attempt++) {
        try {
          response = await this.startRequest(origin, policy?.minimum ?? this.options.minInterval ?? 500, () =>
            (this.options.fetcher ?? fetch)(url, {
              headers: { "User-Agent": USER_AGENT },
              redirect: "manual",
              signal: AbortSignal.timeout(this.options.timeout ?? 30_000),
            }),
          );
        } catch (error) {
          this.journal.push({ url, status: null, retrieved_at: new Date(this.now()).toISOString(), cached: false });
          if (attempt >= (this.options.retries ?? 2))
            throw new ProseFetchError(
              error instanceof Error
                ? `${error.message}${error.cause ? `: ${String(error.cause)}` : ""}`
                : String(error),
              url,
              null,
              "network",
            );
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        this.journal.push({
          url,
          status: response.status,
          retrieved_at: new Date(this.now()).toISOString(),
          cached: false,
        });
        if (!RETRY_STATUSES.has(response.status) || attempt >= (this.options.retries ?? 2)) break;
        const header = response.headers.get("retry-after");
        const numeric = header === null ? NaN : Number(header);
        const delay = Number.isFinite(numeric) ? numeric * 1000 : header ? Date.parse(header) - this.now() : NaN;
        await response.body?.cancel();
        await this.sleep(Number.isFinite(delay) ? Math.max(0, delay) : 1000 * 2 ** attempt);
      }
      if (!response) throw new ProseFetchError(`No response: ${url}`, url, null, "network");
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new ProseFetchError(`Redirect without Location: ${url}`, url, response.status, "invalid");
        url = publicUbcUrl(location, url);
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new ProseFetchError(`HTTP ${response.status}: ${url}`, url, response.status);
      }
      if (nonArticleResponse(url, response.headers.get("content-type") ?? "")) {
        await response.body?.cancel();
        throw new ProseFetchError(`Non-HTML binary response: ${url}`, url, 200, "nonarticle");
      }
      const maximum = this.options.maxBytes ?? 25_000_000;
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > maximum) {
            await reader.cancel();
            throw new ProseFetchError(`Response exceeds explicit ${maximum}-byte limit: ${url}`, url, 200, "invalid");
          }
          chunks.push(chunk.value);
        }
      }
      const result: ProseResponse = {
        url,
        requested_url: initial,
        status: 200,
        headers: Object.fromEntries(
          CACHE_HEADERS.flatMap((key) => {
            const value = response!.headers.get(key);
            return value === null ? [] : [[key, value]];
          }),
        ),
        body: Buffer.concat(chunks).toString("utf8"),
        retrieved_at: new Date(this.now()).toISOString(),
      };
      if (this.options.cacheDir) {
        await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 });
        await writeFile(this.cachePath(initial), JSON.stringify(result), { mode: 0o600 });
        if (url !== initial) {
          await writeFile(this.cachePath(url), JSON.stringify({ ...result, requested_url: url }), { mode: 0o600 });
        }
      }
      return result;
    }
  }
}
