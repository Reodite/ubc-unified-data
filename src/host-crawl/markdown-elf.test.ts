import { describe, expect, it } from "vitest";
import { inspectMarkdownElf, MARKDOWN_ELF_LIMITS } from "./markdown-elf.ts";

function fixture(fileBytes = 4096) {
  const bytes = Buffer.alloc(fileBytes);
  bytes.set([0x7f, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(3, 56);
  const program = (index: number, type: number, offset: number, size: number, vaddr = 0x400000 + offset) => {
    const at = 64 + index * 56;
    bytes.writeUInt32LE(type, at);
    bytes.writeUInt32LE(4, at + 4);
    bytes.writeBigUInt64LE(BigInt(offset), at + 8);
    bytes.writeBigUInt64LE(BigInt(vaddr), at + 16);
    bytes.writeBigUInt64LE(BigInt(size), at + 32);
    bytes.writeBigUInt64LE(BigInt(size), at + 40);
    bytes.writeBigUInt64LE(1n, at + 48);
  };
  const interpreter = "/lib64/ld-linux-x86-64.so.2\0";
  program(0, 3, 300, interpreter.length);
  bytes.write(interpreter, 300);
  program(1, 1, 0, bytes.length);
  program(2, 2, 512, 7 * 16);
  const dynamic = (index: number, tag: number, value: number) => {
    bytes.writeBigInt64LE(BigInt(tag), 512 + index * 16);
    bytes.writeBigUInt64LE(BigInt(value), 520 + index * 16);
  };
  bytes.write("\0libc.so.6\0libm.so.6\0node.so\0", 1024);
  dynamic(0, 5, 0x400400);
  dynamic(1, 10, 29);
  dynamic(2, 1, 1);
  dynamic(3, 1, 11);
  dynamic(4, 14, 21);
  dynamic(5, 24, 0);
  dynamic(6, 0, 0);
  const reads: Array<[number, number]> = [];
  const reader = async (offset: number, length: number) => {
    expect(Number.isSafeInteger(offset)).toBe(true);
    expect(length).toBeGreaterThan(0);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset + length).toBeLessThanOrEqual(bytes.length);
    reads.push([offset, length]);
    return bytes.subarray(offset, offset + length);
  };
  return { bytes, program, dynamic, reads, reader };
}

describe("bounded Markdown ELF metadata", () => {
  it("reads immutable ordered metadata and permits normal LOAD containment", async () => {
    const f = fixture();
    const result = await inspectMarkdownElf(f.reader, f.bytes.length);
    expect(result).toEqual({
      class: 64,
      data: "little",
      machine: 62,
      type: 3,
      interpreter: "/lib64/ld-linux-x86-64.so.2",
      soname: "node.so",
      needed: ["libc.so.6", "libm.so.6"],
      bind_now: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.needed)).toBe(true);
    expect(f.reads.reduce((sum, [, length]) => sum + length, 0)).toBeLessThan(1024);
    expect(f.reads.length).toBeLessThan(20);
  });

  it.each([24, 30, 0x6ffffffb])("recognizes bind-now tag %i", async (tag) => {
    const f = fixture();
    f.dynamic(5, tag, tag === 30 ? 8 : tag === 0x6ffffffb ? 1 : 0);
    expect((await inspectMarkdownElf(f.reader, f.bytes.length)).bind_now).toBe(true);
  });

  it.each([
    [0, 0],
    [4, 1],
    [5, 2],
    [6, 0],
    [7, 9],
    [8, 1],
    [9, 1],
    [16, 1],
    [18, 3],
    [20, 0],
    [52, 63],
    [54, 55],
  ])("rejects malformed header byte %i=%i", async (offset, value) => {
    const f = fixture();
    f.bytes[offset] = value;
    await expect(inspectMarkdownElf(f.reader, f.bytes.length)).rejects.toThrow();
  });

  it.each([0, 129, 65535])("rejects program header count %i", async (count) => {
    const f = fixture();
    f.bytes.writeUInt16LE(count, 56);
    await expect(inspectMarkdownElf(f.reader, f.bytes.length)).rejects.toThrow();
    expect(f.reads.length).toBe(1);
  });

  it.each([15, 29, 0x6ffffefc, 0x6ffffefb, 0x7fffffff, 0x7ffffffd])("rejects forbidden dynamic tag %i", async (tag) => {
    const f = fixture();
    f.dynamic(5, tag, 1);
    await expect(inspectMarkdownElf(f.reader, f.bytes.length)).rejects.toThrow();
  });

  it.each([
    "duplicate",
    "path",
    "unterminated",
    "strtab",
    "strsz",
    "null",
    "ambiguous",
    "file-range",
    "integer-overflow",
    "dynamic-alignment",
  ])("rejects %s geometry or names", async (mutation) => {
    const f = fixture();
    if (mutation === "duplicate") f.dynamic(3, 1, 1);
    if (mutation === "path") f.bytes.write("a/b.so.6", 1025);
    if (mutation === "unterminated") f.dynamic(1, 10, 9);
    if (mutation === "strtab") f.dynamic(0, 5, 0x900000);
    if (mutation === "strsz") f.dynamic(1, 10, 10000);
    if (mutation === "null") f.dynamic(6, 21, 0);
    if (mutation === "ambiguous") f.program(0, 1, 100, 1000, 0x400000);
    if (mutation === "file-range") f.program(1, 3, 4090, 20);
    if (mutation === "integer-overflow") f.bytes.writeBigUInt64LE(1n << 63n, 72);
    if (mutation === "dynamic-alignment") f.program(2, 2, 512, 113);
    await expect(inspectMarkdownElf(f.reader, f.bytes.length)).rejects.toThrow();
  });

  it.each(["first", "last", "only"])("rejects a dynamic string table with a non-NUL %s byte", async (boundary) => {
    const f = fixture();
    if (boundary === "last") f.dynamic(1, 10, 30);
    if (boundary === "only") {
      f.dynamic(1, 10, 1);
      f.dynamic(2, 21, 0);
      f.dynamic(3, 22, 0);
      f.dynamic(4, 23, 0);
    }
    expect((await inspectMarkdownElf(f.reader, f.bytes.length)).needed).toEqual(
      boundary === "only" ? [] : ["libc.so.6", "libm.so.6"],
    );
    f.bytes[boundary === "last" ? 1053 : 1024] = 65;
    await expect(inspectMarkdownElf(f.reader, f.bytes.length)).rejects.toThrow();
  });

  it("rejects PT_INTERP after a loadable segment", async () => {
    const f = fixture();
    expect((await inspectMarkdownElf(f.reader, f.bytes.length)).interpreter).toBe("/lib64/ld-linux-x86-64.so.2");
    const interp = Buffer.from(f.bytes.subarray(64, 120));
    const load = Buffer.from(f.bytes.subarray(120, 176));
    f.bytes.set(load, 64);
    f.bytes.set(interp, 120);
    await expect(inspectMarkdownElf(f.reader, f.bytes.length)).rejects.toThrow();
  });

  it("rejects loadable segments in descending virtual-address order", async () => {
    const f = fixture();
    f.bytes.writeUInt16LE(4, 56);
    f.program(1, 1, 0, 2048, 0x400000);
    f.program(2, 1, 2048, 2048, 0x402000);
    f.program(3, 2, 512, 7 * 16, 0x400200);
    expect((await inspectMarkdownElf(f.reader, f.bytes.length)).needed).toEqual(["libc.so.6", "libm.so.6"]);
    f.program(1, 1, 2048, 2048, 0x402000);
    f.program(2, 1, 0, 2048, 0x400000);
    await expect(inspectMarkdownElf(f.reader, f.bytes.length)).rejects.toThrow();
  });

  it("ignores DT_NULL values and uninterpreted tail padding", async () => {
    const f = fixture();
    f.program(2, 2, 512, 9 * 16);
    f.bytes.writeBigUInt64LE((1n << 64n) - 1n, 512 + 6 * 16 + 8);
    f.dynamic(7, 0, 0x362);
    f.dynamic(8, 29, 1);
    expect((await inspectMarkdownElf(f.reader, f.bytes.length)).needed).toEqual(["libc.so.6", "libm.so.6"]);
  });

  it("maps high safe virtual addresses without unsafe intermediate addition", async () => {
    const offset = 1024 * 1024;
    const f = fixture(offset + 4096);
    const address = Number.MAX_SAFE_INTEGER - 4096;
    f.bytes.copy(f.bytes, offset + 512, 512, 624);
    f.bytes.copy(f.bytes, offset + 1024, 1024, 1053);
    f.bytes.writeUInt16LE(2, 56);
    f.program(0, 1, offset, 4096, address);
    f.program(1, 2, offset + 512, 112, address + 512);
    f.bytes.writeBigUInt64LE(BigInt(address + 1024), offset + 520);
    expect((await inspectMarkdownElf(f.reader, f.bytes.length)).needed).toEqual(["libc.so.6", "libm.so.6"]);
  });

  it("reads bounded labels rather than a large dynamic string table", async () => {
    const f = fixture(256 * 1024);
    f.dynamic(1, 10, f.bytes.length - 1024);
    await inspectMarkdownElf(f.reader, f.bytes.length);
    expect(f.reads.filter(([offset]) => offset >= 1024)).toEqual([
      [1024, 1],
      [262143, 1],
      [1025, 256],
      [1035, 256],
      [1045, 256],
    ]);
    expect(f.reads.reduce((sum, [, length]) => sum + length, 0)).toBeLessThan(MARKDOWN_ELF_LIMITS.readBytes);
  });

  it.each([255, 256])("enforces the %i byte label boundary", async (length) => {
    const f = fixture();
    f.bytes.fill(0, 1024);
    f.bytes.write("a".repeat(length), 1025);
    f.dynamic(1, 10, length + 2);
    f.dynamic(3, 21, 0);
    f.dynamic(4, 22, 0);
    const promise = inspectMarkdownElf(f.reader, f.bytes.length);
    if (length === 255) expect((await promise).needed).toEqual(["a".repeat(length)]);
    else await expect(promise).rejects.toThrow();
  });

  it.each(["", ".", "..", "a/b", "a\\b", "$ORIGIN", "a:b", "a;b", "a,b", "a%20b", "a b", "é"])(
    "rejects unsafe label %s",
    async (label) => {
      const f = fixture();
      f.bytes.fill(0, 1024);
      f.bytes.write(label, 1025);
      f.dynamic(3, 21, 0);
      f.dynamic(4, 22, 0);
      await expect(inspectMarkdownElf(f.reader, f.bytes.length)).rejects.toThrow();
    },
  );

  it.each([64, 65])("bounds ordered NEEDED entry count at %i", async (count) => {
    const f = fixture(8192);
    f.program(2, 2, 512, (count + 3) * 16);
    f.dynamic(0, 5, 0x401000);
    f.dynamic(1, 10, count * 16 + 1);
    for (let index = 0; index < count; index++) {
      f.dynamic(index + 2, 1, index * 16 + 1);
      f.bytes.write(`lib${index}.so\0`, 4097 + index * 16);
    }
    f.dynamic(count + 2, 0, 0);
    const promise = inspectMarkdownElf(f.reader, f.bytes.length);
    if (count === 64)
      expect((await promise).needed).toEqual(Array.from({ length: 64 }, (_, index) => `lib${index}.so`));
    else await expect(promise).rejects.toThrow();
  });

  it.each([4096, 4097])("bounds dynamic entries at %i before reading the table", async (count) => {
    const f = fixture(70000);
    f.program(2, 2, 512, count * 16);
    for (let index = 0; index < count; index++) f.dynamic(index, index === count - 1 ? 0 : 21, 0);
    const promise = inspectMarkdownElf(f.reader, f.bytes.length);
    if (count === 4096) expect((await promise).needed).toEqual([]);
    else {
      await expect(promise).rejects.toThrow();
      expect(f.reads.every(([offset]) => offset !== 512)).toBe(true);
    }
  });

  it("accepts the program-header ceiling", async () => {
    const f = fixture(8192);
    f.bytes.fill(0, 64);
    f.program(0, 1, 0, f.bytes.length);
    f.bytes.writeUInt16LE(128, 56);
    expect((await inspectMarkdownElf(f.reader, f.bytes.length)).needed).toEqual([]);
  });

  it.each([
    "dynamic-duplicate",
    "interp-duplicate",
    "segment-overlap",
    "memory-short",
    "memory-overflow",
    "load-alignment",
    "dynamic-address",
    "extended-sections",
    "section-table-range",
    "duplicate-strtab",
    "duplicate-soname",
    "missing-strsz",
    "empty-interpreter",
    "relative-interpreter",
    "long-interpreter",
  ])("rejects %s", async (mutation) => {
    const f = fixture(8192);
    if (mutation === "dynamic-duplicate") f.program(0, 2, 700, 16);
    if (mutation === "interp-duplicate") f.program(2, 3, 700, 16);
    if (mutation === "segment-overlap") f.program(0, 3, 512, 16);
    if (mutation === "memory-short") f.bytes.writeBigUInt64LE(1n, 64 + 56 + 40);
    if (mutation === "memory-overflow") f.bytes.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER), 64 + 56 + 16);
    if (mutation === "load-alignment") f.bytes.writeBigUInt64LE(3n, 64 + 56 + 48);
    if (mutation === "dynamic-address") f.bytes.writeBigUInt64LE(0x400300n, 64 + 2 * 56 + 16);
    if (mutation === "extended-sections") f.bytes.writeBigUInt64LE(4096n, 40);
    if (mutation === "section-table-range") {
      f.bytes.writeBigUInt64LE(8192n, 40);
      f.bytes.writeUInt16LE(64, 58);
      f.bytes.writeUInt16LE(1, 60);
    }
    if (mutation === "duplicate-strtab") f.dynamic(5, 5, 0x400400);
    if (mutation === "duplicate-soname") f.dynamic(5, 14, 21);
    if (mutation === "missing-strsz") f.dynamic(1, 21, 0);
    if (mutation === "empty-interpreter") f.bytes[300] = 0;
    if (mutation === "relative-interpreter") f.bytes[300] = 65;
    if (mutation === "long-interpreter") f.program(0, 3, 300, 4097);
    await expect(inspectMarkdownElf(f.reader, f.bytes.length)).rejects.toThrow();
  });

  it("accepts the interpreter-byte ceiling including its terminal NUL", async () => {
    const f = fixture(8192);
    const interpreter = `/${[...Array.from({ length: 15 }, () => "a".repeat(255)), "b".repeat(254)].join("/")}`;
    expect(interpreter.length + 1).toBe(4096);
    f.program(0, 3, 2000, interpreter.length + 1);
    f.bytes.write(`${interpreter}\0`, 2000);
    expect((await inspectMarkdownElf(f.reader, f.bytes.length)).interpreter).toBe(interpreter);
  });

  it("reports unknown dependency labels without admitting or expanding their recipe", async () => {
    const f = fixture();
    f.bytes.write("unseen.so\0", 1025);
    expect((await inspectMarkdownElf(f.reader, f.bytes.length)).needed).toEqual(["unseen.so", "libm.so.6"]);
  });

  it("uses intrinsic byte accessors and copies each callback result", async () => {
    const f = fixture();
    let touched = 0;
    const reader = async (offset: number, length: number) => {
      const bytes = f.bytes.subarray(offset, offset + length);
      Object.defineProperty(bytes, "byteLength", {
        get() {
          touched++;
          throw new Error();
        },
      });
      return bytes;
    };
    expect((await inspectMarkdownElf(reader, f.bytes.length)).soname).toBe("node.so");
    expect(touched).toBe(0);
  });

  it("accepts static ET_EXEC without interpreter or dynamics", async () => {
    const f = fixture();
    f.bytes.writeUInt16LE(2, 16);
    f.bytes.writeUInt16LE(1, 56);
    f.program(0, 1, 0, f.bytes.length);
    expect(await inspectMarkdownElf(f.reader, f.bytes.length)).toMatchObject({
      type: 2,
      interpreter: null,
      soname: null,
      needed: [],
      bind_now: false,
    });
  });

  it("bounds size before reader calls and demands exact byte responses", async () => {
    let reads = 0;
    for (const size of [0, 63, -1, NaN, Infinity, 256 * 1024 * 1024 + 1]) {
      await expect(
        inspectMarkdownElf(async () => {
          reads++;
          return new Uint8Array();
        }, size),
      ).rejects.toThrow();
    }
    expect(reads).toBe(0);
    for (const response of [new Uint8Array(63), new Uint8Array(65), new Uint8Array(new SharedArrayBuffer(64))]) {
      await expect(inspectMarkdownElf(async () => response, 4096)).rejects.toThrow();
    }
    expect(Object.isFrozen(MARKDOWN_ELF_LIMITS)).toBe(true);
  });
});
