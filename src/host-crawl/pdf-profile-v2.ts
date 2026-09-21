import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdtemp, open, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createPdfWorkspace, PdfEvidenceError, writePdfEvidenceJson, type PdfResource } from "./pdf-profile.ts";
import { assertNoSymlinkPath } from "./public-validation.ts";

export const PDF_V2_EXECUTABLES = Object.freeze({
  info: "/usr/bin/pdfinfo",
  text: "/usr/bin/pdftotext",
  raster: "/usr/bin/pdftoppm",
  ocr: "/usr/bin/tesseract",
  limits: "/usr/bin/prlimit",
  loader: "/lib64/ld-linux-x86-64.so.2",
  node: process.execPath,
});

export const PDF_V2_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  outputBytes: 32 * 1024 * 1024,
  infoBytes: 1024 * 1024,
  diagnosticBytes: 256 * 1024,
  ocrOutputBytes: 8 * 1024 * 1024,
  rasterBytes: 32 * 1024 * 1024,
  temporaryBytes: 256 * 1024 * 1024,
  temporaryFiles: 4096,
  pages: 500,
  ocrPages: 50,
  rasterDpi: 200,
  pixelsPerPage: 24_000_000,
  totalOcrPixels: 240_000_000,
  timeoutMs: 30_000,
  addressSpaceBytes: 1024 * 1024 * 1024,
  cpuSeconds: 20,
  openFiles: 64,
});

export const PDF_V2_INFO_ARGUMENTS = Object.freeze(["-enc", "UTF-8", "-rawdates"]);
export const PDF_V2_TEXT_ARGUMENTS = Object.freeze(["-enc", "UTF-8", "-eol", "unix", "-r", "72"]);
export const PDF_V2_RASTER_ARGUMENTS = Object.freeze(["-singlefile", "-r", String(PDF_V2_LIMITS.rasterDpi), "-png"]);
export const PDF_V2_OCR_ARGUMENTS = Object.freeze([
  "-l",
  "eng",
  "--oem",
  "1",
  "--psm",
  "3",
  "--dpi",
  String(PDF_V2_LIMITS.rasterDpi),
  "tsv",
]);

const LIMIT_ARGUMENTS = Object.freeze([
  `--as=${PDF_V2_LIMITS.addressSpaceBytes}`,
  `--cpu=${PDF_V2_LIMITS.cpuSeconds}`,
  `--fsize=${PDF_V2_LIMITS.outputBytes}`,
  `--nofile=${PDF_V2_LIMITS.openFiles}`,
  "--core=0",
  "--",
]);
const TESSDATA_DIRECTORY = "/usr/share/tessdata";
const OCR_RESOURCES = Object.freeze([`${TESSDATA_DIRECTORY}/eng.traineddata`, `${TESSDATA_DIRECTORY}/configs/tsv`]);
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
  ...OCR_RESOURCES,
]);

export interface PdfV2ProfileManifest {
  schema: "host-pdf-profile-v2";
  platform: string;
  architecture: string;
  runtime: { executable: string; version: string; versions: NodeJS.ProcessVersions };
  executables: typeof PDF_V2_EXECUTABLES;
  versions: Record<string, string>;
  linkedLibraries: Record<string, string[]>;
  resourceRoots: readonly string[];
  resources: PdfResource[];
  ocrResources: readonly string[];
  extraction: {
    infoArguments: readonly string[];
    textArguments: readonly string[];
    textPageArguments: readonly ["-f", "$FIRST_PAGE", "-l", "$LAST_PAGE"];
    rasterArguments: readonly string[];
    rasterPageArguments: readonly ["-f", "$PAGE", "-l", "$PAGE"];
    ocrArguments: readonly string[];
    limitArguments: readonly string[];
    environment: Readonly<Record<string, string>>;
    fontconfigSha256: string;
    limits: typeof PDF_V2_LIMITS;
    inputName: "input.pdf";
    nativePageBoundary: "form-feed";
    ocrFormat: "tsv";
    lineOrder: "tesseract-block-paragraph-line-word-v1";
    markdown: "labelled-pages-dynamic-backtick-fences-v2";
  };
  limitations: readonly string[];
}

export interface PdfV2Profile {
  sha256: string;
  manifest: PdfV2ProfileManifest;
}

