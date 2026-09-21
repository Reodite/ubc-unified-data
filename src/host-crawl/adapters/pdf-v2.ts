import { constants } from "node:fs";
import { lstat, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeMarkdown } from "../../prose/markdown.ts";
import {
  createPdfV2Workspace,
  PDF_V2_EXECUTABLES,
  PDF_V2_LIMITS,
  requirePdfV2Profile,
  retainPdfV2Failure,
  runPdfV2Native,
  type PdfV2Context,
  type PdfV2Profile,
} from "../pdf-profile-v2.ts";
import { writePdfEvidenceJson } from "../pdf-profile.ts";

export interface ExtractPdfV2Options {
  bytes: Uint8Array;
  sourceUrl: string;
  workspace: string;
  profile: PdfV2Profile;
}

export interface ExtractedPdfV2 {
  title: string;
  markdown: string;
  pages: number;
  native_text_pages: number[];
  ocr_pages: number[];
  profile_sha256: string;
  warnings: string[];
}

interface OcrWord {
  block: number;
  paragraph: number;
  line: number;
  word: number;
  left: number;
  top: number;
  width: number;
  height: number;
  text: string;
}

function copyPdfInput(bytes: Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > PDF_V2_LIMITS.inputBytes)
    throw new Error("PDF v2 input is empty or exceeds its byte limit");
  return Buffer.from(bytes);
}

function validatePdf(copy: Buffer): void {
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(copy.subarray(0, 16).toString("latin1")))
    throw new Error("PDF v2 signature is invalid");
  const trailer = copy.subarray(Math.max(0, copy.length - 2048)).toString("latin1");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: PDF syntax treats NUL as whitespace.
  const match = trailer.match(/startxref[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+%%EOF[\x00\t\n\f\r ]*$/);
  const offset = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(offset) || offset < 9 || offset >= copy.length)
    throw new Error("PDF v2 is truncated or lacks a valid final cross-reference pointer");
  const xref = copy.subarray(offset, Math.min(offset + 4096, copy.length)).toString("latin1");
  if (!/^xref\s/.test(xref) && !/^\d+\s+\d+\s+obj\s*<<[\s\S]*?\/Type\s*\/XRef\b/.test(xref))
    throw new Error("PDF v2 final cross-reference pointer is invalid");
}

function decode(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function field(info: string, name: string, required: boolean): string {
  const values = info.split("\n").filter((line) => line.startsWith(`${name}:`));
  if (values.length > 1 || (required && values.length !== 1))
    throw new Error(`PDF v2 metadata has an ambiguous or missing ${name} field`);
  return values[0]?.slice(name.length + 1).trim() ?? "";
}

function urlTitle(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  let title = last ?? `${url.hostname} PDF`;
  try {
    title = decodeURIComponent(title);
  } catch {
    /* Preserve an undecodable URL component literally. */
  }
  return (
    Array.from(
      title
        .replace(/[\p{Cc}\p{Cf}\ufffd<>]/gu, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
      .slice(0, 512)
      .join("") || `${url.hostname} PDF`
  );
}

function cleanTitle(title: string): string {
  const value = title.replace(/\s+/g, " ").trim();
  return value.length <= 512 && !/[\p{Cc}\p{Cf}\ufffd<>]/u.test(value) ? value : "";
}

function usable(text: string): boolean {
  return /[^\s\p{Cc}\p{Cf}\p{Co}\ufffd]/u.test(text);
}

function fenceText(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

async function temporaryUsage(directory: string): Promise<void> {
  let bytes = 0;
  let files = 0;
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error("PDF v2 temporary workspace contains a symlink");
      if (info.isDirectory()) await visit(child);
      else if (info.isFile()) {
        files++;
        bytes += info.size;
        if (files > PDF_V2_LIMITS.temporaryFiles || bytes > PDF_V2_LIMITS.temporaryBytes)
          throw new Error("PDF v2 temporary workspace exceeds its file or byte limit");
      } else throw new Error("PDF v2 temporary workspace contains an unsupported file type");
    }
  }
  await visit(directory);
}

async function readBoundedRegularFile(path: string, maximum: number): Promise<Buffer> {
  const beforePath = await lstat(path);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size < 1 || beforePath.size > maximum)
    throw new Error("PDF v2 raster output is empty, invalid or exceeds its byte limit");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      before.size !== beforePath.size
    )
      throw new Error("PDF v2 raster output changed before reading");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error("PDF v2 raster output changed while reading");
    return bytes;
  } finally {
    await file.close();
  }
}

function pngDimensions(bytes: Buffer): { width: number; height: number; pixels: number } {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  )
    throw new Error("PDF v2 raster output is not a canonical PNG image");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const pixels = width * height;
  if (!width || !height || !Number.isSafeInteger(pixels) || pixels > PDF_V2_LIMITS.pixelsPerPage)
    throw new Error("PDF v2 raster page exceeds its pixel limit");
  return { width, height, pixels };
}

