import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostBatchConfig, ReadyHost } from "./batch-model.ts";
import type { SearchDocument } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { cheapGuardCompletedHost } from "./generic.ts";
import { deriveCollectionInputDigest } from "./inputs.ts";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { verifyReadyHost, type ReadyHostContext } from "./ready-host.ts";

const mocks = vi.hoisted(() => ({ producer: vi.fn(), pdf: vi.fn(), markdown: vi.fn(), historical: vi.fn() }));
vi.mock("./provenance.ts", async (original) => ({
  ...(await original<typeof import("./provenance.ts")>()),
  captureProducer: mocks.producer,
}));
vi.mock("./pdf-profile-cache.ts", () => ({ loadCachedPdfProfile: mocks.pdf }));
vi.mock("./markdown-collection-runtime.ts", () => ({ withMarkdownCollectionRuntime: mocks.markdown }));
vi.mock("./historical-output.ts", () => ({ verifyHistoricalReady: mocks.historical }));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.resetAllMocks();
});

async function fixture(format: "html" | "pdf" | "markdown" = "html", version: 1 | 2 = 2, sourcePath = "") {
  await mkdir(DEFAULT_EXTERNAL_ROOT, { recursive: true });
  const directory = await mkdtemp(join(DEFAULT_EXTERNAL_ROOT, "ready-validation-"));
  directories.push(directory);
  const hostname = "ready-fixture.ubc.ca";
  const home = `https://${hostname}/`;
  const sourceUrl = `${home}${sourcePath}`;
  const seed = Buffer.from(JSON.stringify({ hostname, urls: [] }));
  const profile = sha256("runtime profile");
  const config: HostBatchConfig = {
    repositoryRoot: join(directory, "repository"),
    producerRoot: join(directory, "producer"),
    producer: {
      inputs_sha256: sha256("producer"),
      runtime: { node: "26.8.1", icu: "78.3", unicode: "17.0", platform: "linux", arch: "x64" },
    },
    baseline: "a".repeat(40),
    main: "b".repeat(40),
    bootstrapFiles: {},
  };
  const title = "Public programme guidance";
  const body = "Public programme requirements and eligibility.\n";
  const document: SearchDocument = {
    id: `documents:official-web:${sha256(sourceUrl).slice(0, 24)}`,
    hostname,
    title,
    source_url: sourceUrl,
    retrieved_at: "2026-01-01T00:00:00Z",
    source_modified_at: null,
    snapshot_sha256: sha256("homepage"),
    input_sha256: deriveCollectionInputDigest({
      recording: sha256("seal"),
      seed: sha256(seed),
      ...(format === "pdf" ? { pdf_profile: profile } : {}),
      ...(format === "markdown" ? { markdown_profile: profile } : {}),
    }),
    body_sha256: sha256(body),
    content_sha256: sha256(`${title}\n${body}`),
    content_markdown: body,
    warnings: [],
    alternate_urls: [],
    producer: config.producer,
  };
  if (format === "pdf")
    document.extraction = {
      format,
      source_bytes_sha256: sha256("pdf bytes"),
      source_bytes: 100,
      pages: 1,
      profile_sha256: profile,
    };
  if (format === "markdown")
    document.extraction = {
      format,
      source_bytes_sha256: document.body_sha256,
      source_bytes: Buffer.byteLength(body),
      profile_sha256: profile,
      termination: "observed-pid-absence",
      title_origin: { kind: "markdown-body" },
      witnesses: [
        {
          source_url: `${home}witness`,
          snapshot_sha256: sha256("homepage"),
          target_url: home,
          channel: "html-head",
          title: null,
        },
      ],
    };
  const ready: ReadyHost = {
    ...(version === 1
      ? { version: 1 }
      : { version: 2, markdown_profile_sha256: format === "markdown" ? profile : null }),
    hostname,
    recording_seal: sha256("seal"),
    seed_sha256: sha256(seed),
    pdf_profile_sha256: format === "pdf" ? profile : null,
    completed: {
      complete: true,
      host: {
        hostname,
        title,
        homepage_url: home,
        homepage_retrieved_at: document.retrieved_at,
        homepage_sha256: document.snapshot_sha256,
        scope: "Public institutional guidance",
        document_root: `data/documents/${hostname}`,
        document_count: 1,
      },
      documents: [document],
    },
  };
  const close = vi.fn();
  const verifySeal = vi.fn(async () => ready.recording_seal);
  const openRecording = vi.fn(async () => ({ recording: { verifySeal, close }, seed: { bytes: seed } }));
  const context: ReadyHostContext = { config, directory, openRecording };
  const row = { hostname, details: { ready_path: join(directory, "ready.json"), ready_sha256: "" } };
  const save = async () => {
    const bytes = Buffer.from(JSON.stringify(ready));
    row.details.ready_sha256 = sha256(bytes);
    await writeFile(row.details.ready_path, bytes);
  };
  await save();
  mocks.producer.mockResolvedValue(config.producer);
  mocks.pdf.mockResolvedValue({ sha256: profile });
  mocks.markdown.mockResolvedValue({ profile_sha256: profile });
  return {
    context,
    row,
    ready,
    document,
    profile,
    close,
    verifySeal,
    openRecording,
    save,
    verify: () => verifyReadyHost(context, row),
  };
}

