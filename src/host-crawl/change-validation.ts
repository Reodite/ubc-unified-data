import { isDeepStrictEqual } from "node:util";
import { assertDocumentCategory, type DocumentCategory } from "./categories.ts";
import { parseRoutingPolicy, routeSearchDocument } from "./category-routing.ts";
import type { VettedHost } from "./contracts.ts";
import { formatDocument, parseDocument } from "./document-format.ts";
import { formatHostList, HOST_LIST_PATH, hostDocumentRoots } from "./public-validation.ts";
import { normalizeHost } from "./urls.ts";

export interface ChangedFile {
  path: string;
  bytes: Uint8Array | null;
  previousBytes?: Uint8Array | null;
}

export interface HostChangeOptions {
  mode?: "publish" | "migrate" | "withdraw";
  expectedHostname?: string;
}

interface ChangedDocument {
  file: ChangedFile;
  hostname: string;
  filename: string;
  category?: DocumentCategory;
  root: string;
}

const GENERIC_REGISTRY = "src/host-scrapers/generic-hosts.json";

function documentPath(file: ChangedFile): ChangedDocument | undefined {
  const legacy = /^data\/documents\/([^/]+)\/([a-f0-9]{64}\.md)$/.exec(file.path);
  const nested = /^data\/documents\/([^/]+)\/([^/]+)\/([a-f0-9]{64}\.md)$/.exec(file.path);
  if (!legacy && !nested) return undefined;
  if (nested) assertDocumentCategory(nested[1]);
  return {
    file,
    hostname: (nested?.[2] ?? legacy?.[1])!,
    filename: (nested?.[3] ?? legacy?.[2])!,
    ...(nested ? { category: nested[1] as DocumentCategory } : {}),
    root: file.path.slice(0, file.path.lastIndexOf("/")),
  };
}

function decodeIndex(bytes: Uint8Array | null): VettedHost[] {
  if (bytes === null) return [];
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  if (!Array.isArray(value)) throw new Error("Host list must be an array");
  const hosts = value as VettedHost[];
  if (
    !formatHostList(
      hosts,
      hosts.map((host) => host?.hostname),
    ).equals(Buffer.from(bytes))
  )
    throw new Error("Host list must be canonical and sorted");
  return hosts;
}

function assertRegistryChange(file: ChangedFile, hostname: string, mode: NonNullable<HostChangeOptions["mode"]>) {
  if (!file.bytes || file.previousBytes === undefined) throw new Error("Generic registry baseline is required");
  const decode = (bytes: Uint8Array | null): string[] => {
    const value: unknown = bytes ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : [];
    if (
      !Array.isArray(value) ||
      value.some(
        (item, index) =>
          typeof item !== "string" || normalizeHost(item) !== item || (index > 0 && value[index - 1] >= item),
      )
    )
      throw new Error("Invalid sorted generic host registry");
    return value as string[];
  };
  const before = decode(file.previousBytes);
  const after = decode(file.bytes);
  if (mode === "migrate") throw new Error("Migration cannot change the generic registry");
  if (mode === "publish") {
    if (before.includes(hostname) || !isDeepStrictEqual(after, [...before, hostname].sort()))
      throw new Error("Generic registry must add only the published hostname");
  } else if (
    !before.includes(hostname) ||
    !isDeepStrictEqual(
      after,
      before.filter((name) => name !== hostname),
    )
  ) {
    throw new Error("Generic registry must remove only the withdrawn hostname");
  }
}

function parseChangedDocument(document: ChangedDocument, bytes: Uint8Array) {
  const parsed = parseDocument(bytes, document);
  if (parsed.category !== document.category) throw new Error("Document category/path mismatch");
  return parsed;
}

function assertDocumentCensus(documents: readonly ChangedDocument[], host: VettedHost) {
  const roots = hostDocumentRoots(host);
  if (
    documents.length !== host.document_count ||
    roots.some((root) => documents.filter((document) => document.root === root.path).length !== root.document_count) ||
    documents.some((document) => !roots.some((root) => root.path === document.root))
  )
    throw new Error("Changed document roots/count do not match the target host index");
  if (new Set(documents.map((document) => document.filename)).size !== documents.length)
    throw new Error("Duplicate document identity across categories");
}

