import { rename, writeFile } from "node:fs/promises";
import { assertExternalPath } from "./paths.ts";
import { readRegularFile } from "./public-validation.ts";

export const LARGE_PRIVATE_FILE = 256 * 1024 * 1024;
export const isAbsent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

export async function readPrivateJson(path: string): Promise<unknown> {
  return JSON.parse((await readRegularFile(assertExternalPath(path), LARGE_PRIVATE_FILE)).toString("utf8"));
}

export async function savePrivateJson(path: string, value: unknown): Promise<void> {
  assertExternalPath(path);
  const temporary = `${path}.${process.pid}.new`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

/** Create an immutable private object, accepting an existing copy only when its bytes match. */
export async function writeImmutable(path: string, bytes: Buffer): Promise<void> {
  assertExternalPath(path);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await readRegularFile(path, bytes.length)).equals(bytes)
    )
      throw error;
  }
}
