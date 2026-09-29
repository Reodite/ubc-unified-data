import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProducerContext } from "./contracts.ts";
import { createGenericScraper } from "./generic.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { HostRecording } from "./recording.ts";

const host = "ccli.ubc.ca";
const home = `https://${host}/`;
const query = `${home}?post_type=team-member&p=3962`;
const producer: ProducerContext = {
  inputs_sha256: "a".repeat(64),
  runtime: { node: "26", icu: "78", unicode: "17", platform: "linux", arch: "x64" },
};
const directories: string[] = [];
const opened: HostRecording[] = [];
const html = () =>
  new Response("<title>Team member</title><main><p>Public biography.</p></main>", {
    headers: { "content-type": "text/html" },
  });

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live network forbidden");
    }),
  ),
);
afterEach(async () => {
  for (const recording of opened.splice(0)) recording.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
async function fixture(handler = (_url: string) => html(), robots = "User-agent: *\n") {
  await mkdir(DEFAULT_EXTERNAL_ROOT, { recursive: true });
  const directory = await mkdtemp(join(DEFAULT_EXTERNAL_ROOT, "required-query-test-"));
  directories.push(directory);
  const scraper = createGenericScraper(host);
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    String(url) === `${home}robots.txt`
      ? new Response(robots, { headers: { "content-type": "text/plain" } })
      : handler(String(url)),
  );
  const options = {
    hostname: host,
    directory,
    producer,
    acquire: true,
    minimumMs: 1,
    timeoutMs: 1000,
    fetcher,
    documentUrlAllowed: (url: string) => scraper.excludeUrl!(url) === null,
  };
  const recording = await HostRecording.open(options);
  opened.push(recording);
  return { recording, options, directory, fetcher, scraper };
}

describe("real recording callback for required query", () => {
  it("admits before discovery and replays cached HTML without network or saved-state changes", async () => {
    const f = await fixture();
    const observation = await f.recording.readDocument(query);
    expect(observation.snapshot.url).toBe(query);
    expect(f.scraper.extract(observation.snapshot).kind).toBe("document");
    expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${home}robots.txt`, query]);
    const seal = await f.recording.seal();
    f.recording.close();
    const before = await readFile(join(f.directory, "state.sqlite"));
    const noNetwork = vi.fn(async () => {
      throw new Error("Offline replay only");
    });
    const replay = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(replay);
    expect(await replay.verifySeal()).toBe(seal);
    expect(await replay.readDocument(query)).toEqual(observation);
    expect(f.scraper.extract((await replay.readDocument(query)).snapshot).kind).toBe("document");
    replay.close();
    expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(before);
    expect(noNetwork).not.toHaveBeenCalled();
  });
  it.each([
    "?post_type=team-member&p=0",
    "?post_type=team-member&p=3963",
    "?p=3962&post_type=team-member",
    "private/guide.pdf",
  ])("rejects before dispatch: %s", async (path) => {
    const f = await fixture();
    await expect(f.recording.readDocument(home + path)).rejects.toThrow(/Document URL policy/);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("blocks an unreviewed query redirect before target dispatch", async () => {
    const target = `${home}?post_type=team-member&p=3963`;
    const f = await fixture(() => new Response(null, { status: 302, headers: { location: target } }));
    await expect(f.recording.readDocument(query)).rejects.toThrow(/Document URL policy/);
    expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${home}robots.txt`, query]);
  });
  it("retains selector-losing redirect evidence and rejects extraction on acquisition and replay", async () => {
    const f = await fixture((url) =>
      url === query ? new Response(null, { status: 302, headers: { location: "/" } }) : html(),
    );
    const observation = await f.recording.readDocument(query);
    expect(observation.snapshot.redirects).toHaveLength(1);
    expect(() => f.scraper.extract(observation.snapshot)).toThrow(/Required query.*identity/);
    await f.recording.seal();
    f.recording.close();
    const noNetwork = vi.fn(async () => {
      throw new Error("Offline replay only");
    });
    const replay = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(replay);
    const replayed = await replay.readDocument(query);
    expect(() => f.scraper.extract(replayed.snapshot)).toThrow(/Required query.*identity/);
    expect(replayed).toEqual(observation);
    expect(noNetwork).not.toHaveBeenCalled();
  });
  it("rechecks a cached unsupported query with the real document callback", async () => {
    const f = await fixture();
    const other = `${home}?post_type=team-member&p=3963`;
    await f.recording.read(other);
    const calls = f.fetcher.mock.calls.length;
    await expect(f.recording.readDocument(other)).rejects.toThrow(/Document URL policy/);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });
  it.each(["initial", "redirect"])("checks robots before %s dispatch", async (part) => {
    const target = part === "initial" ? "/?post_type=team-member&p=3962" : "/blocked/";
    const f = await fixture(
      () => new Response(null, { status: 302, headers: { location: "/blocked/" } }),
      `User-agent: *\nDisallow: ${target}\n`,
    );
    await expect(f.recording.readDocument(query)).rejects.toThrow(/Robots/i);
    expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual(
      part === "initial" ? [`${home}robots.txt`] : [`${home}robots.txt`, query],
    );
  });
});
