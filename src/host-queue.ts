import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HostBatch } from "./host-crawl/batch.ts";
import { parseRoutingPolicy } from "./host-crawl/category-routing.ts";
import { assertExternalPath } from "./host-crawl/paths.ts";
import { readRegularFile } from "./host-crawl/public-validation.ts";
import type { HostWorkSeed } from "./host-crawl/work-queue.ts";

export async function runHostQueue(args: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      state: { type: "string" },
      action: { type: "string" },
      worker: { type: "string" },
      host: { type: "string" },
      token: { type: "string" },
      decision: { type: "string" },
      reason: { type: "string" },
      seed: { type: "string" },
      routing: { type: "string" },
    },
  });
  if (!values.state || !values.action) throw new Error("--state and --action are required");
  const batch = await HostBatch.open(values.state);
  try {
    if (values.action === "seed") {
      if (!values.seed) throw new Error("--seed is required");
      batch.seed(JSON.parse(await readFile(values.seed, "utf8")) as HostWorkSeed[]);
      return batch.queue.stats();
    }
    if (values.action === "stats") return batch.queue.stats();
    if (values.action === "claim") {
      if (!values.worker) throw new Error("--worker is required");
      return { claim: await batch.claim(values.worker), stats: batch.queue.stats() };
    }
    if (!values.host || !values.token) throw new Error("--host and --token are required");
    if (values.action === "get") return batch.owned(values.host, values.token);
    if (values.action === "homepage") return await batch.homepage(values.host, values.token);
    if (values.action === "decide") {
      if (!["accept", "reject"].includes(values.decision ?? "")) throw new Error("--decision must be accept or reject");
      const policy = values.routing
        ? parseRoutingPolicy(await readRegularFile(assertExternalPath(values.routing)))
        : undefined;
      batch.decide(values.host, values.token, values.decision === "accept", values.reason ?? "", policy);
      return { hostname: values.host, state: batch.owned(values.host, values.token).state };
    }
    if (values.action === "collect") return await batch.collect(values.host, values.token);
    if (values.action === "publish") return await batch.publish(values.host, values.token, values.reason ?? "");
    if (values.action === "block") {
      if (!values.reason?.trim()) throw new Error("--reason is required");
      batch.block(values.host, values.token, values.reason);
      return { hostname: values.host, state: batch.owned(values.host, values.token).state };
    }
    throw new Error("Unknown queue action");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (["homepage", "collect"].includes(values.action) && values.host && values.token) {
      batch.block(values.host, values.token, message);
      return { hostname: values.host, state: "blocked", phase: values.action, error: message };
    }
    throw error;
  } finally {
    batch.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHostQueue(process.argv.slice(2))
    .then((value) => console.log(JSON.stringify(value, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
