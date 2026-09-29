import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  fail,
  hasUnsafeMarkdownCharacter,
  MARKDOWN_INSPECTION_DIALECT,
  MARKDOWN_INSPECTION_LIMITS,
  validateAdvertisements,
  validateDestination,
  validateTitle,
  type MarkdownInspection,
  type MarkdownTitleOrigin,
} from "./markdown-contract.mjs";
import {
  inspectMarkdownSource,
  MARKDOWN_INSPECTION_DIALECT as INSPECTOR_DIALECT,
  MARKDOWN_INSPECTION_LIMITS as INSPECTOR_LIMITS,
  type MarkdownInspection as InspectorInspection,
  type MarkdownTitleOrigin as InspectorTitleOrigin,
} from "./markdown-inspection.mjs";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";

function expectDeepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

const fixedError = (reason: string) => new Error(`Markdown inspection: ${reason}.`);
const fetchGuard = vi.fn(() => {
  throw new Error("Network is forbidden in contract tests.");
});
beforeAll(() => vi.stubGlobal("fetch", fetchGuard));
afterAll(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("parser-free Markdown contract and inspector facade", () => {
  it("keeps the same deeply immutable limits object and dialect", () => {
    expect(INSPECTOR_LIMITS).toBe(MARKDOWN_INSPECTION_LIMITS);
    expect(INSPECTOR_DIALECT).toBe(MARKDOWN_INSPECTION_DIALECT);
    expect(MARKDOWN_INSPECTION_DIALECT).toBe("ubc-markdown-verbatim-v2/markdown-it-15.0.2");
    expect(MARKDOWN_INSPECTION_LIMITS).toEqual({
      inputBytes: 1048576,
      lineBytes: 16384,
      lines: 16384,
      tokens: 50000,
      links: 2048,
      nesting: 32,
      titleBytes: 4096,
      metadataBytes: 262144,
      advertisedTitles: 6,
      advertisedTitleCodeUnits: 4096,
    });
    expectDeepFrozen(MARKDOWN_INSPECTION_LIMITS);
    expect(Reflect.set(MARKDOWN_INSPECTION_LIMITS, "inputBytes", 1)).toBe(false);
    expect(Reflect.deleteProperty(MARKDOWN_INSPECTION_LIMITS, "links")).toBe(false);
    expect(() => Object.defineProperty(MARKDOWN_INSPECTION_LIMITS, "extra", { value: 1 })).toThrow(TypeError);
    expect(INSPECTOR_LIMITS.inputBytes).toBe(1048576);
  });

  it("loads alone with every further module resolution denied", async () => {
    const source = await readFile(new URL("./markdown-contract.mjs", import.meta.url), "utf8");
    await mkdir(DEFAULT_EXTERNAL_ROOT, { recursive: true });
    const root = await mkdtemp(join(DEFAULT_EXTERNAL_ROOT, "test-markdown-contract-"));
    try {
      for (const [name, prefix] of [
        ["contract", ""],
        ["static-import", 'import "node:path";\n'],
        ["caught-import", 'await import("node:path").catch(() => {});\n'],
      ] as const) {
        const addedImport = name !== "contract";
        const file = join(root, `${name}.mjs`);
        await writeFile(file, `${prefix}${source}`);
        const entry = pathToFileURL(file).href;
        const code = `
          import { registerHooks } from 'node:module';
          globalThis.fetch = () => { throw new Error('Network is forbidden.'); };
          const entry = ${JSON.stringify(entry)};
          let denied = false;
          registerHooks({ resolve(specifier, context, next) {
            if (specifier !== entry) {
              denied = true;
              throw new Error('Contract dependency refused.');
            }
            return next(specifier, context);
          }});
          const contract = await import(entry);
          if (contract.validateTitle('Title') !== 'Title') throw new Error('Invalid title result.');
          contract.validateDestination('https://example.org/a');
          if (!Object.isFrozen(contract.MARKDOWN_INSPECTION_LIMITS)) throw new Error('Mutable limits.');
          if (denied) throw new Error('Contract dependency refused.');
          console.log('contract-only');
        `;
        const child = spawnSync(
          process.execPath,
          ["--permission", `--allow-fs-read=${file}`, "--input-type=module", "--eval", code],
          {
            cwd: root,
            env: { LC_ALL: "C", LANG: "C", TZ: "UTC", UV_THREADPOOL_SIZE: "1" },
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 5000,
            killSignal: "SIGKILL",
            maxBuffer: 8192,
          },
        );
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status).toBe(addedImport ? 1 : 0);
        expect(child.stdout.toString("utf8")).toBe(addedImport ? "" : "contract-only\n");
        if (addedImport) expect(child.stderr.toString("utf8")).toContain("Contract dependency refused.");
        else expect(child.stderr.toString("utf8")).toBe("");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves consumer types and precise validator declarations", () => {
    expectTypeOf<InspectorInspection>().toEqualTypeOf<MarkdownInspection>();
    expectTypeOf<InspectorTitleOrigin>().toEqualTypeOf<MarkdownTitleOrigin>();
    expectTypeOf(inspectMarkdownSource).returns.toEqualTypeOf<MarkdownInspection>();
    expectTypeOf(inspectMarkdownSource).parameters.toEqualTypeOf<[Uint8Array, readonly (string | null)[]]>();
    expectTypeOf(MARKDOWN_INSPECTION_LIMITS).toEqualTypeOf<typeof INSPECTOR_LIMITS>();
    expectTypeOf(MARKDOWN_INSPECTION_LIMITS.inputBytes).toEqualTypeOf<1048576>();
    expectTypeOf(MARKDOWN_INSPECTION_DIALECT).toEqualTypeOf<"ubc-markdown-verbatim-v2/markdown-it-15.0.2">();
    expectTypeOf(fail).parameters.toEqualTypeOf<[string]>();
    expectTypeOf(fail).returns.toEqualTypeOf<never>();
    expectTypeOf(hasUnsafeMarkdownCharacter).parameters.toEqualTypeOf<[string]>();
    expectTypeOf(hasUnsafeMarkdownCharacter).returns.toEqualTypeOf<boolean>();
    expectTypeOf(validateTitle).parameters.toEqualTypeOf<[string]>();
    expectTypeOf(validateTitle).returns.toEqualTypeOf<string>();
    expectTypeOf(validateAdvertisements).parameters.toEqualTypeOf<[readonly (string | null)[]]>();
    expectTypeOf(validateAdvertisements).returns.toEqualTypeOf<
      { title: string; title_origin: { kind: "advertisement"; witness_index: number } } | undefined
    >();
    expectTypeOf(validateDestination).parameters.toEqualTypeOf<[string, boolean?]>();
    expectTypeOf(validateDestination).returns.toEqualTypeOf<void>();
  });

  it("retains the exact fixed failure wrapper", () => {
    expect(() => fail("unsafe title")).toThrowError(fixedError("unsafe title"));
    expect(() => fail("")).toThrowError(new Error("Markdown inspection: ."));
  });
});

describe("unchanged title and advertisement guards", () => {
  it.each(["\0", "\t", "\n", "\r", "\u007f", "\u0085", "\u200b", "\u202e", "\ufeff", "\ud800", "\udfff", "\ufffd"])(
    "rejects unsafe Markdown character %j without regex state",
    (character) => {
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(hasUnsafeMarkdownCharacter(`a${character}b`)).toBe(true);
        expect(hasUnsafeMarkdownCharacter("Ordinary é 界 𐐀")).toBe(false);
      }
      expect(() => validateTitle(`a${character}b`)).toThrowError(fixedError("unsafe title"));
      expect(() => validateAdvertisements([`a${character}b`])).toThrowError(
        fixedError("unsafe title in advertisement"),
      );
    },
  );

  it.each(["  Literal *title*  ", "é".repeat(2048), "x".repeat(4096), "[link] & code", "𐐀"])(
    "returns safe titles verbatim",
    (title) => expect(validateTitle(title)).toBe(title),
  );

  it.each([
    ["", "empty title"],
    [" \u00a0 ", "empty title"],
    ["Type <T>", "unsafe title"],
    ["More > less", "unsafe title"],
    [`${"é".repeat(2048)}x`, "title byte limit"],
    ["x".repeat(4097), "title byte limit"],
  ])("retains title failure %s", (title, reason) => {
    expect(() => validateTitle(title)).toThrowError(fixedError(reason));
  });

  it("selects the first nonempty literal title with its original witness index", () => {
    const titles = Object.freeze([null, "", "  Literal *title*  ", "  Literal *title*  ", null]);
    expect(validateAdvertisements(titles)).toEqual({
      title: "  Literal *title*  ",
      title_origin: { kind: "advertisement", witness_index: 2 },
    });
    expect(validateAdvertisements([null, ""])).toBeUndefined();
    expect(validateAdvertisements([])).toBeUndefined();
    expect(validateAdvertisements(Array(6).fill("T"))).toEqual({
      title: "T",
      title_origin: { kind: "advertisement", witness_index: 0 },
    });
  });

  it("leaves published-title validation separate from advertisement evidence", () => {
    for (const title of ["<unused hint>", " ", "界".repeat(4096)]) {
      expect(validateAdvertisements([title])).toEqual({
        title,
        title_origin: { kind: "advertisement", witness_index: 0 },
      });
      expect(() => validateTitle(title)).toThrow();
    }
  });

  it.each([
    [null, "invalid advertisement input"],
    ["T", "invalid advertisement input"],
    [[7], "invalid advertisement input"],
    [[undefined], "invalid advertisement input"],
    [Array(1), "invalid advertisement input"],
    [Array(7).fill("T"), "advertisement limit"],
    [["x".repeat(4097)], "advertisement title limit"],
    [["A", "B"], "conflicting advertisement titles"],
    [["T", " T"], "conflicting advertisement titles"],
  ])("retains advertisement failure %j", (titles, reason) => {
    expect(() => validateAdvertisements(titles as readonly (string | null)[])).toThrowError(fixedError(reason));
  });
});

describe("unchanged URI guards", () => {
  it.each([
    "https://example.org/a?x=1&y=2",
    "HTTP://EXAMPLE.ORG/a",
    "https://例え.テスト/道",
    "https://example.org/%2520",
    "mailto:a@example.org,b@example.org?subject=Hello&body=Safe+body&cc=c@example.org&bcc=d@example.org",
    "mailto:a%40example.org?subject=Hello&CC=b%40example.org",
    "tel:+1-604-555-0100;ext=9",
    "tel:(604) 555-0100",
    "/relative/path?view=full#section",
    "./relative",
    "../parent",
    "?page=2",
    "#fragment",
  ])("accepts the existing absolute destination %s", (value) => {
    expect(validateDestination(value)).toBeUndefined();
    expect(validateDestination(value, true)).toBeUndefined();
  });

  it.each([
    "//example.org/",
    "relative/without-prefix",
    "/%2fexample.org",
    "/%252fexample.org",
    "/%5cevil",
    ".%2fpath",
    "..%2fpath",
    "javascript:evil",
    "data:text/plain,x",
    "https:example.org",
    "https:///example.org",
    "https://user:pass@example.org/",
    "https://@example.org/",
    "https://example.org/\\path",
    "https://example.org/%255cpath",
    "https://example.org/%250D",
    "https://example.org/%e2%80%ae",
    "https://example.org/%ff%0a",
    "https://example.org/%ef%bf%bd",
    "mailto:a&colon;@example.org",
    "mailto:invalid",
    "mailto:a@example.org#fragment",
    "mailto:a@example.org?unexpected=x",
    "mailto:a@example.org?cc=invalid",
    "mailto:a@example.org?body=Hi%0Athere",
    "tel:abc",
    "tel:---",
    "tel:123?x=1",
    "tel:123#x",
    "tel:123;ext=abc",
  ])("retains the exact unsafe destination error for %s", (value) => {
    expect(() => validateDestination(value)).toThrowError(fixedError("unsafe link destination"));
  });

  it("preserves lexical mode without weakening the common guard", () => {
    for (const value of ["mailto:invalid", "mailto:a@example.org?unexpected=x", "tel:abc", "tel:123?x=1"]) {
      expect(validateDestination(value, true)).toBeUndefined();
      expect(() => validateDestination(value)).toThrowError(fixedError("unsafe link destination"));
    }
    expect(() => validateDestination("https://example.org/%0a", true)).toThrowError(
      fixedError("unsafe link destination"),
    );
  });

  it("keeps the fixed percent-decoding depth and rejects unsafe intermediate forms", () => {
    expect(validateDestination(`https://example.org/%${"25".repeat(6)}20`)).toBeUndefined();
    expect(() => validateDestination(`https://example.org/%${"25".repeat(7)}20`)).toThrowError(
      fixedError("unsafe link destination"),
    );
    for (const depth of [0, 1, 6, 7, 8, 12]) {
      expect(() => validateDestination(`https://example.org/%${"25".repeat(depth)}0a`)).toThrowError(
        fixedError("unsafe link destination"),
      );
    }
  });
});

describe("deterministic inspector facade results", () => {
  it("preserves native metadata, source bytes and the exact source hash", () => {
    const input = new TextEncoder().encode("# Native  *heading* `code` [label](https://example.org/a)\r\n\r\nBody.\r");
    const original = input.slice();
    const expected = {
      source_bytes: 67,
      source_bytes_sha256: "dfaf429db9e03400bc9a931bab41d40e56fa970f9f0408679b05d1af56dd9f43",
      title: "Native  heading code label",
      title_origin: { kind: "markdown-body" },
      links: [{ text: "label", url: "https://example.org/a" }],
      stats: { emitted_tokens: 17, links: 1, max_depth: 2 },
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = inspectMarkdownSource(input, ["Not the title"]);
      expect(result).toEqual(expected);
      expectDeepFrozen(result);
      expect(result.source_bytes_sha256).toBe(createHash("sha256").update(original).digest("hex"));
      expect(input).toEqual(original);
    }
  });

  it("preserves literal advertisement selection and source line endings", () => {
    const input = new TextEncoder().encode("Body\r\n");
    const titles = [null, "", "  Literal *title*  ", "  Literal *title*  "];
    const result = inspectMarkdownSource(input, titles);
    expect(result).toEqual({
      source_bytes: 6,
      source_bytes_sha256: "c7f37cfe2bd17c6331179ea9f3fbe4ad368794f69d1a28c7456cf4301f3bf169",
      title: "  Literal *title*  ",
      title_origin: { kind: "advertisement", witness_index: 2 },
      links: [],
      stats: { emitted_tokens: 4, links: 0, max_depth: 1 },
    });
    expectDeepFrozen(result);
    expect(inspectMarkdownSource(input, titles)).toEqual(result);
  });
});
