import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertExternalPath } from "./paths.ts";
import { assertSameProducer, captureProducer } from "./provenance.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readdir: vi.fn(actual.readdir) };
});
let directory: string;
async function fixture(name: string): Promise<string> {
  const root = join(directory, name);
  await mkdir(join(root, "src/nested"), { recursive: true });
  await writeFile(join(root, "src/main.ts"), "export const value = 1;\n");
  await writeFile(join(root, "src/nested/model.ts"), "export type Value = number;\n");
  await writeFile(join(root, "src/main.test.ts"), "ignored test bytes\n");
  await writeFile(join(root, "src/readme.md"), "source note\n");
  await writeFile(join(root, "src/nested/policy.json"), "{}\n");
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) await writeFile(join(root, name), "{}\n");
  return root;
}
beforeEach(async () => {
  directory = await mkdtemp(join(assertExternalPath(tmpdir()), "host-producer-"));
});
afterEach(async (context) => {
  vi.restoreAllMocks();
  vi.mocked(open).mockReset();
  vi.mocked(readdir).mockReset();
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(original.open);
  vi.mocked(readdir).mockImplementation(original.readdir);
  if (context.task.result?.state === "fail") console.error(`Preserved failing producer fixture: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
});

describe("working producer fingerprint", () => {
  it("works without Git and ignores absolute location and mtimes", async () => {
    const first = await fixture("first");
    const second = await fixture("second");
    await utimes(join(second, "src/main.ts"), 1, 1);
    const producer = await captureProducer(first);
    expect(producer).toEqual(await captureProducer(second));
    expect(producer.runtime).toEqual({
      node: process.versions.node,
      icu: process.versions.icu,
      unicode: process.versions.unicode,
      platform: process.platform,
      arch: process.arch,
    });
    expect(producer.inputs_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(first, "src/main.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await readdir(first)).toEqual(["package-lock.json", "package.json", "src", "tsconfig.json"]);
    expect(() => assertSameProducer(producer, structuredClone(producer))).not.toThrow();
    expect(() =>
      assertSameProducer(producer, { ...producer, runtime: { ...producer.runtime, unicode: "different" } }),
    ).toThrow(/changed/);
  });
  it.each([
    "src/main.ts",
    "src/main.test.ts",
    "src/readme.md",
    "src/nested/policy.json",
    "src/nested/model.ts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ])("detects edits to %s", async (name) => {
    const root = await fixture("repo");
    const before = await captureProducer(root);
    await writeFile(join(root, name), "changed bytes\n");
    const after = await captureProducer(root);
    expect(() => assertSameProducer(before, after)).toThrow(/changed/);
  });
  it("records path identity and new uncommitted source files", async () => {
    const root = await fixture("repo");
    const before = await captureProducer(root);
    await writeFile(join(root, "src/new.ts"), "export const pending = true;\n");
    expect((await captureProducer(root)).inputs_sha256).not.toBe(before.inputs_sha256);
  });
  it.each(["src/main.ts", "src/nested", "package.json"])("rejects input symlinks at %s", async (name) => {
    const root = await fixture("repo");
    await rm(join(root, name), { recursive: true });
    await symlink(join(root, "src/main.test.ts"), join(root, name));
    await expect(captureProducer(root)).rejects.toThrow(/symlink/i);
  });
  it("rejects FIFO source inputs and missing required inputs", async () => {
    const root = await fixture("repo");
    execFileSync("mkfifo", [join(root, "src/fifo.ts")]);
    await expect(captureProducer(root)).rejects.toThrow(/Nonregular/);
    await rm(join(root, "src/fifo.ts"));
    await rm(join(root, "package-lock.json"));
    await expect(captureProducer(root)).rejects.toThrow(/ENOENT/);
  });
  it("detects mid-read mutation even when bytes were already read", async () => {
    const root = await fixture("repo");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      const read = file.readFile.bind(file);
      vi.spyOn(file, "readFile").mockImplementationOnce(async () => {
        const bytes = await read();
        await writeFile(args[0], "mutated during read\n");
        return bytes;
      });
      return file;
    });
    await expect(captureProducer(root)).rejects.toThrow(/changed during read/);
  });
  it("detects a source tree addition between capture passes", async () => {
    const root = await fixture("repo");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let calls = 0;
    vi.mocked(readdir).mockImplementation(async (...args: Parameters<typeof readdir>) => {
      if (++calls === 3) await writeFile(join(root, "src/added.ts"), "export const late = 1;\n");
      return actual.readdir(...args);
    });
    await expect(captureProducer(root)).rejects.toThrow(/changed during capture/);
  });
});
