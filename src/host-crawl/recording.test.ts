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
  handler: (url: string) => Response | Promise<Response>,
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
    fetcher: extra.fetcher ?? fetcher,
  };
  const recording = await HostRecording.open(options);
  opened.push(recording);
  return { recording, options, directory, fetcher: options.fetcher };
}
function html(body = "<p>Original public text.</p>") {
  return new Response(body, { headers: { "content-type": "text/html" } });
}
function recordingState(directory: string) {
  const db = new DatabaseSync(join(directory, "state.sqlite"), { readOnly: true });
  try {
    return {
      config: db.prepare("SELECT * FROM config").all(),
      attempts: db.prepare("SELECT * FROM attempts ORDER BY id").all(),
      producers: db.prepare("SELECT * FROM attempt_producers ORDER BY attempt_id").all(),
      outcomes: db.prepare("SELECT * FROM outcomes ORDER BY url").all(),
      failures: db.prepare("SELECT * FROM outcome_failures ORDER BY id").all(),
      repairs: db.prepare("SELECT * FROM repair_authorizations ORDER BY url").all(),
      grants: db.prepare("SELECT * FROM acquisition_budget_grants ORDER BY id").all(),
      grantsV2: db.prepare("SELECT * FROM acquisition_budget_grants_v2 ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

describe("external immutable request recording", () => {
  it("rejects document-policy redirects before dispatching the excluded destination", async () => {
    const f = await fixture(
      () => new Response(null, { status: 302, headers: { location: "/sites/default/private/guide.pdf" } }),
      {
        documentUrlAllowed: (url) => !new URL(url).pathname.startsWith("/sites/default/private/"),
      },
    );
    await expect(f.recording.readDocument(`${origin}/guide.pdf`)).rejects.toThrow(/Document URL policy/);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.fetcher).mock.calls.some(([url]) => String(url).includes("/sites/default/private/"))).toBe(
      false,
    );
  });
  it("rechecks cached observations against the current document policy without new requests", async () => {
    const f = await fixture(
      (url) =>
        url === `${origin}/guide`
          ? new Response(null, { status: 302, headers: { location: "/sites/default/private/guide" } })
          : html(),
      {
        documentUrlAllowed: (url) => !new URL(url).pathname.startsWith("/sites/default/private/"),
      },
    );
    await f.recording.read(`${origin}/guide`);
    const calls = vi.mocked(f.fetcher).mock.calls.length;
    await expect(f.recording.readDocument(`${origin}/guide`)).rejects.toThrow(/Document URL policy/);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });
  it("requires an explicit policy for a document request", async () => {
    const f = await fixture(() => html());
    await expect(f.recording.readDocument(`${origin}/page`)).rejects.toThrow(/Document URL policy/);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("records declared PDF bodies externally and replays their exact bytes", async () => {
    const raw = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0, 255, 128]), Buffer.from("\n%%EOF\n")]);
    const f = await fixture(() => new Response(raw, { headers: { "content-type": "application/pdf" } }), {
      documentFormats: ["pdf"],
    });
    const observation = await f.recording.read(`${origin}/guide.pdf`);
    expect(observation.snapshot.body).toBe("");
    expect(observation.snapshot.binary?.media_type).toBe("application/pdf");
    expect(await f.recording.readBytes(observation.sha256)).toEqual(raw);
    const seal = await f.recording.seal();
    f.recording.close();
    const noNetwork = vi.fn(async () => {
      throw new Error("No network");
    });
    const replay = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(replay);
    expect(await replay.verifySeal()).toBe(seal);
    expect(await replay.readBytes(observation.sha256)).toEqual(raw);
    expect(noNetwork).not.toHaveBeenCalled();
    await writeFile(
      join(f.directory, "objects", `${observation.snapshot.binary!.sha256}.body`),
      Buffer.alloc(raw.length),
    );
    await expect(replay.verifySeal()).rejects.toThrow(/binary body changed/);
  });
  it("reopens legacy PDF recording bounds unchanged under process-local HTML-only acquisition", async () => {
    const f = await fixture(() => html("<p>Legacy cached article.</p>"), {
      documentFormats: ["pdf"],
      documentUrlAllowed: () => true,
      maxResponseBytes: 32 * 1024 * 1024,
    });
    const article = await f.recording.readDocument(`${origin}/article`);
    f.recording.close();
    const reopened = await HostRecording.open({
      ...f.options,
      acquire: true,
      documentFormats: undefined,
      maxResponseBytes: undefined,
      htmlDocumentsOnly: true,
    });
    opened.push(reopened);
    expect(await reopened.readDocument(`${origin}/article`)).toEqual(article);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"), { readOnly: true });
    const config = JSON.parse(
      String((db.prepare("SELECT value FROM config WHERE id=1").get() as { value: string }).value),
    );
    expect(config).toMatchObject({ documentFormats: ["pdf"], maxResponseBytes: 32 * 1024 * 1024 });
    db.close();
  });

  it("retains empty binary-typed redirects without inventing a binary text body", async () => {
    const raw = Buffer.from("%PDF-1.7\nfixture bytes\n%%EOF");
    const f = await fixture(
      (url) =>
        url.endsWith("/alias")
          ? new Response(null, {
              status: 302,
              headers: { location: "/guide.pdf", "content-type": "application/pdf; charset=binary" },
            })
          : new Response(raw, { headers: { "content-type": "application/pdf" } }),
      { documentFormats: ["pdf"] },
    );
    const result = await f.recording.read(`${origin}/alias`);
    expect(result.snapshot.url).toBe(`${origin}/guide.pdf`);
    expect(result.snapshot.redirects).toHaveLength(1);
    expect(await f.recording.readBytes(result.sha256)).toEqual(raw);
    await f.recording.seal();
  });

  it("does not acquire PDF as supported text without an explicit format declaration", async () => {
    const f = await fixture(() => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }));
    await expect(f.recording.read(`${origin}/guide.pdf`)).rejects.toThrow(/Unsupported recorded document format/);
    await expect(f.recording.read(`${origin}/guide.pdf`)).rejects.toThrow(/Saved request failure/);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
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
  it.each(["https://outside.example/referral", "http://example.ubc.ca/referral"])(
    "classifies a recorded redirect to %s without following it",
    async (destination) => {
      const f = await fixture(
        (url) =>
          new Response(null, {
            status: 302,
            headers: { location: url.endsWith("/alias") ? "/middle" : destination },
          }),
      );
      await expect(f.recording.read(`${origin}/alias`)).rejects.toThrow(/scope|official UBC hostname/);
      const before = f.recording.inputDigest();
      expect(f.recording.observedScopeExclusion(`${origin}/alias`)).toMatch(/exact HTTPS host scope/);
      expect(f.recording.inputDigest()).toBe(before);
      expect(f.fetcher).toHaveBeenCalledTimes(3);
      expect(vi.mocked(f.fetcher).mock.calls.some(([url]) => String(url) === destination)).toBe(false);
      expect(() => f.recording.observedScopeExclusion(destination)).toThrow(/scope|official UBC hostname/);
    },
  );
  it("classifies observed document-policy redirects without treating denials as exclusions", async () => {
    const f = await fixture(
      (url) =>
        url.endsWith("/denied")
          ? new Response("Denied", { status: 403 })
          : new Response(null, { status: 302, headers: { location: "/excluded/guide.pdf" } }),
      {
        documentUrlAllowed: (url) => !new URL(url).pathname.startsWith("/excluded/"),
      },
    );
    await expect(f.recording.readDocument(`${origin}/guide`)).rejects.toThrow(/Document URL policy/);
    expect(f.recording.observedScopeExclusion(`${origin}/guide`)).toMatch(/document URL policy/);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await f.recording.read(`${origin}/denied`);
    expect(f.recording.observedScopeExclusion(`${origin}/denied`)).toBeNull();
    await expect(f.recording.read(`${origin}/private`)).rejects.toThrow(/Robots/);
    expect(f.recording.observedScopeExclusion(`${origin}/private`)).toBeNull();
    expect(f.recording.observedScopeExclusion(`${origin}/unknown`)).toBeNull();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it("recognizes an explicit document-policy exclusion without entering a private destination", async () => {
    const f = await fixture(() => new Response(null, { status: 302, headers: { location: "/wp-admin/guide.pdf" } }), {
      documentUrlAllowed: (url) => !new URL(url).pathname.startsWith("/wp-admin/"),
    });
    await expect(f.recording.read(`${origin}/guide`)).rejects.toThrow(/Not a public UBC content endpoint/);
    expect(f.recording.observedScopeExclusion(`${origin}/guide`)).toMatch(/document URL policy/);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, "http://[invalid", "https://user:secret@outside.example/", "ftp://outside.example/", "/loop"])(
    "does not classify a missing, invalid, unsafe or cyclic redirect %s as an exclusion",
    async (location) => {
      const f = await fixture(
        () =>
          new Response(null, {
            status: 302,
            headers: location === undefined ? {} : { location },
          }),
      );
      await expect(f.recording.read(`${origin}/loop`)).rejects.toThrow();
      expect(() => f.recording.observedScopeExclusion(`${origin}/loop`)).toThrow();
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it("does not label a recorded cycle as a document-policy exclusion", async () => {
    const f = await fixture(() => new Response(null, { status: 302, headers: { location: "/loop" } }), {
      documentUrlAllowed: () => false,
    });
    await expect(f.recording.read(`${origin}/loop`)).rejects.toThrow(/Redirect loop/);
    expect(() => f.recording.observedScopeExclusion(`${origin}/loop`)).toThrow(/cycle/);
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

  it.each([
    ["application/pdf", {}],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", {}],
    ["text/html", { "content-disposition": 'attachment; filename="download.html"' }],
  ] as const)("cancels out-of-scope article response %s before reading its body", async (contentType, extraHeaders) => {
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
          { headers: { "content-type": contentType, ...extraHeaders } },
        ),
      {
        documentUrlAllowed: () => true,
        htmlDocumentsOnly: true,
      },
    );
    await expect(f.recording.readDocument(`${origin}/download`)).rejects.toThrow(/Observed non-text media/);
    await expect(f.recording.readDocument(`${origin}/download`)).rejects.toThrow(/Observed non-text media/);
    expect(reads).toBe(0);
    expect(cancelled).toBe(true);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"), { readOnly: true });
    expect(db.prepare("SELECT state,bytes,status FROM attempts WHERE url=?").get(`${origin}/download`)).toMatchObject({
      state: "excluded-media",
      bytes: 0,
      status: 200,
    });
    db.close();
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
      expect(f.recording.observedScopeExclusion(`${origin}/page`)).toBeNull();
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
  it("archives only selected streamed HTTP-200 byte failures after a byte-only grant", async () => {
    const robots = "User-agent: *\nDisallow: /private\n";
    const bytes = Buffer.byteLength(robots);
    const page = `${origin}/page`;
    const unrelated = `${origin}/unrelated`;
    let failing = true;
    const f = await fixture(
      (url) => {
        if (url === page && failing)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("x".repeat(32)));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        return html("<p>Recovered article.</p>");
      },
      { maxBytes: bytes + 16, maxRequests: 4 },
    );
    await expect(f.recording.read(page)).rejects.toThrow("Acquisition response/total byte budget exceeded");
    const failed = recordingState(f.directory);
    expect(failed.attempts.at(-1)).toMatchObject({
      url: page,
      state: "failed",
      status: 200,
      bytes: 32,
      body_sha: null,
      snapshot: null,
      error: "Error: Acquisition response/total byte budget exceeded",
    });
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.prepare("INSERT INTO outcomes(url,error) VALUES (?,'Error: Acquisition duration exhausted')").run(unrelated);
    db.close();
    const before = recordingState(f.directory);
    const calls = vi.mocked(f.fetcher).mock.calls.length;
    await expect(f.recording.read(page)).rejects.toThrow(/Saved request failure/);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(() => f.recording.resumeResponseBudgetFailures([page])).toThrow(/additive grant/);
    expect(recordingState(f.directory)).toEqual(before);
    expect(
      f.recording.authorizeBudgetGrant({
        id: "response-byte-grant",
        authoritySha256: "b".repeat(64),
        expectedRequests: before.attempts.length,
        expectedBytes: bytes + 32,
        additionalRequests: 0,
        additionalBytes: 128,
        minimumIntervalMs: 1000,
      }),
    ).toBe(true);
    const granted = recordingState(f.directory);
    expect(f.recording.resumeResponseBudgetFailures([page])).toBe(1);
    const archived = recordingState(f.directory);
    expect(archived.config).toEqual(granted.config);
    expect(archived.attempts).toEqual(granted.attempts);
    expect(archived.producers).toEqual(granted.producers);
    expect(archived.grants).toEqual(granted.grants);
    expect(archived.grantsV2).toEqual(granted.grantsV2);
    expect(archived.repairs).toEqual(granted.repairs);
    expect(archived.failures).toEqual([
      expect.objectContaining({ url: page, error: "Error: Acquisition response/total byte budget exceeded" }),
    ]);
    expect(archived.outcomes).toEqual(granted.outcomes.filter((row) => row.url !== page));
    expect(archived.outcomes).toContainEqual(expect.objectContaining({ url: unrelated }));
    failing = false;
    expect((await f.recording.read(page)).snapshot.body).toBe("<p>Recovered article.</p>");
    expect(f.fetcher).toHaveBeenCalledTimes(calls + 1);
    const retried = recordingState(f.directory);
    expect(retried.attempts.slice(0, granted.attempts.length)).toEqual(granted.attempts);
    expect(retried.producers.slice(0, granted.producers.length)).toEqual(granted.producers);
    expect(retried.grantsV2).toEqual(granted.grantsV2);
    expect(retried.failures).toEqual(archived.failures);
    expect(f.recording.resumeResponseBudgetFailures([])).toBe(0);
  });
  it("refuses response budget recovery without both effective capacities or a usable physical attempt", async () => {
    const robots = "User-agent: *\nDisallow: /private\n";
    const bytes = Buffer.byteLength(robots);
    const page = `${origin}/page`;
    const f = await fixture(() => html("x".repeat(32)), { maxRequests: 2, maxBytes: bytes + 16 });
    await expect(f.recording.read(page)).rejects.toThrow(/response\/total byte budget exceeded/);
    const baseline = recordingState(f.directory);
    const grant = {
      id: "byte-only",
      authoritySha256: "b".repeat(64),
      expectedRequests: baseline.attempts.length,
      expectedBytes: bytes + 32,
      additionalRequests: 0,
      additionalBytes: 64,
      minimumIntervalMs: 1000,
    };
    expect(
      f.recording.authorizeBudgetGrant({ ...grant, id: "request-only", additionalRequests: 1, additionalBytes: 0 }),
    ).toBe(true);
    const byteExhausted = recordingState(f.directory);
    expect(() => f.recording.resumeResponseBudgetFailures([page])).toThrow(
      /remaining effective request and byte capacity/,
    );
    expect(recordingState(f.directory)).toEqual(byteExhausted);
    expect(f.recording.authorizeBudgetGrant(grant)).toBe(true);
    const requestAvailable = recordingState(f.directory);
    expect(requestAvailable.grantsV2).toHaveLength(2);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.prepare(
      "INSERT INTO outcomes(url,error) VALUES (?,'Error: Acquisition response/total byte budget exceeded')",
    ).run(`${origin}/fake`);
    db.close();
    const ready = recordingState(f.directory);
    for (const selected of [
      [page, page],
      [page, `${origin}/fake`],
      [page, "https://different.ubc.ca/page"],
      [`${origin}/page#fragment`],
      [page, `${origin}/PAGE`],
    ]) {
      expect(() => f.recording.resumeResponseBudgetFailures(selected)).toThrow();
      expect(recordingState(f.directory)).toEqual(ready);
    }
    for (const [column, value] of [
      ["status", 403],
      ["state", "uncertain"],
      ["error", "Error: Acquisition duration exhausted"],
      ["body_sha", "a".repeat(64)],
      ["snapshot", "a".repeat(64)],
    ] as const) {
      const mutate = new DatabaseSync(join(f.directory, "state.sqlite"));
      mutate.prepare(`UPDATE attempts SET ${column}=? WHERE url=?`).run(value, page);
      mutate.close();
      const changed = recordingState(f.directory);
      expect(() => f.recording.resumeResponseBudgetFailures([page])).toThrow();
      expect(recordingState(f.directory)).toEqual(changed);
      const restore = new DatabaseSync(join(f.directory, "state.sqlite"));
      restore
        .prepare(`UPDATE attempts SET ${column}=? WHERE url=?`)
        .run(ready.attempts.at(-1)![column] as string | number | null, page);
      restore.close();
    }
    expect(recordingState(f.directory)).toEqual(ready);
    const db2 = new DatabaseSync(join(f.directory, "state.sqlite"));
    db2.prepare("UPDATE outcomes SET error='Error: Acquisition duration exhausted' WHERE url=?").run(page);
    db2.close();
    const otherError = recordingState(f.directory);
    expect(() => f.recording.resumeResponseBudgetFailures([page])).toThrow(/Not a resumable/);
    expect(recordingState(f.directory)).toEqual(otherError);
  });
  it("refuses response budget recovery when a byte-only grant leaves no request capacity", async () => {
    const page = `${origin}/page`;
    const f = await fixture(() => html("x".repeat(32)), {
      maxRequests: 2,
      maxBytes: Buffer.byteLength("User-agent: *\nDisallow: /private\n") + 16,
    });
    await expect(f.recording.read(page)).rejects.toThrow(/response\/total byte budget exceeded/);
    const prior = recordingState(f.directory);
    expect(
      f.recording.authorizeBudgetGrant({
        id: "bytes-without-requests",
        authoritySha256: "c".repeat(64),
        expectedRequests: prior.attempts.length,
        expectedBytes: prior.attempts.reduce((sum, attempt) => sum + Number(attempt.bytes), 0),
        additionalRequests: 0,
        additionalBytes: 64,
        minimumIntervalMs: 1000,
      }),
    ).toBe(true);
    const granted = recordingState(f.directory);
    expect(() => f.recording.resumeResponseBudgetFailures([page])).toThrow(
      /remaining effective request and byte capacity/,
    );
    expect(recordingState(f.directory)).toEqual(granted);
  });
  it("does not archive a per-response ceiling failure that a total-byte grant cannot fix", async () => {
    const page = `${origin}/page`;
    const f = await fixture(() => html("x".repeat(64)), { maxResponseBytes: 48 });
    await expect(f.recording.read(page)).rejects.toThrow(/response\/total byte budget exceeded/);
    const prior = recordingState(f.directory);
    expect(
      f.recording.authorizeBudgetGrant({
        id: "unusable-byte-grant",
        authoritySha256: "c".repeat(64),
        expectedRequests: prior.attempts.length,
        expectedBytes: prior.attempts.reduce((sum, attempt) => sum + Number(attempt.bytes), 0),
        additionalRequests: 0,
        additionalBytes: 128,
        minimumIntervalMs: 1000,
      }),
    ).toBe(true);
    const granted = recordingState(f.directory);
    expect(() => f.recording.resumeResponseBudgetFailures([page])).toThrow(/Not a resumable/);
    expect(recordingState(f.directory)).toEqual(granted);
  });
  it("rolls back selected response archives and preserves the three-attempt ceiling", async () => {
    const f = await fixture(() => html("x".repeat(32)), {
      maxBytes: Buffer.byteLength("User-agent: *\nDisallow: /private\n") + 16,
    });
    const first = `${origin}/first`;
    const second = `${origin}/second`;
    await expect(f.recording.read(first)).rejects.toThrow(/response\/total byte budget exceeded/);
    const seed = new DatabaseSync(join(f.directory, "state.sqlite"));
    seed
      .prepare("INSERT INTO attempts(url,started,state,bytes,status,error) VALUES (?,?,'failed',32,200,?)")
      .run(second, new Date().toISOString(), "Error: Acquisition response/total byte budget exceeded");
    seed
      .prepare("INSERT INTO outcomes(url,error) VALUES (?,'Error: Acquisition response/total byte budget exceeded')")
      .run(second);
    seed.close();
    const original = recordingState(f.directory);
    expect(
      f.recording.authorizeBudgetGrant({
        id: "byte-grant",
        authoritySha256: "d".repeat(64),
        expectedRequests: original.attempts.length,
        expectedBytes: original.attempts.reduce((sum, attempt) => sum + Number(attempt.bytes), 0),
        additionalRequests: 0,
        additionalBytes: 128,
        minimumIntervalMs: 1000,
      }),
    ).toBe(true);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.exec(
      "CREATE TRIGGER refuse_response_archive BEFORE INSERT ON outcome_failures WHEN NEW.url='https://example.ubc.ca/second' BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END;",
    );
    db.close();
    const before = recordingState(f.directory);
    expect(() => f.recording.resumeResponseBudgetFailures([first, second])).toThrow(/fixture archive failure/);
    expect(recordingState(f.directory)).toEqual(before);
    const mutate = new DatabaseSync(join(f.directory, "state.sqlite"));
    mutate.exec("DROP TRIGGER refuse_response_archive");
    for (let index = 0; index < 2; index++)
      mutate
        .prepare("INSERT INTO attempts(url,started,state,bytes,status,error) VALUES (?,?,'failed',32,200,?)")
        .run(first, new Date().toISOString(), "Error: Acquisition response/total byte budget exceeded");
    mutate.close();
    const ceiling = recordingState(f.directory);
    expect(() => f.recording.resumeResponseBudgetFailures([first, second])).toThrow(/Not a resumable/);
    expect(recordingState(f.directory)).toEqual(ceiling);
  });
  it("adds an exact durable budget grant without replacing prior bounds, attempts or robots exclusions", async () => {
    const robots = "User-agent: *\nCrawl-delay: 10\nDisallow: /private\n";
    const fetcher = vi.fn(async (value: string | URL | Request) => {
      const url = String(value);
      return url === `${origin}/robots.txt`
        ? new Response(robots, { headers: { "content-type": "text/plain" } })
        : html();
    }) as unknown as typeof fetch;
    const f = await fixture(() => html(), { maxRequests: 1, fetcher });
    await f.recording.read(`${origin}/robots.txt`);
    const before = recordingState(f.directory);
    const grant = {
      id: "owner-approved-extension-1",
      authoritySha256: "b".repeat(64),
      expectedRequests: 1,
      expectedBytes: Buffer.byteLength(robots),
      additionalRequests: 1,
      additionalBytes: 1024,
      minimumIntervalMs: 1000,
    };
    expect(f.recording.authorizeBudgetGrant(grant)).toBe(true);
    expect(f.recording.authorizeBudgetGrant(grant)).toBe(false);
    await expect(f.recording.read(`${origin}/private`)).rejects.toThrow(/Robots/);
    await expect(f.recording.read(`${origin}/page`)).resolves.toMatchObject({ snapshot: { status: 200 } });
    await expect(f.recording.read(`${origin}/after-grant`)).rejects.toThrow(/budget/);
    const after = recordingState(f.directory);
    expect(after.config).toEqual(before.config);
    expect(after.attempts.slice(0, before.attempts.length)).toEqual(before.attempts);
    expect(after.grants).toHaveLength(1);
    expect(after.grants[0]).toMatchObject({
      id: grant.id,
      authority_sha256: grant.authoritySha256,
      expected_requests: 1,
      additional_requests: 1,
      additional_bytes: 1024,
      minimum_interval_ms: 1000,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(() => f.recording.authorizeBudgetGrant({ ...grant, id: "wrong-counters", expectedRequests: 0 })).toThrow(
      /preserved acquisition counters/,
    );
    await f.recording.seal();
  });
  it("supports a request-only grant without changing the byte ceiling", async () => {
    const robots = "User-agent: *\nDisallow: /private\n";
    const f = await fixture(() => html(), { maxRequests: 1 });
    await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/budget/);
    expect(
      f.recording.authorizeBudgetGrant({
        id: "request-only-extension",
        authoritySha256: "c".repeat(64),
        expectedRequests: 1,
        expectedBytes: Buffer.byteLength(robots),
        additionalRequests: 1,
        additionalBytes: 0,
        minimumIntervalMs: 1000,
      }),
    ).toBe(true);
    await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/Saved request failure/);
    expect(f.recording.resumeBudgetFailures([`${origin}/page`])).toBe(1);
    await expect(f.recording.read(`${origin}/page`)).resolves.toMatchObject({ snapshot: { status: 200 } });
    await expect(f.recording.read(`${origin}/after-request-grant`)).rejects.toThrow(/budget/);
    const state = recordingState(f.directory);
    expect(state.grants).toEqual([]);
    expect(state.grantsV2).toHaveLength(1);
    expect(state.grantsV2[0]).toMatchObject({ additional_requests: 1, additional_bytes: 0 });
    expect(state.failures).toHaveLength(1);
  });
  it("rejects altered, malformed and sub-second budget grants", async () => {
    const f = await fixture(() => html());
    const grant = {
      id: "owner-approved-extension-1",
      authoritySha256: "b".repeat(64),
      expectedRequests: 0,
      expectedBytes: 0,
      additionalRequests: 1,
      additionalBytes: 1024,
      minimumIntervalMs: 1000,
    };
    expect(f.recording.authorizeBudgetGrant(grant)).toBe(true);
    expect(() => f.recording.authorizeBudgetGrant({ ...grant, additionalRequests: 2 })).toThrow(/differs/);
    expect(() =>
      f.recording.authorizeBudgetGrant({ ...grant, id: "second", expectedRequests: 0, minimumIntervalMs: 999 }),
    ).toThrow(/at least one second/);
    expect(() => f.recording.authorizeBudgetGrant({ ...grant, id: "second", authoritySha256: "not-a-digest" })).toThrow(
      /authority digest/,
    );
    expect(() =>
      f.recording.authorizeBudgetGrant({
        ...grant,
        id: "empty-extension",
        additionalRequests: 0,
        additionalBytes: 0,
      }),
    ).toThrow(/must add requests, bytes or both/);
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
  it("repairs newly encountered transport failures only in explicit recovery mode", async () => {
    let broken = 0;
    const f = await fixture(
      (url) => {
        if (url.endsWith("/broken") && ++broken <= 3)
          throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
        return html();
      },
      { recoverTransientFailures: true },
    );
    expect((await f.recording.read(`${origin}/broken`)).snapshot.status).toBe(200);
    expect(broken).toBe(4);
    const state = recordingState(f.directory);
    expect(state.repairs).toHaveLength(1);
    expect(state.failures).toHaveLength(1);
    expect(state.attempts.filter((a) => a.url === `${origin}/broken`)).toHaveLength(4);
    await f.recording.read(`${origin}/broken`);
    expect(broken).toBe(4);
  });

  it("does not loop or renew repair when a newly encountered failure exhausts its allowance", async () => {
    const f = await fixture(
      () => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      },
      { recoverTransientFailures: true },
    );
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow("fetch failed");
    const before = recordingState(f.directory);
    expect(before.attempts.filter((a) => a.url === `${origin}/broken`)).toHaveLength(6);
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow("Saved request failure");
    expect(recordingState(f.directory)).toEqual(before);
  });

  it("never repairs an observed access denial in automatic recovery mode", async () => {
    const f = await fixture(() => new Response("Forbidden", { status: 403 }), { recoverTransientFailures: true });
    expect((await f.recording.read(`${origin}/denied`)).snapshot.status).toBe(403);
    expect(recordingState(f.directory).repairs).toHaveLength(0);
    await expect(f.recording.read(`${origin}/private`)).rejects.toThrow("Robots");
    expect(recordingState(f.directory).repairs).toHaveLength(0);
  });

  it("authorizes repair once with current provenance while preserving history, cache and seals", async () => {
    let failing = true;
    const f = await fixture((url) => {
      if (url.endsWith("/broken") && failing)
        throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
      return html();
    });
    const cached = await f.recording.read(`${origin}/cached`);
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/fetch failed/);
    const before = recordingState(f.directory);
    expect(before.attempts.filter((row) => row.url === `${origin}/broken`)).toHaveLength(3);
    f.recording.close();
    const next = { ...producer, inputs_sha256: "d".repeat(64) };
    const resumed = await HostRecording.open({ ...f.options, producer: next });
    opened.push(resumed);
    expect(resumed.recoverTransientFailures([`${origin}/broken`])).toBe(1);
    const authorized = recordingState(f.directory);
    expect(authorized.attempts).toEqual(before.attempts);
    expect(authorized.config).toEqual(before.config);
    expect(authorized.producers).toEqual(before.producers);
    expect(authorized.outcomes).toEqual(before.outcomes.filter((row) => row.url !== `${origin}/broken`));
    expect(authorized.failures).toHaveLength(1);
    expect(authorized.failures[0]).toMatchObject({ url: `${origin}/broken`, error: "TypeError: fetch failed" });
    expect(authorized.repairs).toHaveLength(1);
    expect(authorized.repairs[0]).toMatchObject({
      url: `${origin}/broken`,
      reason: "TypeError: fetch failed; cause: Error: read ECONNRESET",
      producer: JSON.stringify(next),
      attempt_count: 3,
      attempt_ceiling: 6,
    });
    expect(Number.isFinite(Date.parse(String(authorized.repairs[0]!.authorized_at)))).toBe(true);
    const authorizedDigest = resumed.inputDigest();
    expect(resumed.recoverTransientFailures()).toBe(0);
    expect(resumed.inputDigest()).toBe(authorizedDigest);
    const calls = vi.mocked(f.fetcher).mock.calls.length;
    expect(await resumed.read(`${origin}/cached`)).toEqual(cached);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
    failing = false;
    expect((await resumed.read(`${origin}/broken`)).snapshot.status).toBe(200);
    const repaired = recordingState(f.directory);
    expect(repaired.attempts.slice(0, before.attempts.length)).toEqual(before.attempts);
    expect(repaired.producers.at(-1)?.producer).toBe(JSON.stringify(next));
    expect(repaired.repairs).toEqual(authorized.repairs);
    expect(vi.mocked(f.fetcher).mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty("Connection");
    const digest = await resumed.seal();
    expect(() => resumed.recoverTransientFailures()).toThrow(/unsealed explicit acquisition/);
    resumed.close();
    const noNetwork = vi.fn(async () => {
      throw new Error("Network forbidden");
    });
    const replay = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(replay);
    expect(await replay.verifySeal()).toBe(digest);
    expect((await replay.read(`${origin}/broken`)).snapshot.status).toBe(200);
    expect(() => replay.recoverTransientFailures()).toThrow(/unsealed explicit acquisition/);
    expect(noNetwork).not.toHaveBeenCalled();
    replay.close();
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.exec("UPDATE repair_authorizations SET reason='changed lineage'");
    db.close();
    const tampered = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(tampered);
    await expect(tampered.verifySeal()).rejects.toThrow(/seal mismatch/);
  });
  it("uses connection-close only on the default-fetch path for authorized URLs", async () => {
    const f = await fixture(() => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    });
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/fetch failed/);
    expect(f.recording.recoverTransientFailures()).toBe(1);
    f.recording.close();
    const injectedDefault = vi.fn(async () => html());
    vi.stubGlobal("fetch", injectedDefault);
    try {
      const resumed = await HostRecording.open({ ...f.options, fetcher: undefined });
      opened.push(resumed);
      await resumed.read(`${origin}/broken`);
      await resumed.read(`${origin}/normal`);
      expect(injectedDefault).toHaveBeenCalledTimes(2);
      expect(injectedDefault).toHaveBeenNthCalledWith(
        1,
        `${origin}/broken`,
        expect.objectContaining({
          headers: expect.objectContaining({ Connection: "close" }),
        }),
      );
      expect(injectedDefault).toHaveBeenNthCalledWith(
        2,
        `${origin}/normal`,
        expect.objectContaining({
          headers: expect.not.objectContaining({ Connection: "close" }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rolls back authorization if failure archiving cannot commit", async () => {
    const f = await fixture(() => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    });
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/fetch failed/);
    const before = recordingState(f.directory);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.exec(
      "CREATE TRIGGER refuse_archive BEFORE INSERT ON outcome_failures BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END;",
    );
    db.close();
    expect(() => f.recording.recoverTransientFailures()).toThrow(/fixture archive failure/);
    expect(recordingState(f.directory)).toEqual(before);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  });
  it("never renews an exhausted six-attempt repair across repeated calls or reopen", async () => {
    const f = await fixture(() => {
      throw new TypeError("fetch failed", { cause: new Error("other side closed") });
    });
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/fetch failed/);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/Saved request failure/);
    expect(f.recording.recoverTransientFailures()).toBe(1);
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/fetch failed/);
    expect(f.fetcher).toHaveBeenCalledTimes(7);
    const exhausted = recordingState(f.directory);
    expect(exhausted.attempts.filter((row) => row.url === `${origin}/broken`)).toHaveLength(6);
    expect(exhausted.repairs).toHaveLength(1);
    expect(exhausted.failures).toHaveLength(1);
    expect(f.recording.recoverTransientFailures()).toBe(0);
    expect(() => f.recording.retryNetworkFailure(`${origin}/broken`)).toThrow(/three-attempt bound/);
    f.recording.close();
    const resumed = await HostRecording.open(f.options);
    opened.push(resumed);
    expect(resumed.recoverTransientFailures()).toBe(0);
    await expect(resumed.read(`${origin}/broken`)).rejects.toThrow(/Saved request failure/);
    expect(recordingState(f.directory)).toEqual(exhausted);
    expect(f.fetcher).toHaveBeenCalledTimes(7);
  });
  it("adds at most three attempts to a short original history without changing default retry behavior", async () => {
    const f = await fixture(() => {
      throw new Error("ECONNRESET");
    });
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/ECONNRESET/);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.recording.recoverTransientFailures()).toBe(1);
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/ECONNRESET/);
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    const state = recordingState(f.directory);
    expect(state.repairs[0]).toMatchObject({ attempt_count: 1, attempt_ceiling: 4 });
    expect(state.attempts.filter((row) => row.url === `${origin}/broken`)).toHaveLength(4);
    expect(f.recording.recoverTransientFailures()).toBe(0);
    expect(f.recording.observedScopeExclusion(`${origin}/broken`)).toBeNull();
  });
  it.each(["AbortError", "TimeoutError"])("authorizes saved status-null %s failures", async (name) => {
    const f = await fixture(() => {
      throw new DOMException("fixture timeout", name);
    });
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/fixture timeout/);
    expect(f.recording.recoverTransientFailures()).toBe(1);
    expect(recordingState(f.directory).repairs[0]).toMatchObject({ attempt_count: 3, attempt_ceiling: 6 });
  });
  it.each(["requests", "bytes"])("keeps the original cumulative %s budget during repair", async (kind) => {
    let failing = true;
    const f = await fixture(
      (url) => {
        if (url.endsWith("/cached")) return html("cache");
        if (failing) throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
        return html("new");
      },
      kind === "requests"
        ? { maxRequests: 5 }
        : {
            maxBytes: Buffer.byteLength("User-agent: *\nDisallow: /private\n") + Buffer.byteLength("cache") + 2,
          },
    );
    await f.recording.read(`${origin}/cached`);
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/fetch failed/);
    const before = recordingState(f.directory);
    expect(f.recording.recoverTransientFailures()).toBe(1);
    failing = false;
    await expect(f.recording.read(`${origin}/broken`)).rejects.toThrow(/budget/);
    const after = recordingState(f.directory);
    expect(after.config).toEqual(before.config);
    expect(after.attempts.slice(0, before.attempts.length)).toEqual(before.attempts);
    expect(f.fetcher).toHaveBeenCalledTimes(kind === "requests" ? 5 : 6);
    expect(f.recording.recoverTransientFailures()).toBe(0);
    expect(recordingState(f.directory)).toEqual(after);
  });
  it.each([false, true])(
    "recovers homepage robots dependencies without authorizing the homepage (separate=%s)",
    async (separate) => {
      let failing = true;
      const fetcher = vi.fn(async (value: string | URL | Request) => {
        if (String(value) === `${origin}/robots.txt`) {
          if (failing) throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
          return new Response("User-agent: *\nDisallow: /private\n");
        }
        return html();
      }) as unknown as typeof fetch;
      const f = await fixture(() => html(), { fetcher });
      await expect(f.recording.read(`${origin}/`)).rejects.toThrow(/fetch failed/);
      await expect(f.recording.read(`${origin}/dependent`)).rejects.toThrow(/Saved request failure/);
      expect(f.fetcher).toHaveBeenCalledTimes(3);
      expect(f.recording.recoverTransientFailures([`${origin}/`])).toBe(0);
      if (separate) {
        expect(f.recording.recoverTransientFailures([`${origin}/robots.txt`])).toBe(1);
        expect(f.recording.recoverTransientFailures([`${origin}/`])).toBe(1);
      } else expect(f.recording.recoverTransientFailures([`${origin}/`, `${origin}/robots.txt`])).toBe(2);
      const state = recordingState(f.directory);
      expect(state.repairs.map((row) => row.url)).toEqual([`${origin}/robots.txt`]);
      expect(state.failures.map((row) => row.url).sort()).toEqual([`${origin}/`, `${origin}/robots.txt`]);
      expect(state.outcomes.map((row) => row.url)).toEqual([`${origin}/dependent`]);
      failing = false;
      expect((await f.recording.read(`${origin}/`)).snapshot.status).toBe(200);
      await expect(f.recording.read(`${origin}/private`)).rejects.toThrow(/Robots disallows/);
      await expect(f.recording.read(`${origin}/dependent`)).rejects.toThrow(/Saved request failure/);
      expect(f.fetcher).toHaveBeenCalledTimes(5);
    },
  );
  it("clears a proven homepage dependency after a separately authorized robots recovery", async () => {
    let failing = true;
    const fetcher = vi.fn(async () => {
      if (failing) throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      return new Response("User-agent: *\nDisallow: /private\n");
    });
    const f = await fixture(() => html(), { fetcher });
    await expect(f.recording.read(`${origin}/`)).rejects.toThrow(/fetch failed/);
    expect(f.recording.recoverTransientFailures([`${origin}/robots.txt`])).toBe(1);
    failing = false;
    await f.recording.read(`${origin}/robots.txt`);
    expect(f.recording.recoverTransientFailures([`${origin}/`])).toBe(1);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    expect(recordingState(f.directory).repairs).toHaveLength(1);
  });
  it("does not clear a homepage dependency when the robots repair is exhausted", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    });
    const f = await fixture(() => html(), { fetcher });
    await expect(f.recording.read(`${origin}/robots.txt`)).rejects.toThrow(/fetch failed/);
    expect(f.recording.recoverTransientFailures()).toBe(1);
    await expect(f.recording.read(`${origin}/robots.txt`)).rejects.toThrow(/fetch failed/);
    await expect(f.recording.read(`${origin}/`)).rejects.toThrow(/Saved request failure/);
    const before = recordingState(f.directory);
    expect(f.recording.recoverTransientFailures([`${origin}/`, `${origin}/robots.txt`])).toBe(0);
    expect(recordingState(f.directory)).toEqual(before);
    expect(f.fetcher).toHaveBeenCalledTimes(6);
  });
  it("filters logical failures and shares one physical authorization between recorded aliases", async () => {
    const f = await fixture((url) => {
      if (url.includes("/alias-")) return new Response(null, { status: 302, headers: { location: "/broken" } });
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    });
    await expect(f.recording.read(`${origin}/alias-a`)).rejects.toThrow(/fetch failed/);
    await expect(f.recording.read(`${origin}/alias-b`)).rejects.toThrow(/attempt bound exhausted/);
    await expect(f.recording.read(`${origin}/other`)).rejects.toThrow(/fetch failed/);
    expect(f.recording.recoverTransientFailures([])).toBe(0);
    expect(f.recording.recoverTransientFailures([`${origin}/alias-a`, `${origin}/alias-b`])).toBe(2);
    const state = recordingState(f.directory);
    expect(state.repairs.map((row) => row.url)).toEqual([`${origin}/broken`]);
    expect(state.outcomes.some((row) => row.url === `${origin}/other` && row.error)).toBe(true);
    expect(() => f.recording.recoverTransientFailures([`${origin}/other`, "https://outside.example/"])).toThrow(
      /scope|official UBC hostname/,
    );
    expect(recordingState(f.directory)).toEqual(state);
    expect(f.recording.recoverTransientFailures()).toBe(1);
  });
  it("leaves nontransport failures, observed responses and scope refusals untouched", async () => {
    let mixed = 0;
    const f = await fixture((url) => {
      const path = new URL(url).pathname;
      if (path === "/dns") throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
      if (path === "/certificate") throw new TypeError("fetch failed", { cause: new Error("CERT_HAS_EXPIRED") });
      if (path === "/ambiguous") throw new DOMException("certificate rejected ECONNRESET", "AbortError");
      if (path === "/unknown") throw new TypeError("fetch failed");
      if (path === "/mixed") {
        if (++mixed === 1) return new Response("observed", { status: 503, headers: { "retry-after": "0" } });
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      }
      if (path === "/refused") throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
      if (path === "/scope") return new Response(null, { status: 302, headers: { location: "https://other.ubc.ca/" } });
      if (path === "/unsupported") return new Response("PDF", { headers: { "content-type": "application/pdf" } });
      if (path === "/media") return new Response("image", { headers: { "content-type": "image/jpeg" } });
      if (path.startsWith("/body-"))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException("fixture body abort", "AbortError"));
            },
          }),
          { status: Number(path.slice("/body-".length)) },
        );
      return new Response("observed", { status: Number(path.slice(1)), headers: { "retry-after": "0" } });
    });
    for (const path of [
      "dns",
      "certificate",
      "ambiguous",
      "unknown",
      "mixed",
      "refused",
      "scope",
      "unsupported",
      "media",
      "private",
      "body-200",
      "body-401",
      "body-403",
      "body-503",
    ])
      await expect(f.recording.read(`${origin}/${path}`)).rejects.toThrow();
    for (const status of [200, 401, 403, 503]) await f.recording.read(`${origin}/${status}`);
    const before = recordingState(f.directory);
    const digest = f.recording.inputDigest();
    const calls = vi.mocked(f.fetcher).mock.calls.length;
    expect(f.recording.recoverTransientFailures()).toBe(0);
    expect(recordingState(f.directory)).toEqual(before);
    expect(f.recording.inputDigest()).toBe(digest);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });
  it("archives only selected exact duration failures with no acquisition or counter renewal", async () => {
    const f = await fixture(() => html());
    const cached = await f.recording.read(`${origin}/cached`);
    const errors = [
      "Error: Acquisition duration exhausted",
      "Error: Acquisition wait exceeds remaining duration",
      "Error: Retry wait exceeds duration budget",
      "Error: Acquisition request/byte budget exhausted",
      "Error: Acquisition response/total byte budget exceeded",
      "TypeError: fetch failed",
      "Error: Robots disallows https://example.ubc.ca/private",
      "Error: HTTP 403",
      "Error: Saved request failure: Error: Acquisition duration exhausted",
      "Error: Acquisition duration exhausted extra detail",
    ];
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    for (const [index, error] of errors.entries())
      db.prepare("INSERT INTO outcomes(url,error) VALUES (?,?)").run(`${origin}/duration-${index}`, error);
    db.close();
    const before = recordingState(f.directory);
    const digest = f.recording.inputDigest();
    expect(f.recording.resumeDurationFailures([])).toBe(0);
    const selected = [`${origin}/duration-0`, `${origin}/duration-1`];
    expect(f.recording.resumeDurationFailures(selected)).toBe(2);
    const after = recordingState(f.directory);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.producers).toEqual(before.producers);
    expect(after.config).toEqual(before.config);
    expect(after.repairs).toEqual(before.repairs);
    expect(after.outcomes).toEqual(before.outcomes.filter((row) => !selected.includes(String(row.url))));
    expect(after.failures.map((row) => row.error)).toEqual(errors.slice(0, 2));
    expect(f.recording.inputDigest()).not.toBe(digest);
    expect(f.recording.resumeDurationFailures(selected)).toBe(0);
    expect(recordingState(f.directory)).toEqual(after);
    expect(f.recording.resumeDurationFailures()).toBe(1);
    expect(recordingState(f.directory).failures.map((row) => row.error)).toEqual(errors.slice(0, 3));
    expect(await f.recording.read(`${origin}/cached`)).toEqual(cached);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const seal = await f.recording.seal();
    const sealed = recordingState(f.directory);
    expect(() => f.recording.resumeDurationFailures()).toThrow(/unsealed explicit acquisition/);
    expect(recordingState(f.directory)).toEqual(sealed);
    f.recording.close();
    const bytes = await readFile(join(f.directory, "state.sqlite"));
    const replay = await HostRecording.open({ ...f.options, acquire: false });
    opened.push(replay);
    expect(() => replay.resumeDurationFailures()).toThrow(/unsealed explicit acquisition/);
    expect(await replay.verifySeal()).toBe(seal);
    replay.close();
    expect(await readFile(join(f.directory, "state.sqlite"))).toEqual(bytes);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("resumes homepage and robots duration outcomes only when explicitly cleared, without restarting the invocation clock", async () => {
    const f = await fixture(() => html());
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
    try {
      await expect(f.recording.read(`${origin}/`)).rejects.toThrow(/Acquisition duration exhausted/);
      expect(recordingState(f.directory).attempts).toHaveLength(0);
      expect(f.recording.resumeDurationFailures([`${origin}/`, `${origin}/robots.txt`])).toBe(2);
      expect(f.fetcher).not.toHaveBeenCalled();
      await expect(f.recording.read(`${origin}/`)).rejects.toThrow(/Acquisition duration exhausted/);
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
    f.recording.close();
    const resumed = await HostRecording.open(f.options);
    opened.push(resumed);
    await expect(resumed.read(`${origin}/`)).rejects.toThrow(/Saved request failure/);
    expect(resumed.resumeDurationFailures([`${origin}/`, `${origin}/robots.txt`])).toBe(2);
    expect(resumed.resumeDurationFailures()).toBe(0);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await resumed.read(`${origin}/`)).snapshot.status).toBe(200);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(recordingState(f.directory).failures).toHaveLength(4);
    expect(recordingState(f.directory).repairs).toHaveLength(0);
  });
  it.each(["requests", "bytes"])(
    "does not resume duration failures after the cumulative %s budget is exhausted",
    async (kind) => {
      const f = await fixture(
        () => html("x"),
        kind === "requests"
          ? { maxRequests: 2 }
          : {
              maxBytes: Buffer.byteLength("User-agent: *\nDisallow: /private\n") + 1,
            },
      );
      await f.recording.read(`${origin}/cached`);
      const db = new DatabaseSync(join(f.directory, "state.sqlite"));
      db.prepare("INSERT INTO outcomes(url,error) VALUES (?,'Error: Acquisition duration exhausted')").run(
        `${origin}/page`,
      );
      db.close();
      const before = recordingState(f.directory);
      expect(f.recording.resumeDurationFailures()).toBe(0);
      expect(recordingState(f.directory)).toEqual(before);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it.each([false, true])(
    "keeps exhausted physical attempt ceilings after clearing duration outcomes (repair=%s)",
    async (repair) => {
      const f = await fixture(() => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      });
      await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/fetch failed/);
      if (repair) {
        expect(f.recording.recoverTransientFailures()).toBe(1);
        await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/fetch failed/);
      }
      const db = new DatabaseSync(join(f.directory, "state.sqlite"));
      db.prepare("UPDATE outcomes SET error='Error: Acquisition duration exhausted' WHERE url=?").run(`${origin}/page`);
      db.close();
      const before = recordingState(f.directory);
      const calls = vi.mocked(f.fetcher).mock.calls.length;
      expect(f.recording.resumeDurationFailures()).toBe(1);
      expect(f.recording.resumeDurationFailures()).toBe(0);
      await expect(f.recording.read(`${origin}/page`)).rejects.toThrow(/Physical URL attempt bound exhausted/);
      expect(f.recording.resumeDurationFailures()).toBe(0);
      const after = recordingState(f.directory);
      expect(after.attempts).toEqual(before.attempts);
      expect(after.repairs).toEqual(before.repairs);
      expect(after.config).toEqual(before.config);
      expect(f.fetcher).toHaveBeenCalledTimes(calls);
    },
  );
  it("refuses duration resumption while active or with an unfinished dispatch", async () => {
    const f = await fixture(() => {
      expect(() => f.recording.resumeDurationFailures()).toThrow(/idle recording/);
      return html();
    });
    await f.recording.read(`${origin}/page`);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.prepare("INSERT INTO attempts(url,started,state) VALUES (?,?,'dispatching')").run(
      `${origin}/pending`,
      new Date().toISOString(),
    );
    db.prepare("INSERT INTO outcomes(url,error) VALUES (?,'Error: Acquisition duration exhausted')").run(
      `${origin}/duration`,
    );
    db.close();
    const before = recordingState(f.directory);
    expect(() => f.recording.resumeDurationFailures()).toThrow(/no dispatching attempts/);
    expect(recordingState(f.directory)).toEqual(before);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("rolls back duration archives and selected outcome removal together", async () => {
    const f = await fixture(() => html());
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    for (const path of ["a", "b"])
      db.prepare("INSERT INTO outcomes(url,error) VALUES (?,'Error: Acquisition duration exhausted')").run(
        `${origin}/${path}`,
      );
    db.exec(
      "CREATE TRIGGER refuse_duration_archive BEFORE INSERT ON outcome_failures WHEN NEW.url='https://example.ubc.ca/b' BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END;",
    );
    db.close();
    const before = recordingState(f.directory);
    expect(() => f.recording.resumeDurationFailures()).toThrow(/fixture archive failure/);
    expect(recordingState(f.directory)).toEqual(before);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['<HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1252">', "windows-1252"],
    ["<head><meta content='text/html; charset=iso-8859-1' http-equiv='CONTENT-TYPE'>", "iso-8859-1"],
  ])("decodes legacy %s only from the original HTML head and verifies saved bytes", async (meta, _label) => {
    const raw = Buffer.concat([
      Buffer.from(`<!doctype html><html>${meta}</head><body>caf`),
      Buffer.from([0xe9]),
      Buffer.from("</body>"),
    ]);
    const f = await fixture(() => new Response(raw, { headers: { "content-type": "text/html" } }));
    const observation = await f.recording.read(`${origin}/legacy`);
    expect(observation.snapshot.body).toContain("café");
    expect(observation.snapshot.headers["content-type"]).toBe("text/html");
    expect(await f.recording.readTextBytes(observation.sha256)).toMatchObject({ bytes: raw });
    const seal = await f.recording.seal();
    f.recording.close();
    const noNetwork = vi.fn(async () => {
      throw new Error("No network");
    });
    const replay = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(replay);
    expect(await replay.verifySeal()).toBe(seal);
    expect(await replay.readTextBytes(observation.sha256)).toMatchObject({ bytes: raw });
    expect(noNetwork).not.toHaveBeenCalled();
  });
  it.each([
    '<!-- <meta http-equiv="Content-Type" content="text/html; charset=windows-1252"> -->',
    '<script>"<meta http-equiv=Content-Type content="text/html; charset=windows-1252">"</script>',
    '<template><meta http-equiv=Content-Type content="text/html; charset=windows-1252"></template>',
    '<template><template></template><meta http-equiv=Content-Type content="text/html; charset=windows-1252"></template>',
    '<title><meta http-equiv=Content-Type content="text/html; charset=windows-1252"></title>',
    '<div><meta http-equiv=Content-Type content="text/html; charset=windows-1252">',
    '</head><body><meta http-equiv=Content-Type content="text/html; charset=windows-1252">',
    '<meta http-equiv=Content-Type content="text/html; charset=unknown">',
    '<meta http-equiv=Content-Type content="text/html; charset=windows-1252oops">',
  ])("does not honor inert or unsupported HTML meta: %s", async (meta) => {
    const raw = Buffer.concat([Buffer.from(`<head>${meta}caf`), Buffer.from([0xe9])]);
    const f = await fixture(() => new Response(raw, { headers: { "content-type": "text/html" } }));
    await expect(f.recording.read(`${origin}/invalid`)).rejects.toThrow(/encoded data/);
    expect(recordingState(f.directory).attempts.at(-1)).toMatchObject({ state: "failed", status: 200 });
  });
  it("honors HTTP charset before a conflicting HTML head and never sniffs other media", async () => {
    const raw = Buffer.concat([
      Buffer.from('<head><meta http-equiv=Content-Type content="text/html; charset=windows-1252"></head>caf'),
      Buffer.from([0xe9]),
    ]);
    const f = await fixture(
      (url) =>
        new Response(raw, {
          headers: { "content-type": url.endsWith("/http") ? "text/html; charset=utf-8" : "text/plain" },
        }),
    );
    await expect(f.recording.read(`${origin}/http`)).rejects.toThrow(/encoded data/);
    await expect(f.recording.read(`${origin}/plain`)).rejects.toThrow(/encoded data/);
    expect(recordingState(f.directory).attempts.filter((row) => row.state === "failed")).toHaveLength(2);
  });
  it("archives only exact verified HTTP-200 decode failures and retains original attempts", async () => {
    const raw = Buffer.concat([
      Buffer.from('<head><meta http-equiv=Content-Type content="text/html; charset=windows-1252"></head>caf'),
      Buffer.from([0xe9]),
    ]);
    let successor = false;
    const f = await fixture(
      (url) =>
        new Response(raw, {
          headers: { "content-type": successor && url.endsWith("/legacy") ? "text/html" : "text/plain" },
        }),
    );
    await expect(f.recording.read(`${origin}/legacy`)).rejects.toThrow(/encoded data/);
    await expect(f.recording.read(`${origin}/other`)).rejects.toThrow(/encoded data/);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.prepare("UPDATE attempts SET headers=? WHERE url=?").run(
      JSON.stringify({ "content-type": "text/html" }),
      `${origin}/legacy`,
    );
    db.close();
    const before = recordingState(f.directory);
    expect(await f.recording.recoverHtmlDecodeFailures([])).toBe(0);
    await expect(f.recording.recoverHtmlDecodeFailures([`${origin}/other`])).rejects.toThrow(/charset-absent HTML/);
    expect(recordingState(f.directory)).toEqual(before);
    expect(await f.recording.recoverHtmlDecodeFailures([`${origin}/legacy`])).toBe(1);
    const after = recordingState(f.directory);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.producers).toEqual(before.producers);
    expect(after.config).toEqual(before.config);
    expect(after.outcomes).toEqual(before.outcomes.filter((row) => row.url !== `${origin}/legacy`));
    expect(after.failures).toMatchObject([
      { url: `${origin}/legacy`, error: before.outcomes.find((row) => row.url === `${origin}/legacy`)!.error },
    ]);
    expect(after.repairs).toEqual([]);
    await expect(f.recording.recoverHtmlDecodeFailures([`${origin}/legacy`])).rejects.toThrow(/single saved/);
    successor = true;
    const observation = await f.recording.read(`${origin}/legacy`);
    expect(observation.snapshot.body).toContain("café");
    expect(recordingState(f.directory).attempts.filter((row) => row.url === `${origin}/legacy`)).toHaveLength(2);
    await expect(f.recording.read(`${origin}/other`)).rejects.toThrow(/Saved request failure/);
  });
  it("rejects a historical HTTP charset and exhausted request capacity", async () => {
    const raw = Buffer.concat([
      Buffer.from('<head><meta http-equiv=Content-Type content="text/html; charset=windows-1252">'),
      Buffer.from([0xe9]),
    ]);
    const f = await fixture(
      (url) => new Response(url.endsWith("/cached") ? "cached" : raw, { headers: { "content-type": "text/plain" } }),
      { maxRequests: 3 },
    );
    await expect(f.recording.read(`${origin}/legacy`)).rejects.toThrow(/encoded data/);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.prepare("UPDATE attempts SET headers=? WHERE url=?").run(
      JSON.stringify({ "content-type": "text/html; charset=utf-8" }),
      `${origin}/legacy`,
    );
    db.close();
    const before = recordingState(f.directory);
    await expect(f.recording.recoverHtmlDecodeFailures([`${origin}/legacy`])).rejects.toThrow(/charset-absent HTML/);
    expect(recordingState(f.directory)).toEqual(before);
    const corrected = new DatabaseSync(join(f.directory, "state.sqlite"));
    corrected
      .prepare("UPDATE attempts SET headers=? WHERE url=?")
      .run(JSON.stringify({ "content-type": "text/html" }), `${origin}/legacy`);
    corrected.close();
    await f.recording.read(`${origin}/cached`);
    const exhausted = recordingState(f.directory);
    await expect(f.recording.recoverHtmlDecodeFailures([`${origin}/legacy`])).rejects.toThrow(/capacity/);
    expect(recordingState(f.directory)).toEqual(exhausted);
  });
  it("refuses altered body receipts and unfinished attempts without archiving", async () => {
    const raw = Buffer.concat([
      Buffer.from('<head><meta http-equiv=Content-Type content="text/html; charset=iso-8859-1">'),
      Buffer.from([0xe9]),
    ]);
    const f = await fixture(() => new Response(raw, { headers: { "content-type": "text/plain" } }));
    await expect(f.recording.read(`${origin}/legacy`)).rejects.toThrow(/encoded data/);
    const saved = new DatabaseSync(join(f.directory, "state.sqlite"));
    saved
      .prepare("UPDATE attempts SET headers=? WHERE url=?")
      .run(JSON.stringify({ "content-type": "text/html" }), `${origin}/legacy`);
    saved.close();
    const body = recordingState(f.directory).attempts.at(-1)!.body_sha;
    await writeFile(join(f.directory, "objects", `${body}.body`), Buffer.from("changed"));
    await expect(f.recording.recoverHtmlDecodeFailures([`${origin}/legacy`])).rejects.toThrow(/body changed/);
    await writeFile(join(f.directory, "objects", `${body}.body`), raw);
    const db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.prepare("INSERT INTO attempts(url,started,state) VALUES (?,?,'dispatching')").run(
      `${origin}/pending`,
      new Date().toISOString(),
    );
    db.close();
    const before = recordingState(f.directory);
    await expect(f.recording.recoverHtmlDecodeFailures([`${origin}/legacy`])).rejects.toThrow(/no dispatching/);
    expect(recordingState(f.directory)).toEqual(before);
  });
  it("preserves the legacy digest when authorization tables are empty or absent", async () => {
    const f = await fixture(() => html());
    await f.recording.read(`${origin}/page`);
    const digest = f.recording.inputDigest();
    f.recording.close();
    let db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.exec("DROP TABLE repair_authorizations");
    db.close();
    const resumed = await HostRecording.open(f.options);
    opened.push(resumed);
    expect(resumed.inputDigest()).toBe(digest);
    expect(await resumed.seal()).toBe(digest);
    resumed.close();
    db = new DatabaseSync(join(f.directory, "state.sqlite"));
    db.exec("DROP TABLE repair_authorizations");
    db.close();
    const noNetwork = vi.fn(async () => {
      throw new Error("Network forbidden");
    });
    const replay = await HostRecording.open({ ...f.options, acquire: false, fetcher: noNetwork });
    opened.push(replay);
    expect(await replay.verifySeal()).toBe(digest);
    expect(() => replay.recoverTransientFailures()).toThrow(/unsealed explicit acquisition/);
    expect(noNetwork).not.toHaveBeenCalled();
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
