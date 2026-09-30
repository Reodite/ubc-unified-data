import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  floatValue,
  Http,
  HTTPError,
  InvalidValueError,
  jsLiteral,
  jsonapiCollection,
  Output,
  RequestTimeoutError,
  setCampus,
  simplifyJsonapi,
  stringifyCsv,
  stringifyJson,
  stringifyJsonItems,
  wants,
  wpCollection,
  type ResponseLike,
} from "./base.ts";

describe("stringifyJson writes JSON with conventional offsets and quoting", () => {
  it("serializes primitives and nested structures", () => {
    const payload = { a: 1, s: "héllo", list: [1, true, null], nested: { x: "y" } };
    expect(stringifyJson(payload, 2)).toBe(
      '{\n  "a": 1,\n  "s": "héllo",\n  "list": [\n    1,\n    true,\n    null\n  ],\n  "nested": {\n    "x": "y"\n  }\n}',
    );
  });

  it("writes integral floats with a trailing .0", () => {
    expect(stringifyJson(floatValue(3), null)).toBe("3.0");
    expect(stringifyJson(floatValue(3.5), null)).toBe("3.5");
    expect(stringifyJson([floatValue(0)], null)).toBe("[0.0]");
  });

  it("escapes only C0 controls", () => {
    expect(stringifyJson("a\nb\tc\u0001")).toBe('"a\\nb\\tc\\u0001"');
    expect(stringifyJson("héllo")).toBe('"héllo"');
  });

  it("switches to compact separators when indent is null", () => {
    expect(stringifyJson([1, 2], null)).toBe("[1,2]");
  });

  it("stringifyJsonItems writes one compact item per line", () => {
    expect(stringifyJsonItems([{ a: 1, b: [2, 3] }, { a: floatValue(3) }])).toBe(
      '[\n  {"a":1,"b":[2,3]},\n  {"a":3.0}\n]',
    );
    expect(stringifyJsonItems([])).toBe("[]");
  });
});

describe("stringifyCsv quotes the delimiter, quotes, and newlines only", () => {
  it("quotes only the delimiter, quotes, and newlines", () => {
    const rows = [
      { name: "plain", n: 1 },
      { name: "with,comma", n: 2 },
      { name: 'with"quote', n: 3 },
      { name: "a\nb", n: 4 },
    ];
    expect(stringifyCsv(rows, { columns: ["name", "n"] })).toBe(
      'name,n\r\nplain,1\r\n"with,comma",2\r\n"with""quote",3\r\n"a\nb",4\r\n',
    );
  });

  it("orders columns by first-seen key order", () => {
    const rows = [
      { b: 1, a: 2 },
      { c: 3, a: 4 },
    ];
    expect(stringifyCsv(rows)).toBe("b,a,c\r\n1,2,\r\n,4,3\r\n");
  });

  it("flattens nested values via the _scalar rule", () => {
    const rows = [{ obj: { a: [1, "b"] }, n: 1 }];
    expect(stringifyCsv(rows, { columns: ["obj", "n"] })).toBe('obj,n\r\n"{""a"": [1, ""b""]}",1\r\n');
  });
});

