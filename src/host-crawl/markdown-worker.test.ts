import { constants } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBoundedReader, type BoundedReaderOperations } from "./markdown-bootstrap.mjs";

const fetchGuard = vi.fn(() => {
  throw new Error("Network forbidden in worker tests");
});

beforeAll(() => {
  vi.stubGlobal("fetch", fetchGuard);
});
afterAll(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function readerFixture(bytes = Buffer.from("xxxx")) {
  const snapshot: ReturnType<BoundedReaderOperations["fstatSync"]> = {
    isFile: () => true,
    dev: 1n,
    ino: 2n,
    mode: 0o100400n,
    nlink: 1n,
    uid: 3n,
    gid: 4n,
    size: BigInt(bytes.length),
    mtimeNs: 5n,
    ctimeNs: 6n,
  };
  const options: {
    after?: Partial<typeof snapshot>;
    link?: boolean;
    short?: boolean;
    chunk?: number;
    readError?: Error;
  } = {};
  let stats = 0;
  const operations = {
    constants: { ...constants },
    realpathSync: vi.fn((path: string) => (options.link ? `${path}-target` : path)),
    openSync: vi.fn((_path: string, _flags: number) => {
      stats = 0;
      return 123;
    }),
    fstatSync: vi.fn((_fd: number, _options: { readonly bigint: true }) => ({
      ...snapshot,
      ...(++stats > 1 ? options.after : {}),
    })),
    readSync: vi.fn((_fd: number, target: Buffer, offset: number, length: number, position: number) => {
      if (options.readError) throw options.readError;
      if (options.short) return 0;
      const count = Math.min(length, bytes.length - position, options.chunk ?? length);
      bytes.copy(target, offset, position, position + count);
      return count;
    }),
    closeSync: vi.fn((_fd: number) => {}),
    deny: vi.fn((): never => {
      throw new Error("MARKDOWN_WORKER_REFUSED");
    }),
  } satisfies BoundedReaderOperations;
  return { snapshot, options, operations, read: createBoundedReader(operations) };
}

describe("bounded worker file reads", () => {
  it("returns complete bytes with no-follow flags and a bounded EOF probe", () => {
    const fixture = readerFixture();
    expect(fixture.read("/app/owned", 8)).toEqual(Buffer.from("xxxx"));
    expect(fixture.operations.openSync).toHaveBeenCalledWith(
      "/app/owned",
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect(fixture.operations.readSync.mock.calls.map((call) => [call[3], call[4]])).toEqual([
      [4, 0],
      [1, 4],
    ]);
    expect(fixture.operations.closeSync).toHaveBeenCalledExactlyOnceWith(123);
  });

  it("accumulates short positive reads without reading beyond the exact cap", () => {
    const fixture = readerFixture(Buffer.from("abcdef"));
    fixture.options.chunk = 2;
    expect(fixture.read("/app/owned", 6)).toEqual(Buffer.from("abcdef"));
    expect(fixture.operations.readSync.mock.calls.map((call) => [call[3], call[4]])).toEqual([
      [6, 0],
      [4, 2],
      [2, 4],
    ]);
    expect(fixture.operations.closeSync).toHaveBeenCalledExactlyOnceWith(123);
  });

  it.each(["oversized", "nonregular", "multiple-links"])("refuses %s before reading bytes", (kind) => {
    const fixture = readerFixture();
    if (kind === "oversized") fixture.snapshot.size = 9n;
    if (kind === "nonregular") fixture.snapshot.isFile = () => false;
    if (kind === "multiple-links") fixture.snapshot.nlink = 2n;
    expect(() => fixture.read("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
    expect(fixture.operations.readSync).not.toHaveBeenCalled();
    expect(fixture.operations.closeSync).toHaveBeenCalledExactlyOnceWith(123);
  });

  it("refuses redirected paths without opening a descriptor", () => {
    const fixture = readerFixture();
    fixture.options.link = true;
    expect(() => fixture.read("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
    expect(fixture.operations.openSync).not.toHaveBeenCalled();
    expect(fixture.operations.closeSync).not.toHaveBeenCalled();
  });

  it.each(["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeNs", "ctimeNs"] as const)(
    "refuses a changed %s after reading and closes the descriptor",
    (field) => {
      const fixture = readerFixture();
      fixture.options.after = { [field]: fixture.snapshot[field] + 1n };
      expect(() => fixture.read("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
      expect(fixture.operations.closeSync).toHaveBeenCalledExactlyOnceWith(123);
    },
  );

  it("refuses truncated and growing files and closes after read errors", () => {
    const short = readerFixture();
    short.options.short = true;
    expect(() => short.read("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
    expect(short.operations.closeSync).toHaveBeenCalledExactlyOnceWith(123);

    const growing = readerFixture();
    growing.snapshot.size = 3n;
    expect(() => growing.read("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
    expect(growing.operations.closeSync).toHaveBeenCalledExactlyOnceWith(123);

    const failed = readerFixture();
    failed.options.readError = new Error("read failed");
    expect(() => failed.read("/app/owned", 8)).toThrow("read failed");
    expect(failed.operations.closeSync).toHaveBeenCalledExactlyOnceWith(123);
  });

  it("keeps independent readers and captures their operations once", () => {
    const left = readerFixture(Buffer.from("left"));
    const right = readerFixture(Buffer.from("right"));
    left.options.link = true;
    expect(() => left.read("/app/left", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
    expect(right.read("/app/right", 8)).toEqual(Buffer.from("right"));
    expect(right.operations.deny).not.toHaveBeenCalled();

    const open = right.operations.openSync;
    const replacement = vi.fn((): never => {
      throw new Error("replaced operation");
    });
    Object.assign(right.operations, {
      realpathSync: replacement,
      openSync: replacement,
      fstatSync: replacement,
      readSync: replacement,
      closeSync: replacement,
      deny: replacement,
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
    });
    expect(right.read("/app/right", 8)).toEqual(Buffer.from("right"));
    expect(open).toHaveBeenLastCalledWith(
      "/app/right",
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect(replacement).not.toHaveBeenCalled();
  });
});
