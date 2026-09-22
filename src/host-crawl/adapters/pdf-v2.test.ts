import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTERNAL_ROOT } from "../paths.ts";
import {
  capturePdfV2Profile,
  PDF_V2_EXECUTABLES,
  PDF_V2_LIMITS,
  requirePdfV2Profile,
  runPdfV2Native,
} from "../pdf-profile-v2.ts";
import { extractPdfV2 } from "./pdf-v2.ts";

vi.mock("../pdf-profile-v2.ts", async (original) => {
  const module = await original<typeof import("../pdf-profile-v2.ts")>();
  return {
    ...module,
    requirePdfV2Profile: vi.fn(module.requirePdfV2Profile),
    runPdfV2Native: vi.fn(module.runPdfV2Native),
  };
});

const native = await vi.importActual<typeof import("../pdf-profile-v2.ts")>("../pdf-profile-v2.ts");
const workspace = join(DEFAULT_EXTERNAL_ROOT, "test-pdf-v2");
await mkdir(workspace, { recursive: true, mode: 0o700 });
const profile = await capturePdfV2Profile(join(workspace, "profile"));
let failed = false;
afterEach((context) => {
  if (context.task.result?.state === "fail") failed = true;
});
afterAll(async () => {
  if (failed) console.error(`Preserved PDF v2 fixture: ${workspace}`);
  else await rm(workspace, { recursive: true, force: true });
});
beforeEach(() => {
  vi.mocked(requirePdfV2Profile).mockReset().mockImplementation(native.requirePdfV2Profile);
  vi.mocked(runPdfV2Native).mockReset().mockImplementation(native.runPdfV2Native);
});

function literal(text: string): string {
  return `(${text
    .replace(/([\\()])/g, "\\$1")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")})`;
}

interface PdfPage {
  text?: string;
  stream?: string;
}

