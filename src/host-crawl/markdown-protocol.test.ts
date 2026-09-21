import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inspectMarkdownSource } from "./markdown-inspection.mjs";
import {
  createMarkdownRequestDecoder,
  createMarkdownResponseDecoder,
  encodeMarkdownRequest,
  encodeMarkdownResponse,
  getMarkdownRequestInput,
  MARKDOWN_PROTOCOL_LIMITS,
  prepareMarkdownRequest,
} from "./markdown-protocol.mjs";

const bytes = (value: string) => Buffer.from(value, "utf8");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const source = bytes("# Guide\n\nA [link](https://example.test/path).\n");
const protocolError = /^Markdown protocol: invalid input\.$/;
const fetchGuard = vi.fn(() => {
  throw new Error("Network forbidden in codec tests");
});

beforeAll(() => {
  vi.stubGlobal("fetch", fetchGuard);
});
afterAll(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function requestFrame(header: string, body: Uint8Array, declaredBody = body.byteLength) {
  const encoded = bytes(header);
  const prefix = Buffer.alloc(16);
  prefix.write("UBCMDQ01");
  prefix.writeUInt32BE(encoded.length, 8);
  prefix.writeUInt32BE(declaredBody, 12);
  return Buffer.concat([prefix, encoded, body]);
}

function responseFrame(envelope: string) {
  const encoded = bytes(envelope);
  const prefix = Buffer.alloc(12);
  prefix.write("UBCMDR01");
  prefix.writeUInt32BE(encoded.length, 8);
  return Buffer.concat([prefix, encoded]);
}

function fixture() {
  const request = prepareMarkdownRequest(source, []);
  const metadata = inspectMarkdownSource(source, []);
  return { request, metadata };
}

function mutableMetadata() {
  return JSON.parse(JSON.stringify(fixture().metadata));
}

describe("prepared Markdown requests", () => {
  it("exposes only frozen independently hashed evidence and copies input", () => {
    const original = Uint8Array.from(source);
    const titles: (string | null)[] = [null, "", "Guide", "Guide"];
    const request = prepareMarkdownRequest(original, titles);
    expect(request).toEqual({
      source_bytes: source.length,
      source_bytes_sha256: hash(source),
      advertised_titles: titles,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.advertised_titles)).toBe(true);
    original.fill(0);
    titles[2] = "Mutated";
    const first = getMarkdownRequestInput(request);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.bytes).toEqual(Uint8Array.from(source));
    expect(first.advertised_titles).toEqual([null, "", "Guide", "Guide"]);
    first.bytes.fill(0);
    const encoded = encodeMarkdownRequest(request);
    encoded.fill(0);
    expect(getMarkdownRequestInput(request).bytes).toEqual(Uint8Array.from(source));
    expect(Buffer.from(encodeMarkdownRequest(request)).subarray(-source.length)).toEqual(source);
  });

  it("rejects forged and deserialized handles at every authority boundary", () => {
    const { request, metadata } = fixture();
    for (const forged of [{ ...request }, JSON.parse(JSON.stringify(request)), Object.create(request), null] as any[]) {
      expect(() => getMarkdownRequestInput(forged)).toThrow(protocolError);
      expect(() => encodeMarkdownRequest(forged)).toThrow(protocolError);
      expect(() => encodeMarkdownResponse(metadata, forged)).toThrow(protocolError);
      expect(() => createMarkdownResponseDecoder(forged)).toThrow(protocolError);
    }
  });

  it("transports invalid UTF8 unchanged without inspecting it", () => {
    const raw = Uint8Array.of(0xff, 0xc0, 0, 0xef, 0xbb, 0xbf);
    const request = prepareMarkdownRequest(raw, []);
    const decoder = createMarkdownRequestDecoder();
    expect(decoder.push(encodeMarkdownRequest(request))).toBeUndefined();
    const result = decoder.finish();
    expect(getMarkdownRequestInput(result).bytes).toEqual(raw);
    expect(result).not.toBe(request);
    expect(() => inspectMarkdownSource(raw, [])).toThrow();
  });
});

