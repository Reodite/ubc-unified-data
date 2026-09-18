import { createHash } from "node:crypto";
import { constants, lstatSync, type BigIntStats } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compareStrings, ROOT } from "../base.ts";
import type { ProducerContext } from "./contracts.ts";

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function checkedPath(value: string, directory = false): string {
  const target = resolve(value);
  const absolute = isAbsolute(value) ? value : `${process.cwd()}${sep}${value}`;
  let current = parse(absolute).root;
  const parts = absolute.slice(current.length).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Producer input symlink: ${current}`);
    if (!(index === parts.length - 1 && !directory ? info.isFile() : info.isDirectory()))
      throw new Error(`Nonregular producer input: ${current}`);
  }
  return target;
}

async function inputPaths(root: string): Promise<string[]> {
  checkedPath(root, true);
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    checkedPath(directory, true);
    for (const name of (await readdir(directory)).sort(compareStrings)) {
      const entry = join(directory, name);
      const info = lstatSync(entry);
      if (info.isSymbolicLink()) throw new Error(`Producer input symlink: ${entry}`);
      if (info.isDirectory()) await visit(entry);
      else if (!info.isFile()) throw new Error(`Nonregular producer input: ${entry}`);
      else result.push(entry);
    }
  }
  await visit(join(root, "src"));
  if (!result.length) throw new Error("Producer has no source inputs");
  result.push(...["package.json", "package-lock.json", "tsconfig.json"].map((name) => join(root, name)));
  return result.sort(compareStrings);
}

async function captureInputs(root: string) {
  const records: Array<{ path: string; bytes: number; sha256: string }> = [];
  const stamps: string[] = [];
  const paths = await inputPaths(root);
  for (const path of paths) {
    checkedPath(path);
    const before = lstatSync(path, { bigint: true });
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || stamp(before) !== stamp(opened)) throw new Error(`Producer input changed: ${path}`);
      const bytes = await file.readFile();
      checkedPath(path);
      const after = await file.stat({ bigint: true });
      if (
        stamp(before) !== stamp(after) ||
        stamp(after) !== stamp(lstatSync(path, { bigint: true })) ||
        BigInt(bytes.length) !== after.size
      )
        throw new Error(`Producer input changed during read: ${path}`);
      records.push({ path: relative(root, path).split(sep).join("/"), bytes: bytes.length, sha256: hash(bytes) });
      stamps.push(stamp(after));
    } finally {
      await file.close();
    }
  }
  if (!isDeepStrictEqual(paths, await inputPaths(root))) throw new Error("Producer inputs changed during capture");
  return { records, stamps };
}

/** Fingerprint working production inputs and runtime; this does not assert code review or Git cleanliness. */
export async function captureProducer(repositoryRoot = ROOT): Promise<ProducerContext> {
  const root = checkedPath(repositoryRoot, true);
  const before = await captureInputs(root);
  const after = await captureInputs(root);
  if (!isDeepStrictEqual(before, after)) throw new Error("Producer inputs changed during capture");
  const inputs = before.records;
  return {
    inputs_sha256: hash(JSON.stringify({ version: 1, inputs })),
    runtime: {
      node: process.versions.node,
      icu: process.versions.icu ?? "unavailable",
      unicode: process.versions.unicode ?? "unavailable",
      platform: process.platform,
      arch: process.arch,
    },
  };
}

export function assertSameProducer(expected: ProducerContext, actual: ProducerContext): void {
  for (const producer of [expected, actual]) {
    if (
      !producer ||
      !/^[a-f0-9]{64}$/.test(producer.inputs_sha256) ||
      !producer.runtime ||
      !["node", "icu", "unicode", "platform", "arch"].every((key) => {
        const value = producer.runtime[key as keyof ProducerContext["runtime"]];
        return typeof value === "string" && value.length > 0;
      })
    )
      throw new Error("Invalid producer context");
  }
  if (!isDeepStrictEqual(expected, actual)) throw new Error("Producer inputs or runtime changed");
}
