import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_EXTERNAL_ROOT } from "./paths.ts";
import { assertNoSymlinkPath } from "./public-validation.ts";

export const PDF_EXECUTABLES = Object.freeze({
  info: "/usr/bin/pdfinfo",
  text: "/usr/bin/pdftotext",
  limits: "/usr/bin/prlimit",
  loader: "/lib64/ld-linux-x86-64.so.2",
});

export const PDF_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  outputBytes: 32 * 1024 * 1024,
  infoBytes: 1024 * 1024,
  diagnosticBytes: 256 * 1024,
  pages: 500,
  timeoutMs: 30_000,
  addressSpaceBytes: 1024 * 1024 * 1024,
  cpuSeconds: 20,
  openFiles: 64,
});

export const PDF_INFO_ARGUMENTS = Object.freeze(["-enc", "UTF-8", "-rawdates"]);
/** Physical-layout baseline; execute the capability-selected arguments in the captured profile. */
export const PDF_TEXT_ARGUMENTS = Object.freeze([
  "-layout",
  "-enc",
  "UTF-8",
  "-eol",
  "unix",
  "-r",
  "72",
  "-colspacing",
  "0.7",
]);

const LIMIT_ARGUMENTS = Object.freeze([
  `--as=${PDF_LIMITS.addressSpaceBytes}`,
  `--cpu=${PDF_LIMITS.cpuSeconds}`,
  `--fsize=${PDF_LIMITS.outputBytes}`,
  `--nofile=${PDF_LIMITS.openFiles}`,
  "--core=0",
  "--",
]);
const ENVIRONMENT = Object.freeze({
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC",
  HOME: "$PRIVATE/home",
  XDG_CACHE_HOME: "$PRIVATE/cache",
  XDG_CONFIG_HOME: "$PRIVATE/config",
  XDG_DATA_HOME: "$PRIVATE/data",
  XDG_CONFIG_DIRS: "$PRIVATE/config-dirs",
  XDG_DATA_DIRS: "$PRIVATE/data-dirs",
  TMPDIR: "$PRIVATE/tmp",
  FONTCONFIG_FILE: "$PRIVATE/fonts.conf",
  FONTCONFIG_PATH: "$PRIVATE/config",
});

