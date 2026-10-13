import { DocumentPolicyError } from "./contracts.ts";

export type RecordingFailureKind = "integrity" | "limit" | "unavailable";

/** A file no longer matches the observation bound to an input read. */
export class FileIntegrityError extends Error {}

/** Keep the historical Error serialization while carrying a machine-readable collection decision. */
export class RecordingError extends Error {
  constructor(
    message: string,
    readonly kind: RecordingFailureKind = "integrity",
  ) {
    super(message);
  }
}

const LIMIT_MESSAGES = new Set([
  "Acquisition request/byte budget exhausted",
  "Acquisition duration exhausted",
  "Acquisition wait exceeds remaining duration",
  "Acquisition response/total byte budget exceeded",
  "Retry wait exceeds duration budget",
]);
const INTEGRITY_MESSAGES = new Set([
  "Recorded snapshot bytes changed",
  "Recorded binary body changed",
  "Recorded text body changed",
  "Recorded text decoding differs from snapshot body",
  "Invalid recorded observation",
  "Invalid or undeclared binary observation",
  "Invalid saved media classification",
  "Recursive request dependency",
]);

/** Decode persisted legacy diagnostics at the recording boundary, without rewriting their evidence. */
export function savedRequestFailure(detail: string): RecordingError {
  let reason = detail;
  while (reason.startsWith("Error: Saved request failure: "))
    reason = reason.slice("Error: Saved request failure: ".length);
  if (reason.startsWith("Error: ")) reason = reason.slice("Error: ".length);
  const storageFailure = /^(?:ENOENT|EIO|ENOSPC):(?:\s|$)/.test(reason);
  const changedFile =
    reason.startsWith("File changed before reading: ") || reason.startsWith("File changed while reading: ");
  const kind = LIMIT_MESSAGES.has(reason)
    ? "limit"
    : INTEGRITY_MESSAGES.has(reason) || storageFailure || changedFile
      ? "integrity"
      : "unavailable";
  return new RecordingError(`Saved request failure: ${detail}`, kind);
}

const STORAGE_FAILURES = new Set(["ENOENT", "EIO", "ENOSPC"]);

export function isFatalCollectionError(error: unknown): boolean {
  return (
    error instanceof DocumentPolicyError ||
    error instanceof FileIntegrityError ||
    (error instanceof RecordingError && error.kind !== "unavailable") ||
    (error !== null && typeof error === "object" && STORAGE_FAILURES.has(String((error as NodeJS.ErrnoException).code)))
  );
}
