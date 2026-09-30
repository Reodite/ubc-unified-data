import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { ROOT } from "../base.ts";

/** Resolve a dedicated workspace root; overrides must already be absolute and normalized. */
export function resolveExternalBoundary(home: string, override?: string): string {
  const boundary = override ?? join(home, "Projects", "ubc-tmp");
  if (
    !boundary.trim() ||
    boundary.includes("\0") ||
    !isAbsolute(boundary) ||
    resolve(boundary) !== boundary ||
    boundary === parse(boundary).root
  )
    throw new Error("UBC_TMP_ROOT must be a normalized absolute directory, not a filesystem root");
  return boundary;
}

export const EXTERNAL_BOUNDARY = resolveExternalBoundary(homedir(), process.env.UBC_TMP_ROOT);
export const DEFAULT_EXTERNAL_ROOT = join(EXTERNAL_BOUNDARY, "ubc-unified-data");
export const DEFAULT_LEGACY_STATE_FILE = join(DEFAULT_EXTERNAL_ROOT, "state/legacy/state.sqlite");
export const DEFAULT_LEGACY_SNAPSHOTS_DIR = join(DEFAULT_EXTERNAL_ROOT, "state/legacy/snapshots");

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
