import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ROOT } from "../base.ts";

export const DEFAULT_EXTERNAL_ROOT = "/home/admin2/Projects/ubc-tmp/ubc-unified-data";
export const DEFAULT_LEGACY_STATE_FILE = join(DEFAULT_EXTERNAL_ROOT, "state/legacy/state.sqlite");
export const DEFAULT_LEGACY_SNAPSHOTS_DIR = join(DEFAULT_EXTERNAL_ROOT, "state/legacy/snapshots");
const EXTERNAL_BOUNDARY = "/home/admin2/Projects/ubc-tmp";

function within(value: string, parent: string): boolean {
  const part = relative(parent, value);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** Normalize an external file/directory path without following symlinks. Missing components are allowed. */
export function assertExternalPath(value: string, repositoryRoot = ROOT): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("Invalid external path");
  const normalized = resolve(value);
  const repository = resolve(repositoryRoot);
  let physicalRepository = repository;
  try {
    physicalRepository = realpathSync(repository);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    !within(normalized, EXTERNAL_BOUNDARY) ||
    within(normalized, repository) ||
    within(normalized, physicalRepository)
  )
    throw new Error(`Path must stay external to the repository under ${EXTERNAL_BOUNDARY}: ${normalized}`);

  // Inspect before collapsing '..' so a symlink cannot disappear during normalization.
  const absolute = isAbsolute(value) ? value : `${process.cwd()}${sep}${value}`;
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error(`Symlink in external path: ${current}`);
      if (!info.isDirectory() && (index !== parts.length - 1 || !info.isFile()))
        throw new Error(`Nonregular external path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return normalized;
}
