import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const list = (arguments_) => {
  const result = JSON.parse(
    execFileSync(process.execPath, [cli, "list", "--json", "--no-cache", "--configLoader", "native", ...arguments_], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  if (
    !Array.isArray(result) ||
    result.some((test) => typeof test.name !== "string" || !test.name || !test.file?.endsWith(".test.ts"))
  )
    throw new Error("Unrecognized Vitest test inventory");
  return result;
};
const full = list([]);
const portable = list(["--exclude", "**/*.native.test.ts"]);
const native = list([".native.test.ts"]);
if (
  !portable.length ||
  !native.length ||
  portable.some((test) => test.file.endsWith(".native.test.ts")) ||
  native.some((test) => !test.file.endsWith(".native.test.ts"))
)
  throw new Error("Portable and native test selection overlap or have no coverage");
const identities = (tests) => tests.map((test) => JSON.stringify([test.file, test.name])).sort();
if (JSON.stringify(identities(full)) !== JSON.stringify(identities([...portable, ...native])))
  throw new Error("Test partitions lose or duplicate default-suite coverage");
console.log(
  JSON.stringify(
    {
      full: full.length,
      portable: portable.length,
      native: native.length,
      note: "Inventory only: portable plus native preserves every default test. Each lane must be executed separately.",
    },
    null,
    2,
  ),
);
