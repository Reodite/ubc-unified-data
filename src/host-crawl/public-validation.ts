import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import type { VettedHost } from "./contracts.ts";
import {
  digest,
  exactHostUrl,
  exactObject,
  MAX_DOCUMENT_BYTES,
  parseDocument,
  safeText,
  timestamp,
} from "./document-format.ts";
import { normalizeHost } from "./urls.ts";

export type RegisteredHosts = readonly string[] | ReadonlySet<string>;
export const HOST_LIST_PATH = "data/official-hosts.json";
const HOST_KEYS = [
  "hostname",
  "title",
  "homepage_url",
  "homepage_retrieved_at",
  "homepage_sha256",
  "scope",
  "document_root",
  "document_count",
] as const;

export function registeredHostSet(hosts: RegisteredHosts): Set<string> {
  if (!Array.isArray(hosts) && !(hosts instanceof Set)) throw new Error("Expected registered hostnames");
  const result = new Set<string>();
  for (const host of hosts) {
    if (typeof host !== "string" || normalizeHost(host) !== host || result.has(host))
      throw new Error("Invalid or duplicate registered hostname");
    result.add(host);
  }
  return result;
}

export function validateVettedHost(value: unknown, registeredHosts: RegisteredHosts): asserts value is VettedHost {
  exactObject(value, HOST_KEYS, "vetted host");
  safeText(value.hostname, "hostname");
  if (normalizeHost(value.hostname) !== value.hostname || !registeredHostSet(registeredHosts).has(value.hostname))
    throw new Error("Unregistered or noncanonical vetted hostname");
  safeText(value.title, "host title");
  safeText(value.scope, "host scope");
  exactHostUrl(value.homepage_url, value.hostname);
  if (value.homepage_url !== `https://${value.hostname}/`) throw new Error("Homepage must be the exact host root");
  timestamp(value.homepage_retrieved_at, "homepage retrieved_at");
  digest(value.homepage_sha256, "homepage");
  if (value.document_root !== `data/documents/${value.hostname}`) throw new Error("Invalid host document root");
  if (!Number.isSafeInteger(value.document_count) || (value.document_count as number) < 1)
    throw new Error("Vetted host requires a positive document count");
}

