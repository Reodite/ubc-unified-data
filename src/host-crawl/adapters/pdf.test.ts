import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import MarkdownIt from "markdown-it";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTERNAL_ROOT } from "../paths.ts";
import {
  capturePdfProfile,
  PDF_EXECUTABLES,
  PDF_LIMITS,
  PDF_TEXT_ARGUMENTS,
  PdfEvidenceError,
  requirePdfProfile,
  runPdfNative,
} from "../pdf-profile.ts";
import { readRegularFile } from "../public-validation.ts";
import { extractPdf } from "./pdf.ts";

vi.mock("../pdf-profile.ts", async (original) => {
  const module = await original<typeof import("../pdf-profile.ts")>();
  return {
    ...module,
    runPdfNative: vi.fn(module.runPdfNative),
    requirePdfProfile: vi.fn(module.requirePdfProfile),
  };
});

const native = await vi.importActual<typeof import("../pdf-profile.ts")>("../pdf-profile.ts");
const testRoot = join(DEFAULT_EXTERNAL_ROOT, "test-pdf-native");
await mkdir(testRoot, { recursive: true, mode: 0o700 });
const workspace = await mkdtemp(join(testRoot, ".suite-"));
// Dependency hashing is fixture readiness, outside ordinary test/hook deadlines and never per document.
const readinessStart = performance.now();
const profile = await capturePdfProfile(workspace);
console.info(
  `PDF native fixture readiness: ${((performance.now() - readinessStart) / 1000).toFixed(3)}s; ${profile.manifest.resources.length} resources`,
);

let failed = false;
afterEach((context) => {
  if (context.task.result?.state === "fail") failed = true;
});
afterAll(async () => {
  if (failed) console.error(`Preserved PDF fixture: ${workspace}`);
  else await rm(workspace, { recursive: true, force: true });
});
beforeEach(() => {
  vi.mocked(runPdfNative).mockReset().mockImplementation(native.runPdfNative);
  vi.mocked(requirePdfProfile).mockReset().mockImplementation(native.requirePdfProfile);
});

function literal(text: string): string {
  return `(${text
    .replace(/([\\()])/g, "\\$1")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")})`;
}

function md5(bytes: Uint8Array): Buffer {
  return createHash("md5").update(bytes).digest();
}

function rc4(key: Uint8Array, bytes: Uint8Array): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  let i = 0;
  j = 0;
  return Buffer.from(
    bytes.map((byte) => {
      i = (i + 1) & 255;
      j = (j + state[i]!) & 255;
      [state[i], state[j]] = [state[j]!, state[i]!];
      return byte ^ state[(state[i]! + state[j]!) & 255]!;
    }),
  );
}

