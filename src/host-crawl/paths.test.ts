import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "../base.ts";
import {
  assertExternalPath,
  DEFAULT_EXTERNAL_ROOT,
  DEFAULT_LEGACY_SNAPSHOTS_DIR,
  DEFAULT_LEGACY_STATE_FILE,
} from "./paths.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(assertExternalPath(tmpdir()), "host-paths-"));
});
afterEach(async (context) => {
  if (context.task.result?.state === "fail") console.error(`Preserved failing path fixture: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
});

describe("external host paths", () => {
  it("defines only external legacy defaults", () => {
    expect(DEFAULT_EXTERNAL_ROOT).toBe("/home/admin2/Projects/ubc-tmp/ubc-unified-data");
    expect(DEFAULT_LEGACY_STATE_FILE).toBe(`${DEFAULT_EXTERNAL_ROOT}/state/legacy/state.sqlite`);
    expect(DEFAULT_LEGACY_SNAPSHOTS_DIR).toBe(`${DEFAULT_EXTERNAL_ROOT}/state/legacy/snapshots`);
  });
  it("normalizes external directories, regular files and missing destinations", async () => {
    await writeFile(join(directory, "state.sqlite"), "fixture");
    expect(assertExternalPath(`${directory}/./state.sqlite`)).toBe(join(directory, "state.sqlite"));
    expect(assertExternalPath(`${directory}/not-created/../new/output`)).toBe(join(directory, "new/output"));
    expect(assertExternalPath(directory)).toBe(resolve(directory));
  });
  it.each([
    "/tmp/archive",
    "/home/admin2/Projects/ubc-tmp-escape/file",
    "/home/admin2/Projects/ubc-tmp/../escape/file",
    "",
    "\0",
  ])("rejects boundary escape %s", (path) => {
    expect(() => assertExternalPath(path)).toThrow();
  });
  it("rejects repository root, descendants and custom nested repository roots", async () => {
    expect(() => assertExternalPath(ROOT)).toThrow(/external/);
    expect(() => assertExternalPath(join(ROOT, "state.sqlite"))).toThrow(/external/);
    const repository = join(directory, "repo");
    await mkdir(repository);
    expect(() => assertExternalPath(repository, repository)).toThrow(/external/);
    expect(() => assertExternalPath(join(repository, "data/file"), repository)).toThrow(/external/);
    expect(assertExternalPath(`${repository}-sibling/file`, repository)).toBe(`${repository}-sibling/file`);
    expect(() => assertExternalPath(directory, "/home/admin2/Projects/ubc-tmp")).toThrow(/external/);
  });
  it("rejects symlink components, including links erased by normalization", async () => {
    await mkdir(join(directory, "real"));
    await writeFile(join(directory, "real/file"), "test");
    await symlink(join(directory, "real"), join(directory, "link"));
    await symlink(join(directory, "real/file"), join(directory, "file-link"));
    await symlink(join(directory, "missing"), join(directory, "dangling"));
    for (const value of ["link", "link/file", "link/../safe", "file-link", "dangling"])
      expect(() => assertExternalPath(`${directory}/${value}`)).toThrow(/Symlink/);
  });
  it("recognizes a repository-root symlink alias", async () => {
    const repository = join(directory, "repo");
    await mkdir(repository);
    await symlink(repository, join(directory, "repo-alias"));
    expect(() => assertExternalPath(join(repository, "file"), join(directory, "repo-alias"))).toThrow(/external/);
  });
  it("rejects FIFOs and regular files used as parent directories", async () => {
    const fifo = join(directory, "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(() => assertExternalPath(fifo)).toThrow(/Nonregular/);
    await writeFile(join(directory, "file"), "test");
    expect(() => assertExternalPath(join(directory, "file/child"))).toThrow(/Nonregular/);
  });
});