describe("canonical Markdown frames", () => {
  it("exports frozen explicit transport limits", () => {
    expect(MARKDOWN_PROTOCOL_LIMITS).toEqual({
      requestPrefixBytes: 16,
      requestHeaderBytes: 163840,
      requestSourceBytes: 1048576,
      requestFrameBytes: 1212432,
      responsePrefixBytes: 12,
      responseMetadataBytes: 262144,
      responseEnvelopeHeadroom: 1024,
      responseEnvelopeBytes: 263168,
      responseFrameBytes: 263180,
    });
    expect(Object.isFrozen(MARKDOWN_PROTOCOL_LIMITS)).toBe(true);
  });

  it("matches fixed-order compact request and object-valued response fixtures", () => {
    const { request, metadata } = fixture();
    const expectedRequest = requestFrame(
      JSON.stringify({
        version: 1,
        source_bytes: source.length,
        source_bytes_sha256: hash(source),
        advertised_titles: [],
      }),
      source,
    );
    const expectedResponse = responseFrame(JSON.stringify({ version: 1, inspection: metadata }));
    expect(Buffer.from(encodeMarkdownRequest(request))).toEqual(expectedRequest);
    expect(Buffer.from(encodeMarkdownResponse(metadata, request))).toEqual(expectedResponse);
    const decoder = createMarkdownResponseDecoder(request);
    expect(decoder.push(expectedResponse)).toBeUndefined();
    const result = decoder.finish();
    expect(result).toEqual(metadata);
    for (const value of [result, result.title_origin, result.links, ...result.links, result.stats])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("accepts a synthetic inspector result without changing its metadata", () => {
    const { request, metadata } = fixture();
    const frame = encodeMarkdownResponse(metadata, request);
    const decoder = createMarkdownResponseDecoder(request);
    for (const byte of frame) decoder.push(Uint8Array.of(byte));
    expect(encodeMarkdownResponse(decoder.finish(), request)).toEqual(frame);
  });

  it("returns independent response frames and detached decoded records", () => {
    const { request } = fixture();
    const input = mutableMetadata();
    const first = encodeMarkdownResponse(input, request);
    const expected = Uint8Array.from(first);
    const decoder = createMarkdownResponseDecoder(request);
    decoder.push(first);
    first.fill(0);
    const decoded = decoder.finish();
    input.links[0].text = "Mutation";
    input.title = "Mutation";
    expect(decoded.title).toBe("Guide");
    expect(decoded.links[0]?.text).toBe("link");
    expect(Buffer.from(encodeMarkdownResponse(decoded, request)).equals(expected)).toBe(true);
  });

  it("requires EOF and makes success terminal", () => {
    const { request, metadata } = fixture();
    const decoders = [
      { decoder: createMarkdownRequestDecoder(), frame: encodeMarkdownRequest(request) },
      { decoder: createMarkdownResponseDecoder(request), frame: encodeMarkdownResponse(metadata, request) },
    ];
    for (const { decoder, frame } of decoders) {
      expect(decoder.push(new Uint8Array())).toBeUndefined();
      expect(decoder.push(frame)).toBeUndefined();
      expect(decoder.push(new Uint8Array())).toBeUndefined();
      decoder.finish();
      expect(() => decoder.push(new Uint8Array())).toThrow(protocolError);
      expect(() => decoder.finish()).toThrow(protocolError);
    }
  });

  it("rejects metadata bound to different source bytes", () => {
    const metadata = mutableMetadata();
    metadata.source_bytes_sha256 = "0".repeat(64);
    expect(() => encodeMarkdownResponse(metadata, fixture().request)).toThrow(protocolError);
  });
});

function assertSticky(decoder: { push(chunk: Uint8Array): void; finish(): unknown }) {
  expect(() => decoder.push(new Uint8Array())).toThrow(protocolError);
  expect(() => decoder.push(Uint8Array.of(0))).toThrow(protocolError);
  expect(() => decoder.finish()).toThrow(protocolError);
}

function rejectsResponse(metadata: any) {
  const { request } = fixture();
  expect(() => encodeMarkdownResponse(metadata, request)).toThrow(protocolError);
  const decoder = createMarkdownResponseDecoder(request);
  decoder.push(responseFrame(JSON.stringify({ version: 1, inspection: metadata })));
  expect(() => decoder.finish()).toThrow(protocolError);
  assertSticky(decoder);
}

describe("data-only encoder boundaries", () => {
  it.each([
    ["not bytes", "source"],
    ["array", [1]],
    ["ArrayBuffer", new ArrayBuffer(1)],
    ["DataView", new DataView(new ArrayBuffer(1))],
    ["wrong typed array", new Uint16Array(1)],
    ["empty", new Uint8Array()],
    ["over limit", new Uint8Array(1048577)],
    ["shared", new Uint8Array(new SharedArrayBuffer(1))],
  ])("rejects source %s", (_, input) => {
    expect(() => prepareMarkdownRequest(input as Uint8Array, [])).toThrow(protocolError);
  });

  it("rejects a detached source", () => {
    const input = new Uint8Array(1);
    structuredClone(input.buffer, { transfer: [input.buffer] });
    expect(() => prepareMarkdownRequest(input, [])).toThrow(protocolError);
  });

  it("copies just a typed-array slice without consulting active byte properties", () => {
    const input = Uint8Array.from([0, ...source, 0]).subarray(1, source.length + 1);
    const getter = vi.fn(() => {
      throw new Error("not data");
    });
    for (const key of ["buffer", "byteOffset", "byteLength", "length", "subarray", Symbol.iterator]) {
      Object.defineProperty(input, key, { get: getter });
    }
    expect(getMarkdownRequestInput(prepareMarkdownRequest(input, [])).bytes).toEqual(Uint8Array.from(source));
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["string", "Title"],
    ["record", { 0: "Title", length: 1 }],
    ["too many", Array(7).fill(null)],
    ["long title", ["x".repeat(4097)]],
    ["nonstring", [1]],
    ["boxed string", [new String("Title")]],
    ["undefined entry", [undefined]],
    ["hole", Array(1)],
    ["extension", Object.assign([], { extra: true })],
    ["symbol", Object.assign([], { [Symbol("extra")]: 1 })],
    ["custom prototype", Object.setPrototypeOf([], null)],
    ["conflict", ["A", "B"]],
    ...["\n", "\t", "\u200b", "\ud800", "\ufffd"].map((value) => [`unsafe ${JSON.stringify(value)}`, [value]] as const),
  ] as [string, unknown][])("rejects title evidence %s", (_, titles) => {
    expect(() => prepareMarkdownRequest(source, titles as (string | null)[])).toThrow(protocolError);
  });

  it("does not call advertisement accessors or scalar coercion hooks", () => {
    const hook = vi.fn(() => "Title");
    const accessor = Object.defineProperty(["Title"], "0", { get: hook });
    const extended = Object.defineProperty([], "toJSON", { get: hook });
    for (const titles of [accessor, extended, [{ toString: hook, toJSON: hook, [Symbol.toPrimitive]: hook }]]) {
      expect(() => prepareMarkdownRequest(source, titles as (string | null)[])).toThrow(protocolError);
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it("accepts ordinary and null-prototype records in arbitrary input key order", () => {
    const { request, metadata } = fixture();
    const nullRecord = (value: object) =>
      Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).reverse()));
    const input = nullRecord({
      ...metadata,
      title_origin: nullRecord(metadata.title_origin),
      links: metadata.links.map(nullRecord),
      stats: nullRecord(metadata.stats),
    });
    expect(encodeMarkdownResponse(input, request)).toEqual(encodeMarkdownResponse(metadata, request));
  });

  it.each(["metadata", "origin", "link", "stats", "links array"])(
    "rejects accessors and extensions at %s without invoking them",
    (location) => {
      const { request } = fixture();
      for (const mode of ["getter", "unknown", "symbol", "toJSON", "prototype"]) {
        const input = mutableMetadata();
        const target =
          location === "metadata"
            ? input
            : location === "origin"
              ? input.title_origin
              : location === "link"
                ? input.links[0]
                : location === "stats"
                  ? input.stats
                  : input.links;
        const hook = vi.fn(() => {
          throw new Error("PRIVATE SOURCE CONTENT");
        });
        if (mode === "getter") Object.defineProperty(target, Object.keys(target)[0]!, { get: hook });
        if (mode === "unknown") Object.defineProperty(target, "unknown", { value: 1 });
        if (mode === "symbol") target[Symbol("extra")] = 1;
        if (mode === "toJSON") target.toJSON = hook;
        if (mode === "prototype") Object.setPrototypeOf(target, { toJSON: hook });
        expect(() => encodeMarkdownResponse(input, request)).toThrow(protocolError);
        expect(hook).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects sparse and extended links, including a hole compensated by an extra key", () => {
    for (const inputLinks of [Array(1), Object.assign(Array(1), { extra: true }), Object.setPrototypeOf([], null)]) {
      const metadata = mutableMetadata();
      metadata.links = inputLinks;
      expect(() => encodeMarkdownResponse(metadata, fixture().request)).toThrow(protocolError);
    }
  });

  it("does not serialize or coerce object-valued scalar fields", () => {
    const hook = vi.fn(() => "Guide");
    const object = { toJSON: hook, toString: hook, [Symbol.toPrimitive]: hook };
    const setters = [
      (m: any) => {
        m.source_bytes = object;
      },
      (m: any) => {
        m.source_bytes_sha256 = object;
      },
      (m: any) => {
        m.title = object;
      },
      (m: any) => {
        m.title_origin.kind = object;
      },
      (m: any) => {
        m.links[0].text = object;
      },
      (m: any) => {
        m.links[0].url = object;
      },
      (m: any) => {
        m.stats.emitted_tokens = object;
      },
    ];
    for (const set of setters) {
      const input = mutableMetadata();
      set(input);
      expect(() => encodeMarkdownResponse(input, fixture().request)).toThrow(protocolError);
    }
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("metadata schema consistency", () => {
  it.each([
    "",
    " ",
    " Guide",
    "Guide ",
    "Guide\t",
    "Guide\n",
    "Guide\r",
    "<Guide>",
    "Guide\u200b",
    "Guide\ud800",
    "Guide\ufffd",
    "x".repeat(4097),
    "界".repeat(1366),
  ])("rejects unsafe, untrimmed or oversized native title %j", (title) => {
    const metadata = mutableMetadata();
    metadata.title = title;
    rejectsResponse(metadata);
  });

  it("keeps literal advertisement selection and the earliest nonempty index", () => {
    const raw = bytes("Plain prose without a heading.");
    const titles = [null, "", " Literal title ", " Literal title "];
    const request = prepareMarkdownRequest(raw, titles);
    const metadata = inspectMarkdownSource(raw, titles);
    expect(metadata.title_origin).toEqual({ kind: "advertisement", witness_index: 2 });
    const frame = encodeMarkdownResponse(metadata, request);
    const decoder = createMarkdownResponseDecoder(request);
    decoder.push(frame);
    expect(decoder.finish()).toEqual(metadata);
    for (const change of [
      { title: "Literal title" },
      { title_origin: { kind: "advertisement", witness_index: 3 } },
      { title_origin: { kind: "advertisement", witness_index: -0 } },
      { title_origin: { kind: "advertisement", witness_index: 6 } },
      { title_origin: { kind: "advertisement", witness_index: 2.5 } },
      { title_origin: { kind: "advertisement" } },
      { title_origin: { kind: "advertisement", witness_index: 2, extra: 1 } },
    ])
      expect(() => encodeMarkdownResponse({ ...metadata, ...change } as any, request)).toThrow(protocolError);
  });

  it("retains non-ASCII edge spaces and literal advertisement markup", () => {
    const raw = bytes("Body");
    const title = "\u00a0Literal *markup*\u00a0";
    const request = prepareMarkdownRequest(raw, [null, "", title, title]);
    const metadata = inspectMarkdownSource(raw, [null, "", title, title]);
    expect(() => encodeMarkdownResponse(metadata, request)).not.toThrow();
    const native = { ...metadata, title_origin: { kind: "markdown-body" as const } };
    expect(() => encodeMarkdownResponse(native, request)).not.toThrow();
  });

  it("allows a native title to differ from a valid advertisement", () => {
    const request = prepareMarkdownRequest(source, ["Different"]);
    expect(() => encodeMarkdownResponse(inspectMarkdownSource(source, ["Different"]), request)).not.toThrow();
  });

  it.each([
    null,
    "markdown-body",
    {},
    { kind: "native" },
    { kind: "markdown-body", witness_index: 0 },
    { kind: "advertisement", witness_index: 0 },
    { kind: "markdown-body", extra: true },
  ])("rejects invalid or unevidenced title origin %j", (origin) => {
    const metadata = mutableMetadata();
    metadata.title_origin = origin;
    rejectsResponse(metadata);
  });

  it.each([
    "javascript:alert(1)",
    "/relative",
    "//example.test/",
    "ftp://example.test/",
    "https://u:p@example.test/",
    "https://example.test/\\bad",
    "https://example.test/%250a",
    "mailto:bad",
    "mailto:a@example.test?unknown=x",
    "tel:no",
    "tel:12?x=y",
    "https://example.test/\ufffd",
  ])("rejects unsafe URI %j", (url) => {
    const metadata = mutableMetadata();
    metadata.links[0].url = url;
    rejectsResponse(metadata);
  });

  it.each([
    "https://example.test/a%20b",
    "HTTP://example.test/",
    "mailto:a@example.test?subject=hello&cc=b@example.test",
    "tel:+1-604-555-0100;ext=2",
  ])("accepts shared nonlexical destination rules for %s", (url) => {
    const metadata = mutableMetadata();
    metadata.links[0].url = url;
    expect(() => encodeMarkdownResponse(metadata, fixture().request)).not.toThrow();
  });

  it.each(["\0", "\n", "\r", "\u007f", "\u0085", "\u202e", "\udfff", "\ufffd", "\ud800\t\udc00"])(
    "rejects unsafe link label %j",
    (label) => {
      const metadata = mutableMetadata();
      metadata.links[0].text = `left${label}right`;
      rejectsResponse(metadata);
    },
  );

  it("preserves empty labels, literal HT, pair order and non-BMP Unicode", () => {
    const metadata = mutableMetadata();
    metadata.title = '界😀"Title';
    metadata.links = [
      { text: "left\tright", url: "https://example.test/" },
      { text: "", url: "https://example.test/" },
      { text: '界😀"\\', url: "https://example.test/" },
      { text: "left\tright", url: "https://example.test/different" },
    ];
    metadata.stats = { emitted_tokens: 10, links: 4, max_depth: 1 };
    const { request } = fixture();
    const frame = encodeMarkdownResponse(metadata, request);
    expect(Buffer.from(frame).subarray(12).toString()).toBe(JSON.stringify({ version: 1, inspection: metadata }));
    const decoder = createMarkdownResponseDecoder(request);
    decoder.push(frame);
    expect(decoder.finish()).toEqual(metadata);
  });

  it("rejects duplicate pairs but allows raw link counts above distinct counts", () => {
    const metadata = mutableMetadata();
    metadata.stats.links = 2;
    expect(() => encodeMarkdownResponse(metadata, fixture().request)).not.toThrow();
    metadata.links.push({ ...metadata.links[0] });
    rejectsResponse(metadata);
  });

  it.each([
    ["emitted_tokens", 0],
    ["emitted_tokens", 50001],
    ["emitted_tokens", 1.5],
    ["emitted_tokens", -0],
    ["emitted_tokens", NaN],
    ["emitted_tokens", Infinity],
    ["emitted_tokens", Number.MAX_SAFE_INTEGER + 1],
    ["emitted_tokens", "4"],
    ["links", -1],
    ["links", -0],
    ["links", 2049],
    ["links", 0.5],
    ["max_depth", 0],
    ["max_depth", -0],
    ["max_depth", 33],
    ["max_depth", 1.5],
  ])("rejects invalid statistic %s=%j", (key, value) => {
    const metadata = mutableMetadata();
    metadata.stats[key] = value;
    expect(() => encodeMarkdownResponse(metadata, fixture().request)).toThrow(protocolError);
  });

  it("enforces necessary token/raw/distinct consistency, not proof of semantics", () => {
    for (const stats of [
      { emitted_tokens: 1, links: 1, max_depth: 1 },
      { emitted_tokens: 4, links: 0, max_depth: 1 },
    ]) {
      const metadata = mutableMetadata();
      metadata.stats = stats;
      rejectsResponse(metadata);
    }
    const metadata = mutableMetadata();
    metadata.links = [];
    metadata.stats = { emitted_tokens: 1, links: 0, max_depth: 1 };
    expect(() => encodeMarkdownResponse(metadata, fixture().request)).not.toThrow();
    metadata.stats = { emitted_tokens: 50000, links: 2048, max_depth: 32 };
    expect(() => encodeMarkdownResponse(metadata, fixture().request)).not.toThrow();
  });

  it.each([
    (m: any) => {
      m.source_bytes++;
    },
    (m: any) => {
      m.source_bytes = -0;
    },
    (m: any) => {
      m.source_bytes_sha256 = m.source_bytes_sha256.toUpperCase();
    },
    (m: any) => {
      m.source_bytes_sha256 = "g".repeat(64);
    },
    (m: any) => {
      m.source_bytes_sha256 = "0".repeat(63);
    },
    (m: any) => {
      delete m.title;
    },
    (m: any) => {
      m.body = "replacement";
    },
    (m: any) => {
      m.profile_digest = "not authority";
    },
    (m: any) => {
      m.links[0].unknown = true;
    },
    (m: any) => {
      m.stats.extra = 1;
    },
  ])("rejects metadata field or source mismatch %#", (change) => {
    const metadata = mutableMetadata();
    change(metadata);
    rejectsResponse(metadata);
  });
});

function smallFrames() {
  const raw = bytes("# T");
  const request = prepareMarkdownRequest(raw, []);
  const metadata = inspectMarkdownSource(raw, []);
  return [
    {
      name: "request",
      prefix: 16,
      frame: Buffer.from(encodeMarkdownRequest(request)),
      create: () => createMarkdownRequestDecoder(),
      encode: (value: any) => encodeMarkdownRequest(value),
    },
    {
      name: "response",
      prefix: 12,
      frame: Buffer.from(encodeMarkdownResponse(metadata, request)),
      create: () => createMarkdownResponseDecoder(request),
      encode: (value: any) => encodeMarkdownResponse(value, request),
    },
  ];
}

function validHeader(body = source) {
  return {
    version: 1,
    source_bytes: body.length,
    source_bytes_sha256: hash(body),
    advertised_titles: [] as (string | null)[],
  };
}

describe("canonical wire admission", () => {
  const noncanonical = [
    ["leading whitespace", (json: string) => ` ${json}`],
    ["trailing newline", (json: string) => `${json}\n`],
    ["BOM", (json: string) => `\ufeff${json}`],
    ["pretty JSON", (json: string) => JSON.stringify(JSON.parse(json), null, 2)],
    ["duplicate version", (json: string) => json.replace('"version":1', '"version":1,"version":1')],
    ["alternate number", (json: string) => json.replace('"version":1', '"version":1.0')],
    ["exponent", (json: string) => json.replace('"version":1', '"version":1e0')],
    ["escaped field", (json: string) => json.replace("version", "vers\\u0069on")],
    ["unknown field", (json: string) => json.replace('"version":1', '"version":1,"extra":0')],
    ["different version", (json: string) => json.replace('"version":1', '"version":2')],
    [
      "field reordering",
      (json: string) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).reverse())),
    ],
    ["another JSON value", (json: string) => `${json}{}`],
  ] as const;

  it.each(noncanonical)("rejects %s in both canonical JSON layers", (_, transform) => {
    const { request, metadata } = fixture();
    const pairs = [
      {
        decoder: createMarkdownRequestDecoder(),
        frame: requestFrame(transform(JSON.stringify(validHeader())), source),
      },
      {
        decoder: createMarkdownResponseDecoder(request),
        frame: responseFrame(transform(JSON.stringify({ version: 1, inspection: metadata }))),
      },
    ];
    for (const { decoder, frame } of pairs) {
      decoder.push(frame);
      expect(() => decoder.finish()).toThrow(protocolError);
      assertSticky(decoder);
    }
  });

  it.each([
    (h: any) => {
      h.source_bytes++;
    },
    (h: any) => {
      h.source_bytes = 0;
    },
    (h: any) => {
      h.source_bytes_sha256 = "0".repeat(64);
    },
    (h: any) => {
      h.source_bytes_sha256 = h.source_bytes_sha256.toUpperCase();
    },
    (h: any) => {
      delete h.advertised_titles;
    },
    (h: any) => {
      h.advertised_titles = [1];
    },
    (h: any) => {
      h.advertised_titles = Array(7).fill(null);
    },
    (h: any) => {
      h.advertised_titles = ["A", "B"];
    },
    (h: any) => {
      h.command = "not protocol data";
    },
    (h: any) => {
      Object.setPrototypeOf(h, null);
      h.module = "not protocol data";
    },
  ])("rejects request schema/hash disagreements %#", (change) => {
    const header = validHeader();
    change(header);
    const decoder = createMarkdownRequestDecoder();
    decoder.push(requestFrame(JSON.stringify(header), source));
    expect(() => decoder.finish()).toThrow(protocolError);
    assertSticky(decoder);
  });

  it.each([null, [], "metadata", 1, true])("rejects nonrecord request or envelope %j", (value) => {
    const request = createMarkdownRequestDecoder();
    request.push(requestFrame(JSON.stringify(value), source));
    expect(() => request.finish()).toThrow(protocolError);
    const response = createMarkdownResponseDecoder(fixture().request);
    response.push(responseFrame(JSON.stringify(value)));
    expect(() => response.finish()).toThrow(protocolError);
  });

  it("rejects nested JSON strings and duplicate, reordered or noncanonical nested fields", () => {
    const { request, metadata } = fixture();
    const json = JSON.stringify({ version: 1, inspection: metadata });
    for (const variant of [
      JSON.stringify({ version: 1, inspection: JSON.stringify(metadata) }),
      json.replace('"title":"Guide"', '"title":"Guide","title":"Guide"'),
      json.replace('"title":"Guide"', '"title":"Gu\\u0069de"'),
      json.replace('"kind":"markdown-body"', '"kind":"markdown-body","kind":"markdown-body"'),
      json.replace('"links":1', '"links":1,"links":1'),
      json.replace('"links":1', '"links":-0'),
      json.replace(
        '"text":"link","url":"https://example.test/path"',
        '"url":"https://example.test/path","text":"link"',
      ),
      json.replace("https://", "https:\\/\\/"),
      json.replace('"title":"Guide"', '"title":"\\ud800"'),
    ]) {
      const decoder = createMarkdownResponseDecoder(request);
      decoder.push(responseFrame(variant));
      expect(() => decoder.finish()).toThrow(protocolError);
      assertSticky(decoder);
    }
  });

  it("rejects fatal UTF8 in JSON, but not arbitrary request body bytes", () => {
    for (const { frame, prefix, create } of smallFrames()) {
      for (const sequence of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]]) {
        const input = Buffer.from(frame);
        input.set(sequence, prefix + 3);
        const decoder = create();
        decoder.push(input);
        expect(() => decoder.finish()).toThrow(protocolError);
        assertSticky(decoder);
      }
    }
  });

  it("rejects disagreement between prefix, header and actual source lengths", () => {
    for (const delta of [-1, 1]) {
      const frame = requestFrame(JSON.stringify(validHeader()), source, source.length + delta);
      const decoder = createMarkdownRequestDecoder();
      expect(() => {
        decoder.push(frame);
        decoder.finish();
      }).toThrow(protocolError);
      assertSticky(decoder);
    }
    const frame = requestFrame(JSON.stringify(validHeader()), Buffer.concat([source, Uint8Array.of(0)]));
    const decoder = createMarkdownRequestDecoder();
    decoder.push(frame);
    expect(() => decoder.finish()).toThrow(protocolError);
    assertSticky(decoder);
  });

  it("does not accept source mutation with the original request digest", () => {
    const frame = Buffer.from(encodeMarkdownRequest(fixture().request));
    frame[frame.length - 1] = frame[frame.length - 1]! ^ 1;
    const decoder = createMarkdownRequestDecoder();
    decoder.push(frame);
    expect(() => decoder.finish()).toThrow(protocolError);
  });
});

describe("incremental EOF and terminal failures", () => {
  it.each(smallFrames())(
    "preserves $name bytes at every one- and two-cut whole-frame partition",
    ({ frame, create, encode }) => {
      let count = 0;
      for (let first = 0; first <= frame.length; first++) {
        for (let second = first; second <= frame.length; second++) {
          const decoder = create();
          decoder.push(new Uint8Array());
          decoder.push(frame.subarray(0, first));
          decoder.push(frame.subarray(first, second));
          decoder.push(frame.subarray(second));
          decoder.push(new Uint8Array());
          if (!Buffer.from(encode(decoder.finish())).equals(frame)) throw new Error("Partition mismatch");
          count++;
        }
      }
      expect(count).toBe(((frame.length + 1) * (frame.length + 2)) / 2);
    },
  );

  it.each(smallFrames())("preserves $name bytes for every prefix partition", ({ frame, prefix, create, encode }) => {
    for (let mask = 0; mask < 2 ** (prefix - 1); mask++) {
      const decoder = create();
      let start = 0;
      for (let offset = 1; offset < prefix; offset++) {
        if (mask & (1 << (offset - 1))) {
          decoder.push(frame.subarray(start, offset));
          start = offset;
        }
      }
      decoder.push(frame.subarray(start, prefix));
      decoder.push(frame.subarray(prefix));
      if (!Buffer.from(encode(decoder.finish())).equals(frame)) throw new Error("Prefix partition mismatch");
    }
  });

  it.each(smallFrames())("rejects $name truncation at every position and cannot recover", ({ frame, create }) => {
    for (let end = 0; end < frame.length; end++) {
      const decoder = create();
      decoder.push(frame.subarray(0, end));
      expect(() => decoder.finish()).toThrow(protocolError);
      expect(() => decoder.push(frame.subarray(end))).toThrow(protocolError);
      assertSticky(decoder);
    }
  });

  it.each(smallFrames())("rejects $name trailing bytes in the same or subsequent push", ({ frame, create }) => {
    for (const split of [0, 1, 8, frame.length - 1, frame.length]) {
      const decoder = create();
      const extra = Buffer.concat([frame, Uint8Array.of(0)]);
      decoder.push(extra.subarray(0, split));
      expect(() => decoder.push(extra.subarray(split))).toThrow(protocolError);
      assertSticky(decoder);
    }
    const decoder = create();
    expect(() => decoder.push(Buffer.concat([frame, frame]))).toThrow(protocolError);
    assertSticky(decoder);
  });

  it.each(smallFrames())("copies every admitted $name chunk before returning", ({ frame, create, encode }) => {
    const decoder = create();
    for (const byte of frame) {
      const chunk = Uint8Array.of(byte);
      decoder.push(chunk);
      chunk[0] = chunk[0]! ^ 255;
    }
    expect(Buffer.from(encode(decoder.finish()))).toEqual(frame);
  });

  it.each(smallFrames())("rejects invalid/shared $name chunks even when empty", ({ frame, create }) => {
    for (const chunk of [
      null,
      [],
      new Uint16Array(1),
      new Uint8Array(new SharedArrayBuffer(0)),
      new Uint8Array(new SharedArrayBuffer(1)),
    ]) {
      const decoder = create();
      decoder.push(frame.subarray(0, 2));
      expect(() => decoder.push(chunk as Uint8Array)).toThrow(protocolError);
      assertSticky(decoder);
    }
  });

  it.each(smallFrames())("rejects detached $name chunks and permanently closes", ({ create }) => {
    const input = new Uint8Array(1);
    structuredClone(input.buffer, { transfer: [input.buffer] });
    const decoder = create();
    expect(() => decoder.push(input)).toThrow(protocolError);
    assertSticky(decoder);
  });

  it.each(smallFrames())("rejects every $name magic-byte mutation on prefix admission", ({ frame, prefix, create }) => {
    for (let index = 0; index < 8; index++) {
      const input = Buffer.from(frame.subarray(0, prefix));
      input[index] = input[index]! ^ 1;
      const decoder = create();
      expect(() => decoder.push(input)).toThrow(protocolError);
      assertSticky(decoder);
    }
  });
});

function maximumMetadata() {
  const make = (extra: number) =>
    bytes(
      Array.from(
        { length: 33 },
        (_, index) => `[${"x".repeat(index < 32 ? 7900 : extra)}](https://example.org/${index})`,
      ).join("\n\n"),
    );
  const titles = ["Advertisement"];
  const initial = inspectMarkdownSource(make(1), titles);
  const extra = 1 + MARKDOWN_PROTOCOL_LIMITS.responseMetadataBytes - Buffer.byteLength(JSON.stringify(initial));
  const raw = make(extra);
  return {
    request: prepareMarkdownRequest(raw, titles),
    metadata: inspectMarkdownSource(raw, titles),
    overflow: make(extra + 1),
    titles,
  };
}

function deterministicChunks(frame: Uint8Array, seed: number) {
  const chunks = [];
  let offset = 0;
  let state = seed;
  while (offset < frame.length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const end = Math.min(frame.length, offset + 1 + (state % 16384));
    chunks.push(frame.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

describe("aggregate and transport ceilings", () => {
  it("admits maximum raw source and six bounded multibyte hints", () => {
    const raw = new Uint8Array(1048576).fill(0xff);
    const titles = Array<string>(6).fill("界".repeat(4096));
    const request = prepareMarkdownRequest(raw, titles);
    const frame = Buffer.from(encodeMarkdownRequest(request));
    expect(frame.readUInt32BE(8)).toBe(73893);
    expect(frame.readUInt32BE(12)).toBe(1048576);
    for (const seed of [0, 1, 2, 17, 123, 0xdeadbeef]) {
      const decoder = createMarkdownRequestDecoder();
      for (const chunk of deterministicChunks(frame, seed)) decoder.push(chunk);
      const decoded = decoder.finish();
      expect(Buffer.from(encodeMarkdownRequest(decoded)).equals(frame)).toBe(true);
      expect(Buffer.from(getMarkdownRequestInput(decoded).bytes).equals(raw)).toBe(true);
    }
  });

  it("frames the exact maximum honest inspector metadata as an object", () => {
    const { request, metadata, overflow, titles } = maximumMetadata();
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBe(262144);
    const frame = Buffer.from(encodeMarkdownResponse(metadata, request));
    expect(frame.readUInt32BE(8)).toBe(262171);
    expect(frame.length).toBe(262183);
    expect(JSON.parse(frame.subarray(12).toString()).inspection).toEqual(metadata);
    for (const seed of [0, 1, 2, 17, 123, 0xdeadbeef]) {
      const decoder = createMarkdownResponseDecoder(request);
      for (const chunk of deterministicChunks(frame, seed)) decoder.push(chunk);
      expect(Buffer.from(encodeMarkdownResponse(decoder.finish(), request)).equals(frame)).toBe(true);
    }
    expect(() => inspectMarkdownSource(overflow, titles)).toThrow("metadata byte limit");
    const tooLarge = JSON.parse(JSON.stringify(metadata));
    tooLarge.links[32].text += "x";
    expect(() => encodeMarkdownResponse(tooLarge, request)).toThrow(protocolError);
    const decoder = createMarkdownResponseDecoder(request);
    decoder.push(responseFrame(JSON.stringify({ version: 1, inspection: tooLarge })));
    expect(() => decoder.finish()).toThrow(protocolError);
  });

  it("counts escaped and multibyte scalars against aggregate metadata bytes", () => {
    const { request, metadata } = maximumMetadata();
    for (const [character, unitBytes] of [
      ["界", 3],
      ["😀", 4],
      ["\t", 2],
      ['"', 2],
      ["\\", 2],
    ] as const) {
      const input = JSON.parse(JSON.stringify(metadata));
      input.links[0].text = character + input.links[0].text.slice(unitBytes);
      expect(Buffer.byteLength(JSON.stringify(input))).toBe(262144);
      expect(() => encodeMarkdownResponse(input, request)).not.toThrow();
      input.links[0].text += "x";
      expect(() => encodeMarkdownResponse(input, request)).toThrow(protocolError);
    }
  });

  it("bounds aggregate assembly before serializing all individually bounded fields", () => {
    const metadata = mutableMetadata();
    metadata.links = Array.from({ length: 2048 }, (_, index) => ({
      text: "x".repeat(16384),
      url: `https://example.test/${index}`,
    }));
    metadata.stats = { emitted_tokens: 50000, links: 2048, max_depth: 32 };
    const { request } = fixture();
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(() => encodeMarkdownResponse(metadata, request)).toThrow(protocolError);
      expect(stringify.mock.calls.length).toBeLessThan(50);
      expect(stringify.mock.calls.every(([value]) => typeof value === "string")).toBe(true);
      expect(stringify.mock.calls.filter(([value]) => value === metadata.links[0].text).length).toBeLessThan(16);
    } finally {
      stringify.mockRestore();
    }
  });

  it("rejects obvious code-unit overflow without serializing the giant scalar", () => {
    const metadata = mutableMetadata();
    const enormous = "x".repeat(2 * MARKDOWN_PROTOCOL_LIMITS.responseMetadataBytes);
    metadata.links[0].text = enormous;
    const { request } = fixture();
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(() => encodeMarkdownResponse(metadata, request)).toThrow(protocolError);
      expect(stringify.mock.calls.some(([value]) => value === enormous)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it("admits exactly 2048 distinct pairs and rejects one more", () => {
    const metadata = mutableMetadata();
    metadata.links = Array.from({ length: 2048 }, (_, index) => ({ text: "x", url: `https://example.test/${index}` }));
    metadata.stats = { emitted_tokens: 4096, links: 2048, max_depth: 1 };
    expect(() => encodeMarkdownResponse(metadata, fixture().request)).not.toThrow();
    metadata.links.push({ text: "extra", url: "https://example.test/extra" });
    rejectsResponse(metadata);
  });

  it.each([
    ["header zero", 0, 1],
    ["header overflow", 163841, 1],
    ["header u32", 0xffffffff, 1],
    ["source zero", 1, 0],
    ["source overflow", 1, 1048577],
    ["source u32", 1, 0xffffffff],
  ])("rejects request %s before payload allocation", (_, headerSize, sourceSize) => {
    const prefix = Buffer.alloc(16);
    prefix.write("UBCMDQ01");
    prefix.writeUInt32BE(headerSize as number, 8);
    prefix.writeUInt32BE(sourceSize as number, 12);
    const chunk = Buffer.concat([prefix, Buffer.alloc(2 * 1048576)]);
    const decoder = createMarkdownRequestDecoder();
    const allocate = vi.spyOn(Buffer, "alloc");
    try {
      expect(() => decoder.push(chunk)).toThrow(protocolError);
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
    }
    assertSticky(decoder);
  });

  it.each([0, 263169, 0xffffffff])("rejects response overclaim %d before payload allocation", (size) => {
    const prefix = Buffer.alloc(12);
    prefix.write("UBCMDR01");
    prefix.writeUInt32BE(size, 8);
    const decoder = createMarkdownResponseDecoder(fixture().request);
    const allocate = vi.spyOn(Buffer, "alloc");
    try {
      expect(() => decoder.push(prefix)).toThrow(protocolError);
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
    }
    assertSticky(decoder);
  });

  it("admits transport ceilings without inventing schema-valid maximum headers", () => {
    const requestPrefix = Buffer.alloc(16);
    requestPrefix.write("UBCMDQ01");
    requestPrefix.writeUInt32BE(163840, 8);
    requestPrefix.writeUInt32BE(1048576, 12);
    const responsePrefix = Buffer.alloc(12);
    responsePrefix.write("UBCMDR01");
    responsePrefix.writeUInt32BE(263168, 8);
    for (const [prefix, size, create] of [
      [requestPrefix, 1212432, () => createMarkdownRequestDecoder()],
      [responsePrefix, 263180, () => createMarkdownResponseDecoder(fixture().request)],
    ] as const) {
      const decoder = create();
      const allocate = vi.spyOn(Buffer, "alloc");
      try {
        expect(() => decoder.push(prefix)).not.toThrow();
        expect(allocate).toHaveBeenCalledExactlyOnceWith(size);
      } finally {
        allocate.mockRestore();
      }
      decoder.push(new Uint8Array(size - prefix.length));
      expect(() => decoder.finish()).toThrow(protocolError);
      assertSticky(decoder);
    }
  });

  it("rejects oversized incoming chunks before allocating an otherwise valid declared frame", () => {
    for (const { frame, prefix, create } of smallFrames()) {
      const chunk = Buffer.alloc(2 * 1048576);
      chunk.set(frame.subarray(0, prefix));
      const decoder = create();
      const allocate = vi.spyOn(Buffer, "alloc");
      try {
        expect(() => decoder.push(chunk)).toThrow(protocolError);
        expect(allocate).not.toHaveBeenCalled();
      } finally {
        allocate.mockRestore();
      }
      assertSticky(decoder);
    }
  });
});
