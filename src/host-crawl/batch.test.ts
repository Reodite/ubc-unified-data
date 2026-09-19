import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HostBatch } from "./batch.ts";
import type { CompletedHost, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { DEFAULT_EXTERNAL_ROOT, EXTERNAL_BOUNDARY } from "./paths.ts";

const mocks = vi.hoisted(() => ({ git: vi.fn(), producer: vi.fn(), seal: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: mocks.git,
}));
vi.mock("./provenance.ts", async (original) => ({
  ...(await original<typeof import("./provenance.ts")>()),
  captureProducer: mocks.producer,
}));
vi.mock("./recording.ts", () => ({ HostRecording: { open: async () => ({ verifySeal: mocks.seal, close() {} }) } }));

async function fixture() {
  const id = randomUUID();
  const directory = join(DEFAULT_EXTERNAL_ROOT, "test-host-batch", id);
  const repositoryRoot = join(EXTERNAL_BOUNDARY, `batch-test-${id}`);
  const producerRoot = join(directory, "producer");
  const producer: ProducerContext = {
    inputs_sha256: "c".repeat(64),
    runtime: { node: "26.8.1", icu: "78.3", unicode: "17.0", platform: "linux", arch: "x64" },
  };
  const baseline = "a".repeat(40);
  const main = "b".repeat(40);
  const hostname = `batch-${id}.ubc.ca`;
  await mkdir(join(directory, "state"), { recursive: true });
  await mkdir(join(repositoryRoot, "src/host-scrapers"), { recursive: true });
  await writeFile(join(repositoryRoot, "src/host-scrapers/generic-hosts.json"), "[]\n");
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ repositoryRoot, producerRoot, producer, baseline, main, bootstrapFiles: {} }),
  );
  mocks.producer.mockResolvedValue(producer);
  mocks.seal.mockResolvedValue("d".repeat(64));
  const batch = await HostBatch.open(directory);
  batch.seed([{ hostname, admitted: true }]);
  return { batch, directory, repositoryRoot, hostname, producer, baseline, main };
}

describe("five-worker batch handoff", () => {
  it("recovers the queue claim when its worker receipt was never saved", async () => {
    const { batch, hostname } = await fixture();
    try {
      const original = batch.queue.claim("w1")!;
      expect(await batch.claim("w1")).toMatchObject({ hostname, token: original.token });
      expect(batch.queue.stats()).toMatchObject({ claimed: 1, total: 1 });
    } finally {
      batch.close();
    }
  });

  it("publishes one hostname and retries an uncertain push without another commit", async () => {
    const { batch, directory, repositoryRoot, hostname, producer, baseline, main } = await fixture();
    const claim = await batch.claim("w1");
    const token = claim!.token!;
    const sourceUrl = `https://${hostname}/`;
    const seedBytes = Buffer.from(JSON.stringify({ hostname, urls: [] }));
    const seal = "d".repeat(64);
    const input = sha256(Buffer.from(JSON.stringify({ recording: seal, seed: sha256(seedBytes) })));
    const title = "Public guidance";
    const body = "Public programme requirements and eligibility.\n";
    const complete: CompletedHost = {
      complete: true,
      host: {
        hostname,
        title,
        homepage_url: sourceUrl,
        homepage_retrieved_at: "2026-09-18T00:00:00.000Z",
        homepage_sha256: "e".repeat(64),
        scope: "Public text",
        document_root: `data/documents/${hostname}`,
        document_count: 1,
      },
      documents: [
        {
          id: `documents:official-web:${sha256(sourceUrl).slice(0, 24)}`,
          hostname,
          title,
          source_url: sourceUrl,
          retrieved_at: "2026-09-18T00:00:00.000Z",
          source_modified_at: null,
          snapshot_sha256: "e".repeat(64),
          input_sha256: input,
          body_sha256: sha256(body),
          content_sha256: sha256(`${title}\n${body}`),
          content_markdown: body,
          warnings: [],
          alternate_urls: [],
          producer,
        },
      ],
    };
    const recording = join(DEFAULT_EXTERNAL_ROOT, "hosts", hostname, "recording");
    await mkdir(recording, { recursive: true });
    await writeFile(join(recording, "seed.json"), seedBytes);
    const ready = Buffer.from(
      JSON.stringify({
        version: 1,
        hostname,
        recording_seal: seal,
        seed_sha256: sha256(seedBytes),
        pdf_profile_sha256: null,
        completed: complete,
      }),
    );
    const readyPath = join(directory, "ready.json");
    await writeFile(readyPath, ready);
    batch.queue.update(hostname, token, "collecting");
    batch.queue.update(hostname, token, "ready", { ready_path: readyPath, ready_sha256: sha256(ready), documents: 1 });
    let head = baseline;
    let commits = 0;
    let pushes = 0;
    const committed = "f".repeat(40);
    const tree = "1".repeat(40);
    let staged: string[] = [];
    mocks.git.mockImplementation((command: string, raw: string[]) => {
      expect(command).toBe("git");
      const args = raw.slice(1);
      const call = args.join(" ");
      if (call === "branch --show-current") return Buffer.from("feat/prose-documents\n");
      if (call === "rev-parse refs/heads/main") return Buffer.from(main);
      if (call === "rev-parse HEAD") return Buffer.from(head);
      if (call === "remote get-url --push --all origin")
        return Buffer.from("https://github.com/Reodite/ubc-unified-data\n");
      if (args[0] === "ls-files" || args[0] === "status") return Buffer.alloc(0);
      if (args[0] === "add") {
        staged = [
          "src/host-scrapers/generic-hosts.json",
          "data/official-hosts.json",
          ...readdirSync(join(repositoryRoot, `data/documents/${hostname}`)).map(
            (name) => `data/documents/${hostname}/${name}`,
          ),
        ];
        return Buffer.alloc(0);
      }
      if (args[0] === "diff")
        return Buffer.from(
          staged.map((path) => `${path.endsWith("generic-hosts.json") ? "M" : "A"}\0${path}\0`).join(""),
        );
      if (call === "show HEAD:src/host-scrapers/generic-hosts.json") return Buffer.from("[]\n");
      if (args[0] === "show" && args[1]!.startsWith(":")) return readFileSync(join(repositoryRoot, args[1]!.slice(1)));
      if (args[0] === "write-tree") return Buffer.from(tree);
      if (args[0] === "commit") {
        commits++;
        head = committed;
        return Buffer.alloc(0);
      }
      if (args[0] === "push") {
        expect(args).toEqual(["push", "origin", "HEAD:refs/heads/feat/prose-documents"]);
        if (++pushes === 1) throw new Error("simulated uncertain push");
        return Buffer.alloc(0);
      }
      if (args[0] === "ls-remote")
        return Buffer.from(`${committed}\trefs/heads/feat/prose-documents\n${main}\trefs/heads/main\n`);
      throw new Error(`Unexpected Git call: ${call}`);
    });
    try {
      await expect(batch.publish(hostname, token, "Readable public guidance sample")).rejects.toThrow(
        "simulated uncertain push",
      );
      expect(batch.queue.get(hostname)?.state).toBe("publishing");
      await expect(batch.publish(hostname, token, "Same retained sample")).resolves.toMatchObject({
        hostname,
        commit: committed,
        published: true,
      });
      expect(commits).toBe(1);
      expect(pushes).toBe(2);
      expect(batch.queue.get(hostname)?.state).toBe("published");
    } finally {
      batch.close();
    }
  });
});