describe("internal ready-host verification", () => {
  it.each([1, 2] as const)("accepts exact v%s HTML without preparing native resources", async (version) => {
    const f = await fixture("html", version);
    expect(await f.verify()).toEqual(f.ready);
    expect(f.openRecording).toHaveBeenCalledWith(f.row.hostname);
    expect(f.close).toHaveBeenCalledOnce();
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect(mocks.markdown).not.toHaveBeenCalled();
  });

  it.each(["pdf", "markdown"] as const)(
    "verifies the current %s profile before accepting ready output",
    async (format) => {
      const f = await fixture(format);
      expect(await f.verify()).toEqual(f.ready);
      if (format === "pdf") expect(mocks.pdf).toHaveBeenCalledWith(join(f.context.directory, "pdf-profile-cache"));
      else expect(mocks.markdown).toHaveBeenCalledWith(true, expect.any(Function));
      expect(f.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["pdf", "markdown"] as const)(
    "rejects changed %s runtime evidence and closes the recording",
    async (format) => {
      const f = await fixture(format);
      if (format === "pdf") mocks.pdf.mockResolvedValue({ sha256: sha256("changed profile") });
      else mocks.markdown.mockResolvedValue({ profile_sha256: sha256("changed profile") });
      await expect(f.verify()).rejects.toThrow(`Ready ${format === "pdf" ? "PDF" : "Markdown"} profile differs`);
      expect(f.close).toHaveBeenCalledOnce();
    },
  );

  it("preserves a runtime verification failure and closes the recording", async () => {
    const f = await fixture("markdown");
    const failure = new Error("Runtime verification failed");
    mocks.markdown.mockRejectedValue(failure);
    await expect(f.verify()).rejects.toBe(failure);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each(["frontier", "seal", "producer", "document input"])(
    "rejects changed %s evidence before runtime verification",
    async (change) => {
      const f = await fixture("markdown");
      if (change === "frontier") f.ready.seed_sha256 = sha256("changed seed");
      if (change === "seal") f.verifySeal.mockResolvedValue(sha256("changed seal"));
      if (change === "producer")
        mocks.producer.mockResolvedValue({ ...f.context.config.producer, inputs_sha256: sha256("changed producer") });
      if (change === "document input") f.document.input_sha256 = sha256("changed input");
      await f.save();
      await expect(f.verify()).rejects.toThrow();
      expect(f.close).toHaveBeenCalledOnce();
      expect(mocks.markdown).not.toHaveBeenCalled();
    },
  );

  it.each([
    [1, false],
    [2, false],
    [1, true],
    [2, true],
  ] as const)("rejects a valid foreign completed owner in v%s (historical=%s)", async (version, historical) => {
    const f = await fixture("html", version);
    const hostname = "different-ready-fixture.ubc.ca";
    const home = `https://${hostname}/`;
    Object.assign(f.ready.completed.host, {
      hostname,
      homepage_url: home,
      document_root: `data/documents/${hostname}`,
    });
    Object.assign(f.document, {
      hostname,
      source_url: home,
      id: `documents:official-web:${sha256(home).slice(0, 24)}`,
    });
    expect(cheapGuardCompletedHost(f.ready.completed)).toEqual(f.ready.completed);
    await f.save();
    if (historical) {
      f.context.config.historicalReady = {
        [f.row.hostname]: {
          readySha256: f.row.details.ready_sha256,
          producerRoot: join(f.context.directory, "archived-producer"),
          producer: f.context.config.producer,
        },
      };
      mocks.historical.mockResolvedValue(f.ready.completed);
    }
    await expect(f.verify()).rejects.toThrow("Unregistered or noncanonical vetted hostname");
    expect(f.openRecording).not.toHaveBeenCalled();
    expect(mocks.historical).not.toHaveBeenCalled();
    expect(mocks.producer).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect(mocks.markdown).not.toHaveBeenCalled();
  });

  it("rejects a historical verifier result owned by a different host", async () => {
    const f = await fixture("html", 1);
    f.context.config.historicalReady = {
      [f.row.hostname]: {
        readySha256: f.row.details.ready_sha256,
        producerRoot: join(f.context.directory, "archived-producer"),
        producer: f.context.config.producer,
      },
    };
    const completed = structuredClone(f.ready.completed);
    const hostname = "different-ready-fixture.ubc.ca";
    completed.host = {
      ...completed.host,
      hostname,
      homepage_url: `https://${hostname}/`,
      document_root: `data/documents/${hostname}`,
    };
    Object.assign(completed.documents[0]!, {
      hostname,
      source_url: completed.host.homepage_url,
      id: `documents:official-web:${sha256(completed.host.homepage_url).slice(0, 24)}`,
    });
    expect(cheapGuardCompletedHost(completed)).toEqual(completed);
    mocks.historical.mockResolvedValue(completed);
    await expect(f.verify()).rejects.toThrow("Unregistered or noncanonical vetted hostname");
    expect(f.openRecording).not.toHaveBeenCalled();
    expect(mocks.producer).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect(mocks.markdown).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "requires exact historical authorization (matching %s) without opening current resources",
    async (matching) => {
      const f = await fixture("pdf", 1, "file.pdf");
      f.context.config.historicalReady = {
        [f.row.hostname]: {
          readySha256: matching ? f.row.details.ready_sha256 : sha256("different ready"),
          producerRoot: join(f.context.directory, "archived-producer"),
          producer: f.context.config.producer,
        },
      };
      mocks.historical.mockResolvedValue(f.ready.completed);
      if (matching) expect(await f.verify()).toEqual(f.ready);
      else await expect(f.verify()).rejects.toThrow("Historical ready authorization differs");
      expect(mocks.historical).toHaveBeenCalledTimes(matching ? 1 : 0);
      expect(f.openRecording).not.toHaveBeenCalled();
      expect(mocks.producer).not.toHaveBeenCalled();
      expect(mocks.pdf).not.toHaveBeenCalled();
      expect(mocks.markdown).not.toHaveBeenCalled();
    },
  );
});
