import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { SaxesParser, type SaxesTag } from "saxes";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export const OOXML_LIMITS = Object.freeze({
  sourceBytes: 64 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  entries: 10_000,
  xmlBytes: 16 * 1024 * 1024,
  compressionRatio: 100,
  xmlDepth: 128,
  xmlNodes: 1_000_000,
  xmlTextBytes: 32 * 1024 * 1024,
  wallMs: 30_000,
});

const require = createRequire(import.meta.url);
const yauzlVersion = (require("yauzl/package.json") as { version: string }).version;
const saxesVersion = (require("saxes/package.json") as { version: string }).version;
export const OOXML_PROFILE_MANIFEST = Object.freeze({
  schema: "host-ooxml-profile-v1",
  limits: OOXML_LIMITS,
  source: "host-crawl-ooxml-adapters-v1",
  dependencies: { yauzl: yauzlVersion, saxes: saxesVersion },
  runtime: { family: "node", major: Number(process.versions.node.split(".")[0]) },
});
export const OOXML_PROFILE_SHA256 = createHash("sha256").update(JSON.stringify(OOXML_PROFILE_MANIFEST)).digest("hex");

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const EXECUTABLE = /\.(?:exe|dll|com|bat|cmd|ps1|js|jse|vbs|vbe|msi|scr|jar|app|sh)$/i;
const ACTIVE_NAME = /(?:^|\/)(?:activeX|embeddings)(?:\/|$)|vbaProject|oleObject/i;
const ACTIVE_TYPE = /macroEnabled|vbaProject|activeX|oleObject|application\/(?:vnd\.ms-office|x-msdownload)/i;

export interface XmlNode {
  local: string;
  uri: string;
  attributes: Readonly<Record<string, string>>;
  children: Array<XmlNode | string>;
}

export interface OoxmlRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

export interface OoxmlPackage {
  kind: "docx" | "pptx";
  mainPart: string;
  names: readonly string[];
  profileSha256: string;
  sourceSha256: string;
  has(name: string): boolean;
  xml(name: string): XmlNode;
  relationships(partName?: string): readonly OoxmlRelationship[];
}

export interface ReadOoxmlOptions {
  bytes: Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function failIfCancelled(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("OOXML extraction cancelled");
  if (Date.now() > deadline) throw new Error("OOXML extraction exceeded its wall-clock limit");
}

function canonicalName(raw: string): string {
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw))
    throw new Error(`OOXML ZIP has an unsafe part name: ${JSON.stringify(raw)}`);
  const pieces = raw.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === ".."))
    throw new Error(`OOXML ZIP has an unsafe part path: ${JSON.stringify(raw)}`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error(`OOXML ZIP has an invalid encoded part name: ${JSON.stringify(raw)}`);
  }
  if (
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.split("/").some((piece) => piece === "." || piece === "..")
  )
    throw new Error(`OOXML ZIP has an unsafe canonical part path: ${JSON.stringify(raw)}`);
  return decoded.normalize("NFC").toLowerCase();
}

function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("OOXML ZIP could not be opened"));
        else resolve(zip);
      },
    );
  });
}

function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error("OOXML ZIP entry could not be opened"));
      const chunks: Buffer[] = [];
      let length = 0;
      stream.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > limit) stream.destroy(new Error("OOXML part exceeds its byte limit"));
        else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks, length)));
    });
  });
}

async function readZip(bytes: Buffer, signal: AbortSignal | undefined, deadline: number): Promise<Map<string, Buffer>> {
  const zip = await openZip(bytes);
  const parts = new Map<string, Buffer>();
  const canonical = new Set<string>();
  let count = 0;
  let expanded = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      if (error) reject(error);
      else resolve(parts);
    };
    zip.once("error", finish);
    zip.once("end", () => finish());
    zip.on("entry", async (entry: Entry) => {
      try {
        failIfCancelled(signal, deadline);
        count++;
        if (count > OOXML_LIMITS.entries) throw new Error("OOXML ZIP exceeds its entry limit");
        if (entry.fileName.endsWith("/")) throw new Error("OOXML ZIP directory entries are not permitted");
        const name = canonicalName(entry.fileName);
        if (canonical.has(name)) throw new Error("OOXML ZIP contains duplicate or canonical-colliding part names");
        canonical.add(name);
        if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error("Encrypted OOXML ZIP entries are not permitted");
        if (![0, 8].includes(entry.compressionMethod)) throw new Error("OOXML ZIP uses unsupported compression");
        if (entry.versionNeededToExtract > 45) throw new Error("OOXML ZIP uses unsupported extraction features");
        expanded += entry.uncompressedSize;
        if (expanded > OOXML_LIMITS.expandedBytes) throw new Error("OOXML ZIP exceeds its expanded byte limit");
        if (
          entry.uncompressedSize > 0 &&
          (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > OOXML_LIMITS.compressionRatio)
        )
          throw new Error("OOXML ZIP entry exceeds its compression ratio limit");
        const isXml = /(?:\.xml|\.rels)$/i.test(entry.fileName) || entry.fileName === "[Content_Types].xml";
        if (isXml && entry.uncompressedSize > OOXML_LIMITS.xmlBytes)
          throw new Error("OOXML XML part exceeds its byte limit");
        if (ACTIVE_NAME.test(entry.fileName) || EXECUTABLE.test(entry.fileName))
          throw new Error("OOXML package contains an active, OLE, or executable part");
        if (isXml) parts.set(entry.fileName, await readEntry(zip, entry, OOXML_LIMITS.xmlBytes));
        else parts.set(entry.fileName, Buffer.alloc(0));
        failIfCancelled(signal, deadline);
        zip.readEntry();
      } catch (error) {
        finish(error);
      }
    });
    zip.readEntry();
  });
}

