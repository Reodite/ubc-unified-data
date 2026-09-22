import { createHash } from "node:crypto";
import type { SavedUrl } from "./contracts.ts";

export interface CollectionInputDigests {
  readonly recording: string;
  readonly seed: string;
  readonly pdf_profile?: string;
  readonly docx_profile?: string;
  readonly pptx_profile?: string;
  readonly markdown_profile?: string;
}

const COLLECTION_INPUT_KEYS = new Set([
  "recording",
  "seed",
  "pdf_profile",
  "docx_profile",
  "pptx_profile",
  "markdown_profile",
]);

/** Hash canonical outer bindings; omitted profiles contribute no key to legacy preimages. */
export function deriveCollectionInputDigest(input: CollectionInputDigests): string {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("Invalid collection input record");
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !COLLECTION_INPUT_KEYS.has(key)))
    throw new Error("Invalid collection input fields");
  const properties = Object.getOwnPropertyDescriptors(input);
  const encoded: Record<string, string> = Object.create(null);
  for (const key of COLLECTION_INPUT_KEYS) {
    const required = key === "recording" || key === "seed";
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!property) {
      if (required) throw new Error(`Invalid collection input: missing ${key}`);
      continue;
    }
    if (!("value" in property)) throw new Error(`Invalid collection input accessor: ${key}`);
    if (!required && property.value === undefined) continue;
    if (typeof property.value !== "string" || property.value.length !== 64 || !/^[a-f0-9]{64}$/.test(property.value))
      throw new Error(`Invalid collection input digest: ${key}`);
    encoded[key] = property.value;
  }
  return createHash("sha256").update(JSON.stringify(encoded)).digest("hex");
}

export function decodeFrozenSeed(value: Uint8Array, hostname: string): { bytes: Buffer; urls: SavedUrl[] } {
  const bytes = Buffer.from(value);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
    hostname?: unknown;
    urls?: unknown;
  };
  if (
    parsed.hostname !== hostname ||
    !Array.isArray(parsed.urls) ||
    parsed.urls.some((row) => !row || typeof row.url !== "string")
  )
    throw new Error("Invalid per-host saved frontier");
  return { bytes, urls: parsed.urls as SavedUrl[] };
}

export function assertCollectedInput(expected: string, actual: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected)
    throw new Error("Recording differs from the collected input");
}
