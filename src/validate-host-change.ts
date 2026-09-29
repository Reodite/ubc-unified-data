import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "./base.ts";
import { assertSingleHostChange, type ChangedFile } from "./host-crawl/change-validation.ts";
import { readRegularFile, validatePublishedHosts } from "./host-crawl/public-validation.ts";
import { registeredHostnames } from "./host-crawl/registry.ts";

const git = (args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], { cwd: ROOT });
try {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      mode: { type: "string", default: "publish" },
      host: { type: "string" },
    },
  });
  const mode = values.mode;
  if (mode !== "publish" && mode !== "migrate" && mode !== "withdraw")
    throw new Error("--mode must be publish, migrate, or withdraw");
  const protectedInputs = ["src", "test/fixtures/host-scrapers", "package.json", "package-lock.json", "tsconfig.json"];
  if (
    git(["diff", "--name-only", "-z", "--", ...protectedInputs]).length ||
    git(["ls-files", "--others", "-z", "--", ...protectedInputs]).length
  )
    throw new Error("Stage all reviewed producer inputs and focused fixtures before validating the commit");
  const fields = git(["diff", "--cached", "--name-status", "--no-renames", "-z"]).toString("utf8").split("\0");
  fields.pop();
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]!;
    const path = fields[i + 1]!;
    if (!["A", "M", "D"].includes(status)) throw new Error("Unresolved or unsupported staged change");
    const bytes = status === "D" ? null : git(["show", `:${path}`]);
    if (bytes && !bytes.equals(await readRegularFile(join(ROOT, path))))
      throw new Error(`Staged/working bytes differ: ${path}`);
    let previousBytes: Buffer | null | undefined;
    if (
      path === "src/host-scrapers/generic-hosts.json" ||
      path === "data/official-hosts.json" ||
      path.startsWith("data/documents/") ||
      path.startsWith("src/host-scrapers/routing/")
    ) {
      previousBytes = status === "A" ? null : git(["show", `HEAD:${path}`]);
    }
    files.push({ path, bytes, previousBytes });
  }
  const hostname = assertSingleHostChange(files, { mode, expectedHostname: values.host });
  const hosts = await validatePublishedHosts({
    repositoryRoot: ROOT,
    registeredHosts: registeredHostnames(),
    ...(mode === "withdraw"
      ? { documentHostnames: [] }
      : mode === "migrate" || files.some((file) => file.path === "src/host-scrapers/generic-hosts.json")
        ? { documentHostnames: [hostname] }
        : {}),
  });
  const present = hosts.some((host) => host.hostname === hostname);
  if (mode === "withdraw" ? present : !present)
    throw new Error(
      mode === "withdraw"
        ? "Withdrawn hostname remains in the final vetted index"
        : "Changed hostname is not in the final vetted index",
    );
  console.log(
    JSON.stringify(
      {
        hostname,
        mode,
        staged_files: files.length,
        ...(mode === "withdraw" ? { withdrawn: true } : { publishable: true }),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