/** Build complete synthetic PDFs, including valid xrefs and optional Standard R2 encryption. */
function makePdf(
  options: {
    pages?: string[];
    streams?: string[];
    title?: string;
    encrypted?: boolean;
    actionScript?: string;
    actionUri?: string;
  } = {},
): Buffer {
  const streams =
    options.streams ??
    (options.pages ?? ["Co-op source text"]).map((text) =>
      text ? `BT /F1 12 Tf 72 720 Td ${literal(text)} Tj ET\n` : "",
    );
  const objects = new Map<number, Buffer>();
  const put = (id: number, text: string) => objects.set(id, Buffer.from(text, "latin1"));
  const padding = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
  const fileId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const ownerPad = Buffer.concat([Buffer.from("owner"), padding]).subarray(0, 32);
  const owner = rc4(md5(ownerPad).subarray(0, 5), padding);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = md5(Buffer.concat([padding, owner, permissions, fileId])).subarray(0, 5);
  const encrypt = (id: number, bytes: Buffer) => {
    if (!options.encrypted) return bytes;
    const objectNumber = Buffer.alloc(5);
    objectNumber.writeUIntLE(id, 0, 3);
    return rc4(md5(Buffer.concat([key, objectNumber])).subarray(0, 10), bytes);
  };
  put(
    1,
    `<< /Type /Catalog /Pages 2 0 R ${options.actionScript ? `/OpenAction << /S /Launch /F ${literal(options.actionScript)} >>` : ""} >>`,
  );
  put(
    2,
    `<< /Type /Pages /Count ${streams.length} /Kids [${streams.map((_, index) => `${5 + index * 2} 0 R`).join(" ")}] >>`,
  );
  put(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const title =
    options.title === undefined
      ? undefined
      : Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(options.title, "utf16le").swap16()]);
  put(4, title ? `<< /Title <${encrypt(4, title).toString("hex")}> >>` : "<< >>");
  streams.forEach((stream, index) => {
    const id = 5 + index * 2;
    const annotation = options.actionUri
      ? `/Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 30 30] /A << /S /URI /URI ${literal(options.actionUri)} >> >>] /AA << /O << /S /JavaScript /JS ${literal(`app.launchURL('${options.actionUri}')`)} >> >>`
      : "";
    put(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R ${annotation} >>`,
    );
    const bytes = encrypt(id + 1, Buffer.from(stream, "latin1"));
    objects.set(
      id + 1,
      Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from("\nendstream")]),
    );
  });
  let encryption = "";
  if (options.encrypted) {
    const id = objects.size + 1;
    put(
      id,
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${rc4(key, padding).toString("hex")}> /P -4 >>`,
    );
    encryption = `/Encrypt ${id} 0 R /ID [<${fileId.toString("hex")}><${fileId.toString("hex")}>]`;
  }
  const chunks = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [0];
  let length = chunks[0]!.length;
  for (const [id, bytes] of objects) {
    offsets[id] = length;
    const object = Buffer.concat([Buffer.from(`${id} 0 obj\n`), bytes, Buffer.from("\nendobj\n")]);
    chunks.push(object);
    length += object.length;
  }
  const xref = `xref\n0 ${objects.size + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.size + 1} /Root 1 0 R /Info 4 0 R ${encryption} >>\nstartxref\n${length}\n%%EOF\n`;
  return Buffer.concat([...chunks, Buffer.from(xref)]);
}

const sourceUrl = "https://coop.ubc.ca/guides/Co-op%20guide.pdf?download=1";
function extract(bytes = makePdf(), url = sourceUrl) {
  return extractPdf({ bytes, sourceUrl: url, workspace, profile });
}
function mockOutput(text: string | Buffer, info = "Title: Source title\nPages: 1\nEncrypted: no\n") {
  vi.mocked(runPdfNative)
    .mockResolvedValueOnce({ stdout: Buffer.from(info), stderr: Buffer.alloc(0) })
    .mockResolvedValueOnce({ stdout: Buffer.from(text), stderr: Buffer.alloc(0) });
}

async function expectedFailure(bytes: Buffer): Promise<PdfEvidenceError> {
  try {
    await extract(bytes);
  } catch (error) {
    if (error instanceof PdfEvidenceError) return error;
    throw error;
  }
  throw new Error("Expected PDF extraction to fail");
}

async function evidenceJson(directory: string, name: string) {
  return JSON.parse((await readRegularFile(join(directory, name))).toString("utf8"));
}

async function nativeEvidence(directory: string) {
  const entries = (await readdir(directory)).filter((name) => name.startsWith("native-"));
  return Promise.all(
    entries.map(async (name) => {
      const path = join(directory, name);
      return {
        path,
        invocation: await evidenceJson(path, "invocation.json"),
        result: await evidenceJson(path, "result.json"),
      };
    }),
  );
}