export function parseOoxmlXml(bytes: Uint8Array, partName = "OOXML XML", check?: () => void): XmlNode {
  if (bytes.byteLength > OOXML_LIMITS.xmlBytes) throw new Error(`${partName} exceeds its XML byte limit`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${partName} is not valid UTF-8 XML`);
  }
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let nodes = 0;
  let textBytes = 0;
  parser.on("doctype", () => {
    throw new Error(`${partName} contains a forbidden document type`);
  });
  parser.on("opentag", (tag: SaxesTag) => {
    check?.();
    nodes++;
    if (nodes > OOXML_LIMITS.xmlNodes) throw new Error(`${partName} exceeds its XML node limit`);
    if (stack.length >= OOXML_LIMITS.xmlDepth) throw new Error(`${partName} exceeds its XML depth limit`);
    const attributes: Record<string, string> = {};
    for (const attribute of Object.values(tag.attributes)) {
      if (typeof attribute === "string") continue;
      attributes[attribute.name] = attribute.value;
      if (!(attribute.local in attributes)) attributes[attribute.local] = attribute.value;
    }
    const node: XmlNode = { local: tag.local ?? tag.name, uri: tag.uri ?? "", attributes, children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else if (root) throw new Error(`${partName} has multiple document roots`);
    else root = node;
    stack.push(node);
  });
  const appendText = (value: string) => {
    check?.();
    textBytes += Buffer.byteLength(value);
    if (textBytes > OOXML_LIMITS.xmlTextBytes) throw new Error(`${partName} exceeds its XML text limit`);
    if (value && stack.length) stack.at(-1)!.children.push(value);
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  parser.on("closetag", () => void stack.pop());
  parser.write(text).close();
  if (!root) throw new Error(`${partName} lacks an XML root`);
  return root;
}

export function childElements(node: XmlNode, local?: string): XmlNode[] {
  return node.children.filter(
    (child): child is XmlNode => typeof child !== "string" && (!local || child.local === local),
  );
}

export function descendants(node: XmlNode, local?: string): XmlNode[] {
  const result: XmlNode[] = [];
  for (const child of childElements(node)) {
    if (!local || child.local === local) result.push(child);
    result.push(...descendants(child, local));
  }
  return result;
}

export function nodeText(node: XmlNode): string {
  return node.children.map((child) => (typeof child === "string" ? child : nodeText(child))).join("");
}

function relsName(partName?: string): string {
  if (!partName) return "_rels/.rels";
  return posix.join(posix.dirname(partName), "_rels", `${posix.basename(partName)}.rels`);
}

function resolveInternalTarget(partName: string | undefined, target: string): string {
  if (target.includes("\\") || target.includes("\0")) throw new Error("OOXML relationship has an unsafe target");
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split("#", 1)[0]!);
  } catch {
    throw new Error("OOXML relationship has an invalid encoded target");
  }
  const base = partName ? posix.dirname(partName) : "";
  const resolved = posix.normalize(posix.join(base, decoded.replace(/^\//, "")));
  if (!resolved || resolved === "." || resolved.startsWith("../") || posix.isAbsolute(resolved))
    throw new Error("OOXML relationship escapes the package");
  return resolved;
}

function parseRelationships(
  parts: Map<string, Buffer>,
  parsed: Map<string, XmlNode>,
  partName?: string,
): OoxmlRelationship[] {
  const name = relsName(partName);
  const bytes = parts.get(name);
  if (!bytes) return [];
  const root = parsed.get(name);
  if (!root) throw new Error(`OOXML relationship XML is unavailable: ${name}`);
  if (root.local !== "Relationships" || root.uri !== REL_NS) throw new Error(`${name} has an invalid root`);
  const ids = new Set<string>();
  return childElements(root, "Relationship").map((node) => {
    const id = node.attributes.Id;
    const type = node.attributes.Type;
    const rawTarget = node.attributes.Target;
    if (!id || !type || !rawTarget || ids.has(id)) throw new Error(`${name} has an invalid or duplicate relationship`);
    ids.add(id);
    const external = node.attributes.TargetMode === "External";
    if (node.attributes.TargetMode && !external) throw new Error(`${name} has an unsupported relationship target mode`);
    if (/vbaProject|activeX|oleObject|package$/i.test(type))
      throw new Error("OOXML package contains an active, embedded, or executable relationship");
    return { id, type, target: external ? rawTarget : resolveInternalTarget(partName, rawTarget), external };
  });
}

export async function readOoxml({
  bytes,
  signal,
  timeoutMs = OOXML_LIMITS.wallMs,
}: ReadOoxmlOptions): Promise<OoxmlPackage> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > OOXML_LIMITS.sourceBytes)
    throw new Error("OOXML source is empty or exceeds its source byte limit");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > OOXML_LIMITS.wallMs)
    throw new Error("OOXML wall-clock limit is invalid");
  const copy = Buffer.from(bytes);
  const deadline = Date.now() + timeoutMs;
  const parts = await readZip(copy, signal, deadline);
  failIfCancelled(signal, deadline);
  const parsed = new Map<string, XmlNode>();
  const check = () => failIfCancelled(signal, deadline);
  for (const [name, part] of parts) {
    if (/(?:\.xml|\.rels)$/i.test(name) || name === "[Content_Types].xml")
      parsed.set(name, parseOoxmlXml(part, name, check));
  }
  const typesBytes = parts.get("[Content_Types].xml");
  if (!typesBytes) throw new Error("OOXML package lacks [Content_Types].xml");
  const types = parsed.get("[Content_Types].xml")!;
  if (types.local !== "Types" || types.uri !== TYPES_NS) throw new Error("OOXML package has invalid content types");
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const item of childElements(types)) {
    const contentType = item.attributes.ContentType;
    if (!contentType || !["Default", "Override"].includes(item.local))
      throw new Error("OOXML package has an invalid content type declaration");
    if (ACTIVE_TYPE.test(contentType)) throw new Error("OOXML package declares active or executable content");
    if (item.local === "Default") {
      const extension = item.attributes.Extension?.toLowerCase();
      if (!extension || defaults.has(extension)) throw new Error("OOXML package has a duplicate content type default");
      defaults.set(extension, contentType);
    } else {
      const partName = item.attributes.PartName;
      if (!partName?.startsWith("/")) throw new Error("OOXML package has an invalid content type override");
      const canonical = canonicalName(partName.slice(1));
      if (overrides.has(canonical)) throw new Error("OOXML package has a duplicate content type override");
      overrides.set(canonical, contentType);
    }
  }
  const rootRelationships = parseRelationships(parts, parsed);
  const office = rootRelationships.filter((relationship) => relationship.type === OFFICE_REL && !relationship.external);
  if (office.length !== 1) throw new Error("OOXML package requires one internal root officeDocument relationship");
  const mainPart = office[0]!.target;
  const main = parts.get(mainPart);
  if (!main) throw new Error("OOXML package main officeDocument part is missing");
  const mainXml = parsed.get(mainPart);
  if (!mainXml) throw new Error("OOXML package main officeDocument part is not XML");
  const mainContentType =
    overrides.get(canonicalName(mainPart)) ?? defaults.get(mainPart.split(".").at(-1)?.toLowerCase() ?? "");
  const docx =
    mainXml.local === "document" &&
    mainXml.uri === WORD_NS &&
    mainPart.startsWith("word/") &&
    mainContentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  const pptx =
    mainXml.local === "presentation" &&
    mainXml.uri === PRESENTATION_NS &&
    mainPart.startsWith("ppt/") &&
    mainContentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
  if (docx === pptx) throw new Error("OOXML package structure or main content type is missing or contradictory");
  const names = [...parts.keys()].sort();
  return {
    kind: docx ? "docx" : "pptx",
    mainPart,
    names,
    profileSha256: OOXML_PROFILE_SHA256,
    sourceSha256: createHash("sha256").update(copy).digest("hex"),
    has: (name) => parts.has(name),
    xml: (name) => {
      if (!parts.has(name)) throw new Error(`OOXML part is missing: ${name}`);
      const root = parsed.get(name);
      if (!root) throw new Error(`OOXML part is not XML: ${name}`);
      return root;
    },
    relationships: (partName) => parseRelationships(parts, parsed, partName),
  };
}
