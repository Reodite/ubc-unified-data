import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProseClient, publicUbcUrl } from "./client.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function clock() {
  let milliseconds = 0;
  return {
    now: () => milliseconds,
    sleep: async (delay: number) => {
      milliseconds += delay;
    },
  };
}

function fetcher(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input) => handler(String(input))) as typeof fetch;
}

describe("public UBC prose requests", () => {
  it.each([
    "http://science.ubc.ca/students",
    "https://evil.example/students",
    "https://ubc.ca.evil.example/",
    "https://name:secret@science.ubc.ca/",
    "https://science.ubc.ca:8443/",
    "https://science.ubc.ca/wp-admin/",
    "https://science.ubc.ca/wp%2dadmin/",
    "https://authentication.ubc.ca/login",
    "https://science.ubc.ca/login_required?destination=private",
    "https://science.ubc.ca/user/1",
  ])("rejects non-public endpoint %s", (url) => {
    expect(() => publicUbcUrl(url)).toThrow();
  });

  it("retains ordinary public instructions about accounts", () => {
    expect(publicUbcUrl("/students/how-to-log-in#steps", "https://science.ubc.ca")).toBe(
      "https://science.ubc.ca/students/how-to-log-in",
    );
  });

  it("throttles concurrent page requests from the robots request start", async () => {
    const time = clock();
    const calls: Array<{ url: string; time: number }> = [];
    const client = new ProseClient({
      ...time,
      minInterval: 0,
      fetcher: fetcher((url) => {
        calls.push({ url, time: time.now() });
        return new Response(url.endsWith("robots.txt") ? "User-agent: *\nCrawl-delay: 10\n" : "article");
      }),
    });
    await Promise.all([client.get("https://science.ubc.ca/a"), client.get("https://science.ubc.ca/b")]);
    expect(calls.map((call) => call.time)).toEqual([0, 10000, 20000]);
  });

  it("does not request a robots-disallowed page", async () => {
    const calls: string[] = [];
    const client = new ProseClient({
      minInterval: 0,
      fetcher: fetcher((url) => {
        calls.push(url);
        return new Response("User-agent: *\nDisallow: /restricted/\n");
      }),
    });
    await expect(client.get("https://science.ubc.ca/restricted/guide")).rejects.toThrow("Disallowed by robots");
    expect(calls).toEqual(["https://science.ubc.ca/robots.txt"]);
  });

  it("rejects redirects to authentication without contacting that host", async () => {
    const calls: string[] = [];
    const client = new ProseClient({
      minInterval: 0,
      fetcher: fetcher((url) => {
        calls.push(url);
        return url.endsWith("robots.txt")
          ? new Response("")
          : new Response(null, { status: 302, headers: { location: "https://authentication.ubc.ca/login" } });
      }),
    });
    await expect(client.get("https://science.ubc.ca/guide")).rejects.toThrow("Not a public UBC");
    expect(calls).toHaveLength(2);
  });

  it("honors crawl delay on retries even when Retry-After is shorter", async () => {
    const time = clock();
    const starts: number[] = [];
    const client = new ProseClient({
      ...time,
      minInterval: 0,
      retries: 1,
      fetcher: fetcher((url) => {
        if (url.endsWith("robots.txt")) return new Response("User-agent: *\nCrawl-delay: 10\n");
        starts.push(time.now());
        return starts.length === 1
          ? new Response(null, { status: 503, headers: { "retry-after": "1" } })
          : new Response("article");
      }),
    });
    expect((await client.get("https://science.ubc.ca/guide")).body).toBe("article");
    expect(starts).toEqual([10000, 20000]);
  });

  it("keeps the original retrieval timestamp when resuming from private cache", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "prose-cache-"));
    temporary.push(directory);
    const first = new ProseClient({
      cacheDir: directory,
      minInterval: 0,
      now: () => 1000,
      fetcher: fetcher(() => new Response("article")),
    });
    const response = await first.get("https://science.ubc.ca/guide");
    let network = 0;
    const second = new ProseClient({
      cacheDir: directory,
      minInterval: 0,
      now: () => 5000,
      fetcher: fetcher(() => {
        network++;
        throw new Error("No network expected");
      }),
    });
    const resumed = await second.get("https://science.ubc.ca/guide");
    expect(resumed.retrieved_at).toBe(response.retrieved_at);
    expect(network).toBe(0);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const files = await readdir(directory);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect((await stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
  });

  it("does not download a binary destination reached through a redirect", async () => {
    const requested: string[] = [];
    const client = new ProseClient({
      minInterval: 0,
      fetcher: fetcher((url) => {
        requested.push(url);
        return url.endsWith("robots.txt")
          ? new Response("")
          : new Response(null, { status: 302, headers: { location: "/uploads/diagram.jpeg" } });
      }),
    });
    await expect(client.get("https://science.ubc.ca/guide")).rejects.toMatchObject({ kind: "nonarticle" });
    expect(requested).not.toContain("https://science.ubc.ca/uploads/diagram.jpeg");
  });

  it("does not contact a host excluded from the run", async () => {
    const client = new ProseClient({
      blockedHosts: ["science.ubc.ca"],
      fetcher: fetcher(() => {
        throw new Error("No request allowed");
      }),
    });
    await expect(client.get("https://science.ubc.ca/guide")).rejects.toThrow("excluded from this run");
  });

  it("reports a bounded response failure instead of truncating prose", async () => {
    const client = new ProseClient({
      minInterval: 0,
      maxBytes: 5,
      fetcher: fetcher((url) => new Response(url.endsWith("robots.txt") ? "" : "too much prose")),
    });
    await expect(client.get("https://science.ubc.ca/guide")).rejects.toThrow("explicit 5-byte limit");
  });
});