describe("PDF extraction contracts", () => {
  it.each([true, false])("executes exactly the profile arguments (hyphen option available: %s)", async (available) => {
    const selected = structuredClone(profile);
    selected.manifest.capabilities.removeHyphens = available ? "explicit-none" : "legacy-layout";
    selected.manifest.extraction.textArguments = available
      ? [...PDF_TEXT_ARGUMENTS, "-remove-hyphens", "none"]
      : [...PDF_TEXT_ARGUMENTS];
    // This synthetic argument-delivery test does not invoke the native parser with an altered profile.
    vi.mocked(requirePdfProfile).mockImplementationOnce(() => {});
    mockOutput("co-\noperation\f");
    await extractPdf({ bytes: makePdf(), sourceUrl, workspace, profile: selected });
    const call = vi.mocked(runPdfNative).mock.calls.find(([executable]) => executable === PDF_EXECUTABLES.text)!;
    expect(call[1]).toEqual([...selected.manifest.extraction.textArguments, "input.pdf", "-"]);
    expect(call[1].includes("-remove-hyphens")).toBe(available);
  });
  it("keeps source markup inert and preserves exact spaces and page boundaries", async () => {
    const page =
      "Left       Right\n<script>alert(1)</script>\n![image](https://example.invalid/a)\n`````\n[link](javascript:alert(1))\n";
    mockOutput(`${page}\fsecond page\n\f`, "Title: Source title\nPages: 2\nEncrypted: no\n");
    const result = await extract();
    expect(result.pageCount).toBe(2);
    expect(result.title).toBe("Source title");
    expect(result.markdown).toContain(`\`\`\`\`\`\`text\n${page}\`\`\`\`\`\``);
    expect(result.markdown).toContain("## Page 2");
    const rendered = new MarkdownIt({ html: true, linkify: true }).render(result.markdown);
    expect(rendered).not.toMatch(/<(?:script|img|a)\b/);
    expect(rendered).toContain("&lt;script&gt;");
  });

  it("uses a deterministic URL title rather than publishing unsafe metadata", async () => {
    mockOutput("source text\f", "Title: <script>unsafe title</script>\nPages: 1\nEncrypted: no\n");
    const result = await extract();
    expect(result.title).toBe("Co-op guide.pdf");
    expect(result.warnings.join(" ")).toContain("metadata title is unsafe");
  });

  it("warns about empty pages and unmapped glyphs without dropping those page sections", async () => {
    mockOutput("source text\f\f\ufffd\ue000\f", "Pages: 3\nEncrypted: no\n");
    const result = await extract();
    expect(result.title).toBe("Co-op guide.pdf");
    expect(result.markdown).toContain("## Page 2\n\n```text\n\n```");
    expect(result.markdown).toContain("## Page 3");
    expect(result.warnings.join("\n")).toMatch(/Page 2:.*blank, image-only or unmapped/);
    expect(result.warnings.join("\n")).toMatch(/Page 3: replacement or private-use glyphs/);
    expect(result.markdown).toContain("\\u{fffd}");
    expect(result.markdown).not.toContain("\ufffd");
  });

  it("makes control and bidi-formatting characters visible with explicit warnings", async () => {
    mockOutput("source\u0000\u202e text\f");
    const result = await extract();
    expect(result.markdown).toContain("source\\u{0}\\u{202e} text");
    expect(result.warnings.join(" ")).toContain("Unicode escapes");
    expect(result.markdown).not.toContain("\u202e");
  });

  it.each(["", "\f", "\ufffd\ue000\f", "text without page break", "text\fextra", "text\fextra\f"])(
    "rejects empty, unusable or inconsistent native page output %#",
    async (text) => {
      mockOutput(text);
      await expect(extract()).rejects.toThrow(/no usable mapped text|page boundaries disagree/);
    },
  );

  it.each([
    "Pages: 0\nEncrypted: no\n",
    "Pages: 501\nEncrypted: no\n",
    "Pages: 1.5\nEncrypted: no\n",
    "Pages: 1\nPages: 1\nEncrypted: no\n",
    "Pages: 1\n",
    "Pages: 1\nEncrypted: yes (print:yes)\n",
  ])("rejects invalid, ambiguous or encrypted metadata %#", async (info) => {
    mockOutput("text\f", info);
    await expect(extract()).rejects.toThrow(/page count|ambiguous|missing|Encrypted/);
    expect(runPdfNative).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid UTF-8 and diagnostics even when the parser exits successfully", async () => {
    mockOutput(Buffer.from([0xff, 0x0c]));
    await expect(extract()).rejects.toThrow("valid UTF-8");
    vi.mocked(runPdfNative).mockResolvedValueOnce({
      stdout: Buffer.from("Pages: 1\nEncrypted: no\n"),
      stderr: Buffer.from("Syntax Warning: private repair detail"),
    });
    await expect(extract()).rejects.toThrow("metadata parser emitted diagnostics");
    vi.mocked(runPdfNative)
      .mockResolvedValueOnce({ stdout: Buffer.from("Pages: 1\nEncrypted: no\n"), stderr: Buffer.alloc(0) })
      .mockResolvedValueOnce({
        stdout: Buffer.from("partial\f"),
        stderr: Buffer.from("Syntax Error: private repair detail"),
      });
    await expect(extract()).rejects.toThrow("text parser emitted diagnostics");
  });

  it("bounds input and validates signature, final EOF and xref before native execution", async () => {
    const valid = makePdf();
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("not PDF"),
      valid.subarray(0, valid.length - 10),
      Buffer.from(valid.toString("latin1").replace(/startxref\n\d+/, "startxref\n1"), "latin1"),
      new Uint8Array(PDF_LIMITS.inputBytes + 1),
    ]) {
      await expect(extractPdf({ bytes, sourceUrl, workspace, profile })).rejects.toThrow(
        /input|signature|truncated|cross-reference/,
      );
    }
    expect(runPdfNative).not.toHaveBeenCalled();
  });

  it("rejects Markdown expansion beyond the output bound without returning a prefix", async () => {
    mockOutput(`${"`".repeat(Math.ceil(PDF_LIMITS.outputBytes / 3))}\f`);
    await expect(extract()).rejects.toThrow("Markdown exceeds its output limit");
  });

  it("does not use source strings as native arguments or accept unverified profiles", async () => {
    mockOutput("text\f");
    await extract(makePdf(), "https://coop.ubc.ca/--opw=secret.pdf?args=-q");
    for (const call of vi.mocked(runPdfNative).mock.calls) {
      expect(call[1]).toContain("input.pdf");
      expect(call[1].join(" ")).not.toContain("secret");
      expect(call[1]).not.toContain("-q");
    }
    await expect(
      extractPdf({ bytes: makePdf(), sourceUrl, workspace, profile: structuredClone(profile) }),
    ).rejects.toThrow("Capture or assert");
    await expect(extract(makePdf(), "file:///tmp/source.pdf")).rejects.toThrow("HTTP URL");
  });
});

