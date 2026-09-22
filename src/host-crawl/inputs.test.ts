import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertCollectedInput,
  decodeFrozenSeed,
  deriveCollectionInputDigest,
  type CollectionInputDigests,
} from "./inputs.ts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const recording = "a".repeat(64);
const seed = "b".repeat(64);
const pdf = "c".repeat(64);
const markdown = "d".repeat(64);
const docx = "e".repeat(64);
const pptx = "f".repeat(64);
describe("captured collection inputs", () => {
  it("binds parsed URLs to the same captured bytes even if the input buffer changes", () => {
    const original = Buffer.from(
      JSON.stringify({ hostname: "example.ubc.ca", urls: [{ url: "https://example.ubc.ca/guide" }] }),
    );
    const before = hash(original);
    const seed = decodeFrozenSeed(original, "example.ubc.ca");
    original.fill(0);
    expect(seed.urls.map((row) => row.url)).toEqual(["https://example.ubc.ca/guide"]);
    expect(hash(seed.bytes)).toBe(before);
    expect(JSON.parse(seed.bytes.toString("utf8")).urls).toEqual(seed.urls);
  });
  it("rejects unrelated, invalid and malformed frontier bytes", () => {
    for (const value of [
      { hostname: "other.ubc.ca", urls: [] },
      { hostname: "example.ubc.ca", urls: [null] },
      { hostname: "example.ubc.ca", urls: [{}] },
    ])
      expect(() => decodeFrozenSeed(Buffer.from(JSON.stringify(value)), "example.ubc.ca")).toThrow();
    expect(() => decodeFrozenSeed(Buffer.from([0xff]), "example.ubc.ca")).toThrow();
  });
  it("rejects a different consistently resealed recording rather than accepting self-consistency", () => {
    const captured = "a".repeat(64),
      resealed = "b".repeat(64);
    expect(() => assertCollectedInput(captured, captured)).not.toThrow();
    expect(() => assertCollectedInput(captured, resealed)).toThrow(/differs/);
  });
});

