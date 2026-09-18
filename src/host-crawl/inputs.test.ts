import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertCollectedInput, decodeFrozenSeed } from "./inputs.ts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
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