describe("actual Poppler synthetic PDFs", () => {
  it("binds current native help and preserves line-end hyphens with the selected arguments", async () => {
    const capability = profile.manifest.capabilities;
    const help = `${capability.pdftotextHelp.stdout}\n${capability.pdftotextHelp.stderr}`;
    const available = /^\s+-remove-hyphens\s/m.test(help);
    expect(capability.pdftotextHelp.arguments).toEqual(["-h"]);
    expect(help).toMatch(/^Usage:\s+pdftotext\b/m);
    expect(capability.removeHyphens).toBe(available ? "explicit-none" : "legacy-layout");
    expect(profile.manifest.extraction.textArguments).toEqual(
      available ? [...PDF_TEXT_ARGUMENTS, "-remove-hyphens", "none"] : [...PDF_TEXT_ARGUMENTS],
    );
    if (/pdftotext version 26\.08\b/.test(profile.manifest.versions[PDF_EXECUTABLES.text]!))
      expect(available).toBe(true);
    const result = await extract(
      makePdf({ streams: ["BT /F1 12 Tf 72 720 Td (co-) Tj 0 -14 Td (operation) Tj ET\n"] }),
    );
    expect(result.markdown).toMatch(/co-[ \t]*\noperation/);
    const call = vi.mocked(runPdfNative).mock.calls.find(([executable]) => executable === PDF_EXECUTABLES.text)!;
    expect(call[1]).toEqual([...profile.manifest.extraction.textArguments, "input.pdf", "-"]);
  });

  it("extracts native pages, deterministic Unicode metadata and faithful two-column spacing", async () => {
    const before = (await readdir(workspace)).sort();
    const bytes = makePdf({
      title: "Co-op – Étudiant",
      streams: [
        "BT /F1 12 Tf 72 720 Td (Left column) Tj 240 0 Td (Right column) Tj ET\n",
        "BT /F1 12 Tf 72 720 Td (Second page source) Tj ET\n",
      ],
    });
    const result = await extract(bytes);
    expect(result.title).toBe("Co-op – Étudiant");
    expect(result.pageCount).toBe(2);
    expect(result.markdown).toMatch(/Left column {3,}Right column/);
    expect(result.markdown).toContain("Second page source");
    expect(result.warnings.join(" ")).toContain("no OCR");
    expect((await readdir(workspace)).sort()).toEqual(before);
  });

  it("reproduces native extraction under conflicting locale/timezone/fontconfig variables", async () => {
    const bytes = makePdf({
      title: "Source title",
      pages: ["Literal ``` <script> [link](file:///not-read)"],
    });
    const first = await extract(bytes);
    vi.stubEnv("LC_ALL", "fr_CA.UTF-8");
    vi.stubEnv("LANG", "zh_CN.UTF-8");
    vi.stubEnv("TZ", "Pacific/Honolulu");
    vi.stubEnv("FONTCONFIG_FILE", "/not-a-font-config");
    vi.stubEnv("LD_PRELOAD", "/not-a-library");
    try {
      expect(await extract(bytes)).toEqual(first);
    } finally {
      vi.unstubAllEnvs();
    }
    const rendered = new MarkdownIt({ html: true }).render(first.markdown);
    expect(rendered).not.toMatch(/<(?:script|a)\b/);
  });

  it("rejects a genuine empty-password encrypted PDF", async () => {
    await expect(
      extract(makePdf({ encrypted: true, title: "Encrypted title", pages: ["Encrypted source"] })),
    ).rejects.toThrow("Encrypted PDF extraction");
  });

  it("retains malformed-stream diagnostics and exact input instead of accepting partial text", async () => {
    const bytes = makePdf({ streams: ["BT /F1 12 Tf 72 720 Td (unclosed literal Tj ET\n"] });
    const error = await expectedFailure(bytes);
    expect(error.reason).toMatch(/parser emitted diagnostics|subprocess rejected/);
    expect(error.message).toContain(error.evidenceDirectory);
    expect(error.evidenceDirectory.startsWith(`${workspace}/.pdf-`)).toBe(true);
    expect(error.evidenceComplete).toBe(true);
    expect(await readRegularFile(join(error.evidenceDirectory, "input.pdf"))).toEqual(bytes);
    expect((await lstat(error.evidenceDirectory)).mode & 0o777).toBe(0o700);
    for (const name of ["input.pdf", "context.json", "failure.json", "fonts.conf"])
      expect((await lstat(join(error.evidenceDirectory, name))).mode & 0o777).toBe(0o600);
    expect(await evidenceJson(error.evidenceDirectory, "context.json")).toMatchObject({
      sourceUrl,
      profileSha256: profile.sha256,
      inputBytes: bytes.length,
      text: { arguments: [...profile.manifest.extraction.textArguments, "input.pdf", "-"] },
    });
    const receipts = await nativeEvidence(error.evidenceDirectory);
    expect(receipts).toHaveLength(2);
    const text = receipts.find((row) => row.invocation.executable === PDF_EXECUTABLES.text)!;
    const diagnostics = await readRegularFile(join(text.path, "stderr"));
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.length).toBeLessThanOrEqual(PDF_LIMITS.diagnosticBytes);
    expect(text.result).toMatchObject({ stderrBytesRetained: diagnostics.length, stderrTruncated: false });
    expect(error.message).not.toContain("Syntax Error:");
    expect(JSON.stringify(error)).not.toContain("Syntax Error:");
  });

  it("retains native nonzero exit evidence without disclosing parser diagnostics in the error", async () => {
    const bytes = Buffer.from(makePdf().toString("latin1").replace("/Root 1 0 R", "/Root 999 0 R"), "latin1");
    const error = await expectedFailure(bytes);
    expect(error.reason).toContain("subprocess rejected");
    const receipt = (await nativeEvidence(error.evidenceDirectory))[0]!;
    expect(receipt.result.exitCode).not.toBe(0);
    expect(receipt.result.stderrBytesRetained).toBeGreaterThan(0);
    expect((await readRegularFile(join(receipt.path, "stderr"))).length).toBe(receipt.result.stderrBytesRetained);
    expect(await evidenceJson(error.evidenceDirectory, "failure.json")).toMatchObject({
      stage: "metadata",
      nativeEvidenceDirectory: receipt.path,
      evidenceComplete: true,
    });
    expect(error.message).not.toContain("Syntax Error:");
  });

  it("retains evidence for input validation and image-only semantic rejection", async () => {
    const invalid = Buffer.from("invalid PDF signature");
    const invalidError = await expectedFailure(invalid);
    expect(await readRegularFile(join(invalidError.evidenceDirectory, "input.pdf"))).toEqual(invalid);
    expect(await evidenceJson(invalidError.evidenceDirectory, "failure.json")).toMatchObject({
      stage: "input-validation",
    });
    expect(await nativeEvidence(invalidError.evidenceDirectory)).toEqual([]);
    const blankError = await expectedFailure(makePdf({ pages: [""] }));
    const text = (await nativeEvidence(blankError.evidenceDirectory)).find(
      (row) => row.invocation.executable === PDF_EXECUTABLES.text,
    )!;
    expect(text.result).toMatchObject({ exitCode: 0, failure: null, stdoutTruncated: false });
    expect((await readRegularFile(join(text.path, "stdout"))).toString()).toContain("\f");
    expect(await evidenceJson(blankError.evidenceDirectory, "failure.json")).toMatchObject({
      stage: "markdown",
      evidenceComplete: true,
    });
  });

  it("rejects wholly image-only PDFs and reports mixed empty/image pages", async () => {
    const image = "q 10 0 0 10 50 50 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\0\0 EI Q\n";
    await expect(extract(makePdf({ streams: [image] }))).rejects.toThrow("no usable mapped text");
    const result = await extract(makePdf({ streams: ["BT /F1 12 Tf 72 720 Td (Useful source) Tj ET\n", image, ""] }));
    expect(result.pageCount).toBe(3);
    expect(result.warnings.join("\n")).toMatch(/Page 2:.*image-only/);
    expect(result.warnings.join("\n")).toMatch(/Page 3:.*blank/);
    await expect(extract(makePdf({ pages: [""] }))).rejects.toThrow("no usable mapped text");
  });

  it("enforces the page bound before text extraction", async () => {
    await expect(
      extract(makePdf({ pages: Array.from({ length: PDF_LIMITS.pages + 1 }, () => "text") })),
    ).rejects.toThrow("page limit");
    expect(runPdfNative).toHaveBeenCalledTimes(1);
  });

  it("does not execute launch/JavaScript actions or fetch a file URI", async () => {
    const marker = join(workspace, "action-was-executed");
    const script = join(workspace, "launch-action");
    const secret = join(workspace, "uri-private-text");
    await writeFile(script, `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, { mode: 0o700 });
    await chmod(script, 0o700);
    await writeFile(secret, "PRIVATE_URI_CONTENT_NOT_SOURCE", { mode: 0o600 });
    // inotify observes opens/reads even on noatime mounts. Python is a test-only libc FFI bridge.
    const observer = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
assert fd >= 0
assert libc.inotify_add_watch(fd, os.fsencode(sys.argv[1]), 0x20 | 0x01) >= 0
print("ready", flush=True)
for line in sys.stdin:
    count = 0
    while True:
        try:
            count += len(os.read(fd, 65536))
        except BlockingIOError:
            break
    print(count, flush=True)
`,
        secret,
      ],
      {
        cwd: workspace,
        env: { LC_ALL: "C", LANG: "C", TZ: "UTC", HOME: workspace, TMPDIR: workspace },
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    observer.on("error", () => {});
    const stopped = new Promise<void>((resolve) => observer.on("close", () => resolve()));
    const timer = setTimeout(() => observer.kill("SIGKILL"), 4_000);
    const reader = createInterface({ input: observer.stdout });
    const lines = reader[Symbol.asyncIterator]();
    const drain = async () => {
      observer.stdin.write("drain\n");
      const line = await lines.next();
      if (line.done || !/^\d+$/.test(line.value)) throw new Error("Private URI read observer failed");
      return Number(line.value);
    };
    try {
      expect((await lines.next()).value).toBe("ready");
      const result = await extract(
        makePdf({ actionScript: script, actionUri: `file://${secret}`, pages: ["Only page source"] }),
      );
      expect(result.markdown).toContain("Only page source");
      expect(result.markdown).not.toContain("PRIVATE_URI_CONTENT_NOT_SOURCE");
      expect(await drain()).toBe(0);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await readRegularFile(secret);
      expect(await drain()).toBeGreaterThan(0);
    } finally {
      clearTimeout(timer);
      reader.close();
      observer.kill("SIGKILL");
      await stopped;
    }
  });
});
