import { createHash } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ROOT } from "./core/output.ts";
import { loadRoutingPolicy, loadSavedClassifications, routeCompletedHost } from "./host-crawl/category-routing.ts";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT } from "./host-crawl/paths.ts";
import { writeImmutable } from "./host-crawl/private-files.ts";
import { assertSameProducer, captureProducer } from "./host-crawl/provenance.ts";
import { publishCompletedHost } from "./host-crawl/publication.ts";
import { collectRecordedSession, openRecordedHost } from "./host-crawl/recorded-host.ts";
import { getHostScraper, registeredHostnames } from "./host-crawl/registry.ts";

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function runCollectHost(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      host: { type: "string" },
      acquire: { type: "boolean", default: false },
      publish: { type: "boolean", default: false },
      "resume-interrupted": { type: "boolean", default: false },
      "retry-network": { type: "string", multiple: true, default: [] },
    },
  });
  if (!values.host) throw new Error("--host is required");
  if (values.acquire && values.publish) throw new Error("Acquisition and publication are separate operations");
  if ((values["resume-interrupted"] || values["retry-network"].length) && !values.acquire)
    throw new Error("Resume requires explicit acquisition");
  const scraper = getHostScraper(values.host);
  const source = await captureProducer();
  const session = await openRecordedHost({
    scraper,
    producer: source,
    acquire: values.acquire,
    resumeInterrupted: values["resume-interrupted"],
  });
  const { recording, directory } = session;
  try {
    for (const url of values["retry-network"]) recording.retryNetworkFailure(url);
    if (values.acquire) {
      await mkdir(join(directory, "producer"), { recursive: true, mode: 0o700 });
      const frozen = join(directory, "producer", source.inputs_sha256);
      try {
        await mkdir(frozen, { recursive: false });
        await cp(join(ROOT, "src"), join(frozen, "src"), { recursive: true });
        for (const name of ["package.json", "package-lock.json", "tsconfig.json"])
          await cp(join(ROOT, name), join(frozen, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      assertSameProducer(source, await captureProducer(frozen));
    }
    const collected = await collectRecordedSession(session, source, {
      mode: values.acquire ? "acquire" : "replay",
      scopeExclusions: "fail",
    });
    const { completed: result, input } = collected;
    const verifyInputs = async () => {
      await collected.verifyInputs();
      assertSameProducer(source, await captureProducer());
    };
    await verifyInputs();
    const policy = await loadRoutingPolicy(scraper.hostname);
    const categorized = routeCompletedHost(result, policy, await loadSavedClassifications(ROOT, scraper.hostname));
    const verifyCategorizedInputs = async () => {
      await verifyInputs();
      routeCompletedHost(
        categorized,
        await loadRoutingPolicy(scraper.hostname),
        await loadSavedClassifications(ROOT, scraper.hostname),
      );
    };
    const bytes = Buffer.from(`${JSON.stringify(categorized, null, 2)}\n`);
    const verifiedPath = assertExternalPath(join(directory, `verified-${digest(bytes)}.json`));
    await writeImmutable(verifiedPath, bytes);
    const publication = values.publish
      ? await publishCompletedHost({
          completed: categorized,
          repositoryRoot: ROOT,
          externalRoot: DEFAULT_EXTERNAL_ROOT,
          registeredHosts: registeredHostnames(),
          verifyInputs: verifyCategorizedInputs,
        })
      : null;
    return {
      hostname: scraper.hostname,
      documents: result.documents.length,
      complete: true,
      acquisition: values.acquire,
      published: !!publication,
      changed: publication?.changed ?? false,
      input_sha256: input,
    };
  } finally {
    recording.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCollectHost(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