describe("Output", () => {
  let root: string;
  let out: Output;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "output-"));
    out = new Output("test-group", root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes json/csv/raw under the folder and tracks them in datasets order", async () => {
    const tree: Array<[string, number | null, string | null]> = [];
    const json = out.json.bind(out);
    const csv = out.csv.bind(out);
    const raw = out.raw.bind(out);
    out.json = async (rel: string, payload: unknown, opts) => {
      const p = await json(rel, payload, opts);
      tree.push([rel, Array.isArray(payload) ? payload.length : null, opts?.source ?? null]);
      return p;
    };
    out.csv = async (rel: string, rows: Array<Record<string, unknown>>, opts) => {
      const p = await csv(rel, rows, opts);
      tree.push([rel, rows.length, opts?.source ?? null]);
      return p;
    };
    out.raw = async (rel: string, content: ArrayBuffer | Uint8Array | string, opts) => {
      const p = await raw(rel, content, opts);
      tree.push([rel, null, opts?.source ?? null]);
      return p;
    };

    await out.json("a.json", [{ x: 1 }], { source: "https://example" });
    await out.csv("b.csv", [{ y: 2 }], { source: "https://example" });
    await out.raw("c.bin", new Uint8Array([1, 2]), { source: "https://example" });

    expect(await stat(path.join(root, "test-group/a.json"))).toBeTruthy();
    const files = await readdir(path.join(root, "test-group"));
    expect(files.sort()).toEqual(["a.json", "b.csv", "c.bin"]);
    expect(out.datasets.map((d) => d.path)).toEqual(["test-group/a.json", "test-group/b.csv", "test-group/c.bin"]);
  });

  it("writes compact JSON for arrays above the 2000-row threshold", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({ i }));
    await out.json("big.json", rows);
    const written = JSON.parse(await readFile(path.join(root, "test-group/big.json"), "utf8"));
    expect(written).toHaveLength(2001);
    const raw = await readFile(path.join(root, "test-group/big.json"), "utf8");
    expect(raw).not.toContain("\n  {");
  });

  it("prunes stale files and empty directories, deepest first, keeping written ones", async () => {
    await out.json("keep.json", [{ x: 1 }]);
    await out.raw("sub/keep2.bin", "x");
    // Stale files at the same and deeper levels.
    await mkdir(path.join(root, "test-group/deep/nested"), { recursive: true });
    await writeFile(path.join(root, "test-group/stale.json"), "{}");
    await writeFile(path.join(root, "test-group/sub/stale2.json"), "{}");
    await writeFile(path.join(root, "test-group/deep/nested/stale3.json"), "{}");

    const removed = await out.prune();
    expect(removed.sort()).toEqual([
      "test-group/deep/nested/stale3.json",
      "test-group/stale.json",
      "test-group/sub/stale2.json",
    ]);
    expect(await readFile(path.join(root, "test-group/keep.json"), "utf8")).toBeDefined();
    // Empty directories are cleaned up.
    const deep = await readdir(path.join(root, "test-group/deep")).catch(() => null);
    expect(deep).toBe(null);
  });
});

describe("campus selection", () => {
  it("wants() keeps null/unlabelled and 'both', filters otherwise", () => {
    setCampus("vancouver");
    expect(wants(null)).toBe(true);
    expect(wants(undefined)).toBe(true);
    expect(wants("vancouver")).toBe(true);
    expect(wants("okanagan")).toBe(false);
    setCampus("both");
    expect(wants("okanagan")).toBe(true);
  });

  it("setCampus rejects unknown values", () => {
    setCampus("vancouver");
    expect(() => setCampus("mars")).toThrow(InvalidValueError);
  });
});

describe("simplifyJsonapi", () => {
  const record = {
    id: "1",
    type: "node--course",
    attributes: {
      drupal_internal__id: 10,
      title: "CPSC 110",
      path: { alias: "/courses/cpsc-110" },
      field_campuses: "ubco",
      metatag: { bogus: true },
      plain: "kept",
    },
    relationships: {
      field_subjects: { data: [{ id: "s1" }, { id: "s2" }] },
      field_faculty: { data: { id: "f1" } },
      empty_rel: { data: null },
    },
  };

  it("strips prefixes, drops the drop set, and collects relationships", () => {
    const out = simplifyJsonapi(record as unknown as Record<string, unknown>);
    expect(out).toEqual({
      id: 10,
      type: "node--course",
      title: "CPSC 110",
      alias: "/courses/cpsc-110",
      field_campuses: "ubco",
      plain: "kept",
      related: { subjects: ["s1", "s2"], faculty: "f1" },
    });
  });
});

