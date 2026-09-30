import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

describe("fixed worker in exact-file sparse namespaces", () => {
  it("checks bounded no-follow reads with a builtins-only owned harness", async () => {
    const source = (await readFile(new URL("./markdown-bootstrap.mjs", import.meta.url), "utf8"))
      .replace(/^import[\s\S]*?from "node:[^"]+";\n/gm, "")
      .replace(/^export /gm, "")
      .replaceAll("import.meta.url", JSON.stringify("file:///app/markdown-bootstrap.mjs"));
    const snapshot = { isFile: () => true, nlink: 1n, size: 4n, ino: 1n };
    const options: { size?: bigint; regular?: boolean; link?: boolean; changed?: boolean } = {};
    const opened: number[] = [],
      reads: number[] = [];
    let closed = 0,
      stats = 0;
    const harness = runInNewContext(`${source}\n({ readBounded });`, {
      Buffer,
      constants,
      process: { stdin: { destroy() {} }, stderr: { write() {} } },
      realpathSync: (path: string) => (options.link ? `${path}-target` : path),
      openSync: (_path: string, flags: number) => {
        opened.push(flags);
        return 123;
      },
      fstatSync: () => ({
        ...snapshot,
        size: options.size ?? 4n,
        isFile: () => options.regular !== false,
        ino: options.changed && ++stats > 1 ? 2n : 1n,
      }),
      closeSync: () => {
        closed++;
      },
      readSync: (_fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
        reads.push(length);
        if (position === 4) return 0;
        bytes.fill(120, offset, offset + length);
        return length;
      },
    }) as { readBounded(path: string, cap: number): Buffer };
    expect(harness.readBounded("/app/owned", 8)).toEqual(Buffer.from("xxxx"));
    expect(opened[0]! & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(opened[0]! & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(closed).toBe(1);
    expect(reads).toEqual([4, 1]);
    options.size = 9n;
    expect(() => harness.readBounded("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
    expect(reads).toEqual([4, 1]);
    expect(closed).toBe(2);
    options.size = 4n;
    options.regular = false;
    expect(() => harness.readBounded("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
    expect(closed).toBe(3);
    options.regular = true;
    options.link = true;
    expect(() => harness.readBounded("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
    expect(opened.length).toBe(3);
    options.link = false;
    options.changed = true;
    expect(() => harness.readBounded("/app/owned", 8)).toThrow("MARKDOWN_WORKER_REFUSED");
    expect(closed).toBe(4);
  });
});
