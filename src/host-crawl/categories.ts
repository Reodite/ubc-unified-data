import { normalizeHost } from "./urls.ts";

export const DOCUMENT_CATEGORIES = ["support", "academics", "opportunities", "research", "news", "stories"] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export function assertDocumentCategory(value: unknown): asserts value is DocumentCategory {
  if (typeof value !== "string" || !DOCUMENT_CATEGORIES.includes(value as DocumentCategory))
    throw new Error("Unknown document category");
}

export function categoryDocumentRoot(category: DocumentCategory, hostname: string): string {
  assertDocumentCategory(category);
  if (normalizeHost(hostname) !== hostname) throw new Error("Invalid category hostname");
  return `data/documents/${category}/${hostname}`;
}