function makePdf(pages: PdfPage[] = [{ text: "Native source text" }], title = "Source title"): Buffer {
  const streams = pages.map(
    (page) => page.stream ?? (page.text ? `BT /F1 12 Tf 72 720 Td ${literal(page.text)} Tj ET\n` : ""),
  );
  const objects = new Map<number, Buffer>();
  const put = (id: number, value: string) => objects.set(id, Buffer.from(value, "latin1"));
  put(1, "<< /Type /Catalog /Pages 2 0 R >>");
  put(
    2,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${5 + index * 2} 0 R`).join(" ")}] >>`,
  );
  put(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  put(4, `<< /Title ${literal(title)} >>`);
  streams.forEach((stream, index) => {
    const page = 5 + index * 2;
    put(
      page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`,
    );
    const bytes = Buffer.from(stream, "latin1");
    objects.set(
      page + 1,
      Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from("\nendstream")]),
    );
  });
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
    .join("")}trailer\n<< /Size ${objects.size + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  return Buffer.concat([...chunks, Buffer.from(xref)]);
}

const glyphs: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
};

function imageStream(text: string): string {
  const width = 640;
  const height = 120;
  const scale = 8;
  const pixels = Buffer.alloc(width * height, 255);
  let originX = 16;
  for (const character of text) {
    const glyph = glyphs[character];
    if (!glyph) throw new Error(`Missing fixture glyph: ${character}`);
    for (const [row, bits] of glyph.entries()) {
      for (const [column, bit] of [...bits].entries()) {
        if (bit !== "1") continue;
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            pixels[(16 + row * scale + y) * width + originX + column * scale + x] = 0;
          }
        }
      }
    }
    originX += 6 * scale;
  }
  return `q 520 0 0 98 46 620 cm BI /W ${width} /H ${height} /CS /DeviceGray /BPC 8 /F /ASCIIHexDecode ID\n${pixels.toString("hex")}>\nEI Q\n`;
}

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const sourceUrl = "https://example.ubc.ca/guides/source.pdf";
const tsv = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "5\t1\t1\t1\t2\t2\t60\t40\t30\t12\t93\tline",
  "5\t1\t1\t1\t1\t2\t55\t20\t40\t12\t94\tfirst",
  "5\t1\t1\t1\t2\t1\t10\t40\t40\t12\t95\tSecond",
  "5\t1\t1\t1\t1\t1\t10\t20\t35\t12\t96\tOCR",
  "",
].join("\n");

function mockMixed(ocrOutput = tsv, imageWidth = 100, imageHeight = 100): void {
  vi.mocked(runPdfV2Native).mockImplementation(async (executable, args, context) => {
    if (executable === PDF_V2_EXECUTABLES.info)
      return { stdout: Buffer.from("Title: Source title\nPages: 2\nEncrypted: no\n"), stderr: Buffer.alloc(0) };
    if (executable === PDF_V2_EXECUTABLES.text)
      return { stdout: Buffer.from("Native page contains sufficient mapped text\f\f"), stderr: Buffer.alloc(0) };
    if (executable === PDF_V2_EXECUTABLES.raster) {
      await writeFile(join(context.directory, `${args.at(-1)}.png`), pngHeader(imageWidth, imageHeight));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (executable === PDF_V2_EXECUTABLES.ocr) return { stdout: Buffer.from(ocrOutput), stderr: Buffer.alloc(0) };
    throw new Error(`Unexpected executable: ${executable}`);
  });
}

function extract(bytes = makePdf([{ text: "first" }, {}])) {
  return extractPdfV2({ bytes, sourceUrl, workspace, profile });
}

describe("PDF v2 selection and output", () => {
  it("uses default reading order and OCRs only the unmapped page", async () => {
    mockMixed();
    const result = await extract();
    expect(result).toMatchObject({
      pages: 2,
      native_text_pages: [1],
      ocr_pages: [2],
      profile_sha256: profile.sha256,
    });
    expect(result.markdown).toContain("Native page contains sufficient mapped text");
    expect(result.markdown).toContain("OCR first\nSecond line");
    expect(result.warnings).toEqual([...result.warnings].sort());
    expect(result.warnings.join(" ")).toContain("English Tesseract");
    const textCall = vi.mocked(runPdfV2Native).mock.calls.find(([tool]) => tool === PDF_V2_EXECUTABLES.text)!;
    expect(textCall[1]).toEqual([...profile.manifest.extraction.textArguments, "-f", "1", "-l", "2", "input.pdf", "-"]);
    expect(textCall[1]).not.toContain("-layout");
    const rasterCall = vi.mocked(runPdfV2Native).mock.calls.find(([tool]) => tool === PDF_V2_EXECUTABLES.raster)!;
    expect(rasterCall[1]).toEqual([
      "-f",
      "2",
      "-l",
      "2",
      ...profile.manifest.extraction.rasterArguments,
      "input.pdf",
      "ocr-page-0002",
    ]);
    const ocrCall = vi.mocked(runPdfV2Native).mock.calls.find(([tool]) => tool === PDF_V2_EXECUTABLES.ocr)!;
    expect(ocrCall[1]).toEqual(["ocr-page-0002.png", "stdout", ...profile.manifest.extraction.ocrArguments]);
  });

  it("returns native provenance without invoking raster or OCR", async () => {
    vi.mocked(runPdfV2Native).mockImplementation(async (executable) => {
      if (executable === PDF_V2_EXECUTABLES.info)
        return { stdout: Buffer.from("Pages: 2\nEncrypted: no\n"), stderr: Buffer.alloc(0) };
      if (executable === PDF_V2_EXECUTABLES.text)
        return {
          stdout: Buffer.from(
            "First native paragraph contains enough mapped text\fSecond native paragraph also has enough mapped text\f",
          ),
          stderr: Buffer.alloc(0),
        };
      throw new Error("OCR must not run for mapped text");
    });
    const result = await extract();
    expect(result.native_text_pages).toEqual([1, 2]);
    expect(result.ocr_pages).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("OCRs a scanned page whose mapped layer contains only a sparse page label", async () => {
    vi.mocked(runPdfV2Native).mockImplementation(async (executable, args, context) => {
      if (executable === PDF_V2_EXECUTABLES.info)
        return { stdout: Buffer.from("Pages: 1\nEncrypted: no\n"), stderr: Buffer.alloc(0) };
      if (executable === PDF_V2_EXECUTABLES.text) return { stdout: Buffer.from("Page 1\f"), stderr: Buffer.alloc(0) };
      if (executable === PDF_V2_EXECUTABLES.raster) {
        await writeFile(join(context.directory, `${args.at(-1)}.png`), pngHeader(100, 100));
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (executable === PDF_V2_EXECUTABLES.ocr) return { stdout: Buffer.from(tsv), stderr: Buffer.alloc(0) };
      throw new Error(`Unexpected executable: ${executable}`);
    });
    const result = await extract(makePdf([{ text: "Page 1" }]));
    expect(result.native_text_pages).toEqual([]);
    expect(result.ocr_pages).toEqual([1]);
    expect(result.markdown).toContain("OCR first");
  });

  it.each([
    ["malformed header\n", /header/],
    [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n",
      /no usable English text/,
    ],
    [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t95\t0\t10\t10\t90\toverflow\n",
      /coordinates/,
    ],
  ])("rejects malformed or empty OCR output %#", async (output, message) => {
    mockMixed(output);
    await expect(extract()).rejects.toThrow(message);
  });

  it("rejects raster pixel and OCR-page limits without returning native prefixes", async () => {
    mockMixed(tsv, PDF_V2_LIMITS.pixelsPerPage + 1, 1);
    await expect(extract()).rejects.toThrow("pixel limit");
    vi.mocked(runPdfV2Native)
      .mockReset()
      .mockImplementation(async (executable) => {
        if (executable === PDF_V2_EXECUTABLES.info)
          return {
            stdout: Buffer.from(`Pages: ${PDF_V2_LIMITS.ocrPages + 1}\nEncrypted: no\n`),
            stderr: Buffer.alloc(0),
          };
        if (executable === PDF_V2_EXECUTABLES.text)
          return { stdout: Buffer.from("\f".repeat(PDF_V2_LIMITS.ocrPages + 1)), stderr: Buffer.alloc(0) };
        throw new Error("Rasterization must not begin after the OCR-page limit fails");
      });
    await expect(extract(makePdf(Array.from({ length: PDF_V2_LIMITS.ocrPages + 1 }, () => ({}))))).rejects.toThrow(
      "OCR page limit",
    );
  });

  it("rejects malformed native boundaries, encryption and empty input before partial success", async () => {
    vi.mocked(runPdfV2Native)
      .mockResolvedValueOnce({ stdout: Buffer.from("Pages: 2\nEncrypted: no\n"), stderr: Buffer.alloc(0) })
      .mockResolvedValueOnce({ stdout: Buffer.from("only one boundary\f"), stderr: Buffer.alloc(0) });
    await expect(extract()).rejects.toThrow("page boundaries");
    vi.mocked(runPdfV2Native)
      .mockReset()
      .mockResolvedValueOnce({
        stdout: Buffer.from("Pages: 1\nEncrypted: yes\n"),
        stderr: Buffer.alloc(0),
      });
    await expect(extract(makePdf())).rejects.toThrow("Encrypted");
    vi.mocked(runPdfV2Native).mockReset();
    await expect(extract(Buffer.alloc(0))).rejects.toThrow("input is empty");
    expect(runPdfV2Native).not.toHaveBeenCalled();
  });
});

describe("actual PDF v2 OCR", () => {
  it("extracts an owned image-only page with fixed English OCR", async () => {
    const result = await extract(makePdf([{ stream: imageStream("TEST") }]));
    expect(result.native_text_pages).toEqual([]);
    expect(result.ocr_pages).toEqual([1]);
    expect(result.markdown.toUpperCase()).toContain("TEST");
    expect(result.warnings.join(" ")).toContain("English Tesseract");
  });

  it("combines owned native and image pages without OCRing mapped pages", async () => {
    const result = await extract(makePdf([{ text: "Native reading order source" }, { stream: imageStream("TEST") }]));
    expect(result.native_text_pages).toEqual([1]);
    expect(result.ocr_pages).toEqual([2]);
    expect(result.markdown).toContain("Native reading order source");
    expect(result.markdown.toUpperCase()).toContain("TEST");
  });
});
