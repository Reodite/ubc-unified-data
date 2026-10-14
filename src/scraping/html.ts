import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

export const HTML_MEDIA_TYPE = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i;

export function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Select outermost matches so nested containers contribute their content only once. */
export function contentRoots<T extends AnyNode>($: CheerioAPI, candidates: Cheerio<T>): Cheerio<T> {
  const nodes = new Set<AnyNode>(candidates.toArray());
  return candidates.filter(
    (_, node) =>
      !$(node)
        .parents()
        .toArray()
        .some((parent) => nodes.has(parent)),
  );
}
