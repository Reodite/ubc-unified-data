import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Observation, Snapshot } from "../contracts.ts";
import { RecordingError } from "../errors.ts";
import { assertExternalPath } from "../paths.ts";
import { readRegularFile } from "../public-validation.ts";
import { decodeRecordedText } from "../text-decoding.ts";
import type { RecordingOptions } from "./contracts.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function durableObject(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(join(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Own immutable snapshot and body objects and the evidence needed to revalidate reads. */
export class RecordedObjects {
  constructor(
    private readonly db: Pick<DatabaseSync, "prepare">,
    private readonly config: Readonly<Record<string, unknown>>,
    private readonly options: Pick<RecordingOptions, "directory">,
    private readonly assertOpen: () => void,
    private readonly scoped: (value: string) => string,
  ) {}

  private seen = new Map<string, string>();
  // Equal-byte snapshot JSON and raw responses occupy distinct artifact paths.
  private seenTextBodies = new Map<string, string>();

  async store(snapshot: Snapshot): Promise<Observation> {
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const sha256 = hash(bytes);
    const path = assertExternalPath(join(this.options.directory, "objects", `${sha256}.json`));
    try {
      await durableObject(path, bytes);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !(await readRegularFile(path, 64 * 1024 * 1024)).equals(bytes)
      )
        throw error;
    }
    this.seen.set(sha256, path);
    return { sha256, snapshot };
  }
  async readSnapshot(sha256: string): Promise<Observation> {
    this.assertOpen();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new RecordingError("Invalid snapshot digest");
    const path = assertExternalPath(join(this.options.directory, "objects", `${sha256}.json`));
    const bytes = await readRegularFile(path, 64 * 1024 * 1024);
    if (hash(bytes) !== sha256) throw new RecordingError("Recorded snapshot bytes changed");
    const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Snapshot;
    this.scoped(snapshot.url);
    this.scoped(snapshot.requested_url);
    if (
      typeof snapshot.body !== "string" ||
      !Number.isFinite(Date.parse(snapshot.retrieved_at)) ||
      !Number.isInteger(snapshot.status)
    )
      throw new RecordingError("Invalid recorded observation");
    if (snapshot.binary) await this.binaryBytes(snapshot);
    this.seen.set(sha256, path);
    return { sha256, snapshot };
  }

  private async binaryBytes(snapshot: Snapshot): Promise<Buffer> {
    const binary = snapshot.binary;
    if (
      binary?.media_type !== "application/pdf" ||
      !/^[a-f0-9]{64}$/.test(binary.sha256) ||
      snapshot.body !== "" ||
      !Number.isSafeInteger(snapshot.bytes) ||
      snapshot.bytes < 1 ||
      !Array.isArray(this.config.documentFormats) ||
      !this.config.documentFormats.includes("pdf")
    )
      throw new RecordingError("Invalid or undeclared binary observation");
    const path = assertExternalPath(join(this.options.directory, "objects", `${binary.sha256}.body`));
    const bytes = await readRegularFile(path, Number(this.config.maxResponseBytes));
    if (bytes.length !== snapshot.bytes || hash(bytes) !== binary.sha256)
      throw new RecordingError("Recorded binary body changed");
    return bytes;
  }

  async readBytes(snapshotSha256: string): Promise<Buffer> {
    return this.binaryBytes((await this.readSnapshot(snapshotSha256)).snapshot);
  }

  private async readPhysicalTextBytes(observation: Observation): Promise<{ bytes: Buffer; sha256: string }> {
    const { snapshot, sha256: snapshotSha256 } = observation;
    if (
      Object.hasOwn(snapshot, "binary") ||
      Object.hasOwn(snapshot, "redirects") ||
      snapshot.requested_url !== snapshot.url ||
      this.scoped(snapshot.url) !== snapshot.url ||
      !Number.isSafeInteger(snapshot.bytes) ||
      snapshot.bytes < 0 ||
      snapshot.bytes > Number(this.config.maxResponseBytes) ||
      !snapshot.headers ||
      typeof snapshot.headers !== "object" ||
      Array.isArray(snapshot.headers) ||
      Object.values(snapshot.headers).some((value) => typeof value !== "string") ||
      hash(JSON.stringify(snapshot)) !== snapshotSha256
    )
      throw new RecordingError("Invalid physical text observation");
    const receipts = this.db
      .prepare("SELECT url,state,bytes,body_sha,status,headers,error FROM attempts WHERE snapshot=?")
      .all(snapshotSha256);
    const sha256 = receipts[0]?.body_sha;
    if (
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      receipts.some(
        (receipt) =>
          receipt.state !== "observed" ||
          receipt.error !== null ||
          receipt.url !== snapshot.url ||
          receipt.status !== snapshot.status ||
          receipt.bytes !== snapshot.bytes ||
          receipt.body_sha !== sha256 ||
          receipt.headers !== JSON.stringify(snapshot.headers),
      )
    )
      throw new RecordingError("Missing or disagreeing observed text receipts");
    const path = assertExternalPath(join(this.options.directory, "objects", `${sha256}.body`));
    const bytes = await readRegularFile(path, Number(this.config.maxResponseBytes));
    if (bytes.length !== snapshot.bytes || hash(bytes) !== sha256)
      throw new RecordingError("Recorded text body changed");
    this.seenTextBodies.set(path, sha256);
    const decoded = decodeRecordedText(bytes, snapshot.headers["content-type"] ?? "");
    if (decoded !== snapshot.body) throw new RecordingError("Recorded text decoding differs from snapshot body");
    return { bytes, sha256 };
  }

  /** Return original text bytes only through exact observed physical receipts, without acquisition or state writes. */
  async readTextBytes(snapshotSha256: string): Promise<{ bytes: Buffer; sha256: string }> {
    const observation = await this.readSnapshot(snapshotSha256);
    const { snapshot } = observation;
    if (Object.hasOwn(snapshot, "binary")) throw new RecordingError("Binary observation is not recorded text");
    if (!Object.hasOwn(snapshot, "redirects")) return this.readPhysicalTextBytes(observation);

    const { redirects, ...physical } = snapshot;
    const redirectStatuses = [301, 302, 303, 307, 308];
    const outcomes = this.db.prepare("SELECT url,error FROM outcomes WHERE snapshot=?").all(snapshotSha256);
    if (
      !Array.isArray(redirects) ||
      redirects.length < 1 ||
      redirects.length >= 8 ||
      redirectStatuses.includes(snapshot.status) ||
      outcomes.length !== 1 ||
      outcomes[0]!.url !== snapshot.requested_url ||
      outcomes[0]!.error !== null ||
      this.scoped(snapshot.requested_url) !== snapshot.requested_url ||
      hash(JSON.stringify(snapshot)) !== snapshotSha256
    )
      throw new RecordingError("Invalid recorded logical text wrapper");

    let url = snapshot.requested_url;
    const visited = new Set<string>();
    for (const hop of redirects) {
      if (
        !hop ||
        typeof hop !== "object" ||
        Object.keys(hop).join(",") !== "url,location,status,snapshot" ||
        hop.url !== url ||
        visited.has(url) ||
        !redirectStatuses.includes(hop.status)
      )
        throw new RecordingError("Invalid recorded text redirect trace");
      visited.add(url);
      const observed = await this.readSnapshot(hop.snapshot);
      await this.readPhysicalTextBytes(observed);
      if (
        observed.snapshot.url !== url ||
        observed.snapshot.status !== hop.status ||
        !observed.snapshot.headers.location ||
        this.scoped(new URL(observed.snapshot.headers.location, url).href) !== hop.location
      )
        throw new RecordingError("Recorded text redirect evidence disagrees");
      url = hop.location;
    }
    if (url !== snapshot.url || visited.has(url)) throw new RecordingError("Recorded text redirect terminal disagrees");

    // Assignment preserves the physical property's position in the recorder's newline-free JSON encoding.
    physical.requested_url = physical.url;
    const terminal = await this.readSnapshot(hash(JSON.stringify(physical)));
    return this.readPhysicalTextBytes(terminal);
  }

  async assertUnchanged(): Promise<void> {
    this.assertOpen();
    for (const row of this.db
      .prepare("SELECT snapshot,body_sha FROM attempts WHERE snapshot IS NOT NULL OR body_sha IS NOT NULL")
      .all()) {
      if (row.snapshot) await this.readSnapshot(String(row.snapshot));
      if (row.body_sha) {
        if (!/^[a-f0-9]{64}$/.test(String(row.body_sha))) throw new RecordingError("Invalid raw-body digest");
        const path = assertExternalPath(join(this.options.directory, "objects", `${row.body_sha}.body`));
        if (hash(await readRegularFile(path, Number(this.config.maxResponseBytes))) !== row.body_sha)
          throw new RecordingError("Recorded raw body changed");
      }
    }
    for (const [sha, path] of this.seen)
      if (hash(await readRegularFile(path, 64 * 1024 * 1024)) !== sha)
        throw new RecordingError("Recording object changed");
    for (const [path, sha] of this.seenTextBodies)
      if (hash(await readRegularFile(path, Number(this.config.maxResponseBytes))) !== sha)
        throw new RecordingError("Recorded text object changed");
  }
}
