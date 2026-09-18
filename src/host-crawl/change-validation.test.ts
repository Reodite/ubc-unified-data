import { describe, expect, it } from "vitest";
import { assertSingleHostChange, type ChangedFile } from "./change-validation.ts";

const host = "fixture.ubc.ca";
function fixture(): ChangedFile[] {
  return [
    `src/host-scrapers/${host}/index.ts`,
    `src/host-scrapers/${host}/index.test.ts`,
    "src/host-crawl/registry.ts",
    "data/official-hosts.json",
    `data/documents/${host}/${"a".repeat(64)}.md`,
  ].map((path) => ({ path, bytes: Buffer.from("text\n") }));
}
describe("one-host staged publication boundary", () => {
  it("accepts one complete host with shared foundation code", () =>
    expect(
      assertSingleHostChange([...fixture(), { path: "src/host-crawl/collect.ts", bytes: Buffer.from("export {};\n") }]),
    ).toBe(host));
  it.each([
    "data/document-crawl/raw.json",
    "data/documents-crawl/markdown/final.md",
    "data/documentation-crawl/state.json",
    ".cache/document-crawl/state.sqlite",
    "DOMAINS.tsv",
    "CRAWL-COVERAGE.md",
    "data/prose/changed.json",
    "data/queue.jsonl",
  ])("rejects intermediate or unrelated dataset change %s", (path) =>
    expect(() => assertSingleHostChange([...fixture(), { path, bytes: Buffer.from("{}") }])).toThrow(),
  );
  it("rejects multiple hosts and incomplete commit units", () => {
    expect(() =>
      assertSingleHostChange([
        ...fixture(),
        { path: "src/host-scrapers/other.ubc.ca/index.ts", bytes: Buffer.from("code") },
      ]),
    ).toThrow(/exactly one/);
    for (let i = 0; i < fixture().length; i++)
      expect(() => assertSingleHostChange(fixture().filter((_entry, index) => index !== i))).toThrow();
  });
  it.each([
    Buffer.from([0xff]),
    Buffer.from("binary\0value"),
    Buffer.from("version https://git-lfs.github.com/spec/v1\n"),
    Buffer.alloc(1024 * 1024 + 1, "x"),
  ])("rejects unsafe or oversized bytes", (bytes) =>
    expect(() => assertSingleHostChange([...fixture(), { path: "extra.md", bytes }])).toThrow(),
  );
  it("accepts one generic declaration without bespoke files", () => {
    const files: ChangedFile[] = [
      {
        path: "src/host-scrapers/generic-hosts.json",
        previousBytes: Buffer.from("[]\n"),
        bytes: Buffer.from(JSON.stringify([host])),
      },
      { path: "data/official-hosts.json", bytes: Buffer.from("[]\n") },
      { path: `data/documents/${host}/${"a".repeat(64)}.md`, bytes: Buffer.from("text\n") },
    ];
    expect(assertSingleHostChange(files)).toBe(host);
    expect(() => assertSingleHostChange([{ ...files[0]!, previousBytes: undefined }, ...files.slice(1)])).toThrow(
      /baseline/,
    );
    expect(() =>
      assertSingleHostChange([
        { ...files[0]!, bytes: Buffer.from(JSON.stringify([host, "other.ubc.ca"])) },
        ...files.slice(1),
      ]),
    ).toThrow(/only the published/);
    expect(() =>
      assertSingleHostChange([{ ...files[0]!, previousBytes: Buffer.from('["old.ubc.ca"]') }, ...files.slice(1)]),
    ).toThrow(/only the published/);
  });
  it("rejects LFS attributes and deleted required source", () => {
    expect(() =>
      assertSingleHostChange([...fixture(), { path: ".gitattributes", bytes: Buffer.from("*.json filter=lfs\n") }]),
    ).toThrow(/LFS/);
    const files = fixture();
    files[0]!.bytes = null;
    expect(() => assertSingleHostChange(files)).toThrow(/Missing/);
  });
});
