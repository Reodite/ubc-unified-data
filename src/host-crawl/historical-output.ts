import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompletedHost, Observation, ProducerContext, SearchDocument } from "./contracts.ts";
import { digest, exactHostUrl, exactObject, formatDocument, parseDocument, sha256 } from "./document-format.ts";
import { decodeFrozenSeed, deriveCollectionInputDigest } from "./inputs.ts";
import { assertExternalPath } from "./paths.ts";
import type { PdfProfile } from "./pdf-profile.ts";
import { assertSameProducer, captureProducer } from "./provenance.ts";
import { readRegularFile, requireDirectory, validateVettedHost } from "./public-validation.ts";
import { HostRecording } from "./recording.ts";
import { normalizeHost } from "./urls.ts";

const MAX_READY_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const IDENTITY_KEYS = [
  "dev",
  "ino",
  "mode",
  "nlink",
  "uid",
  "gid",
  "rdev",
  "size",
  "blksize",
  "blocks",
  "mtimeNs",
  "ctimeNs",
  "birthtimeNs",
];

export interface VerifyHistoricalReadyOptions {
  hostname: string;
  readyPath: string;
  readySha256: string;
  recordingDirectory: string;
  producerRoot: string;
  producer: ProducerContext;
  archivedPdfCacheDirectory?: string;
}

interface HistoricalReady {
  version: 1;
  hostname: string;
  recording_seal: string;
  seed_sha256: string;
  pdf_profile_sha256: string | null;
  completed: CompletedHost;
}

function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}

// Profile v1 sorts object keys recursively; JSON insertion order is not its digest encoding.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Unsupported archived PDF profile value");
  return result;
}

function absolutePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value)
    throw new Error("Invalid archived PDF resource path");
}

function validateProfile(value: unknown, expectedHash: string): asserts value is PdfProfile {
  exactObject(value, ["sha256", "manifest"], "archived PDF profile");
  digest(value.sha256, "archived PDF profile");
  const manifest = value.manifest;
  exactObject(
    manifest,
    [
      "schema",
      "platform",
      "architecture",
      "executables",
      "versions",
      "linkedLibraries",
      "resourceRoots",
      "resources",
      "capabilities",
      "extraction",
      "limitations",
    ],
    "archived PDF manifest",
  );
  if (
    manifest.schema !== "host-pdf-profile-v1" ||
    value.sha256 !== expectedHash ||
    sha256(canonical(manifest)) !== expectedHash
  )
    throw new Error("Archived PDF profile digest differs from ready output");
  exactObject(manifest.executables, ["info", "text", "limits", "loader"], "PDF executables");
  for (const path of Object.values(manifest.executables)) absolutePath(path);
  exactObject(manifest.capabilities, ["pdftotextHelp", "removeHyphens"], "PDF capabilities");
  exactObject(manifest.capabilities.pdftotextHelp, ["arguments", "stdout", "stderr"], "PDF capability help");
  exactObject(
    manifest.extraction,
    [
      "infoArguments",
      "textArguments",
      "limitArguments",
      "environment",
      "fontconfig",
      "limits",
      "inputName",
      "output",
      "markdown",
    ],
    "PDF extraction manifest",
  );
  exactObject(
    manifest.extraction.limits,
    [
      "inputBytes",
      "outputBytes",
      "infoBytes",
      "diagnosticBytes",
      "pages",
      "timeoutMs",
      "addressSpaceBytes",
      "cpuSeconds",
      "openFiles",
    ],
    "PDF extraction limits",
  );
  for (const bound of Object.values(manifest.extraction.limits))
    if (!Number.isSafeInteger(bound) || (bound as number) < 1) throw new Error("Invalid archived PDF extraction limit");
  if (manifest.extraction.markdown !== "labelled-pages-dynamic-backtick-fences-v1")
    throw new Error("Unsupported archived PDF Markdown format");
  if (!Array.isArray(manifest.resources) || !manifest.resources.length)
    throw new Error("Missing archived PDF resources");
  let previous = "";
  for (const resource of manifest.resources) {
    const fields: Record<string, string[]> = {
      missing: ["path", "kind"],
      file: ["path", "kind", "resolvedPath", "bytes", "sha256"],
      directory: ["path", "kind", "resolvedPath", "entries"],
      symlink: ["path", "kind", "target", "resolvedPath"],
    };
    const keys = resource && fields[resource.kind];
    if (!keys) throw new Error("Invalid archived PDF resource kind");
    exactObject(resource, keys, "archived PDF resource");
    absolutePath(resource.path);
    if (resource.path <= previous) throw new Error("Archived PDF resources must be unique and sorted");
    previous = resource.path;
    if (resource.kind === "file") {
      digest(resource.sha256, "archived PDF resource");
      if (!Number.isSafeInteger(resource.bytes) || (resource.bytes as number) < 0)
        throw new Error("Invalid archived PDF resource byte count");
    }
    if (resource.kind === "symlink" && typeof resource.target !== "string")
      throw new Error("Invalid archived PDF symlink target");
    if (resource.kind !== "missing" && !(resource.kind === "symlink" && resource.resolvedPath === null))
      absolutePath(resource.resolvedPath);
    if (
      resource.kind === "directory" &&
      (!Array.isArray(resource.entries) || resource.entries.some((name) => typeof name !== "string"))
    )
      throw new Error("Invalid archived PDF directory entries");
  }
}

