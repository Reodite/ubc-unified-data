import type { BigIntStats, constants } from "node:fs";

export interface BoundedReaderOperations {
  readonly constants: Pick<typeof constants, "O_RDONLY" | "O_NOFOLLOW" | "O_NONBLOCK">;
  realpathSync(path: string): string;
  openSync(path: string, flags: number): number;
  fstatSync(
    fd: number,
    options: { readonly bigint: true },
  ): Pick<BigIntStats, "isFile" | "dev" | "ino" | "mode" | "nlink" | "uid" | "gid" | "size" | "mtimeNs" | "ctimeNs">;
  readSync(fd: number, bytes: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
  deny(): never;
}

/** Bind bounded reads to captured filesystem operations and one refusal policy. */
export function createBoundedReader(operations: BoundedReaderOperations): (path: string, cap: number) => Buffer;

/** Run the sole metadata-only child path; invocation and projection belong to the trusted parent. */
export function runMarkdownWorker(): Promise<void>;
