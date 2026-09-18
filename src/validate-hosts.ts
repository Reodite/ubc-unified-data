import { ROOT } from "./base.ts";
import { validatePublishedHosts } from "./host-crawl/public-validation.ts";
import { registeredHostnames } from "./host-crawl/registry.ts";

try {
  const hosts = await validatePublishedHosts({ repositoryRoot: ROOT, registeredHosts: registeredHostnames() });
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
