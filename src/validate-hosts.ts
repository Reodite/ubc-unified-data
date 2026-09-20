import { parseArgs } from "node:util";
import { ROOT } from "./base.ts";
import { loadRoutingPolicy, loadSavedClassifications, routeCompletedHost } from "./host-crawl/category-routing.ts";
import { validatePublishedHosts } from "./host-crawl/public-validation.ts";
import { registeredHostnames } from "./host-crawl/registry.ts";

try {
  const { values } = parseArgs({
    options: { "require-categories": { type: "boolean", default: false } },
    strict: true,
    allowPositionals: false,
  });
  const hosts = await validatePublishedHosts({
    repositoryRoot: ROOT,
    registeredHosts: registeredHostnames(),
    requireCategories: values["require-categories"],
  });
  for (const host of hosts) {
    if (!host.document_roots) continue;
    const documents = await loadSavedClassifications(ROOT, host.hostname);
    routeCompletedHost({ complete: true, host, documents }, await loadRoutingPolicy(host.hostname), documents);
  }
  console.log(
    JSON.stringify(
      { hosts: hosts.length, documents: hosts.reduce((sum, host) => sum + host.document_count, 0) },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
