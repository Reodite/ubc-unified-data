import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeMarkdown } from "../../prose/markdown.ts";
import {
  createPdfWorkspace,
  PDF_EXECUTABLES,
  PDF_LIMITS,
  requirePdfProfile,
  retainPdfFailure,
  runPdfNative,
  writePdfEvidenceJson,
  type PdfProfile,
} from "../pdf-profile.ts";

export interface ExtractPdfOptions {
  bytes: Uint8Array;
  sourceUrl: string;
  workspace: string;
  profile: PdfProfile;
}

export interface ExtractedPdf {
  title: string;
  markdown: string;
  warnings: string[];
  pageCount: number;
}

function copyPdfInput(bytes: Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > PDF_LIMITS.inputBytes)
    throw new Error("PDF input is empty or exceeds its byte limit");
  return Buffer.from(bytes);
}

function validatePdf(copy: Buffer): void {
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(copy.subarray(0, 16).toString("latin1")))
    throw new Error("PDF signature is invalid");
  const trailer = copy.subarray(Math.max(0, copy.length - 2048)).toString("latin1");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: PDF syntax treats NUL as whitespace.
  const match = trailer.match(/startxref[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+%%EOF[\x00\t\n\f\r ]*$/);
  const offset = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(offset) || offset < 9 || offset >= copy.length)
    throw new Error("PDF is truncated or lacks a valid final cross-reference pointer");
  const xref = copy.subarray(offset, Math.min(offset + 4096, copy.length)).toString("latin1");
  if (!/^xref\s/.test(xref) && !/^\d+\s+\d+\s+obj\s*<<[\s\S]*?\/Type\s*\/XRef\b/.test(xref))
    throw new Error("PDF final cross-reference pointer is invalid");
}

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("PDF native output is not valid UTF-8");
  }
}

function field(info: string, name: string, required: boolean): string {
  const values = info.split("\n").filter((line) => line.startsWith(`${name}:`));
  if (values.length > 1 || (required && values.length !== 1))
    throw new Error(`PDF metadata has an ambiguous or missing ${name} field`);
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

function fenceText(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

/**
 * Extract source text using an already verified profile; recheck it before publication, not per document.
 * Retain owned input/context/native evidence on failure and throw PdfEvidenceError with its private path.
 * Invalid profile, URL, input size/type or workspace arguments fail before allocating extraction evidence.
 */
export async function extractPdf({ bytes, sourceUrl, workspace, profile }: ExtractPdfOptions): Promise<ExtractedPdf> {
  requirePdfProfile(profile);
  const url = new URL(sourceUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("PDF source URL must be a credential-free HTTP URL");
  const input = copyPdfInput(bytes);
  const context = await createPdfWorkspace(workspace);
  const infoArguments = [...profile.manifest.extraction.infoArguments, "input.pdf"];
  const textArguments = [...profile.manifest.extraction.textArguments, "input.pdf", "-"];
  let stage = "input";
  try {
    await writeFile(join(context.directory, "input.pdf"), input, { flag: "wx", mode: 0o600 });
    stage = "context";
    await writePdfEvidenceJson(join(context.directory, "context.json"), {
      schema: "host-pdf-extraction-context-v1",
      sourceUrl,
      profileSha256: profile.sha256,
      inputBytes: input.length,
      environment: context.env,
      info: { executable: PDF_EXECUTABLES.info, arguments: infoArguments },
      text: { executable: PDF_EXECUTABLES.text, arguments: textArguments },
      limits: profile.manifest.extraction.limits,
    });
    stage = "input-validation";
    validatePdf(input);
    stage = "metadata";
    const infoResult = await runPdfNative(PDF_EXECUTABLES.info, infoArguments, context, PDF_LIMITS.infoBytes);
    stage = "metadata-validation";
    // Poppler can repair malformed input and exit zero. Diagnostics are not accepted as partial success.
    if (infoResult.stderr.length)
      throw new Error("PDF metadata parser emitted diagnostics; refusing partial extraction");
    const info = decode(infoResult.stdout);
    const encrypted = field(info, "Encrypted", true);
    if (encrypted !== "no") throw new Error("Encrypted PDF extraction is not permitted");
    const pages = field(info, "Pages", true);
    const pageCount = Number(pages);
    if (!/^\d+$/.test(pages) || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > PDF_LIMITS.pages)
      throw new Error("PDF page count is invalid or exceeds its page limit");
    const metadataTitle = field(info, "Title", false);
    const title = cleanTitle(metadataTitle) || urlTitle(url);
    stage = "text";
    const result = await runPdfNative(PDF_EXECUTABLES.text, textArguments, context);
    stage = "text-validation";
    if (result.stderr.length) throw new Error("PDF text parser emitted diagnostics; refusing partial extraction");
    const text = decode(result.stdout);
    const extractedPages = text.split("\f");
    const suffix = extractedPages.pop();
    if (extractedPages.length !== pageCount || !/^[\r\n]*$/.test(suffix ?? ""))
      throw new Error("PDF extracted page boundaries disagree with its metadata page count");
    const warnings = [
      "PDF text extraction only: no OCR or image transcription. Images and some glyphs may be absent even on pages containing text; columns and tables retain Poppler's physical text layout, not inferred structure.",
    ];
    if (metadataTitle && !cleanTitle(metadataTitle))
      warnings.push("The PDF metadata title is unsafe or too long; the title uses the source URL filename instead.");
    stage = "markdown";
    let usefulPages = 0;
    let markdownBytes = 1;
    const sections = extractedPages.map((page, index) => {
      const label = `Page ${index + 1}`;
      if (/[^\s\p{Cc}\p{Cf}\p{Co}\ufffd]/u.test(page)) usefulPages++;
      else
        warnings.push(
          `${label}: no usable mapped text; this page may be blank, image-only or unmapped. No transcription is available.`,
        );
      if (/[\ufffd\p{Co}]/u.test(page))
        warnings.push(
          `${label}: replacement or private-use glyphs may represent unmapped text; this is not a complete transcription.`,
        );
      if (/[\p{Cc}\p{Cf}\ufffd]/u.test(page.replace(/[\t\n]/g, ""))) {
        warnings.push(`${label}: control, formatting or replacement characters are displayed as Unicode escapes.`);
        page = page.replace(/[\p{Cc}\p{Cf}\ufffd]/gu, (character) =>
          character === "\t" || character === "\n" ? character : `\\u{${character.codePointAt(0)!.toString(16)}}`,
        );
      }
      // Fences preserve spacing and treat source HTML, links and code delimiters as inert text.
      const section = `## ${label}\n\n${fenceText(page)}`;
      markdownBytes += Buffer.byteLength(section) + (index ? 2 : 0);
      if (markdownBytes > PDF_LIMITS.outputBytes) throw new Error("PDF Markdown exceeds its output limit");
      return section;
    });
    if (!usefulPages)
      throw new Error("PDF has no usable mapped text; image-only, empty or wholly unmapped PDFs are not accepted");
    const markdown = `${sections.join("\n\n")}\n`;
    assertSafeMarkdown(markdown);
    stage = "cleanup";
    await rm(context.directory, { recursive: true, force: true });
    return { title, markdown, warnings, pageCount };
  } catch (error) {
    throw await retainPdfFailure(context.directory, error, stage, !["input", "context", "cleanup"].includes(stage));
  }
}
