import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "../base.ts";
import {
  assertExternalPath,
  DEFAULT_EXTERNAL_ROOT,
  DEFAULT_LEGACY_SNAPSHOTS_DIR,
  DEFAULT_LEGACY_STATE_FILE,
  EXTERNAL_BOUNDARY,
  resolveExternalBoundary,
} from "./paths.ts";

let directory: string;
beforeEach(async () => {
  await mkdir(assertExternalPath(EXTERNAL_BOUNDARY), { recursive: true });
  directory = await mkdtemp(join(EXTERNAL_BOUNDARY, "host-paths-"));
});
afterEach(async (context) => {
  if (context.task.result?.state === "fail") console.error(`Preserved failing path fixture: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
});

describe("external host paths", () => {
  it("defines only external legacy defaults", () => {
    expect(EXTERNAL_BOUNDARY).toBe(resolveExternalBoundary(homedir(), process.env.UBC_TMP_ROOT));
    expect(DEFAULT_EXTERNAL_ROOT).toBe(join(EXTERNAL_BOUNDARY, "ubc-unified-data"));
    expect(DEFAULT_LEGACY_STATE_FILE).toBe(`${DEFAULT_EXTERNAL_ROOT}/state/legacy/state.sqlite`);
    expect(DEFAULT_LEGACY_SNAPSHOTS_DIR).toBe(`${DEFAULT_EXTERNAL_ROOT}/state/legacy/snapshots`);
  });
  it("derives home-relative defaults and permits an explicit runner workspace", () => {
    const home = join(directory, "portable-user");
    const configured = join(directory, "runner-workspace");
    expect(resolveExternalBoundary(home)).toBe(join(home, "Projects", "ubc-tmp"));
    expect(resolveExternalBoundary(home, configured)).toBe(configured);
    for (const override of [
      "",
      "relative/workspace",
      "/",
      `${configured}/../escape`,
      `${configured}/.`,
      `${configured}\0`,
    ])
      expect(() => resolveExternalBoundary(home, override)).toThrow(/UBC_TMP_ROOT/);
  });
  it("loads defaults under a different home without requiring the original machine", () => {
    const home = join(directory, "relocated-home");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      TSX_DISABLE_CACHE: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
    delete env.UBC_TMP_ROOT;
    const script = `import { EXTERNAL_BOUNDARY } from ${JSON.stringify(new URL("./paths.ts", import.meta.url).href)}; console.log(EXTERNAL_BOUNDARY);`;
    const output = execFileSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
      { env, encoding: "utf8" },
    );
    expect(output.trim()).toBe(join(home, "Projects", "ubc-tmp"));
  });
  it("normalizes external directories, regular files and missing destinations", async () => {
    await writeFile(join(directory, "state.sqlite"), "fixture");
    expect(assertExternalPath(`${directory}/./state.sqlite`)).toBe(join(directory, "state.sqlite"));
    expect(assertExternalPath(`${directory}/not-created/../new/output`)).toBe(join(directory, "new/output"));
    expect(assertExternalPath(directory)).toBe(resolve(directory));
  });
  it.each([
    join(EXTERNAL_BOUNDARY, "..", "outside-archive"),
    `${EXTERNAL_BOUNDARY}-escape/file`,
    `${EXTERNAL_BOUNDARY}/../escape/file`,
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
    expect(() => assertExternalPath(directory, EXTERNAL_BOUNDARY)).toThrow(/external/);
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