describe("collection input digest encoding", () => {
  it.each([
    ["legacy", {}, "4cbe921b952001870e47e6036bafdb3114e321bb0c93a4e423ca3eb95b26bf49"],
    ["PDF", { pdf_profile: pdf }, "0d8f4a683ce48b93c14ed2c31293ba9a8f047c5f054bb60654af70a257cff209"],
    ["Markdown", { markdown_profile: markdown }, "19ef8e8e8ced4d00d13f6ec24de82a0db6493eaa45df28f031d42ea52a99d0f1"],
    ["DOCX", { docx_profile: docx }, "53a6343952dbf7cbd910d3cf5165d5318a10c39283e21cabdbcde120ec998e01"],
    ["PPTX", { pptx_profile: pptx }, "701734d074b47e7f6f54d05bf82b3b644c5a2d5ca3853535edb958ff6c2b4025"],
    [
      "both profiles",
      { pdf_profile: pdf, markdown_profile: markdown },
      "ff6cfe242477d7dd0b6aa587de09dda26ee7bcc5a4c3c43b89c32f884cf92bd4",
    ],
  ] as const)("matches the independent %s hash vector", (_label, profiles, expected) => {
    expect(deriveCollectionInputDigest({ recording, seed, ...profiles })).toBe(expected);
  });

  it("omits undefined optionals without adding null or a schema marker", () => {
    const expected = "4cbe921b952001870e47e6036bafdb3114e321bb0c93a4e423ca3eb95b26bf49";
    expect(deriveCollectionInputDigest({ recording, seed, pdf_profile: undefined })).toBe(expected);
    expect(deriveCollectionInputDigest({ recording, seed, markdown_profile: undefined })).toBe(expected);
    expect(deriveCollectionInputDigest({ recording, seed, pdf_profile: undefined, markdown_profile: undefined })).toBe(
      expected,
    );
    expect(deriveCollectionInputDigest({ recording, seed, pdf_profile: pdf, markdown_profile: undefined })).toBe(
      "0d8f4a683ce48b93c14ed2c31293ba9a8f047c5f054bb60654af70a257cff209",
    );
    expect(deriveCollectionInputDigest({ recording, seed, pdf_profile: undefined, markdown_profile: markdown })).toBe(
      "19ef8e8e8ced4d00d13f6ec24de82a0db6493eaa45df28f031d42ea52a99d0f1",
    );
  });

  it("preserves all former string and Buffer hash expressions for deterministic legacy inputs", () => {
    for (let index = 0; index < 32; index++) {
      const seal = hash(Buffer.from(`recording-${index}`));
      const seedHash = hash(Buffer.from(`seed-${index}`));
      for (const profile of [undefined, hash(Buffer.from(`pdf-${index}`))]) {
        const input = { recording: seal, seed: seedHash, ...(profile ? { pdf_profile: profile } : {}) };
        const encoded = JSON.stringify(input);
        expect(deriveCollectionInputDigest(input)).toBe(hash(Buffer.from(encoded)));
        expect(deriveCollectionInputDigest(input)).toBe(createHash("sha256").update(encoded).digest("hex"));
      }
    }
  });

  it("uses canonical field order for every permutation of the supplied keys", () => {
    const entries = Object.entries({
      recording,
      seed,
      pdf_profile: pdf,
      docx_profile: docx,
      pptx_profile: pptx,
      markdown_profile: markdown,
    });
    function* permutations<T>(values: T[]): Generator<T[]> {
      if (!values.length) yield [];
      for (let index = 0; index < values.length; index++) {
        for (const rest of permutations(values.filter((_, position) => position !== index))) {
          yield [values[index]!, ...rest];
        }
      }
    }
    let checked = 0;
    for (const permutation of permutations(entries)) {
      const input = Object.fromEntries(permutation) as unknown as CollectionInputDigests;
      const before = JSON.stringify(input);
      expect(deriveCollectionInputDigest(input)).toBe(
        "ef1401669a7005e7281dcc06c0e88a3b8af215df08651d2fff918ea318333dbf",
      );
      expect(JSON.stringify(input)).toBe(before);
      checked++;
    }
    expect(checked).toBe(720);
  });

  it("binds every supplied digest and distinguishes profile roles", () => {
    const input = {
      recording,
      seed,
      pdf_profile: pdf,
      docx_profile: docx,
      pptx_profile: pptx,
      markdown_profile: markdown,
    };
    const expected = deriveCollectionInputDigest(input);
    for (const key of Object.keys(input)) {
      expect(deriveCollectionInputDigest({ ...input, [key]: "9".repeat(64) })).not.toBe(expected);
    }
    expect(deriveCollectionInputDigest({ ...input, pdf_profile: markdown, markdown_profile: pdf })).not.toBe(expected);
    expect(deriveCollectionInputDigest({ recording, seed, pdf_profile: pdf })).not.toBe(
      deriveCollectionInputDigest({ recording, seed, markdown_profile: pdf }),
    );
  });

  it("accepts frozen and null-prototype data records without changing them", () => {
    const input = Object.freeze({ recording, seed, pdf_profile: pdf });
    const nullPrototype = Object.assign(Object.create(null), input) as CollectionInputDigests;
    const before = Object.getOwnPropertyDescriptors(nullPrototype);
    expect(deriveCollectionInputDigest(input)).toBe("0d8f4a683ce48b93c14ed2c31293ba9a8f047c5f054bb60654af70a257cff209");
    expect(deriveCollectionInputDigest(nullPrototype)).toBe(deriveCollectionInputDigest(input));
    expect(Object.getOwnPropertyDescriptors(nullPrototype)).toEqual(before);
    expect(Object.getPrototypeOf(nullPrototype)).toBeNull();
  });

  it.each(["recording", "seed", "pdf_profile", "docx_profile", "pptx_profile", "markdown_profile"] as const)(
    "rejects malformed %s values",
    (field) => {
      for (const invalid of [null, "", "a".repeat(63), "A".repeat(64), "g".repeat(64), `${recording}\n`, 1, {}, []]) {
        expect(() =>
          deriveCollectionInputDigest({ recording, seed, [field]: invalid } as unknown as CollectionInputDigests),
        ).toThrow(/Invalid collection input/);
      }
    },
  );

  it.each([
    null,
    undefined,
    [],
    "record",
    {},
    { recording },
    { seed },
    { recording: undefined, seed },
    { recording, seed: undefined },
    { recording, seed, markdown_profiel: markdown },
    { recording, seed, schema: 2 },
    { recording, seed, [Symbol("hidden")]: markdown },
    Object.create({ recording, seed }),
  ])("rejects missing fields, unknown fields and non-record shapes %#", (input) => {
    expect(() => deriveCollectionInputDigest(input as CollectionInputDigests)).toThrow(/Invalid collection input/);
  });

  it.each(["recording", "seed", "pdf_profile", "docx_profile", "pptx_profile", "markdown_profile"] as const)(
    "does not invoke a %s accessor",
    (field) => {
      let calls = 0;
      const input = { recording, seed };
      Object.defineProperty(input, field, {
        enumerable: true,
        get() {
          calls++;
          return markdown;
        },
      });
      expect(() => deriveCollectionInputDigest(input)).toThrow(/Invalid collection input/);
      expect(calls).toBe(0);
    },
  );

  it.each(["pdf_profile", "docx_profile", "pptx_profile", "markdown_profile"] as const)(
    "does not read inherited %s descriptor values",
    (field) => {
      const input = Object.assign(Object.create(null), { recording, seed }) as CollectionInputDigests;
      const original = Object.getOwnPropertyDescriptor(Object.prototype, field);
      let calls = 0;
      let actual: string;
      try {
        Object.defineProperty(Object.prototype, field, {
          configurable: true,
          get() {
            calls++;
            return { value: pdf };
          },
        });
        actual = deriveCollectionInputDigest(input);
      } finally {
        if (original) Object.defineProperty(Object.prototype, field, original);
        else Reflect.deleteProperty(Object.prototype, field);
      }
      expect(calls).toBe(0);
      expect(actual).toBe("4cbe921b952001870e47e6036bafdb3114e321bb0c93a4e423ca3eb95b26bf49");
    },
  );

  it("does not invoke an unknown toJSON method or accessor", () => {
    let calls = 0;
    for (const accessor of [false, true]) {
      const input = { recording, seed };
      const value = () => {
        calls++;
        return { recording, seed };
      };
      Object.defineProperty(input, "toJSON", accessor ? { get: value } : { value });
      expect(() => deriveCollectionInputDigest(input)).toThrow(/Invalid collection input/);
    }
    expect(calls).toBe(0);
  });
});