export interface PdfV2Context {
  directory: string;
  env: NodeJS.ProcessEnv;
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
  if (result === undefined) throw new Error("PDF v2 profile contains an unsupported value");
  return result;
}

function profileDigest(manifest: PdfV2ProfileManifest): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}

function freezeDeep(value: object): void {
  for (const item of Object.values(value)) if (item && typeof item === "object") freezeDeep(item);
  Object.freeze(value);
}

/** Require an immutable v2 profile captured or rechecked in this process. */
export function requirePdfV2Profile(profile: PdfV2Profile): void {
  if (!profile || !checkedProfiles.has(profile))
    throw new Error("Capture or assert the PDF v2 profile before extraction");
}

/** Create the isolated v2 environment with one authenticated English tessdata root. */
export async function createPdfV2Workspace(workspace: string): Promise<PdfV2Context> {
  const context = await createPdfWorkspace(workspace);
  return {
    directory: context.directory,
    env: { ...context.env, OMP_THREAD_LIMIT: "1", TESSDATA_PREFIX: TESSDATA_DIRECTORY },
  };
}

export async function retainPdfV2Failure(
  directory: string,
  error: unknown,
  stage: string,
  contextComplete = true,
): Promise<PdfEvidenceError> {
  const reason = (
    error instanceof PdfEvidenceError
      ? error.reason
      : error instanceof Error
        ? error.message
        : "PDF v2 operation failed"
  ).slice(0, 4096);
  let complete = contextComplete && (!(error instanceof PdfEvidenceError) || error.evidenceComplete);
  try {
    await writePdfEvidenceJson(join(directory, "failure.json"), {
      schema: "host-pdf-failure-v2",
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

/** Run one authenticated v2 tool under fixed wall-time, rlimit and pipe bounds. */
export async function runPdfV2Native(
  executable: string,
  args: readonly string[],
  context: PdfV2Context,
  maximumOutput = PDF_V2_LIMITS.outputBytes,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  if (!(Object.values(PDF_V2_EXECUTABLES) as string[]).includes(executable))
    throw new Error("Untrusted PDF v2 executable");
  if (!Number.isSafeInteger(maximumOutput) || maximumOutput < 0 || maximumOutput > PDF_V2_LIMITS.outputBytes)
    throw new Error("Invalid PDF v2 subprocess output bound");
  const evidenceDirectory = await mkdtemp(join(context.directory, "native-v2-"));
  await writePdfEvidenceJson(join(evidenceDirectory, "invocation.json"), {
    schema: "host-pdf-native-invocation-v2",
    executable,
    arguments: args,
    cwd: context.directory,
    environment: context.env,
    limitArguments: LIMIT_ARGUMENTS,
    maximumOutput,
    maximumDiagnostics: PDF_V2_LIMITS.diagnosticBytes,
    timeoutMs: PDF_V2_LIMITS.timeoutMs,
  });
  return new Promise((resolveRun, reject) => {
    const child = spawn(PDF_V2_EXECUTABLES.limits, [...LIMIT_ARGUMENTS, executable, ...args], {
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
    const timer = setTimeout(() => fail("PDF v2 subprocess exceeded its wall-time limit"), PDF_V2_LIMITS.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      const retained = Math.min(chunk.length, maximumOutput - outputStored);
      if (retained > 0) stdout.push(Buffer.from(chunk.subarray(0, retained)));
      outputStored += retained;
      if (outputSize > maximumOutput) fail("PDF v2 subprocess exceeded its output limit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorSize += chunk.length;
      const retained = Math.min(chunk.length, PDF_V2_LIMITS.diagnosticBytes - errorStored);
      if (retained > 0) stderr.push(Buffer.from(chunk.subarray(0, retained)));
      errorStored += retained;
      if (errorSize > PDF_V2_LIMITS.diagnosticBytes) fail("PDF v2 subprocess exceeded its diagnostic limit");
    });
    child.stdout.on("error", () => fail("Unable to read PDF v2 subprocess output"));
    child.stderr.on("error", () => fail("Unable to read PDF v2 subprocess diagnostics"));
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = { code: error.code?.slice(0, 64) ?? null, message: error.message.slice(0, 4096) };
      failure ??= new Error("Unable to start trusted PDF v2 subprocess");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (!failure && (code !== 0 || signal))
        failure = new Error("PDF v2 subprocess rejected the input or exceeded a resource limit");
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      void (async () => {
        try {
          await assertNoSymlinkPath(evidenceDirectory);
          await writeFile(join(evidenceDirectory, "stdout"), result.stdout, { flag: "wx", mode: 0o600 });
          await writeFile(join(evidenceDirectory, "stderr"), result.stderr, { flag: "wx", mode: 0o600 });
          await writePdfEvidenceJson(join(evidenceDirectory, "result.json"), {
            schema: "host-pdf-native-result-v2",
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
              failure?.message ?? "Unable to persist PDF v2 subprocess evidence",
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

async function hashFile(path: string, resolvedPath: string): Promise<PdfResource> {
  const beforePath = await stat(resolvedPath);
  const file = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || !sameFile(beforePath, before)) throw new Error(`PDF v2 dependency changed: ${path}`);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > before.size) throw new Error(`PDF v2 dependency grew while hashing: ${path}`);
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (bytes !== before.size || !sameFile(before, await file.stat()) || !sameFile(before, await stat(resolvedPath)))
      throw new Error(`PDF v2 dependency changed while hashing: ${path}`);
    return { path, kind: "file", resolvedPath, bytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

async function inventory(paths: readonly string[]): Promise<PdfResource[]> {
  const entries = new Map<string, PdfResource>();
  const active = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (active.has(path)) throw new Error(`Cyclic PDF v2 resource symlink: ${path}`);
    if (entries.has(path)) return;
    active.add(path);
    try {
      const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!before) entries.set(path, { path, kind: "missing" });
      else if (before.isSymbolicLink()) {
        const target = await readlink(path);
        const destination = resolve(path, "..", target);
        const resolvedPath = await realpath(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        entries.set(path, { path, kind: "symlink", target, resolvedPath });
        await visit(destination);
        if (target !== (await readlink(path))) throw new Error(`PDF v2 resource symlink changed: ${path}`);
      } else if (before.isDirectory()) {
        const children = (await readdir(path)).sort();
        entries.set(path, { path, kind: "directory", resolvedPath: await realpath(path), entries: children });
        for (const name of children) await visit(join(path, name));
        if (canonical(children) !== canonical((await readdir(path)).sort()) || !sameFile(before, await lstat(path)))
          throw new Error(`PDF v2 resource directory changed: ${path}`);
      } else if (before.isFile()) {
        entries.set(path, await hashFile(path, await realpath(path)));
        if (!sameFile(before, await lstat(path))) throw new Error(`PDF v2 resource changed: ${path}`);
      } else throw new Error(`Unsupported PDF v2 resource file type: ${path}`);
    } finally {
      active.delete(path);
    }
  }
  for (const path of [...new Set(paths)].sort()) await visit(path);
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
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
    if (!match?.[1]) throw new Error("Unresolved or unrecognized PDF v2 linked library");
    result.add(match[1]);
  }
  if (!result.size) throw new Error("PDF v2 linked library inventory is empty");
  return [...result].sort();
}

async function captureProfile(workspace: string): Promise<PdfV2Profile> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("PDF v2 profile requires Linux x64");
  for (const executable of Object.values(PDF_V2_EXECUTABLES)) {
    if (!isAbsolute(executable)) throw new Error("PDF v2 executables must use absolute paths");
  }
  const context = await createPdfV2Workspace(workspace);
  let stage = "profile-capture";
  try {
    const versions: Record<string, string> = {};
    const linkedLibraries: Record<string, string[]> = {};
    for (const [name, executable] of Object.entries(PDF_V2_EXECUTABLES)) {
      const versionArguments = ["info", "text", "raster"].includes(name) ? ["-v"] : ["--version"];
      const version = await runPdfV2Native(executable, versionArguments, context, PDF_V2_LIMITS.infoBytes);
      versions[executable] = Buffer.concat([version.stdout, version.stderr]).toString("utf8").trim();
      if (!versions[executable] || versions[executable].includes("\ufffd"))
        throw new Error("Missing PDF v2 tool version");
      if (executable !== PDF_V2_EXECUTABLES.loader) {
        const libraries = await runPdfV2Native(
          PDF_V2_EXECUTABLES.loader,
          ["--list", executable],
          context,
          PDF_V2_LIMITS.infoBytes,
        );
        if (libraries.stderr.length) throw new Error("PDF v2 loader emitted diagnostics");
        linkedLibraries[executable] = linkedPaths(libraries.stdout);
      }
    }
    const fontconfigSha256 = createHash("sha256")
      .update(await readFile(join(context.directory, "fonts.conf")))
      .digest("hex");
    const environment = { ...context.env } as Record<string, string>;
    for (const [key, value] of Object.entries(environment))
      environment[key] = value.replace(context.directory, "$PRIVATE");
    const resources = await inventory([
      ...RESOURCE_ROOTS,
      ...Object.values(PDF_V2_EXECUTABLES),
      ...Object.values(linkedLibraries).flat(),
    ]);
    for (const resource of OCR_RESOURCES) {
      if (!resources.some((entry) => entry.path === resource && entry.kind === "file"))
        throw new Error(`Required PDF v2 OCR resource is unavailable: ${resource}`);
    }
    const manifest: PdfV2ProfileManifest = {
      schema: "host-pdf-profile-v2",
      platform: process.platform,
      architecture: process.arch,
      runtime: { executable: process.execPath, version: process.version, versions: { ...process.versions } },
      executables: PDF_V2_EXECUTABLES,
      versions,
      linkedLibraries,
      resourceRoots: RESOURCE_ROOTS,
      resources,
      ocrResources: OCR_RESOURCES,
      extraction: {
        infoArguments: PDF_V2_INFO_ARGUMENTS,
        textArguments: PDF_V2_TEXT_ARGUMENTS,
        textPageArguments: ["-f", "$FIRST_PAGE", "-l", "$LAST_PAGE"],
        rasterArguments: PDF_V2_RASTER_ARGUMENTS,
        rasterPageArguments: ["-f", "$PAGE", "-l", "$PAGE"],
        ocrArguments: PDF_V2_OCR_ARGUMENTS,
        limitArguments: LIMIT_ARGUMENTS,
        environment,
        fontconfigSha256,
        limits: PDF_V2_LIMITS,
        inputName: "input.pdf",
        nativePageBoundary: "form-feed",
        ocrFormat: "tsv",
        lineOrder: "tesseract-block-paragraph-line-word-v1",
        markdown: "labelled-pages-dynamic-backtick-fences-v2",
      },
      limitations: [
        "Linux rlimits and bounded pipes, files and wall time are not a native-parser security sandbox or network isolation.",
        "The profile binds selected executables, loader, linked libraries, Poppler/font resources, Node runtime and exact English OCR resources, not the whole OS, kernel or CPU.",
        "OCR is fixed to English and may omit, misread or reorder text; it does not infer tables or document structure.",
        "Poppler and Tesseract process page rendering only; PDF actions, attachments and links are never requested or followed.",
      ],
    };
    const profile = { sha256: profileDigest(manifest), manifest };
    freezeDeep(profile);
    stage = "profile-cleanup";
    await rm(context.directory, { recursive: true, force: true });
    checkedProfiles.add(profile);
    return profile;
  } catch (error) {
    throw await retainPdfV2Failure(context.directory, error, stage, stage !== "profile-cleanup");
  }
}

/** Capture the authenticated reading-order/OCR profile without changing the v1 profile serializer. */
export async function capturePdfV2Profile(workspace: string): Promise<PdfV2Profile> {
  return captureProfile(workspace);
}

/** Rehash all v2 dependencies and authorize a deserialized profile for extraction. */
export async function assertPdfV2Profile(profile: PdfV2Profile, workspace: string): Promise<void> {
  if (profile && typeof profile === "object") checkedProfiles.delete(profile);
  if (!profile || !/^[a-f\d]{64}$/.test(profile.sha256) || profileDigest(profile.manifest) !== profile.sha256)
    throw new Error("PDF v2 profile digest is invalid");
  const current = await captureProfile(workspace);
  if (current.sha256 !== profile.sha256) throw new Error("PDF v2 dependency profile changed");
  freezeDeep(profile);
  checkedProfiles.add(profile);
}