function respond(status: number, body = "", headers: Record<string, string> = {}): ResponseLike {
  return {
    status,
    headers: new Headers(headers),
    text: async () => body,
    json: async () => JSON.parse(body || "null"),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

/** Replace Http#'s private sleep so backoff tests never wait in real time. */
function stubSleep(http: Http, onDelay: (ms: number) => void = () => {}): void {
  (http as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
    onDelay(ms);
  };
}

describe("jsLiteral", () => {
  it("parses an object literal with string escapes", () => {
    const html = `var data = {"a": 1, "b": "x\\"y", "c": [1, 2]};`;
    expect(jsLiteral(html, "data")).toEqual({ a: 1, b: 'x"y', c: [1, 2] });
  });

  it("throws when the name is missing", () => {
    expect(() => jsLiteral("<html></html>", "data")).toThrow(Error);
  });

  it("throws for a non-object/array opener", () => {
    expect(() => jsLiteral("var data = 'nope';", "data")).toThrow(InvalidValueError);
  });

  it("throws on unterminated literal", () => {
    expect(() => jsLiteral("var data = {a: 1", "data")).toThrow(InvalidValueError);
  });
});

describe("Http", () => {
  it("retries 429 with backoff, then succeeds", async () => {
    let calls = 0;
    let backoff = 0;
    const http = new Http({ retries: 3, minInterval: 0, timeout: 5 });
    http.responder = () => {
      calls++;
      return calls < 3 ? respond(429) : respond(200, '{"ok": true}');
    };
    stubSleep(http, (ms) => (backoff += ms));
    const result = await http.getJson("https://example.com/x");
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
    // exponential backoff: 1s then 2s.
    expect(backoff).toBe(3000);
  });

  it("posts form data and reads HTML calendar responses", async () => {
    const http = new Http({ retries: 0 });
    http.responder = (method, url, body) => {
      expect(method).toBe("POST");
      expect(url).toBe("https://hours.library.ubc.ca/includes/calendar.inc.php");
      expect(body).toBe("location_id=2&month=10&year=2026");
      return respond(200, "<section>October hours</section>");
    };
    await expect(
      http.postText("https://hours.library.ubc.ca/includes/calendar.inc.php", {
        location_id: 2,
        month: 10,
        year: 2026,
        absent: null,
      }),
    ).resolves.toBe("<section>October hours</section>");
  });

  it("does not retry 404 (not a retry status)", async () => {
    let calls = 0;
    const http = new Http({ retries: 3, minInterval: 0, timeout: 5 });
    http.responder = () => {
      calls++;
      return respond(404);
    };
    await expect(http.get("https://example.com/missing")).rejects.toThrow(HTTPError);
    expect(calls).toBe(1);
  });

  it("throws HTTPError for non-retry statuses, naming the reason", async () => {
    const http = new Http({ retries: 0, minInterval: 0, timeout: 5 });
    http.responder = () => respond(403);
    await expect(http.get("https://example.com/x")).rejects.toThrow(
      /403 Client Error: Forbidden for url: https:\/\/example.com\/x/,
    );
  });

  it("honors Retry-After when present", async () => {
    let calls = 0;
    let lastDelay = 0;
    const http = new Http({ retries: 2, minInterval: 0, timeout: 5 });
    http.responder = () => {
      calls++;
      return calls === 1 ? respond(503, "", { "Retry-After": "1" }) : respond(200);
    };
    // Stub out sleep entirely so the test is fast; the Retry-After seconds → ms
    // path is what we're asserting.
    stubSleep(http, (ms) => (lastDelay = ms));
    await http.get("https://example.com/x");
    expect(lastDelay).toBe(1000);
    expect(calls).toBe(2);
  });

  it("treats a timeout as an error", async () => {
    const http = new Http({ retries: 0, minInterval: 0, timeout: 1 });
    http.responder = () => {
      // AbortSignal.timeout() fires an Error named "TimeoutError" in Node.
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    await expect(http.get("https://example.com/slow")).rejects.toThrow(RequestTimeoutError);
  });

  it("map preserves input order and bounds concurrency", async () => {
    const http = new Http({ minInterval: 0, timeout: 5 });
    let active = 0;
    let maxActive = 0;
    const result = await http.map(
      async (item: number) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return item * 2;
      },
      [1, 2, 3, 4, 5, 6],
      2,
    );
    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBe(2);
  });

  it("map returns [] for empty input", async () => {
    const http = new Http({});
    expect(await http.map(async (x: number) => x, [])).toEqual([]);
  });

  it("map reports progress as items complete", async () => {
    const http = new Http({});
    const seen: Array<[number, number]> = [];
    http.onProgress = (done, total) => seen.push([done, total]);
    await http.map(async (x: number) => x, [1, 2, 3], 2);
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe("jsonapiCollection", () => {
  function jsonapiPage(
    data: unknown,
    meta: Record<string, unknown> = {},
    links: Record<string, unknown> = {},
  ): ResponseLike {
    return respond(200, JSON.stringify({ data, meta, links }));
  }

  const base = "https://example.com/jsonapi/node/x";
  function offsetUrl(offset: number): string {
    return `${base}?page%5Blimit%5D=50&page%5Boffset%5D=${offset}`;
  }

  it("fans out when meta.count exceeds the page size", async () => {
    const calls: string[] = [];
    const pages = new Map<string, unknown[]>();
    pages.set(
      "0",
      Array.from({ length: 50 }, (_, i) => ({ id: i })),
    );
    pages.set("50", [{ id: 50 }]);
    const http = new Http({ minInterval: 0, timeout: 5 });
    http.responder = (_method, fullUrl) => {
      const offset = new URL(fullUrl).searchParams.get("page[offset]") ?? "0";
      calls.push(offset);
      const data = pages.get(offset) ?? [];
      return jsonapiPage(data, { count: 51 }, {});
    };
    const result = await jsonapiCollection(http, "example.com", "node/x");
    expect(result.map((r) => r["id"])).toHaveLength(51);
    expect(result[0]).toEqual({ id: 0 });
    expect(result[50]).toEqual({ id: 50 });
    expect(calls.sort()).toEqual(["0", "50"]);
  });

  it("follows links.next when no total is reported", async () => {
    const pages = new Map<string, ResponseLike>();
    pages.set(offsetUrl(0), jsonapiPage([{ id: 1 }], {}, { next: { href: `${base}?page=1` } }));
    pages.set(`${base}?page=1`, jsonapiPage([]));
    const http = new Http({ minInterval: 0, timeout: 5 });
    http.responder = (_method, fullUrl) => pages.get(fullUrl) ?? jsonapiPage([]);
    const result = await jsonapiCollection(http, "example.com", "node/x");
    expect(result).toEqual([{ id: 1 }]);
  });
});

describe("wpCollection", () => {
  function respond(status: number, body = "", headers: Record<string, string> = {}): ResponseLike {
    const h = new Headers(headers);
    return {
      status,
      headers: h,
      text: async () => body,
      json: async () => JSON.parse(body || "null"),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  }

  it("fans out by X-WP-TotalPages", async () => {
    const calls: string[] = [];
    const http = new Http({ minInterval: 0, timeout: 5 });
    http.responder = (_method, fullUrl) => {
      const page = new URL(fullUrl).searchParams.get("page") ?? "1";
      calls.push(page);
      if (page === "1") return respond(200, '[{"id": 1}]', { "X-WP-TotalPages": "2" });
      if (page === "2") return respond(200, '[{"id": 2}]', { "X-WP-TotalPages": "2" });
      return respond(200, "[]", {});
    };
    const result = await wpCollection(http, "example.com", "wp-json/events");
    expect(result.map((r) => (r as { id: number }).id)).toEqual([1, 2]);
    expect(calls.sort()).toEqual(["1", "2"]);
  });
});
