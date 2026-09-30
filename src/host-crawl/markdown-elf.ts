import { types } from "node:util";

export const MARKDOWN_ELF_LIMITS = Object.freeze({
  programHeaders: 128,
  dynamicEntries: 4096,
  neededNames: 64,
  nameBytes: 255,
  interpreterBytes: 4096,
  readBytes: 1048576,
  fileBytes: 268435456,
} as const);

export interface MarkdownElf {
  readonly class: 64;
  readonly data: "little";
  readonly machine: 62;
  readonly type: 2 | 3;
  readonly interpreter: string | null;
  readonly soname: string | null;
  readonly needed: readonly string[];
  readonly bind_now: boolean;
}

/** Supply exactly length bytes at the requested file offset; no implicit filesystem access occurs. */
export type MarkdownElfReader = (offset: number, length: number) => Promise<Uint8Array>;

type Segment = Readonly<{ type: number; offset: number; address: number; files: number; memory: number }>;
const LIMITS = MARKDOWN_ELF_LIMITS;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")!.get!;
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;

function fail(): never {
  throw new Error("Markdown ELF: invalid metadata.");
}

function integer(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > maximum) fail();
  return value;
}

function uint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(value);
}

function range(offset: number, length: number, size: number): void {
  if (offset > size || length > size - offset) fail();
}

function overlaps(a: number, aSize: number, b: number, bSize: number): boolean {
  return aSize > 0 && bSize > 0 && a < b + bSize && b < a + aSize;
}

function ascii(bytes: Uint8Array): string {
  if (bytes.some((byte) => byte < 0x21 || byte > 0x7e)) fail();
  return String.fromCharCode(...bytes);
}

function name(bytes: Uint8Array): string {
  const value = ascii(bytes);
  if (!/^[A-Za-z0-9_+.-]+$/.test(value) || value === "." || value === "..") fail();
  return value;
}

