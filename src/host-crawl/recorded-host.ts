import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, HostScraper, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import { assertCollectedInput, decodeFrozenSeed, deriveCollectionInputDigest } from "./inputs.ts";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT, DEFAULT_LEGACY_STATE_FILE } from "./paths.ts";
import { isAbsent, writeImmutable } from "./private-files.ts";
import { readRegularFile } from "./public-validation.ts";
import { HostRecording, type RecordingOptions } from "./recording.ts";
import { pageUrlPolicy } from "./urls.ts";

const SEED_LIMIT = 16 * 1024 * 1024;

export interface RecordedHost {
  recording: HostRecording;
  directory: string;
  scraper: HostScraper;
  seed: ReturnType<typeof decodeFrozenSeed>;
  seedPath: string;
  sealed: boolean;
}

export async function openRecordedHost(options: {
  scraper: HostScraper;
  producer: ProducerContext;
  acquire: boolean;
  reuseSealed?: boolean;
  resumeInterrupted?: boolean;
  recoverTransientFailures?: boolean;
  directory?: string;
  legacyStateFile?: string;
  transport?: Pick<RecordingOptions, "fetcher" | "minimumMs" | "timeoutMs">;
}): Promise<RecordedHost> {
  const { scraper } = options;
  const directory = assertExternalPath(
    options.directory ?? join(DEFAULT_EXTERNAL_ROOT, "hosts", scraper.hostname, "recording"),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const seedPath = join(directory, "seed.json");
  let bytes: Buffer;
  try {
    bytes = await readRegularFile(seedPath, SEED_LIMIT);
  } catch (error) {
    if (!isAbsent(error) || !options.acquire) throw error;
    const database = new DatabaseSync(assertExternalPath(options.legacyStateFile ?? DEFAULT_LEGACY_STATE_FILE), {
      readOnly: true,
    });
    try {
      database.exec("PRAGMA query_only=ON");
      const urls = database
        .prepare(
          "SELECT url,kind,state,disposition,reason,snapshot,article_id,source_modified_at FROM urls WHERE host=? ORDER BY url",
        )
        .all(scraper.hostname);
      bytes = Buffer.from(JSON.stringify({ hostname: scraper.hostname, urls }));
    } finally {
      database.close();
    }
    await writeImmutable(seedPath, bytes);
  }
  const seed = decodeFrozenSeed(bytes, scraper.hostname);
  let sealed = false;
  try {
    await readRegularFile(join(directory, "seal.json"));
    sealed = true;
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
  const recording = await HostRecording.open({
    ...options.transport,
    hostname: scraper.hostname,
    directory,
    producer: options.producer,
    seedSha256: sha256(seed.bytes),
    acquire: options.acquire && !(options.reuseSealed && sealed),
    resumeInterrupted: options.resumeInterrupted,
    recoverTransientFailures: options.recoverTransientFailures,
    documentUrlAllowed: (url) =>
      (scraper.excludeUrl ? scraper.excludeUrl(url) : pageUrlPolicy(url, scraper.hostname)) === null,
    htmlDocumentsOnly: true,
  });
  return { recording, directory, scraper, seed, seedPath, sealed };
}

/** Reconstruct and bind a complete host; routing, duplicate coalescing and publication belong to callers. */
export async function collectRecordedSession(
  session: RecordedHost,
  producer: ProducerContext,
  options: { mode: "acquire" | "replay"; scopeExclusions: "fail" | "skip-recorded" },
) {
  const { recording, scraper, seed, seedPath } = session;
  const replayInput = options.mode === "replay" ? await recording.verifySeal() : undefined;
  const homepage = await recording.readDocument(`https://${scraper.hostname}/`);
  const archive: HostArchive = {
    hostname: scraper.hostname,
    input_sha256: recording.inputDigest(),
    homepage,
    urls: seed.urls,
    retained: [],
    read: (url) => recording.read(url),
    readDocument: (url) => recording.readDocument(url),
    readSnapshot: (hash) => recording.readSnapshot(hash),
    observedDestination: (url) => recording.observedDestination(url),
    ...(options.scopeExclusions === "skip-recorded"
      ? { observedScopeExclusion: (url: string) => recording.observedScopeExclusion(url) }
      : {}),
    assertUnchanged: () => recording.assertUnchanged(),
    close() {},
  };
  const completed = await collectRecordedHost(scraper, archive, producer);
  const seal = options.mode === "acquire" ? await recording.seal() : await recording.verifySeal();
  if (replayInput) assertCollectedInput(replayInput, seal);
  const seedSha256 = sha256(seed.bytes);
  const input = deriveCollectionInputDigest({ recording: seal, seed: seedSha256 });
  for (const document of completed.documents) document.input_sha256 = input;
  const verifyInputs = async () => {
    if (!(await readRegularFile(seedPath, SEED_LIMIT)).equals(seed.bytes)) throw new Error("Saved frontier changed");
    assertCollectedInput(seal, await recording.verifySeal());
  };
  await verifyInputs();
  return { completed, seal, seedSha256, input, verifyInputs };
}
