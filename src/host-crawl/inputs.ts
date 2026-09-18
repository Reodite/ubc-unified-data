import type { SavedUrl } from "./contracts.ts";

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