function assertIndexChange(
  file: ChangedFile,
  documents: readonly ChangedDocument[],
  hostname: string,
  mode: NonNullable<HostChangeOptions["mode"]>,
) {
  if (file.previousBytes === undefined || (mode !== "publish" && file.previousBytes === null))
    throw new Error("Host index baseline is required");
  const before = decodeIndex(file.previousBytes);
  const after = decodeIndex(file.bytes);
  if (
    !isDeepStrictEqual(
      before.filter((host) => host.hostname !== hostname),
      after.filter((host) => host.hostname !== hostname),
    )
  )
    throw new Error("Other-host index entries must remain unchanged");
  const oldHost = before.find((host) => host.hostname === hostname);
  const newHost = after.find((host) => host.hostname === hostname);
  if (mode === "publish") {
    if (oldHost || !newHost) throw new Error("Publication must add exactly the target host to the index");
    assertDocumentCensus(documents, newHost);
    for (const document of documents) parseChangedDocument(document, document.file.bytes!);
    return;
  }
  if (!oldHost) throw new Error("Target host is missing from the baseline index");
  const removed = documents.filter((document) => document.file.bytes === null);
  assertDocumentCensus(removed, oldHost);
  const originals = new Map<string, ChangedDocument>();
  for (const document of removed) {
    if (!document.file.previousBytes) throw new Error("Deleted document baseline is required");
    parseChangedDocument(document, document.file.previousBytes);
    originals.set(document.filename, document);
  }
  if (mode === "withdraw") {
    if (newHost) throw new Error("Withdrawal must remove the target host from the index");
    if (removed.length !== documents.length) throw new Error("Withdrawal permits only target document deletions");
    return;
  }
  if (!newHost || !oldHost.document_root || !newHost.document_roots)
    throw new Error("Migration requires legacy document_root and category document_roots");
  const { document_root: _oldRoot, ...oldMetadata } = oldHost;
  const { document_roots: _newRoots, ...newMetadata } = newHost;
  if (!isDeepStrictEqual(oldMetadata, newMetadata)) throw new Error("Migration must preserve target host metadata");
  const added = documents.filter((document) => document.file.bytes !== null);
  assertDocumentCensus(added, newHost);
  for (const document of added) {
    if (!document.category || document.file.previousBytes != null)
      throw new Error("Migration requires new category documents, not overwrites");
    const original = originals.get(document.filename);
    if (!original || original.category) throw new Error("Missing legacy migration pair");
    const {
      category: _category,
      routing: _routing,
      ...unrouted
    } = parseChangedDocument(document, document.file.bytes!);
    if (!formatDocument(unrouted).equals(Buffer.from(original.file.previousBytes!)))
      throw new Error("Migration must preserve original document identity, body and provenance bytes");
    originals.delete(document.filename);
  }
  if (originals.size) throw new Error("Missing category migration pair");
}