function tsvInteger(value: string | undefined, label: string, minimum = 0): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`PDF v2 OCR TSV has an invalid ${label}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`PDF v2 OCR TSV has an invalid ${label}`);
  return result;
}

function reconstructOcr(tsv: Buffer, imageWidth: number, imageHeight: number): string {
  const value = decode(tsv, "PDF v2 OCR output");
  const rows = value.replace(/\r\n/g, "\n").split("\n");
  if (
    rows.pop() !== "" ||
    rows.shift() !== "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"
  )
    throw new Error("PDF v2 OCR TSV header or final boundary is invalid");
  const words: OcrWord[] = [];
  for (const row of rows) {
    const columns = row.split("\t");
    if (columns.length !== 12) throw new Error("PDF v2 OCR TSV row is malformed");
    const level = tsvInteger(columns[0], "level", 1);
    if (level !== 5) continue;
    if (tsvInteger(columns[1], "page number", 1) !== 1)
      throw new Error("PDF v2 OCR TSV contains an unexpected page number");
    const word: OcrWord = {
      block: tsvInteger(columns[2], "block number", 1),
      paragraph: tsvInteger(columns[3], "paragraph number", 1),
      line: tsvInteger(columns[4], "line number", 1),
      word: tsvInteger(columns[5], "word number", 1),
      left: tsvInteger(columns[6], "left coordinate"),
      top: tsvInteger(columns[7], "top coordinate"),
      width: tsvInteger(columns[8], "width", 1),
      height: tsvInteger(columns[9], "height", 1),
      text: columns[11]!.replace(/\s+/gu, " ").trim(),
    };
    const confidence = Number(columns[10]);
    if (!Number.isFinite(confidence) || confidence < -1 || confidence > 100)
      throw new Error("PDF v2 OCR TSV has an invalid confidence");
    if (word.left + word.width > imageWidth || word.top + word.height > imageHeight)
      throw new Error("PDF v2 OCR TSV coordinates exceed the raster page");
    if (word.text) {
      if (!usable(word.text)) throw new Error("PDF v2 OCR TSV word has no usable text");
      words.push(word);
    }
  }
  words.sort(
    (a, b) =>
      a.block - b.block ||
      a.paragraph - b.paragraph ||
      a.line - b.line ||
      a.word - b.word ||
      a.top - b.top ||
      a.left - b.left ||
      a.text.localeCompare(b.text),
  );
  const lines: string[] = [];
  let key = "";
  for (const word of words) {
    const next = `${word.block}:${word.paragraph}:${word.line}`;
    if (next !== key) {
      lines.push(word.text);
      key = next;
    } else lines[lines.length - 1] += ` ${word.text}`;
  }
  const text = lines.join("\n");
  if (!usable(text)) throw new Error("PDF v2 OCR produced no usable English text");
  return text;
}

function visibleText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Co}\ufffd]/gu, (character) =>
    character === "\t" || character === "\n" ? character : `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
}

async function ocrPage(
  page: number,
  context: PdfV2Context,
  profile: PdfV2Profile,
): Promise<{ text: string; pixels: number }> {
  const prefix = `ocr-page-${String(page).padStart(4, "0")}`;
  const imageName = `${prefix}.png`;
  const imagePath = join(context.directory, imageName);
  const rasterArguments = [
    "-f",
    String(page),
    "-l",
    String(page),
    ...profile.manifest.extraction.rasterArguments,
    "input.pdf",
    prefix,
  ];
  const raster = await runPdfV2Native(PDF_V2_EXECUTABLES.raster, rasterArguments, context, PDF_V2_LIMITS.infoBytes);
  if (raster.stdout.length || raster.stderr.length) throw new Error("PDF v2 rasterizer emitted unexpected output");
  await temporaryUsage(context.directory);
  const image = await readBoundedRegularFile(imagePath, PDF_V2_LIMITS.rasterBytes);
  const dimensions = pngDimensions(image);
  const ocrArguments = [imageName, "stdout", ...profile.manifest.extraction.ocrArguments];
  const ocr = await runPdfV2Native(PDF_V2_EXECUTABLES.ocr, ocrArguments, context, PDF_V2_LIMITS.ocrOutputBytes);
  if (ocr.stderr.length) throw new Error("PDF v2 OCR emitted diagnostics; refusing partial extraction");
  const text = reconstructOcr(ocr.stdout, dimensions.width, dimensions.height);
  await rm(imagePath);
  await temporaryUsage(context.directory);
  return { text, pixels: dimensions.pixels };
}