export function formatHostList(hosts: readonly VettedHost[], registeredHosts: RegisteredHosts): Buffer {
  const registered = registeredHostSet(registeredHosts);
  const entries = [...hosts].sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0));
  const seen = new Set<string>();
  for (const host of entries) {
    validateVettedHost(host, registered);
    if (seen.has(host.hostname)) throw new Error("Duplicate vetted hostname");
    seen.add(host.hostname);
  }
  return Buffer.from(
    `${JSON.stringify(
      entries.map((host) => Object.fromEntries(HOST_KEYS.map((key) => [key, host[key]]))),
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** Inspect every existing path component, including ancestors outside the repository. */
export async function assertNoSymlinkPath(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Expected normalized absolute path");
  let current = parse(path).root;
  const parts = path.slice(current.length).split("/").filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await maybeLstat(current);
    if (!info) return;
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()))
      throw new Error(`Symlink or invalid path component: ${current}`);
  }
}

export async function maybeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readRegularFile(path: string, maximum = MAX_DOCUMENT_BYTES): Promise<Buffer> {
  await assertNoSymlinkPath(path);
  const pathBefore = await lstat(path);
  if (!pathBefore.isFile() || pathBefore.nlink !== 1 || pathBefore.size > maximum)
    throw new Error(`Not a bounded regular unaliased file: ${path}`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum)
      throw new Error(`Not a bounded regular unaliased file: ${path}`);
    if (
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.size !== pathBefore.size ||
      before.mtimeMs !== pathBefore.mtimeMs ||
      before.ctimeMs !== pathBefore.ctimeMs
    )
      throw new Error(`File changed before reading: ${path}`);
    const bytes = await file.readFile();
    const after = await file.stat();
    const pathAfter = await lstat(path);
    if (
      !pathAfter.isFile() ||
      before.dev !== pathAfter.dev ||
      before.ino !== pathAfter.ino ||
      before.size !== pathAfter.size ||
      before.mtimeMs !== pathAfter.mtimeMs ||
      before.ctimeMs !== pathAfter.ctimeMs ||
      bytes.length > maximum ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== before.size
    )
      throw new Error(`File changed while reading: ${path}`);
    return bytes;
  } finally {
    await file.close();
  }
}

export async function requireDirectory(path: string): Promise<void> {
  await assertNoSymlinkPath(path);
  if (!(await maybeLstat(path))?.isDirectory()) throw new Error(`Not a directory: ${path}`);
}

export interface ValidatePublishedHostsOptions {
  repositoryRoot: string;
  registeredHosts: RegisteredHosts;
  /** Allow both outputs to be absent, or an absent list with an empty documents directory. */
  allowAbsent?: boolean;
  /** Read document bytes only for these registered hostnames; omit to audit all hosts. Retain the full census. */
  documentHostnames?: readonly string[];
}

/** Validate only the owned host index and document tree, leaving upstream data outside that tree alone. */
export async function validatePublishedHosts({
  repositoryRoot,
  registeredHosts,
  allowAbsent = false,
  documentHostnames,
}: ValidatePublishedHostsOptions): Promise<VettedHost[]> {
  const registered = registeredHostSet(registeredHosts);
  if (documentHostnames !== undefined && !Array.isArray(documentHostnames))
    throw new Error("Document validation hostnames must be an array");
  const documentHosts = documentHostnames === undefined ? undefined : registeredHostSet(documentHostnames);
  for (const hostname of documentHosts ?? [])
    if (!registered.has(hostname)) throw new Error("Unregistered document validation hostname");
  await requireDirectory(repositoryRoot);
  const listPath = join(repositoryRoot, HOST_LIST_PATH);
  const documentsRoot = join(repositoryRoot, "data/documents");
  await assertNoSymlinkPath(listPath);
  await assertNoSymlinkPath(documentsRoot);
  const listInfo = await maybeLstat(listPath);
  const rootInfo = await maybeLstat(documentsRoot);
  if (rootInfo && !rootInfo.isDirectory()) throw new Error("Documents root must be a directory");
  const directories = rootInfo ? (await readdir(documentsRoot)).sort() : [];
  if (!listInfo) {
    if (allowAbsent && !directories.length) return [];
    throw new Error("Missing official host list");
  }
  const bytes = await readRegularFile(listPath, 16 * 1024 * 1024);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("Host list must be an array");
  for (const item of raw) validateVettedHost(item, registered);
  const hosts = raw as VettedHost[];
  if (!formatHostList(hosts, registered).equals(bytes)) throw new Error("Host list must be canonical and sorted");
  if (JSON.stringify(directories) !== JSON.stringify(hosts.map((host) => host.hostname)))
    throw new Error("Host directories and index do not match");
  const ids = new Set<string>();
  const urls = new Set<string>();
  const filenames = new Set<string>();
  for (const host of hosts) {
    const directory = join(documentsRoot, host.hostname);
    await requireDirectory(directory);
    const names = (await readdir(directory)).sort();
    if (names.length !== host.document_count) throw new Error("Host document count mismatch");
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.md$/.test(name) || filenames.has(name))
        throw new Error("Invalid or duplicate document filename");
      filenames.add(name);
      if (documentHosts !== undefined && !documentHosts.has(host.hostname)) {
        const path = join(directory, name);
        const info = await maybeLstat(path);
        if (!info?.isFile() || info.nlink !== 1 || info.size > MAX_DOCUMENT_BYTES)
          throw new Error(`Not a bounded regular unaliased file: ${path}`);
        continue;
      }
      const doc = parseDocument(await readRegularFile(join(directory, name)), {
        hostname: host.hostname,
        filename: name,
      });
      if (ids.has(doc.id)) throw new Error("Duplicate document ID");
      ids.add(doc.id);
      for (const url of [doc.source_url, ...doc.alternate_urls]) {
        if (urls.has(url)) throw new Error("Duplicate document URL");
        urls.add(url);
      }
    }
  }
  return hosts;
}
