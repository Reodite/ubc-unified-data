import { mkdtemp, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileIntegrityError, isFatalCollectionError, savedRequestFailure } from "./errors.ts";
import { readRegularFile } from "./public-validation.ts";

const hooks = vi.hoisted(() => ({ opened: undefined as ((file: FileHandle) => void | Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (load) => {
  const fs = await load<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      await hooks.opened?.(file);
      return file;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  hooks.opened = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["before", "while"])("treats a file changed %s reading as fatal live and persisted evidence", async (when) => {
  const root = await mkdtemp(join(tmpdir(), "input-read-"));
  roots.push(root);
  const path = join(root, "input.json");
  await writeFile(path, "original bytes");
  const closed = vi.fn();
  hooks.opened = async (file) => {
    const close = file.close.bind(file);
    vi.spyOn(file, "close").mockImplementation(async () => {
      closed();
      await close();
    });
    if (when === "before") await writeFile(path, "different and longer bytes");
    else {
      const read = file.readFile.bind(file);
      vi.spyOn(file, "readFile").mockImplementation(async () => {
        const bytes = await read();
        await writeFile(path, "different and longer bytes");
        return bytes;
      });
    }
  };
  const failure: unknown = await readRegularFile(path).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(FileIntegrityError);
  expect(failure).toMatchObject({ message: `File changed ${when} reading: ${path}` });
  expect(isFatalCollectionError(failure)).toBe(true);
  expect(isFatalCollectionError(savedRequestFailure(String(failure)))).toBe(true);
  expect(closed).toHaveBeenCalledTimes(1);
});