async function privateFile(path: string, immutable = false): Promise<void> {
  assertExternalPath(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.mode & (immutable ? 0o377 : 0o077) || info.uid !== process.getuid!())
    throw new Error("Archived PDF cache requires private owned regular files and an immutable payload");
}

/** Read archived evidence only; never authorize a profile for extraction or inspect its current resources. */
async function archivedProfile(directory: string, expectedHash: string): Promise<PdfProfile> {
  directory = assertExternalPath(directory);
  await requireDirectory(directory);
  const info = await lstat(directory);
  if (info.mode & 0o077 || info.uid !== process.getuid!())
    throw new Error("Archived PDF cache must be private and owned");
  const receiptPath = join(directory, "creation.sqlite");
  await privateFile(receiptPath);
  const receiptBytes = await readRegularFile(receiptPath, MAX_CACHE_BYTES);
  // Cache v1 uses rollback journaling; opening a WAL archive can create or update shared-memory sidecars.
  if (
    receiptBytes.subarray(0, 16).toString("ascii") !== "SQLite format 3\0" ||
    receiptBytes[18] !== 1 ||
    receiptBytes[19] !== 1
  )
    throw new Error("Archived PDF cache receipt must use rollback journaling");
  const database = new DatabaseSync(receiptPath, { readOnly: true });
  let row: Record<string, unknown>;
  try {
    database.exec("PRAGMA query_only=ON");
    const rows = database.prepare("SELECT * FROM profile_cache").all();
    if (rows.length !== 1) throw new Error("Invalid archived PDF cache receipt count");
    row = rows[0]!;
    exactObject(row, ["id", "sha256", "bytes"], "archived PDF cache receipt");
    digest(row.sha256, "archived PDF cache payload");
    if (
      row.id !== 1 ||
      !Number.isSafeInteger(row.bytes) ||
      (row.bytes as number) < 1 ||
      (row.bytes as number) > MAX_CACHE_BYTES
    )
      throw new Error("Invalid archived PDF cache receipt");
  } finally {
    database.close();
  }
  const path = join(directory, `${row.sha256}.json`);
  await privateFile(path, true);
  const bytes = await readRegularFile(path, MAX_CACHE_BYTES);
  await privateFile(path, true);
  if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256)
    throw new Error("Archived PDF cache payload hash mismatch");
  const cached = json(bytes);
  exactObject(cached, ["schema", "profile", "identities"], "archived PDF cache");
  if (cached.schema !== "host-pdf-profile-cache-v1") throw new Error("Unknown archived PDF cache schema");
  validateProfile(cached.profile, expectedHash);
  const resources = cached.profile.manifest.resources;
  if (!Array.isArray(cached.identities) || cached.identities.length !== resources.length)
    throw new Error("Incomplete archived PDF identities");
  for (const [index, identity] of cached.identities.entries()) {
    exactObject(identity, ["path", "lstat", "stat", "resolvedPath", "target", "entries"], "archived PDF identity");
    if (identity.path !== resources[index]!.path) throw new Error("Archived PDF identity path differs");
    for (const key of ["lstat", "stat"])
      if (identity[key] !== null) {
        exactObject(identity[key], IDENTITY_KEYS, "archived PDF stat");
        if (Object.values(identity[key]).some((value) => typeof value !== "string" || !/^-?\d+$/.test(value)))
          throw new Error("Invalid archived PDF stat value");
      }
  }
  if (!(await readRegularFile(receiptPath, MAX_CACHE_BYTES)).equals(receiptBytes))
    throw new Error("Archived PDF cache receipt changed during verification");
  return cached.profile;
}