/** Extract reading-order native text and OCR only pages without usable mapped text. */
export async function extractPdfV2({
  bytes,
  sourceUrl,
  workspace,
  profile,
}: ExtractPdfV2Options): Promise<ExtractedPdfV2> {
  requirePdfV2Profile(profile);
  const url = new URL(sourceUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("PDF v2 source URL must be a credential-free HTTP URL");
  const input = copyPdfInput(bytes);
  const context = await createPdfV2Workspace(workspace);
  let stage = "input";
  try {
    await writeFile(join(context.directory, "input.pdf"), input, { flag: "wx", mode: 0o600 });
    stage = "context";
    await writePdfEvidenceJson(join(context.directory, "context-v2.json"), {
      schema: "host-pdf-extraction-context-v2",
      sourceUrl,
      profileSha256: profile.sha256,
      inputBytes: input.length,
      limits: profile.manifest.extraction.limits,
    });
    await temporaryUsage(context.directory);
    stage = "input-validation";
    validatePdf(input);
    stage = "metadata";
    const infoArguments = [...profile.manifest.extraction.infoArguments, "input.pdf"];
    const infoResult = await runPdfV2Native(PDF_V2_EXECUTABLES.info, infoArguments, context, PDF_V2_LIMITS.infoBytes);
    if (infoResult.stderr.length)
      throw new Error("PDF v2 metadata parser emitted diagnostics; refusing partial extraction");
    const info = decode(infoResult.stdout, "PDF v2 metadata output");
    const encrypted = field(info, "Encrypted", true);
    if (encrypted !== "no") throw new Error("Encrypted PDF v2 extraction is not permitted");
    const pagesValue = field(info, "Pages", true);
    const pages = Number(pagesValue);
    if (!/^\d+$/.test(pagesValue) || !Number.isSafeInteger(pages) || pages < 1 || pages > PDF_V2_LIMITS.pages)
      throw new Error("PDF v2 page count is invalid or exceeds its page limit");
    const metadataTitle = field(info, "Title", false);
    const title = cleanTitle(metadataTitle) || urlTitle(url);
    stage = "native-text";
    const textArguments = [
      ...profile.manifest.extraction.textArguments,
      "-f",
      "1",
      "-l",
      String(pages),
      "input.pdf",
      "-",
    ];
    const textResult = await runPdfV2Native(PDF_V2_EXECUTABLES.text, textArguments, context);
    if (textResult.stderr.length)
      throw new Error("PDF v2 text parser emitted diagnostics; refusing partial extraction");
    const nativeOutput = decode(textResult.stdout, "PDF v2 native text output");
    const pageTexts = nativeOutput.split("\f");
    const suffix = pageTexts.pop();
    if (pageTexts.length !== pages || !/^[\r\n]*$/.test(suffix ?? ""))
      throw new Error("PDF v2 native page boundaries disagree with its metadata page count");
    const nativeTextPages: number[] = [];
    const ocrPages: number[] = [];
    for (const [index, text] of pageTexts.entries()) {
      if (usable(text)) nativeTextPages.push(index + 1);
      else ocrPages.push(index + 1);
    }
    if (ocrPages.length > PDF_V2_LIMITS.ocrPages) throw new Error("PDF v2 exceeds its OCR page limit");
    const warnings: string[] = [];
    if (metadataTitle && !cleanTitle(metadataTitle))
      warnings.push("The PDF metadata title is unsafe or too long; the title uses the source URL filename instead.");
    let totalPixels = 0;
    for (const page of ocrPages) {
      stage = `ocr-page-${page}`;
      const result = await ocrPage(page, context, profile);
      totalPixels += result.pixels;
      if (totalPixels > PDF_V2_LIMITS.totalOcrPixels) throw new Error("PDF v2 exceeds its total OCR pixel limit");
      pageTexts[page - 1] = result.text;
      warnings.push(
        `Page ${page}: OCR transcription uses fixed ${PDF_V2_LIMITS.rasterDpi} DPI English Tesseract and may contain recognition or reading-order errors.`,
      );
    }
    stage = "markdown";
    let markdownBytes = 1;
    const sections = pageTexts.map((page, index) => {
      if (!usable(page)) throw new Error(`PDF v2 page ${index + 1} has no usable extracted text`);
      const section = `## Page ${index + 1}\n\n${fenceText(visibleText(page))}`;
      markdownBytes += Buffer.byteLength(section) + (index ? 2 : 0);
      if (markdownBytes > PDF_V2_LIMITS.outputBytes) throw new Error("PDF v2 Markdown exceeds its output limit");
      return section;
    });
    if (!sections.length || !pageTexts.some(usable)) throw new Error("PDF v2 has no usable native or OCR text");
    const coverage = [...nativeTextPages, ...ocrPages].sort((a, b) => a - b);
    if (coverage.length !== pages || coverage.some((page, index) => page !== index + 1))
      throw new Error("PDF v2 page provenance is incomplete or overlapping");
    const markdown = `${sections.join("\n\n")}\n`;
    assertSafeMarkdown(markdown);
    warnings.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    stage = "cleanup";
    await rm(context.directory, { recursive: true, force: true });
    return {
      title,
      markdown,
      pages,
      native_text_pages: nativeTextPages,
      ocr_pages: ocrPages,
      profile_sha256: profile.sha256,
      warnings,
    };
  } catch (error) {
    throw await retainPdfV2Failure(context.directory, error, stage, !["input", "context", "cleanup"].includes(stage));
  }
}