// No system includes or system caches: only these font trees affect fontconfig discovery.
const FONTCONFIG = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>
`;
const RESOURCE_ROOTS = Object.freeze([
  "/etc/fonts",
  "/usr/share/fontconfig",
  "/usr/share/fonts",
  "/usr/local/share/fonts",
  "/etc/poppler",
  "/usr/share/poppler",
  "/usr/local/share/poppler",
  "/etc/ld.so.cache",
  "/etc/ld.so.preload",
]);

export type PdfResource =
  | { path: string; kind: "missing" }
  | { path: string; kind: "directory"; resolvedPath: string; entries: string[] }
  | { path: string; kind: "symlink"; target: string; resolvedPath: string | null }
  | { path: string; kind: "file"; resolvedPath: string; bytes: number; sha256: string };

export interface PdfProfileManifest {
  schema: "host-pdf-profile-v1";
  platform: string;
  architecture: string;
  executables: typeof PDF_EXECUTABLES;
  versions: Record<string, string>;
  linkedLibraries: Record<string, string[]>;
  resourceRoots: readonly string[];
  resources: PdfResource[];
  capabilities: {
    pdftotextHelp: { arguments: readonly ["-h"]; stdout: string; stderr: string };
    removeHyphens: "explicit-none" | "legacy-layout";
  };
  extraction: {
    infoArguments: readonly string[];
    textArguments: readonly string[];
    limitArguments: readonly string[];
    environment: Readonly<Record<string, string>>;
    fontconfig: string;
    limits: typeof PDF_LIMITS;
    inputName: "input.pdf";
    output: "stdout";
    markdown: "labelled-pages-dynamic-backtick-fences-v1";
  };
  limitations: readonly string[];
}

export interface PdfProfile {
  sha256: string;
  manifest: PdfProfileManifest;
}

const checkedProfiles = new WeakSet<object>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("PDF profile contains an unsupported value");
  return result;
}

function profileDigest(manifest: PdfProfileManifest): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}

function freezeDeep(value: object): void {
  for (const item of Object.values(value)) if (item && typeof item === "object") freezeDeep(item);
  Object.freeze(value);
}

/** Require an immutable profile captured or rechecked in this process; this does not rehash dependencies. */
export function requirePdfProfile(profile: PdfProfile): void {
  if (!profile || !checkedProfiles.has(profile)) throw new Error("Capture or assert the PDF profile before extraction");
}

/** Create a private workspace beneath the external data boundary, without inheriting process environment. */
export async function createPdfWorkspace(workspace: string): Promise<{ directory: string; env: NodeJS.ProcessEnv }> {
  if (typeof workspace !== "string" || !isAbsolute(workspace) || workspace.includes("\0"))
    throw new Error("PDF workspace must be an absolute external path");
  const root = resolve(workspace);
  const part = relative(DEFAULT_EXTERNAL_ROOT, root);
  if (part === ".." || part.startsWith("../") || isAbsolute(part))
    throw new Error("PDF workspace is outside the authorized external boundary");
  // Reject symlinks before normalization can erase a component followed by '..'.
  if (root !== workspace) throw new Error("PDF workspace must be normalized");
  await assertNoSymlinkPath(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(root);
  const directory = await mkdtemp(join(root, ".pdf-"));
  try {
    const env = Object.fromEntries(
      Object.entries(ENVIRONMENT).map(([key, value]) => [key, value.replace("$PRIVATE", directory)]),
    );
    for (const name of ["home", "cache", "config", "data", "config-dirs", "data-dirs", "tmp"])
      await mkdir(join(directory, name), { mode: 0o700 });
    await writeFile(join(directory, "fonts.conf"), FONTCONFIG, { flag: "wx", mode: 0o600 });
    return { directory, env };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** An error locator, never a container for raw native output. Evidence stays in the private directory. */
export class PdfEvidenceError extends Error {
  constructor(
    readonly reason: string,
    readonly evidenceDirectory: string,
    readonly evidenceComplete = true,
  ) {
    super(
      `${reason}; private PDF evidence: ${evidenceDirectory}${evidenceComplete ? "" : " (evidence persistence incomplete)"}`,
    );
    this.name = "PdfEvidenceError";
  }
}

/** Write bounded evidence with private permissions and without replacing an existing file. */
export async function writePdfEvidenceJson(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > PDF_LIMITS.infoBytes) throw new Error("PDF evidence metadata exceeds its byte limit");
  await assertNoSymlinkPath(path);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

/** Retain the owned context even if writing its failure receipt fails; report that limitation explicitly. */
export async function retainPdfFailure(
  directory: string,
  error: unknown,
  stage: string,
  contextComplete = true,
): Promise<PdfEvidenceError> {
  const reason = (
    error instanceof PdfEvidenceError ? error.reason : error instanceof Error ? error.message : "PDF operation failed"
  ).slice(0, 4096);
  let complete = contextComplete && (!(error instanceof PdfEvidenceError) || error.evidenceComplete);
  try {
    await writePdfEvidenceJson(join(directory, "failure.json"), {
      schema: "host-pdf-failure-v1",
      stage,
      reason,
      nativeEvidenceDirectory: error instanceof PdfEvidenceError ? error.evidenceDirectory : null,
      evidenceComplete: complete,
    });
  } catch {
    complete = false;
  }
  return new PdfEvidenceError(reason, directory, complete);
}

/**
 * Run a trusted executable with bounded pipes/rlimits, never a shell or a full security sandbox.
 * Persist bounded output and execution receipts on success and failure; the caller owns context cleanup.
 */
export async function runPdfNative(
  executable: string,
  args: readonly string[],
  context: { directory: string; env: NodeJS.ProcessEnv },
  maximumOutput = PDF_LIMITS.outputBytes,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  if (!(Object.values(PDF_EXECUTABLES) as string[]).includes(executable)) throw new Error("Untrusted PDF executable");
  if (!Number.isSafeInteger(maximumOutput) || maximumOutput < 0 || maximumOutput > PDF_LIMITS.outputBytes)
    throw new Error("Invalid PDF subprocess output bound");
  const evidenceDirectory = await mkdtemp(join(context.directory, "native-"));
  await writePdfEvidenceJson(join(evidenceDirectory, "invocation.json"), {
    schema: "host-pdf-native-invocation-v1",
    executable,
    arguments: args,
    cwd: context.directory,
    environment: context.env,
    limitArguments: LIMIT_ARGUMENTS,
    maximumOutput,
    maximumDiagnostics: PDF_LIMITS.diagnosticBytes,
    timeoutMs: PDF_LIMITS.timeoutMs,
  });
  return new Promise((resolveRun, reject) => {
    const child = spawn(PDF_EXECUTABLES.limits, [...LIMIT_ARGUMENTS, executable, ...args], {
      cwd: context.directory,
      env: context.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let errorSize = 0;
    let outputStored = 0;
    let errorStored = 0;
    let spawnError: { code: string | null; message: string } | null = null;
    let failure: Error | undefined;
    const fail = (message: string) => {
      failure ??= new Error(message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail("PDF subprocess exceeded its wall-time limit"), PDF_LIMITS.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      const retained = Math.min(chunk.length, maximumOutput - outputStored);
      if (retained > 0) stdout.push(Buffer.from(chunk.subarray(0, retained)));
      outputStored += retained;
      if (outputSize > maximumOutput) fail("PDF subprocess exceeded its output limit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorSize += chunk.length;
      const retained = Math.min(chunk.length, PDF_LIMITS.diagnosticBytes - errorStored);
      if (retained > 0) stderr.push(Buffer.from(chunk.subarray(0, retained)));
      errorStored += retained;
      if (errorSize > PDF_LIMITS.diagnosticBytes) fail("PDF subprocess exceeded its diagnostic limit");
    });
    child.stdout.on("error", () => fail("Unable to read PDF subprocess output"));
    child.stderr.on("error", () => fail("Unable to read PDF subprocess diagnostics"));
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = { code: error.code?.slice(0, 64) ?? null, message: error.message.slice(0, 4096) };
      failure ??= new Error("Unable to start trusted PDF subprocess");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (!failure && (code !== 0 || signal))
        failure = new Error("PDF subprocess rejected the input or exceeded a resource limit");
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      void (async () => {
        try {
          await assertNoSymlinkPath(evidenceDirectory);
          await writeFile(join(evidenceDirectory, "stdout"), result.stdout, { flag: "wx", mode: 0o600 });
          await writeFile(join(evidenceDirectory, "stderr"), result.stderr, { flag: "wx", mode: 0o600 });
          await writePdfEvidenceJson(join(evidenceDirectory, "result.json"), {
            schema: "host-pdf-native-result-v1",
            exitCode: code,
            signal,
            failure: failure?.message ?? null,
            spawnError,
            stdoutBytesSeen: outputSize,
            stderrBytesSeen: errorSize,
            stdoutBytesRetained: result.stdout.length,
            stderrBytesRetained: result.stderr.length,
            stdoutTruncated: outputSize > result.stdout.length,
            stderrTruncated: errorSize > result.stderr.length,
          });
          if (failure) reject(new PdfEvidenceError(failure.message, evidenceDirectory));
          else resolveRun(result);
        } catch {
          reject(
            new PdfEvidenceError(
              failure?.message ?? "Unable to persist PDF subprocess evidence",
              evidenceDirectory,
              false,
            ),
          );
        }
      })();
    });
  });
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Stream large font/library files; reject a dependency changed during hashing. */
async function hashFile(path: string, resolvedPath: string): Promise<PdfResource> {
  const beforePath = await stat(resolvedPath);
  const file = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || !sameFile(beforePath, before)) throw new Error(`PDF dependency changed: ${path}`);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > before.size) throw new Error(`PDF dependency grew while hashing: ${path}`);
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (bytes !== before.size || !sameFile(before, await file.stat()) || !sameFile(before, await stat(resolvedPath)))
      throw new Error(`PDF dependency changed while hashing: ${path}`);
    return { path, kind: "file", resolvedPath, bytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

async function inventory(paths: readonly string[]): Promise<PdfResource[]> {
  const entries = new Map<string, PdfResource>();
  const active = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (active.has(path)) throw new Error(`Cyclic PDF resource symlink: ${path}`);
    if (entries.has(path)) return;
    active.add(path);
    try {
      const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!before) {
        entries.set(path, { path, kind: "missing" });
      } else if (before.isSymbolicLink()) {
        const target = await readlink(path);
        const destination = resolve(path, "..", target);
        const resolvedPath = await realpath(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        entries.set(path, { path, kind: "symlink", target, resolvedPath });
        await visit(destination);
        if (target !== (await readlink(path))) throw new Error(`PDF resource symlink changed: ${path}`);
      } else if (before.isDirectory()) {
        const children = (await readdir(path)).sort();
        entries.set(path, { path, kind: "directory", resolvedPath: await realpath(path), entries: children });
        for (const name of children) await visit(join(path, name));
        if (canonical(children) !== canonical((await readdir(path)).sort()) || !sameFile(before, await lstat(path)))
          throw new Error(`PDF resource directory changed: ${path}`);
      } else if (before.isFile()) {
        entries.set(path, await hashFile(path, await realpath(path)));
        if (!sameFile(before, await lstat(path))) throw new Error(`PDF resource changed: ${path}`);
      } else throw new Error(`Unsupported PDF resource file type: ${path}`);
    } finally {
      active.delete(path);
    }
  }
  for (const path of [...new Set(paths)].sort()) await visit(path);
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function linkedPaths(output: Buffer): string[] {
  const result = new Set<string>();
  for (const line of output
    .toString("utf8")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (/^linux-vdso\.so\.\d+ \(0x[\da-f]+\)$/.test(line)) continue;
    const match = line.match(/^(?:\S+ => )?(\/\S+) \(0x[\da-f]+\)$/);
    if (!match?.[1]) throw new Error("Unresolved or unrecognized PDF linked library");
    result.add(match[1]);
  }
  if (!result.size) throw new Error("PDF linked library inventory is empty");
  return [...result].sort();
}

/**
 * Capture once per run, not per PDF. The optional workspace locates private temporary files.
 * Retain failed capture context and throw PdfEvidenceError; remove only successful capture context.
 */
export async function capturePdfProfile(workspace = join(DEFAULT_EXTERNAL_ROOT, "pdf-profile")): Promise<PdfProfile> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("PDF profile requires Linux x64");
  const context = await createPdfWorkspace(workspace);
  let stage = "profile-capture";
  try {
    const versions: Record<string, string> = {};
    const linkedLibraries: Record<string, string[]> = {};
    for (const executable of Object.values(PDF_EXECUTABLES)) {
      const version = await runPdfNative(
        executable,
        [executable === PDF_EXECUTABLES.info || executable === PDF_EXECUTABLES.text ? "-v" : "--version"],
        context,
        PDF_LIMITS.infoBytes,
      );
      versions[executable] = Buffer.concat([version.stdout, version.stderr]).toString("utf8").trim();
      if (!versions[executable] || versions[executable].includes("\ufffd")) throw new Error("Missing PDF tool version");
      if (executable !== PDF_EXECUTABLES.loader) {
        const libraries = await runPdfNative(
          PDF_EXECUTABLES.loader,
          ["--list", executable],
          context,
          PDF_LIMITS.infoBytes,
        );
        if (libraries.stderr.length) throw new Error("PDF loader emitted diagnostics");
        linkedLibraries[executable] = linkedPaths(libraries.stdout);
      }
    }
    const helpResult = await runPdfNative(PDF_EXECUTABLES.text, ["-h"], context, PDF_LIMITS.infoBytes);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const help = {
      arguments: ["-h"] as const,
      stdout: decoder.decode(helpResult.stdout),
      stderr: decoder.decode(helpResult.stderr),
    };
    const helpText = `${help.stdout}\n${help.stderr}`;
    if (!/^Usage:\s+pdftotext\b/m.test(helpText) || !/^\s+-layout\s/m.test(helpText))
      throw new Error("Unrecognized pdftotext capability help");
    const hyphenOption = helpText.match(/^\s+-remove-hyphens(?=\s|$)[^\r\n]*/m)?.[0];
    if (hyphenOption && !/\bnone\b/.test(hyphenOption))
      throw new Error("pdftotext does not advertise the required hyphen preservation mode");
    const removeHyphens = hyphenOption ? "explicit-none" : "legacy-layout";
    const textArguments = hyphenOption ? [...PDF_TEXT_ARGUMENTS, "-remove-hyphens", "none"] : [...PDF_TEXT_ARGUMENTS];
    const resources = await inventory([
      ...RESOURCE_ROOTS,
      ...Object.values(PDF_EXECUTABLES),
      ...Object.values(linkedLibraries).flat(),
    ]);
    const manifest: PdfProfileManifest = {
      schema: "host-pdf-profile-v1",
      platform: process.platform,
      architecture: process.arch,
      executables: PDF_EXECUTABLES,
      versions,
      linkedLibraries,
      resourceRoots: RESOURCE_ROOTS,
      resources,
      capabilities: { pdftotextHelp: help, removeHyphens },
      extraction: {
        infoArguments: PDF_INFO_ARGUMENTS,
        textArguments,
        limitArguments: LIMIT_ARGUMENTS,
        environment: ENVIRONMENT,
        fontconfig: FONTCONFIG,
        limits: PDF_LIMITS,
        inputName: "input.pdf",
        output: "stdout",
        markdown: "labelled-pages-dynamic-backtick-fences-v1",
      },
      limitations: [
        "Linux rlimits and pipe/time bounds are not a native-parser security sandbox or network isolation.",
        "This profile binds known executable, loader, linked-library, fontconfig/font and Poppler resource inputs, not the whole OS, kernel or CPU.",
        "System fontconfig configuration is inventoried conservatively; extraction uses the recorded isolated configuration without system includes or caches.",
        "Capture/recheck dependencies at run and publication boundaries; concurrent OS mutation is not made atomic.",
        "No OCR, image transcription, table reconstruction or guarantee of complete glyph mapping; Poppler layout text is not a PDF conformance proof.",
      ],
    };
    const profile = { sha256: profileDigest(manifest), manifest };
    freezeDeep(profile);
    stage = "profile-cleanup";
    await rm(context.directory, { recursive: true, force: true });
    checkedProfiles.add(profile);
    return profile;
  } catch (error) {
    throw await retainPdfFailure(context.directory, error, stage, stage !== "profile-cleanup");
  }
}

/** Rehash current native dependencies at a run/publication boundary and authorize this immutable profile. */
export async function assertPdfProfile(profile: PdfProfile, workspace?: string): Promise<void> {
  if (profile && typeof profile === "object") checkedProfiles.delete(profile);
  if (!profile || !/^[a-f\d]{64}$/.test(profile.sha256) || profileDigest(profile.manifest) !== profile.sha256)
    throw new Error("PDF profile digest is invalid");
  const current = await capturePdfProfile(workspace);
  if (current.sha256 !== profile.sha256) throw new Error("PDF dependency profile changed");
  freezeDeep(profile);
  checkedProfiles.add(profile);
}