/** Check one hostname's publication, byte-preserving category migration, or complete withdrawal. */
export function assertSingleHostChange(files: readonly ChangedFile[], options: HostChangeOptions = {}): string {
  const mode = options.mode ?? "publish";
  if (!["publish", "migrate", "withdraw"].includes(mode)) throw new Error("Unknown hostname change mode");
  if (options.expectedHostname !== undefined && normalizeHost(options.expectedHostname) !== options.expectedHostname)
    throw new Error("Expected hostname must be normalized");
  const hosts = new Set<string>();
  const paths = new Set<string>();
  const documents: ChangedDocument[] = [];
  for (const file of files) {
    const { path, bytes } = file;
    if (path.split("/").some((part) => !part || part === "." || part === "..") || /[\\\r\n\0]/.test(path))
      throw new Error("Unsafe changed path");
    if (paths.has(path)) throw new Error("Duplicate changed path");
    paths.add(path);
    if (
      /(?:^|\/)(?:\.cache|documents?-crawl|documentation-crawl)(?:\/|$)/.test(path) ||
      /(?:^|\/)(?:DOMAINS\.(?:md|tsv)|CRAWL-(?:COVERAGE\.md|REPORTS\.json))$/i.test(path) ||
      /\.(?:sqlite(?:-wal|-shm|-journal)?|jsonl)$/i.test(path)
    )
      throw new Error(`Crawl intermediate cannot be committed: ${path}`);
    const document = documentPath(file);
    if (path.startsWith("data/") && path !== HOST_LIST_PATH && !document)
      throw new Error(`Only final host text/index may change under data/: ${path}`);
    const owner =
      document?.hostname ??
      /^src\/host-scrapers\/routing\/([^/]+)\.json$/.exec(path)?.[1] ??
      /^(?:src\/host-scrapers|test\/fixtures\/host-scrapers)\/([^/]+)\//.exec(path)?.[1];
    if (owner) {
      if (normalizeHost(owner) !== owner) throw new Error("Unnormalized hostname path");
      hosts.add(owner);
    }
    if (document) documents.push(document);
    if (bytes !== null) {
      if (bytes.byteLength > 1024 * 1024) throw new Error(`Oversized staged file: ${path}`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0") || text.startsWith("version https://git-lfs.github.com/spec/v1"))
        throw new Error(`Binary or LFS content is forbidden: ${path}`);
      if (path === ".gitattributes" && /\bfilter=lfs\b/.test(text)) throw new Error("LFS attributes are forbidden");
    }
  }
  if (hosts.size !== 1) throw new Error("A hostname commit must contain exactly one accepted hostname");
  const host = [...hosts][0]!;
  if (options.expectedHostname !== undefined && host !== options.expectedHostname)
    throw new Error("Changed hostname does not match the expected hostname");
  const generic = files.find((file) => file.path === GENERIC_REGISTRY);
  if (generic) assertRegistryChange(generic, host, mode);
  const required = [HOST_LIST_PATH];
  if (mode === "publish") {
    required.push(
      ...(generic
        ? [GENERIC_REGISTRY]
        : [
            `src/host-scrapers/${host}/index.ts`,
            `src/host-scrapers/${host}/index.test.ts`,
            "src/host-crawl/registry.ts",
          ]),
    );
    if (documents.some((document) => document.file.bytes === null || document.file.previousBytes != null))
      throw new Error("Publication requires new documents, not deletions or overwrites");
  }
  for (const path of required)
    if (!paths.has(path) || files.find((file) => file.path === path)?.bytes === null)
      throw new Error(`Missing hostname commit component: ${path}`);
  if (!documents.length) throw new Error("Hostname commit has no final documents");
  const routing = files.find((file) => file.path === `src/host-scrapers/routing/${host}.json`);
  if (mode === "withdraw" && routing?.bytes != null) throw new Error("Withdrawal cannot add or replace routing policy");
  if (mode !== "withdraw" && documents.some((document) => document.category)) {
    if (!routing?.bytes) throw new Error("Category publication requires the saved hostname routing policy");
    if (routing.previousBytes && !Buffer.from(routing.previousBytes).equals(Buffer.from(routing.bytes)))
      throw new Error("Saved first classification is immutable");
    const policy = parseRoutingPolicy(routing.bytes);
    if (policy.hostname !== host) throw new Error("Saved routing policy owner mismatch");
    for (const document of documents)
      if (document.file.bytes !== null && document.category) {
        const {
          category: _category,
          routing: _routing,
          ...original
        } = parseChangedDocument(document, document.file.bytes);
        if (!formatDocument(routeSearchDocument(original, policy)).equals(Buffer.from(document.file.bytes)))
          throw new Error("New document classification differs from its saved first decision");
      }
  }
  const index = files.find((file) => file.path === HOST_LIST_PATH)!;
  if (mode !== "publish" || index.previousBytes !== undefined || documents.some((document) => document.category))
    assertIndexChange(index, documents, host, mode);
  return host;
}