function verifyPdfPages(document: SearchDocument, profile: PdfProfile): void {
  const extraction = document.extraction!;
  if (extraction.format !== "pdf") throw new Error("Historical ready v1 supports only PDF extraction");
  if (
    extraction.pages > profile.manifest.extraction.limits.pages ||
    extraction.source_bytes > profile.manifest.extraction.limits.inputBytes
  )
    throw new Error("Ready PDF exceeds its archived profile bounds");
  let remaining = document.content_markdown;
  for (let page = 1; page <= extraction.pages; page++) {
    const heading = `## Page ${page}\n\n`;
    if (!remaining.startsWith(heading)) throw new Error("Ready PDF page labels disagree with extraction metadata");
    remaining = remaining.slice(heading.length);
    const fence = /^(`{3,})text\n/.exec(remaining)?.[1];
    if (!fence) throw new Error("Invalid ready PDF page fence");
    remaining = remaining.slice(fence.length + 5);
    const end = remaining.indexOf(`\n${fence}`);
    if (end < 0) throw new Error("Unclosed ready PDF page fence");
    const text = remaining.slice(0, end);
    let longest = 2;
    for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    if (fence.length !== longest + 1) throw new Error("Noncanonical ready PDF page fence");
    remaining = remaining.slice(end + 1 + fence.length);
    const separator = page === extraction.pages ? "\n" : "\n\n";
    if (!remaining.startsWith(separator)) throw new Error("Invalid ready PDF page separator");
    remaining = remaining.slice(separator.length);
  }
  if (remaining) throw new Error("Ready PDF page count disagrees with extraction metadata");
}

/**
 * Verify retained output integrity, not extraction reproducibility under current native dependencies.
 * Preserve original producer/profile metadata and documents; callers must repeat immediately before publication.
 * Read only saved evidence, apart from acquiring/releasing the existing recording ownership lock.
 */
export async function verifyHistoricalReady(options: VerifyHistoricalReadyOptions): Promise<CompletedHost> {
  const { hostname, producer } = options;
  if (normalizeHost(hostname) !== hostname) throw new Error("Noncanonical historical hostname");
  digest(options.readySha256, "expected ready output");
  const readyPath = assertExternalPath(options.readyPath);
  const directory = assertExternalPath(options.recordingDirectory);
  const producerRoot = assertExternalPath(options.producerRoot);
  const readyBytes = await readRegularFile(readyPath, MAX_READY_BYTES);
  if (sha256(readyBytes) !== options.readySha256) throw new Error("Ready result bytes changed");
  const value = json(readyBytes);
  exactObject(
    value,
    ["version", "hostname", "recording_seal", "seed_sha256", "pdf_profile_sha256", "completed"],
    "ready output",
  );
  if (value.version !== 1 || value.hostname !== hostname) throw new Error("Invalid ready result owner or version");
  digest(value.recording_seal, "recording seal");
  digest(value.seed_sha256, "frozen seed");
  if (value.pdf_profile_sha256 !== null) digest(value.pdf_profile_sha256, "ready PDF profile");
  exactObject(value.completed, ["complete", "host", "documents"], "completed host");
  validateVettedHost(value.completed.host, [hostname]);
  if (
    value.completed.complete !== true ||
    !Array.isArray(value.completed.documents) ||
    value.completed.host.document_count !== value.completed.documents.length
  )
    throw new Error("Incomplete or inconsistent ready output count");
  const ready = value as unknown as HistoricalReady;
  const seedPath = join(directory, "seed.json");
  const seedBytes = await readRegularFile(seedPath, 16 * 1024 * 1024);
  exactObject(json(seedBytes), ["hostname", "urls"], "frozen seed");
  decodeFrozenSeed(seedBytes, hostname);
  if (sha256(seedBytes) !== ready.seed_sha256) throw new Error("Ready frozen seed differs");
  await requireDirectory(join(directory, "objects"));
  // Require existing databases so offline inspection cannot initialize a new recording or owner file.
  await readRegularFile(join(directory, "owner.sqlite"), MAX_CACHE_BYTES);
  await readRegularFile(join(directory, "state.sqlite"), MAX_READY_BYTES);
  assertSameProducer(producer, await captureProducer(producerRoot));
  const recording = await HostRecording.open({
    hostname,
    directory,
    producer,
    seedSha256: ready.seed_sha256,
    acquire: false,
  });
  try {
    const sealPath = join(directory, "seal.json");
    const sealBytes = await readRegularFile(sealPath);
    const seal = json(sealBytes);
    exactObject(seal, ["version", "hostname", "input_sha256"], "recording seal");
    if (
      seal.version !== 1 ||
      seal.hostname !== hostname ||
      seal.input_sha256 !== ready.recording_seal ||
      (await recording.verifySeal()) !== ready.recording_seal
    )
      throw new Error("Ready recording seal differs");
    const database = new DatabaseSync(join(directory, "state.sqlite"), { readOnly: true });
    const members = new Set<string>();
    const outcomes = new Map<string, string>();
    try {
      database.exec("PRAGMA query_only=ON");
      for (const row of database.prepare("SELECT state,snapshot FROM attempts").all()) {
        if (!["observed", "failed", "excluded-media"].includes(String(row.state)))
          throw new Error("Uncertain or unsupported recorded attempt state");
        if (row.snapshot !== null) {
          digest(row.snapshot, "attempt snapshot");
          members.add(row.snapshot);
        }
      }
      for (const row of database.prepare("SELECT url,snapshot,error FROM outcomes").all()) {
        exactHostUrl(row.url, hostname);
        if (row.snapshot !== null) {
          digest(row.snapshot, "outcome snapshot");
          if (row.error !== null) throw new Error("Ambiguous recorded outcome");
          members.add(row.snapshot);
          outcomes.set(row.url, row.snapshot);
        } else if (typeof row.error !== "string" || !row.error) throw new Error("Incomplete recorded outcome");
      }
    } finally {
      database.close();
    }
    const observations = new Map<string, Observation>();
    for (const hash of members) observations.set(hash, await recording.readSnapshot(hash));
    const observation = (hash: string) => {
      const result = observations.get(hash);
      if (!result) throw new Error("Ready snapshot is not a member of the sealed recording");
      return result.snapshot;
    };
    const aliasOutcomes = new Map<string, string[]>();
    for (const [url, hash] of outcomes) {
      const snapshot = observation(hash);
      if (snapshot.requested_url !== url) throw new Error("Recorded outcome request URL differs");
      for (const endpoint of new Set([url, snapshot.url])) {
        const hashes = aliasOutcomes.get(endpoint) ?? [];
        hashes.push(hash);
        aliasOutcomes.set(endpoint, hashes);
      }
    }
    const host = ready.completed.host;
    const home = observation(host.homepage_sha256);
    if (
      outcomes.get(host.homepage_url) !== host.homepage_sha256 ||
      home.requested_url !== host.homepage_url ||
      home.retrieved_at !== host.homepage_retrieved_at ||
      home.status !== 200 ||
      home.binary ||
      !/html/i.test(home.headers["content-type"] ?? "")
    )
      throw new Error("Ready homepage provenance differs from the sealed observation");
    let profile: PdfProfile | undefined;
    if (ready.pdf_profile_sha256) {
      if (!options.archivedPdfCacheDirectory) throw new Error("Ready PDFs require an archived profile cache");
      profile = await archivedProfile(options.archivedPdfCacheDirectory, ready.pdf_profile_sha256);
    }
    const expectedInput = deriveCollectionInputDigest({
      recording: ready.recording_seal,
      seed: ready.seed_sha256,
      ...(ready.pdf_profile_sha256 ? { pdf_profile: ready.pdf_profile_sha256 } : {}),
    });
    const ids = new Set<string>();
    const urls = new Set<string>();
    const content = new Set<string>();
    let pdfs = 0;
    for (const document of ready.completed.documents) {
      const parsed = parseDocument(formatDocument(document), { hostname });
      assertSameProducer(producer, document.producer);
      if (document.input_sha256 !== expectedInput) throw new Error("Ready document input binding differs");
      const source = observation(document.snapshot_sha256);
      if (source.url !== document.source_url || source.retrieved_at !== document.retrieved_at || source.status !== 200)
        throw new Error("Ready document citation or retrieval differs from its snapshot");
      if (document.extraction) {
        if (document.extraction.format !== "pdf") throw new Error("Historical ready v1 supports only PDF extraction");
        pdfs++;
        if (
          !source.binary ||
          !profile ||
          document.extraction.profile_sha256 !== ready.pdf_profile_sha256 ||
          document.extraction.source_bytes_sha256 !== source.binary.sha256 ||
          document.extraction.source_bytes !== source.bytes ||
          document.source_modified_at !== null
        )
          throw new Error("Ready PDF extraction differs from its binary snapshot or profile");
        verifyPdfPages(document, profile);
      } else if (source.binary) throw new Error("Ready binary document lacks PDF extraction metadata");
      const key = JSON.stringify([
        document.title,
        document.content_markdown,
        document.source_modified_at,
        parsed.extraction ?? null,
      ]);
      if (ids.has(document.id) || content.has(key)) throw new Error("Duplicate ready document");
      ids.add(document.id);
      content.add(key);
      const ownUrls = [document.source_url, ...document.alternate_urls];
      for (const url of ownUrls) {
        if (urls.has(url)) throw new Error("Duplicate ready document URL");
        urls.add(url);
      }
      // Coalesced aliases can have different HTML bytes; a redirect's final URL need not have its own request row.
      for (const url of document.alternate_urls) {
        const candidates = (aliasOutcomes.get(url) ?? []).map(observation);
        const backed = candidates.some(
          (alias) =>
            alias.status === 200 &&
            ownUrls.includes(alias.url) &&
            Boolean(alias.binary) === Boolean(document.extraction) &&
            (!alias.binary || alias.binary.sha256 === document.extraction!.source_bytes_sha256),
        );
        if (!backed) throw new Error("Ready alternate URL lacks a compatible successful recorded outcome");
      }
    }
    if (Boolean(pdfs) !== Boolean(ready.pdf_profile_sha256))
      throw new Error("Ready PDF profile and document formats disagree");
    if (
      (await recording.verifySeal()) !== ready.recording_seal ||
      !(await readRegularFile(sealPath)).equals(sealBytes) ||
      !(await readRegularFile(seedPath, 16 * 1024 * 1024)).equals(seedBytes) ||
      !(await readRegularFile(readyPath, MAX_READY_BYTES)).equals(readyBytes)
    )
      throw new Error("Historical ready evidence changed during verification");
    assertSameProducer(producer, await captureProducer(producerRoot));
    return ready.completed;
  } finally {
    recording.close();
  }
}