/** Return bounded immutable ELF evidence, not a native dependency admission or execution grant. */
export async function inspectMarkdownElf(reader: MarkdownElfReader, size: number): Promise<MarkdownElf> {
  integer(size, LIMITS.fileBytes);
  if (size < 64 || typeof reader !== "function") fail();
  let consumed = 0;
  async function read(offset: number, length: number): Promise<Uint8Array> {
    integer(offset);
    integer(length, LIMITS.readBytes);
    range(offset, length, size);
    if (!length || length > LIMITS.readBytes - consumed) fail();
    consumed += length;
    const result = await reader(offset, length);
    if (types.isProxy(result) || !types.isUint8Array(result)) fail();
    const buffer: ArrayBuffer = bufferOf.call(result);
    if (types.isSharedArrayBuffer(buffer) || lengthOf.call(result) !== length) fail();
    return new Uint8Array(new Uint8Array(buffer, offsetOf.call(result), length));
  }
  const header = await read(0, 64);
  const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (
    header[0] !== 0x7f ||
    header[1] !== 69 ||
    header[2] !== 76 ||
    header[3] !== 70 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header[6] !== 1 ||
    (header[7] !== 0 && header[7] !== 3) ||
    header.slice(8, 16).some((byte) => byte !== 0) ||
    h.getUint16(18, true) !== 62 ||
    h.getUint32(20, true) !== 1 ||
    h.getUint32(48, true) !== 0 ||
    h.getUint16(52, true) !== 64 ||
    h.getUint16(54, true) !== 56
  )
    fail();
  const type = h.getUint16(16, true);
  if (type !== 2 && type !== 3) fail();
  uint64(h, 24);
  const phoff = uint64(h, 32);
  const shoff = uint64(h, 40);
  const phnum = h.getUint16(56, true);
  const shsize = h.getUint16(58, true);
  const shnum = h.getUint16(60, true);
  const shstrings = h.getUint16(62, true);
  if (!phnum || phnum > LIMITS.programHeaders || phoff < 64 || phoff % 8) fail();
  if (shoff === 0) {
    if (shnum !== 0 || shstrings !== 0 || (shsize !== 0 && shsize !== 64)) fail();
  } else {
    if (shoff < 64 || shoff % 8 || shsize !== 64 || !shnum || shnum >= 0xff00 || shstrings >= shnum) fail();
    range(shoff, shnum * shsize, size);
    if (overlaps(shoff, shnum * shsize, phoff, phnum * 56)) fail();
  }
  const programs = await read(phoff, phnum * 56);
  const p = new DataView(programs.buffer, programs.byteOffset, programs.byteLength);
  const loads: Segment[] = [];
  let previousLoadAddress: number | undefined;
  let dynamic: Segment | undefined;
  let interp: Segment | undefined;
  for (let index = 0; index < phnum; index++) {
    const at = index * 56;
    const segment: Segment = {
      type: p.getUint32(at, true),
      offset: uint64(p, at + 8),
      address: uint64(p, at + 16),
      files: uint64(p, at + 32),
      memory: uint64(p, at + 40),
    };
    uint64(p, at + 24);
    const alignment = uint64(p, at + 48);
    if (alignment > 1 && (BigInt(alignment) & (BigInt(alignment) - 1n)) !== 0n) fail();
    range(segment.offset, segment.files, size);
    range(segment.address, segment.memory, Number.MAX_SAFE_INTEGER);
    if (segment.type === 1 || segment.type === 2 || segment.type === 3) {
      if (segment.files > segment.memory) fail();
      if (segment.type === 1) {
        if (
          (alignment > 1 && segment.offset % alignment !== segment.address % alignment) ||
          (previousLoadAddress !== undefined && segment.address < previousLoadAddress)
        )
          fail();
        previousLoadAddress = segment.address;
        loads.push(segment);
      } else {
        if (
          !segment.files ||
          overlaps(segment.offset, segment.files, 0, 64) ||
          overlaps(segment.offset, segment.files, phoff, phnum * 56)
        )
          fail();
        if (segment.type === 2) {
          if (dynamic || segment.offset % 8 || segment.files % 16 || segment.files / 16 > LIMITS.dynamicEntries) fail();
          dynamic = segment;
        } else {
          if (interp || loads.length || segment.files > LIMITS.interpreterBytes) fail();
          interp = segment;
        }
      }
    }
  }
  if (!loads.length) fail();
  for (let a = 0; a < loads.length; a++) {
    for (let b = a + 1; b < loads.length; b++) {
      if (overlaps(loads[a]!.address, loads[a]!.memory, loads[b]!.address, loads[b]!.memory)) fail();
    }
  }
  function mapped(address: number, length: number): number {
    range(address, length, Number.MAX_SAFE_INTEGER);
    const matches = loads.filter(
      (load) =>
        address >= load.address &&
        address - load.address <= load.files &&
        length <= load.files - (address - load.address),
    );
    if (matches.length !== 1) fail();
    return matches[0]!.offset + (address - matches[0]!.address);
  }
  // INTERP and DYNAMIC normally live inside LOAD; only their mutual overlap is invalid.
  if (interp && dynamic && overlaps(interp.offset, interp.files, dynamic.offset, dynamic.files)) fail();
  for (const segment of [interp, dynamic]) {
    if (segment && mapped(segment.address, segment.files) !== segment.offset) fail();
  }
  let interpreter: string | null = null;
  if (interp) {
    const bytes = await read(interp.offset, interp.files);
    if (bytes.at(-1) !== 0 || bytes.subarray(0, -1).includes(0)) fail();
    interpreter = ascii(bytes.subarray(0, -1));
    if (
      !interpreter.startsWith("/") ||
      interpreter
        .slice(1)
        .split("/")
        .some((part) => !/^[A-Za-z0-9_+.-]+$/.test(part) || part === "." || part === ".." || part.length > 255)
    )
      fail();
  }
  let soname: string | null = null;
  const needed: string[] = [];
  let bindNow = false;
  if (dynamic) {
    const bytes = await read(dynamic.offset, dynamic.files);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const labels: number[] = [];
    const singletons = new Map<number, number>();
    let ended = false;
    for (let at = 0; at < bytes.length; at += 16) {
      const tag = uint64(view, at);
      if (tag === 0) {
        // DT_NULL terminates the table; its value and subsequent padding are not dynamic entries.
        ended = true;
        break;
      }
      const value = uint64(view, at + 8);
      if ([15, 29, 0x6ffffefc, 0x6ffffefb, 0x7fffffff, 0x7ffffffd].includes(tag)) fail();
      if (tag === 1) {
        if (labels.length >= LIMITS.neededNames) fail();
        labels.push(value);
      } else if ([5, 10, 14, 24, 30, 0x6ffffffb].includes(tag)) {
        if (singletons.has(tag)) fail();
        singletons.set(tag, value);
      }
    }
    if (!ended) fail();
    bindNow =
      singletons.has(24) || ((singletons.get(30) ?? 0) & 8) !== 0 || ((singletons.get(0x6ffffffb) ?? 0) & 1) !== 0;
    const strtab = singletons.get(5);
    const strsize = singletons.get(10);
    if ((strtab === undefined) !== (strsize === undefined)) fail();
    if ((labels.length || singletons.has(14)) && strtab === undefined) fail();
    if (strtab !== undefined && strsize !== undefined) {
      if (!strsize) fail();
      const offset = mapped(strtab, strsize);
      const first = await read(offset, 1);
      if (first[0] !== 0 || (strsize > 1 && (await read(offset + strsize - 1, 1))[0] !== 0)) fail();
      async function label(index: number): Promise<string> {
        if (index >= strsize!) fail();
        const bytes = await read(offset + index, Math.min(LIMITS.nameBytes + 1, strsize! - index));
        const end = bytes.indexOf(0);
        if (end < 1 || end > LIMITS.nameBytes) fail();
        return name(bytes.subarray(0, end));
      }
      for (const index of labels) {
        const value = await label(index);
        if (needed.includes(value)) fail();
        needed.push(value);
      }
      const sonameIndex = singletons.get(14);
      if (sonameIndex !== undefined) soname = await label(sonameIndex);
    }
  }
  return Object.freeze({
    class: 64,
    data: "little",
    machine: 62,
    type,
    interpreter,
    soname,
    needed: Object.freeze(needed),
    bind_now: bindNow,
  });
}
