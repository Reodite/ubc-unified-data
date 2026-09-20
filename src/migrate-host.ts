import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ROOT } from "./base.ts";
import { migratePublishedHost } from "./host-crawl/migration.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./host-crawl/paths.ts";
import { registeredHostnames } from "./host-crawl/registry.ts";

export async function runMigrateHost(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      host: { type: "string" },
      publish: { type: "boolean", default: false },
      reject: { type: "boolean", default: false },
    },
  });
  if (!values.host) throw new Error("--host is required");
  return migratePublishedHost({
    hostname: values.host,
    repositoryRoot: ROOT,
    externalRoot: DEFAULT_EXTERNAL_ROOT,
    registeredHosts: registeredHostnames(),
    publish: values.publish,
    reject: values.reject,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrateHost(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
