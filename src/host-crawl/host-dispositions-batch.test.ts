import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROOT } from "../base.ts";
import { HostBatch } from "./batch.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";

vi.mock("./host-dispositions.ts", () => ({ currentUnavailableHosts: () => new Set(["unavailable.ubc.ca"]) }));
let root: string;
beforeAll(async () => {
  await mkdir(DEFAULT_EXTERNAL_ROOT, { recursive: true });
  root = await mkdtemp(join(DEFAULT_EXTERNAL_ROOT, "unavailable-batch-test-"));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function batch() {
  const path = join(root, "runs", crypto.randomUUID());
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "config.json"),
    JSON.stringify({
      repositoryRoot: ROOT,
      producerRoot: join(root, "producer"),
      producer: { inputs_sha256: "a".repeat(64), runtime: {} },
      baseline: "a".repeat(40),
      main: "b".repeat(40),
      bootstrapFiles: {},
    }),
  );
  return HostBatch.open(path);
}

describe("unavailable hosts in new batches", () => {
  it("refuses new seeds without mutating the queue", async () => {
    const hostBatch = await batch();
    try {
      expect(() => hostBatch.seed([{ hostname: "eligible.ubc.ca" }, { hostname: "unavailable.ubc.ca" }])).toThrow(
        "reviewed unavailable hostname",
      );
      expect(hostBatch.queue.stats().total).toBe(0);
    } finally {
      hostBatch.close();
    }
  });

  it("does not claim an old pending row that became unavailable", async () => {
    const hostBatch = await batch();
    try {
      hostBatch.queue.seed([{ hostname: "unavailable.ubc.ca" }, { hostname: "eligible.ubc.ca" }]);
      expect((await hostBatch.claim("w1"))?.hostname).toBe("eligible.ubc.ca");
      expect(hostBatch.queue.get("unavailable.ubc.ca")?.state).toBe("pending");
    } finally {
      hostBatch.close();
    }
  });
});
