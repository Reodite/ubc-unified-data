import { createHash } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ROOT } from "./base.ts";
import { extractDocx } from "./host-crawl/adapters/docx.ts";
import { captureOoxmlProfile, OOXML_PROFILE_SHA256 } from "./host-crawl/adapters/ooxml.ts";
import { extractPdfV2 } from "./host-crawl/adapters/pdf-v2.ts";
import { extractPptx } from "./host-crawl/adapters/pptx.ts";
import { loadRoutingPolicy, loadSavedClassifications, routeCompletedHost } from "./host-crawl/category-routing.ts";
import { collectRecordedHost } from "./host-crawl/collect.ts";
import type { HostArchive, SavedUrl } from "./host-crawl/contracts.ts";
import { assertCollectedInput, decodeFrozenSeed, deriveCollectionInputDigest } from "./host-crawl/inputs.ts";
import { withMarkdownCollectionRuntime } from "./host-crawl/markdown-collection-runtime.ts";
import { assertExternalPath, DEFAULT_EXTERNAL_ROOT, DEFAULT_LEGACY_STATE_FILE } from "./host-crawl/paths.ts";
import { assertPdfV2Profile, capturePdfV2Profile, type PdfV2Profile } from "./host-crawl/pdf-profile-v2.ts";
import { assertSameProducer, captureProducer } from "./host-crawl/provenance.ts";
import { readRegularFile } from "./host-crawl/public-validation.ts";
import { publishCompletedHost } from "./host-crawl/publication.ts";
import { HostRecording } from "./host-crawl/recording.ts";
import { getHostScraper, registeredHostnames } from "./host-crawl/registry.ts";
import { pageExclusion } from "./host-crawl/urls.ts";

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
  const directory = assertExternalPath(join(DEFAULT_EXTERNAL_ROOT, "hosts", scraper.hostname, "recording"));
  const source = await captureProducer();
  const acquisitionSource = source;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pdfWorkspace = assertExternalPath(join(directory, "pdf-v2-runtime"));
  let pdfProfile: PdfV2Profile | undefined;
  const seedPath = join(directory, "seed.json");
  let seedBytes: Buffer;
  try {
    seedBytes = await readRegularFile(seedPath, 16 * 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !values.acquire) throw error;
    const db = new DatabaseSync(assertExternalPath(DEFAULT_LEGACY_STATE_FILE), { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON;");
      const seed = {
        hostname: scraper.hostname,
        urls: db
          .prepare(
            "SELECT url,kind,state,disposition,reason,snapshot,article_id,source_modified_at FROM urls WHERE host=? ORDER BY url",
          )
          .all(scraper.hostname) as unknown as SavedUrl[],
      };
      seedBytes = Buffer.from(JSON.stringify(seed));
    } finally {
      db.close();
    }
    await writeFile(seedPath, seedBytes, { flag: "wx", mode: 0o600 });
  }
  const seed = decodeFrozenSeed(seedBytes, scraper.hostname);
  const recording = await HostRecording.open({
    hostname: scraper.hostname,
    directory,
    producer: acquisitionSource,
    seedSha256: digest(seed.bytes),
    acquire: values.acquire,
    resumeInterrupted: values["resume-interrupted"],
    documentFormats: scraper.documentFormats?.filter((format) => format !== "markdown"),
    documentUrlAllowed: (url) =>
      (scraper.excludeUrl ? scraper.excludeUrl(url) : pageExclusion(url, scraper.hostname)) === null,
    allowDocumentPolicyUpgrade: true,
    maxResponseBytes: scraper.documentFormats?.some((format) => format !== "markdown") ? 64 * 1024 * 1024 : undefined,
  });
  try {
    let replayInput: string | undefined;
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
    } else replayInput = await recording.verifySeal();
    const homepage = await recording.read(`https://${scraper.hostname}/`);
    const verdict = scraper.vetHomepage(homepage.snapshot);
    if (!verdict.accepted) throw new Error(`Current recorded homepage fails the acceptance policy: ${verdict.reason}`);
    const archive: HostArchive = {
      hostname: scraper.hostname,
      input_sha256: recording.inputDigest(),
      homepage,
      urls: seed.urls,
      retained: [],
      read: (url) => recording.read(url),
      readDocument: (url) => recording.readDocument(url),
      readSnapshot: (sha) => recording.readSnapshot(sha),
      readBytes: (sha) => recording.readBytes(sha),
      readTextBytes: (sha) => recording.readTextBytes(sha),
      observedDestination: (url) => recording.observedDestination(url),
      apiFallbackEligible: (url) => recording.apiFallbackEligible(url),
      assertUnchanged: () => recording.assertUnchanged(),
      close() {},
    };
    const collected = await withMarkdownCollectionRuntime(
      scraper.documentFormats?.includes("markdown") === true,
      (markdown) =>
        collectRecordedHost(scraper, archive, source, {
          ...(scraper.documentFormats?.includes("pdf")
            ? {
                pdf: {
                  get profile_sha256() {
                    if (!pdfProfile) throw new Error("PDF v2 profile was not initialized by extraction");
                    return pdfProfile.sha256;
                  },
                  extract: async (bytes: Uint8Array, sourceUrl: string) => {
                    pdfProfile ??= await capturePdfV2Profile(join(directory, "pdf-v2-profile"));
                    const result = await extractPdfV2({
                      bytes,
                      sourceUrl,
                      workspace: pdfWorkspace,
                      profile: pdfProfile,
                    });
                    return {
                      title: result.title,
                      markdown: result.markdown,
                      warnings: result.warnings,
                      pageCount: result.pages,
                      nativeTextPages: result.native_text_pages,
                      ocrPages: result.ocr_pages,
                    };
                  },
                },
              }
            : {}),
          ...(scraper.documentFormats?.includes("docx")
            ? {
                docx: {
                  profile_sha256: OOXML_PROFILE_SHA256,
                  extract: async (bytes: Uint8Array) => {
                    const result = await extractDocx({ bytes });
                    if (result.profileSha256 !== OOXML_PROFILE_SHA256 || result.sourceSha256 !== digest(bytes))
                      throw new Error("DOCX extraction evidence differs from the authenticated source or profile");
                    return {
                      title: result.title,
                      markdown: result.markdown,
                      warnings: result.warnings,
                      paragraphs: result.paragraphCount,
                      tables: result.tableCount,
                    };
                  },
                },
              }
            : {}),
          ...(scraper.documentFormats?.includes("pptx")
            ? {
                pptx: {
                  profile_sha256: OOXML_PROFILE_SHA256,
                  extract: async (bytes: Uint8Array) => {
                    const result = await extractPptx({ bytes });
                    if (result.profileSha256 !== OOXML_PROFILE_SHA256 || result.sourceSha256 !== digest(bytes))
                      throw new Error("PPTX extraction evidence differs from the authenticated source or profile");
                    return {
                      title: result.title,
                      markdown: result.markdown,
                      warnings: result.warnings,
                      slides: result.slideCount,
                      tables: result.tableCount,
                      slidesWithNotes: result.noteCount,
                    };
                  },
                },
              }
            : {}),
          ...(markdown ? { markdown } : {}),
        }),
    );
    const result = collected.value;
    const markdownProfileSha256 = collected.profile_sha256;
    const usedFormats = new Set(result.documents.map((document) => document.extraction?.format));
    const docxProfileSha256 = usedFormats.has("docx") ? OOXML_PROFILE_SHA256 : null;
    const pptxProfileSha256 = usedFormats.has("pptx") ? OOXML_PROFILE_SHA256 : null;
    const sealed = values.acquire ? await recording.seal() : await recording.verifySeal();
    if (replayInput) assertCollectedInput(replayInput, sealed);
    const input = deriveCollectionInputDigest({
      recording: sealed,
      seed: digest(seed.bytes),
      ...(pdfProfile ? { pdf_profile: pdfProfile.sha256 } : {}),
      ...(docxProfileSha256 ? { docx_profile: docxProfileSha256 } : {}),
      ...(pptxProfileSha256 ? { pptx_profile: pptxProfileSha256 } : {}),
      ...(markdownProfileSha256 ? { markdown_profile: markdownProfileSha256 } : {}),
    });
    for (const doc of result.documents) doc.input_sha256 = input;
    const verifyInputs = async () => {
      if (pdfProfile) await assertPdfV2Profile(pdfProfile, join(directory, "pdf-v2-profile-verify"));
      const currentOoxmlProfile = captureOoxmlProfile().sha256;
      if (docxProfileSha256 && docxProfileSha256 !== currentOoxmlProfile)
        throw new Error("Recorded DOCX profile changed");
      if (pptxProfileSha256 && pptxProfileSha256 !== currentOoxmlProfile)
        throw new Error("Recorded PPTX profile changed");
      if (markdownProfileSha256) {
        const verified = await withMarkdownCollectionRuntime(true, async () => undefined);
        if (verified.profile_sha256 !== markdownProfileSha256) throw new Error("Recorded Markdown profile changed");
      }
      if (!(await readRegularFile(seedPath, 16 * 1024 * 1024)).equals(seed.bytes))
        throw new Error("Saved frontier changed");
      assertCollectedInput(sealed, await recording.verifySeal());
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
    try {
      await writeFile(verifiedPath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(await readRegularFile(verifiedPath, bytes.length)).equals(bytes)
      )
        throw error;
    }
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
