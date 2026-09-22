import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OOXML_PROFILE_SHA256 } from "./adapters/ooxml.ts";
import { HostBatch } from "./batch.ts";
import { formatRoutingPolicy, type HostRoutingPolicy } from "./category-routing.ts";
import type { CompletedHost, ProducerContext, SearchDocument } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { cheapGuardCompletedHost } from "./generic.ts";
import { deriveCollectionInputDigest } from "./inputs.ts";
import { DEFAULT_EXTERNAL_ROOT, EXTERNAL_BOUNDARY } from "./paths.ts";

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  producer: vi.fn(),
  seal: vi.fn(),
  historical: vi.fn(),
  pdfV2: vi.fn(),
}));
vi.mock("./historical-output.ts", () => ({ verifyHistoricalReady: mocks.historical }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: mocks.git,
}));
vi.mock("./provenance.ts", async (original) => ({
  ...(await original<typeof import("./provenance.ts")>()),
  captureProducer: mocks.producer,
}));
vi.mock("./recording.ts", () => ({ HostRecording: { open: async () => ({ verifySeal: mocks.seal, close() {} }) } }));
vi.mock("./pdf-profile-v2.ts", async (original) => ({
  ...(await original<typeof import("./pdf-profile-v2.ts")>()),
  capturePdfV2Profile: mocks.pdfV2,
}));

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
  mocks.pdfV2.mockResolvedValue({ sha256: "f".repeat(64), manifest: {} });
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

  it.each([
    ["unknown envelope field", /ready result fields/],
    ["unknown completed field", /ready completed host fields/],
    ["PDF without profile", /PDF profile and document formats disagree/],
    ["profile without PDF", /PDF profile and document formats disagree/],
    ["mismatched PDF profile", /PDF document profile differs/],
    ["mismatched Markdown profile", /Markdown document profile differs/],
  ] as const)("rejects ready v2 %s before resource verification", async (kind, error) => {
    const { batch, directory, hostname, producer } = await fixture();
    try {
      const home = `https://${hostname}/`;
      const seal = "d".repeat(64);
      const seedBytes = Buffer.from(JSON.stringify({ hostname, urls: [] }));
      const seedSha256 = sha256(seedBytes);
      const title = "Public guidance";
      const body = "Public programme requirements and eligibility.\n";
      const document: SearchDocument = {
        id: `documents:official-web:${sha256(home).slice(0, 24)}`,
        hostname,
        title,
        source_url: home,
        retrieved_at: "2026-09-18T00:00:00.000Z",
        source_modified_at: null,
        snapshot_sha256: "e".repeat(64),
        input_sha256: "0".repeat(64),
        body_sha256: sha256(body),
        content_sha256: sha256(`${title}\n${body}`),
        content_markdown: body,
        warnings: [],
        alternate_urls: [],
        producer,
      };
      const completed: CompletedHost = {
        complete: true,
        host: {
          hostname,
          title,
          homepage_url: home,
          homepage_retrieved_at: "2026-09-18T00:00:00.000Z",
          homepage_sha256: "e".repeat(64),
          scope: "Public text",
          document_root: `data/documents/${hostname}`,
          document_count: 1,
        },
        documents: [document],
      };
      const ready = {
        version: 2 as const,
        hostname,
        recording_seal: seal,
        seed_sha256: seedSha256,
        pdf_profile_sha256: null as string | null,
        markdown_profile_sha256: null as string | null,
        completed,
      };
      const profile = "a".repeat(64);
      if (kind === "unknown envelope field") Object.assign(ready, { unknown: true });
      if (kind === "unknown completed field") Object.assign(completed, { unknown: true });
      if (kind === "PDF without profile" || kind === "mismatched PDF profile") {
        document.extraction = {
          format: "pdf",
          source_bytes_sha256: "b".repeat(64),
          source_bytes: 100,
          pages: 1,
          profile_sha256: kind === "mismatched PDF profile" ? "c".repeat(64) : profile,
        };
        if (kind === "mismatched PDF profile") ready.pdf_profile_sha256 = profile;
      }
      if (kind === "profile without PDF") ready.pdf_profile_sha256 = profile;
      if (kind === "mismatched Markdown profile") {
        const target = home;
        document.extraction = {
          format: "markdown",
          source_bytes_sha256: document.body_sha256,
          source_bytes: Buffer.byteLength(body),
          profile_sha256: "c".repeat(64),
          termination: "observed-pid-absence",
          title_origin: { kind: "markdown-body" },
          witnesses: [
            {
              source_url: `https://${hostname}/witness`,
              snapshot_sha256: completed.host.homepage_sha256,
              target_url: target,
              channel: "html-head",
              title: null,
            },
          ],
        };
        ready.markdown_profile_sha256 = profile;
      }
      document.input_sha256 = deriveCollectionInputDigest({
        recording: seal,
        seed: seedSha256,
        ...(ready.pdf_profile_sha256 ? { pdf_profile: ready.pdf_profile_sha256 } : {}),
        ...(ready.markdown_profile_sha256 ? { markdown_profile: ready.markdown_profile_sha256 } : {}),
      });
      const recording = join(DEFAULT_EXTERNAL_ROOT, "hosts", hostname, "recording");
      await mkdir(recording, { recursive: true });
      await writeFile(join(recording, "seed.json"), seedBytes);
      const readyPath = join(directory, `ready-${kind.replaceAll(" ", "-")}.json`);
      const bytes = Buffer.from(JSON.stringify(ready));
      await writeFile(readyPath, bytes);
      const verifyReady = (
        batch as unknown as {
          verifyReady(row: { hostname: string; details: Record<string, unknown> }): Promise<unknown>;
        }
      ).verifyReady.bind(batch);
      await expect(
        verifyReady({ hostname, details: { ready_path: readyPath, ready_sha256: sha256(bytes) } }),
      ).rejects.toThrow(error);
    } finally {
      batch.close();
    }
  });

  it("accepts a canonical mixed-format ready v3 and rejects tampered profile maps", async () => {
    const { batch, directory, hostname, producer } = await fixture();
    try {
      const seal = "d".repeat(64);
      const seedBytes = Buffer.from(JSON.stringify({ hostname, urls: [] }));
      const seedSha256 = sha256(seedBytes);
      const profiles: { pdf: string | null; docx: string | null; pptx: string | null; markdown: string | null } = {
        pdf: "f".repeat(64),
        docx: OOXML_PROFILE_SHA256,
        pptx: OOXML_PROFILE_SHA256,
        markdown: null,
      };
      const input = deriveCollectionInputDigest({
        recording: seal,
        seed: seedSha256,
        pdf_profile: profiles.pdf!,
        docx_profile: profiles.docx!,
        pptx_profile: profiles.pptx!,
      });
      const body = "Searchable public document text.\n";
      const base = (name: string): SearchDocument => {
        const sourceUrl = `https://${hostname}/${name}`;
        return {
          id: `documents:official-web:${sha256(sourceUrl).slice(0, 24)}`,
          hostname,
          title: name,
          source_url: sourceUrl,
          retrieved_at: "2026-09-18T00:00:00.000Z",
          source_modified_at: null,
          snapshot_sha256: sha256(`snapshot:${name}`),
          input_sha256: input,
          body_sha256: sha256(body),
          content_sha256: sha256(`${name}\n${body}`),
          content_markdown: body,
          warnings: [],
          alternate_urls: [],
          producer,
        };
      };
      const pdf = base("guide.pdf");
      pdf.extraction = {
        format: "pdf-v2",
        source_bytes_sha256: sha256("pdf bytes"),
        source_bytes: 100,
        pages: 2,
        native_text_pages: [1],
        ocr_pages: [2],
        profile_sha256: profiles.pdf!,
      };
      const docx = base("guide.docx");
      docx.extraction = {
        format: "docx",
        source_bytes_sha256: sha256("docx bytes"),
        source_bytes: 101,
        paragraphs: 3,
        tables: 1,
        profile_sha256: profiles.docx!,
      };
      const pptx = base("slides.pptx");
      pptx.extraction = {
        format: "pptx",
        source_bytes_sha256: sha256("pptx bytes"),
        source_bytes: 102,
        slides: 4,
        tables: 1,
        slides_with_notes: 2,
        profile_sha256: profiles.pptx!,
      };
      const completed = cheapGuardCompletedHost({
        complete: true,
        host: {
          hostname,
          title: "Public documents",
          homepage_url: `https://${hostname}/`,
          homepage_retrieved_at: "2026-09-18T00:00:00.000Z",
          homepage_sha256: sha256("homepage"),
          scope: "Public documents",
          document_root: `data/documents/${hostname}`,
          document_count: 3,
        },
        documents: [pdf, docx, pptx],
      });
      const ready = {
        version: 3 as const,
        hostname,
        recording_seal: seal,
        seed_sha256: seedSha256,
        profiles,
        completed,
      };
      const recording = join(DEFAULT_EXTERNAL_ROOT, "hosts", hostname, "recording");
      await mkdir(recording, { recursive: true });
      await writeFile(join(recording, "seed.json"), seedBytes);
      const verifyReady = (
        batch as unknown as {
          verifyReady(row: { hostname: string; details: Record<string, unknown> }): Promise<{ version: number }>;
        }
      ).verifyReady.bind(batch);
      const writeReady = async (name: string, value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value));
        const readyPath = join(directory, `${name}.json`);
        await writeFile(readyPath, bytes);
        return { hostname, details: { ready_path: readyPath, ready_sha256: sha256(bytes) } };
      };
      await expect(verifyReady(await writeReady("ready-v3", ready))).resolves.toMatchObject({ version: 3 });
      const unknownProfile = structuredClone(ready) as typeof ready & { profiles: typeof profiles & { extra?: null } };
      unknownProfile.profiles.extra = null;
      await expect(verifyReady(await writeReady("ready-v3-unknown", unknownProfile))).rejects.toThrow(
        /ready profiles fields/,
      );
      const missingPdf = structuredClone(ready);
      missingPdf.profiles.pdf = null;
      await expect(verifyReady(await writeReady("ready-v3-missing-pdf", missingPdf))).rejects.toThrow();
      const wrongDocx = structuredClone(ready);
      wrongDocx.profiles.docx = "a".repeat(64);
      await expect(verifyReady(await writeReady("ready-v3-wrong-docx", wrongDocx))).rejects.toThrow();
    } finally {
      batch.close();
    }
  });

  it.each(["legacy", "categorized", "ready-v2", "ready-v3", "historical"])(
    "publishes one %s hostname and retries an uncertain push without another commit",
    async (mode) => {
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
        JSON.stringify(
          mode === "ready-v3"
            ? {
                version: 3,
                hostname,
                recording_seal: seal,
                seed_sha256: sha256(seedBytes),
                profiles: { pdf: null, docx: null, pptx: null, markdown: null },
                completed: complete,
              }
            : {
                version: mode === "ready-v2" ? 2 : 1,
                hostname,
                recording_seal: seal,
                seed_sha256: sha256(seedBytes),
                pdf_profile_sha256: null,
                ...(mode === "ready-v2" ? { markdown_profile_sha256: null } : {}),
                completed: complete,
              },
        ),
      );
      const readyPath = join(directory, "ready.json");
      await writeFile(readyPath, ready);
      const policy: HostRoutingPolicy = {
        version: 1,
        hostname,
        decision: {
          method: "model-assisted-first-classification",
          authority: "fixture-owner",
          rationale: "Program homepage reviewed once",
          evidence: [sourceUrl],
        },
        rules: [],
        fallback: { id: "program", category: "academics", rationale: "Saved academic host classification" },
      };
      batch.config.requireSavedRouting = mode !== "legacy";
      if (mode === "historical") {
        batch.config.historicalReady = {
          [hostname]: {
            readySha256: sha256(ready),
            producerRoot: join(directory, "archived-producer"),
            producer,
            pdfCacheDirectory: join(directory, "archived-pdf-cache"),
          },
        };
        mocks.historical.mockResolvedValue(complete);
      }
      batch.queue.update(hostname, token, "collecting");
      batch.queue.update(hostname, token, "ready", {
        ready_path: readyPath,
        ready_sha256: sha256(ready),
        documents: 1,
        ...(mode === "legacy"
          ? {}
          : { routing_policy: policy, routing_policy_sha256: sha256(formatRoutingPolicy(policy)) }),
      });
      const documentRoot = `data/documents/${mode === "legacy" ? "" : "academics/"}${hostname}`;
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
            ...(mode === "legacy" ? [] : [`src/host-scrapers/routing/${hostname}.json`]),
            ...readdirSync(join(repositoryRoot, documentRoot)).map((name) => `${documentRoot}/${name}`),
          ];
          return Buffer.alloc(0);
        }
        if (args[0] === "diff")
          return Buffer.from(
            staged.map((path) => `${path.endsWith("generic-hosts.json") ? "M" : "A"}\0${path}\0`).join(""),
          );
        if (call === "show HEAD:src/host-scrapers/generic-hosts.json") return Buffer.from("[]\n");
        if (args[0] === "show" && args[1]!.startsWith(":"))
          return readFileSync(join(repositoryRoot, args[1]!.slice(1)));
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
        if (mode === "historical")
          expect(mocks.historical).toHaveBeenCalledWith(
            expect.objectContaining({
              hostname,
              readySha256: sha256(ready),
              producerRoot: join(directory, "archived-producer"),
              archivedPdfCacheDirectory: join(directory, "archived-pdf-cache"),
            }),
          );
        expect(batch.queue.get(hostname)?.state).toBe("published");
      } finally {
        batch.close();
      }
    },
  );
});
