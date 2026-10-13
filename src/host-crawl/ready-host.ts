import { join } from "node:path";
import type { HostBatchConfig, ReadyHost } from "./batch-model.ts";
import { digest, exactObject, sha256 } from "./document-format.ts";
import { cheapGuardCompletedHost } from "./generic.ts";
import { verifyHistoricalReady } from "./historical-output.ts";
import { assertCollectedInput, deriveCollectionInputDigest } from "./inputs.ts";
import { withMarkdownCollectionRuntime } from "./markdown-collection-runtime.ts";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { loadCachedPdfProfile } from "./pdf-profile-cache.ts";
import { LARGE_PRIVATE_FILE } from "./private-files.ts";
import { assertSameProducer, captureProducer } from "./provenance.ts";
import { readRegularFile } from "./public-validation.ts";
import type { RecordedHost } from "./recorded-host.ts";
import type { HostWorkRecord } from "./work-queue.ts";

export interface ReadyHostContext {
  directory: string;
  config: HostBatchConfig;
  openRecording(hostname: string): Promise<{
    recording: Pick<RecordedHost["recording"], "verifySeal" | "close">;
    seed: Pick<RecordedHost["seed"], "bytes">;
  }>;
}

/** Validate saved ready bytes against their recording, producer and applicable runtime authorization. */
export async function verifyReadyHost(
  context: ReadyHostContext,
  row: Pick<HostWorkRecord, "hostname" | "details">,
): Promise<ReadyHost> {
  const { config, directory, openRecording } = context;
  const path = assertExternalPath(String(row.details.ready_path));
  const bytes = await readRegularFile(path, LARGE_PRIVATE_FILE);
  if (sha256(bytes) !== row.details.ready_sha256) throw new Error("Ready result bytes changed");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid ready result");
  const version = Object.getOwnPropertyDescriptor(value, "version");
  if (!version || !("value" in version) || ![1, 2].includes(version.value))
    throw new Error("Invalid ready result version");
  exactObject(
    value,
    version.value === 1
      ? ["version", "hostname", "recording_seal", "seed_sha256", "pdf_profile_sha256", "completed"]
      : [
          "version",
          "hostname",
          "recording_seal",
          "seed_sha256",
          "pdf_profile_sha256",
          "markdown_profile_sha256",
          "completed",
        ],
    "ready result",
  );
  const ready = value as unknown as ReadyHost;
  if (ready.hostname !== row.hostname) throw new Error("Invalid ready result owner");
  digest(ready.recording_seal, "ready recording seal");
  digest(ready.seed_sha256, "ready seed");
  if (ready.pdf_profile_sha256 !== null) digest(ready.pdf_profile_sha256, "ready PDF profile");
  const markdownProfileSha256 = ready.version === 2 ? ready.markdown_profile_sha256 : null;
  if (markdownProfileSha256 !== null) digest(markdownProfileSha256, "ready Markdown profile");
  exactObject(ready.completed, ["complete", "host", "documents"], "ready completed host");
  if (JSON.stringify(cheapGuardCompletedHost(ready.completed)) !== JSON.stringify(ready.completed))
    throw new Error("Ready output differs from guarded collection");
  const historical = config.historicalReady?.[row.hostname];
  if (historical) {
    if (historical.readySha256 !== row.details.ready_sha256) throw new Error("Historical ready authorization differs");
    ready.completed = await verifyHistoricalReady({
      hostname: row.hostname,
      readyPath: path,
      readySha256: historical.readySha256,
      recordingDirectory: join(DEFAULT_EXTERNAL_ROOT, "hosts", row.hostname, "recording"),
      producerRoot: historical.producerRoot,
      producer: historical.producer,
      archivedPdfCacheDirectory: historical.pdfCacheDirectory,
    });
  } else {
    const { recording, seed } = await openRecording(row.hostname);
    try {
      if (sha256(seed.bytes) !== ready.seed_sha256) throw new Error("Ready frontier differs");
      assertCollectedInput(ready.recording_seal, await recording.verifySeal());
      assertSameProducer(config.producer, await captureProducer(config.producerRoot));
      const input = deriveCollectionInputDigest({
        recording: ready.recording_seal,
        seed: ready.seed_sha256,
        ...(ready.pdf_profile_sha256 ? { pdf_profile: ready.pdf_profile_sha256 } : {}),
        ...(markdownProfileSha256 ? { markdown_profile: markdownProfileSha256 } : {}),
      });
      for (const document of ready.completed.documents) {
        assertSameProducer(config.producer, document.producer);
        assertCollectedInput(input, document.input_sha256);
      }
      const pdfDocuments = ready.completed.documents.filter((document) => document.extraction?.format === "pdf");
      if (Boolean(pdfDocuments.length) !== Boolean(ready.pdf_profile_sha256))
        throw new Error("Ready PDF profile and document formats disagree");
      if (
        ready.pdf_profile_sha256 &&
        pdfDocuments.some((document) => document.extraction!.profile_sha256 !== ready.pdf_profile_sha256)
      )
        throw new Error("Ready PDF document profile differs");
      if (
        ready.pdf_profile_sha256 &&
        (await loadCachedPdfProfile(join(directory, "pdf-profile-cache"))).sha256 !== ready.pdf_profile_sha256
      )
        throw new Error("Ready PDF profile differs");
      const markdownDocuments = ready.completed.documents.filter(
        (document) => document.extraction?.format === "markdown",
      );
      if (Boolean(markdownDocuments.length) !== Boolean(markdownProfileSha256))
        throw new Error("Ready Markdown profile and document formats disagree");
      if (
        markdownProfileSha256 &&
        markdownDocuments.some((document) => document.extraction!.profile_sha256 !== markdownProfileSha256)
      )
        throw new Error("Ready Markdown document profile differs");
      if (markdownProfileSha256) {
        const verified = await withMarkdownCollectionRuntime(true, async () => undefined);
        if (verified.profile_sha256 !== markdownProfileSha256) throw new Error("Ready Markdown profile differs");
      }
    } finally {
      recording.close();
    }
  }
  return ready;
}
