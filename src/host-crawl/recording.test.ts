import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProducerContext } from "./contracts.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { HostRecording } from "./recording.ts";

const producer: ProducerContext = {
  inputs_sha256: "a".repeat(64),
  runtime: {
    node: process.versions.node,
    icu: process.versions.icu!,
    unicode: process.versions.unicode!,
    platform: process.platform,
    arch: process.arch,
  },
};
const origin = "https://example.ubc.ca";
const directories: string[] = [];
const opened: HostRecording[] = [];
afterEach(async (context) => {
  for (const recording of opened.splice(0)) recording.close();
  for (const directory of directories.splice(0)) {
    if (context.task.result?.state === "fail") console.error(`Preserved recording fixture: ${directory}`);
    else await rm(directory, { recursive: true, force: true });
  }
});
async function fixture(
  handler: (url: string) => Response,
  extra: Partial<Parameters<typeof HostRecording.open>[0]> = {},
) {
  await mkdir(DEFAULT_EXTERNAL_ROOT, { recursive: true });
  const directory = await mkdtemp(join(DEFAULT_EXTERNAL_ROOT, "recording-test-"));
  directories.push(directory);
  const fetcher = vi.fn(async (value: string | URL | Request) => {
    const url = String(value);
    if (url === `${origin}/robots.txt`)
      return new Response("User-agent: *\nDisallow: /private\n", { headers: { "content-type": "text/plain" } });
    return handler(url);
  }) as unknown as typeof fetch;
  const options = {
    hostname: "example.ubc.ca",
    directory,
    producer,
    acquire: true,
    minimumMs: 1,
    timeoutMs: 1000,
    ...extra,
    fetcher,
  };
  const recording = await HostRecording.open(options);
  opened.push(recording);
  return { recording, options, directory, fetcher };
}
function html(body = "<p>Original public text.</p>") {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

describe("external immutable request recording", () => {
  it("records once, seals and replays exact observations without network or state mutation", async () => {
    const f = await fixture((url) => {
      if (url !== `${origin}/page`) throw new Error(`Unexpected fixture request ${url}`);
      return html();
    });
    const observation = await f.recording.read(`${origin}/page`);
    expect(await f.recording.read(`${origin}/page`)).toEqual(observation);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const digest = await f.recording.seal();
    await expect(f.recording.read(`${origin}/after-seal`)).rejects.toThrow(/Missing recorded/);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.recording.close();
    const before = await readFile(join(f.directory, "state.sqlite"));
    const noNetwork = vi.fn(async () => {
      throw new Error("Network forbidden");
    });
    const replay = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(replay);
    expect(await replay.verifySeal()).toBe(digest);
    expect(await replay.read(`${origin}/page`)).toEqual(observation);
    await expect(replay.read(`${origin}/missing`)).rejects.toThrow(/Missing recorded/);
    replay.close();
    expect(noNetwork).not.toHaveBeenCalled();
    expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(before);
    await expect(HostRecording.open(f.options)).rejects.toThrow(/Sealed acquisition/);
  });
  it("serializes concurrent logical reads and bootstraps direct robots reads", async () => {
    const f = await fixture(() => html());
    expect((await f.recording.read(`${origin}/robots.txt`)).snapshot.status).toBe(200);
    const [a, b] = await Promise.all([f.recording.read(`${origin}/page`), f.recording.read(`${origin}/page`)]);
    expect(a).toEqual(b);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("respects robots and exact-host redirects before dispatch", async () => {
    const f = await fixture(() => new Response(null, { status: 302, headers: { location: "https://other.ubc.ca/" } }));
    await expect(f.recording.read(`${origin}/private`)).rejects.toThrow(/Robots/);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await expect(f.recording.read(`${origin}/redirect`)).rejects.toThrow(/scope/);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("preserves physical redirects and bounded HTTP retries", async () => {
    let attempts = 0;
    const f = await fixture((url) => {
      if (url === `${origin}/alias`) return new Response(null, { status: 301, headers: { location: "/page" } });
      if (url === `${origin}/page`) {
        if (++attempts === 1) return new Response("temporary", { status: 503, headers: { "retry-after": "0" } });
        return html();
      }
      throw new Error(`Unexpected fixture request ${url}`);
    });
    const result = await f.recording.read(`${origin}/alias`);
    expect(result.snapshot.url).toBe(`${origin}/page`);
    expect(result.snapshot.redirects).toHaveLength(1);
    expect(attempts).toBe(2);
    await f.recording.seal();
  });
  it("reuses a shared terminal redirect across arbitrarily many logical aliases", async () => {
    const f = await fixture((url) => {
      if (url.includes("/alias-")) return new Response(null, { status: 302, headers: { location: "/middle" } });
      if (url.endsWith("/middle")) return new Response(null, { status: 301, headers: { location: "/page" } });
      return html();
    });
    for (let i = 0; i < 4; i++) expect((await f.recording.read(`${origin}/alias-${i}`)).snapshot.status).toBe(200);
    expect(f.recording.observedDestination(`${origin}/alias-0`)).toBe(`${origin}/page`);
    expect(f.recording.observedDestination(`${origin}/unseen`)).toBe(`${origin}/unseen`);
    expect(vi.mocked(f.fetcher).mock.calls.filter(([url]) => String(url).endsWith("/middle"))).toHaveLength(1);
    expect(vi.mocked(f.fetcher).mock.calls.filter(([url]) => String(url).endsWith("/page"))).toHaveLength(1);
  });
  it("reuses proven media exclusion across aliases instead of exhausting its request bound", async () => {
    const f = await fixture((url) =>
      url.includes("/alias-")
        ? new Response(null, { status: 302, headers: { location: "/media" } })
        : new Response("binary fixture", { headers: { "content-type": "image/jpeg" } }),
    );
    for (let i = 0; i < 4; i++)
      await expect(f.recording.read(`${origin}/alias-${i}`)).rejects.toThrow(/Observed non-text media/);
    expect(vi.mocked(f.fetcher).mock.calls.filter(([url]) => String(url).endsWith("/media"))).toHaveLength(1);
  });

  it("records proven media exclusions without reading binary payloads or resampling", async () => {
    let reads = 0;
    let cancelled = false;
    const f = await fixture(
      () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                reads++;
                controller.enqueue(new Uint8Array(4096));
                controller.close();
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "image/jpeg" } },
        ),
    );
    await expect(f.recording.read(`${origin}/attachment`)).rejects.toThrow(/Observed non-text media/);
    await expect(f.recording.read(`${origin}/attachment`)).rejects.toThrow(/Observed non-text media/);
    expect(reads).toBe(0);
    expect(cancelled).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"), { readOnly: true });
    expect(db.prepare("SELECT state,bytes,status FROM attempts WHERE url=?").get(`${origin}/attachment`)).toMatchObject(
      { state: "excluded-media", bytes: 0, status: 200 },
    );
    db.close();
    await f.recording.seal();
  });

  it.each([401, 403, 404])(
    "does not retry or permit API fallback after HTTP %s with an aborted body",
    async (status) => {
      const f = await fixture(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new DOMException("fixture body abort", "AbortError"));
              },
            }),
            { status, headers: { "content-type": "text/html" } },
          ),
      );
      await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/fixture body abort/);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
      expect(f.recording.apiFallbackEligible(`${origin}/page`)).toBe(false);
    },
  );
  it("recognizes recorded HTTP-200 body resets as transport failures without discarding status", async () => {
    const f = await fixture(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated", { cause: new Error("ECONNRESET") }));
            },
          }),
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    );
    await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/terminated/);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    expect(f.recording.apiFallbackEligible(`${origin}/page`)).toBe(true);
    expect(f.recording.apiFallbackEligible(`${origin}/unknown`)).toBe(false);
  });

  it("keeps terminal failures rather than resampling them", async () => {
    const f = await fixture(() => {
      throw new Error("Recorded network failure");
    });
    await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/network failure/);
    const count = vi.mocked(f.fetcher).mock.calls.length;
    await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/Saved request failure/);
    expect(f.fetcher).toHaveBeenCalledTimes(count);
  });
  it.each(["requests", "bytes"])("enforces the %s bound without silently returning partial text", async (kind) => {
    const f = await fixture(
      () => html("x".repeat(100)),
      kind === "requests" ? { maxRequests: 1 } : { maxResponseBytes: 64 },
    );
    await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/budget/);
  });
  it("rejects seed changes and competing writers while attributing code changes to new attempts", async () => {
    const f = await fixture(() => html(), { seedSha256: "b".repeat(64) });
    await expect(HostRecording.open(f.options)).rejects.toThrow(/locked/);
    const original = await f.recording.read(`${origin}/first`);
    f.recording.close();
    await expect(HostRecording.open({ ...f.options, seedSha256: "c".repeat(64) })).rejects.toThrow(/frontier/);
    const next = { ...producer, inputs_sha256: "d".repeat(64) };
    const resumed = await HostRecording.open({ ...f.options, producer: next });
    opened.push(resumed);
    expect(await resumed.read(`${origin}/first`)).toEqual(original);
    await resumed.read(`${origin}/second`);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"), { readOnly: true });
    const contexts = db
      .prepare("SELECT producer FROM attempt_producers ORDER BY attempt_id")
      .all()
      .map((row) => JSON.parse(String(row.producer)).inputs_sha256);
    expect(contexts).toEqual([producer.inputs_sha256, producer.inputs_sha256, next.inputs_sha256]);
    db.close();
  });
  it("archives a prior network failure before an explicit bounded retry", async () => {
    const f = await fixture(() => html());
    f.recording.close();
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.prepare("INSERT INTO attempts(url,started,state,error) VALUES (?,?,'failed','TypeError: fetch failed')").run(
      `${origin}/page`,
      new Date().toISOString(),
    );
    db.prepare("INSERT INTO outcomes(url,error) VALUES (?,'TypeError: fetch failed')").run(`${origin}/page`);
    db.close();
    const resumed = await HostRecording.open(f.options);
    opened.push(resumed);
    resumed.retryNetworkFailure(`${origin}/page`);
    expect((await resumed.read(`${origin}/page`)).snapshot.status).toBe(200);
    const inspect = new DatabaseSync(join(f.directory, "state.sqlite"), { readOnly: true });
    expect(inspect.prepare("SELECT count(*) n FROM outcome_failures").get()!.n).toBe(1);
    expect(inspect.prepare("SELECT count(*) n FROM attempts WHERE state='failed'").get()!.n).toBe(1);
    inspect.close();
    await resumed.seal();
  });
  it("retries transient fetch failures only within three recorded attempts", async () => {
    let n = 0;
    const f = await fixture(() => {
      if (++n < 3) throw new TypeError("fetch failed", { cause: new Error("fixture connection reset") });
      return html();
    });
    expect((await f.recording.read(`${origin}/page`)).snapshot.status).toBe(200);
    expect(n).toBe(3);
  });
  it("rejects corrupted immutable response objects", async () => {
    const f = await fixture(() => html());
    const result = await f.recording.read(`${origin}/page`);
    await f.recording.seal();
    await writeFile(join(f.directory, "objects", `${result.sha256}.json`), "corrupt");
    await expect(f.recording.verifySeal()).rejects.toThrow(/changed/);
  });
  it("preserves uncertain attempts and reserves their possible response bytes on explicit resume", async () => {
    const f = await fixture(() => html());
    f.recording.close();
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.prepare("INSERT INTO attempts(url,started,state) VALUES (?,?,'dispatching')").run(
      `${origin}/uncertain`,
      new Date().toISOString(),
    );
    db.close();
    await expect(HostRecording.open(f.options)).rejects.toThrow(/explicit acquisition resume/);
    const resumed = await HostRecording.open({ ...f.options, resumeInterrupted: true });
    opened.push(resumed);
    const check = new DatabaseSync(join(f.directory, "state.sqlite"), { readOnly: true });
    expect(check.prepare("SELECT state,bytes FROM attempts").get()).toMatchObject({
      state: "uncertain",
      bytes: 8 * 1024 * 1024,
    });
    check.close();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
