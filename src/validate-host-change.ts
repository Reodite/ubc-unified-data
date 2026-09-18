import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./base.ts";
import { assertSingleHostChange } from "./host-crawl/change-validation.ts";
import { readRegularFile, validatePublishedHosts } from "./host-crawl/public-validation.ts";
import { registeredHostnames } from "./host-crawl/registry.ts";

const git = (args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], { cwd: ROOT });
try {
  const protectedInputs = ["src", "test/fixtures/host-scrapers", "package.json", "package-lock.json", "tsconfig.json"];
  if (
    git(["diff", "--name-only", "-z", "--", ...protectedInputs]).length ||
    git(["ls-files", "--others", "-z", "--", ...protectedInputs]).length
  )
    throw new Error("Stage all reviewed producer inputs and focused fixtures before validating the commit");
  const fields = git(["diff", "--cached", "--name-status", "--no-renames", "-z"]).toString("utf8").split("\0");
  fields.pop();
  const files = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]!;
    const path = fields[i + 1]!;
    if (!["A", "M", "D"].includes(status)) throw new Error("Unresolved or unsupported staged change");
    const bytes = status === "D" ? null : git(["show", `:${path}`]);
    if (bytes && !bytes.equals(await readRegularFile(join(ROOT, path))))
      throw new Error(`Staged/working bytes differ: ${path}`);
    let previousBytes: Buffer | null | undefined;
    if (path === "src/host-scrapers/generic-hosts.json") {
      previousBytes = status === "A" ? null : git(["show", `HEAD:${path}`]);
    }
    files.push({ path, bytes, previousBytes });
  }
  const hostname = assertSingleHostChange(files);
  const hosts = await validatePublishedHosts({
    repositoryRoot: ROOT,
    registeredHosts: registeredHostnames(),
    ...(files.some((file) => file.path === "src/host-scrapers/generic-hosts.json")
      ? { documentHostnames: [hostname] }
      : {}),
  });
  if (!hosts.some((host) => host.hostname === hostname))
    throw new Error("Changed hostname is not in the final vetted index");
  console.log(JSON.stringify({ hostname, staged_files: files.length, publishable: true }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
