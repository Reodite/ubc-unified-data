import { extname } from "node:path";

export const BINARY_DOCUMENT_FORMATS = ["pdf", "docx", "pptx"] as const;
export type BinaryDocumentFormat = (typeof BINARY_DOCUMENT_FORMATS)[number];
export type DocumentSourceFormat = BinaryDocumentFormat | "markdown";

export const DOCUMENT_MEDIA_TYPES: Readonly<Record<BinaryDocumentFormat, readonly string[]>> = Object.freeze({
  pdf: Object.freeze(["application/pdf"]),
  docx: Object.freeze(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]),
  pptx: Object.freeze(["application/vnd.openxmlformats-officedocument.presentationml.presentation"]),
});

const GENERIC_BINARY_MEDIA = new Set(["application/octet-stream", "application/zip", "application/x-zip-compressed"]);

export class DocumentFormatMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentFormatMismatchError";
  }
}

export function documentFormatFromUrl(value: string): BinaryDocumentFormat | undefined {
  const pathname = decodeURIComponent(new URL(value).pathname).replace(/\/+$/, "");
  const extension = extname(pathname).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (extension === ".docx") return "docx";
  if (extension === ".pptx") return "pptx";
  return undefined;
}

export function documentFormatFromMediaType(value: string): BinaryDocumentFormat | undefined {
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  for (const format of BINARY_DOCUMENT_FORMATS) if (DOCUMENT_MEDIA_TYPES[format].includes(mediaType)) return format;
  return undefined;
}

export function documentMagic(bytes: Uint8Array): "pdf" | "zip" | undefined {
  const value = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 8));
  if (value.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (
    value.length >= 4 &&
    value[0] === 0x50 &&
    value[1] === 0x4b &&
    ((value[2] === 0x03 && value[3] === 0x04) ||
      (value[2] === 0x05 && value[3] === 0x06) ||
      (value[2] === 0x07 && value[3] === 0x08))
  )
    return "zip";
  return undefined;
}

export function detectBinaryDocument(
  url: string,
  contentType: string,
  bytes: Uint8Array,
  allowed: readonly DocumentSourceFormat[],
): BinaryDocumentFormat | undefined {
  if (!bytes.byteLength) return undefined;
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const urlFormat = documentFormatFromUrl(url);
  const mediaFormat = documentFormatFromMediaType(mediaType);
  const magic = documentMagic(bytes);
  if (urlFormat && mediaFormat && urlFormat !== mediaFormat)
    throw new DocumentFormatMismatchError(`Document URL and media type disagree: ${urlFormat} versus ${mediaFormat}`);
  const selected = mediaFormat ?? urlFormat;
  if (!selected) return undefined;
  if (!allowed.includes(selected)) return undefined;
  if (selected === "pdf" && magic !== "pdf")
    throw new DocumentFormatMismatchError("PDF declaration lacks PDF file magic");
  if (selected !== "pdf" && magic !== "zip")
    throw new DocumentFormatMismatchError(`${selected.toUpperCase()} declaration lacks ZIP package magic`);
  if (!mediaFormat && !GENERIC_BINARY_MEDIA.has(mediaType) && mediaType !== "")
    throw new DocumentFormatMismatchError(`Unsupported media type for ${selected.toUpperCase()}: ${mediaType}`);
  if (selected === "pdf" && mediaType.includes("zip"))
    throw new DocumentFormatMismatchError("PDF URL returned a ZIP media type");
  if (selected !== "pdf" && mediaType === "application/pdf")
    throw new DocumentFormatMismatchError(`${selected.toUpperCase()} URL returned PDF media`);
  return selected;
}

export function canonicalDocumentMediaType(format: BinaryDocumentFormat): string {
  return DOCUMENT_MEDIA_TYPES[format][0]!;
}
