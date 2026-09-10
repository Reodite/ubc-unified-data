/** Minimal HTML reading for the few UBC pages that aren't served as JSON.
 *
 * Two readers, because the pages come in two shapes:
 *
 * - `blocks()` returns headings and tables *interleaved in document order*,
 *   because both date pages use the heading above a table as its context.
 * - `sections()` returns headings with the prose and list items that follow
 *   them, which is how admission requirements are written. `text()` and
 *   `items()` are the same reader over a fragment with no headings.
 */

import HTML5_ENTITIES from "./entities.ts";

const HEADING_TAGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

// Content that is markup machinery rather than text.
const IGNORED_TAGS = new Set(["script", "style", "noscript"]);

// Tags where the surrounding text should not run together: "<td>a</td><td>b</td>"
// is "a" and "b", never "ab".
const BREAK_TAGS = new Set(["br", "p", "div", "li", "tr", "td", "th", "hr"]);

// Non-breaking space, soft hyphen, zero-width space: the invisible characters
// UBC's CMS sprinkles through page text. Given by codepoint so none of them can
// sit unnoticed in this file.
const INVISIBLE: Record<number, string> = {
  [0xa0]: " ",
  [0xad]: "",
  [0x200b]: "",
};

// The HTML5 character-reference pattern: named, or numeric (decimal/hex),
// with or without the closing semicolon.
const CHARREF_RE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

// Numeric references that map to a real codepoint the HTML5 spec overrides,
// plus the control characters that keep the override.
const INVALID_CHARREFS: Record<number, string> = {
  0: "\uFFFD",
  13: "\r",
  128: "\u20ac",
  129: "\x81",
  130: "\u201a",
  131: "\u0192",
  132: "\u201e",
  133: "\u2026",
  134: "\u2020",
  135: "\u2021",
  136: "\u02c6",
  137: "\u2030",
  138: "\u0160",
  139: "\u2039",
  140: "\u0152",
  141: "\x8d",
  142: "\u017d",
  143: "\x8f",
  144: "\x90",
  145: "\u2018",
  146: "\u2019",
  147: "\u201c",
  148: "\u201d",
  149: "\u2022",
  150: "\u2013",
  151: "\u2014",
  152: "\u02dc",
  153: "\u2122",
  154: "\u0161",
  155: "\u203a",
  156: "\u0153",
  157: "\x9d",
  158: "\u017e",
  159: "\u0178",
};

// Control and noncharacter codepoints a numeric reference decodes to nothing.
function isInvalidCodepoint(code: number): boolean {
  return (
    (code >= 1 && code <= 8) ||
    code === 11 ||
    (code >= 14 && code <= 31) ||
    code === 127 ||
    (code >= 64976 && code <= 65007) ||
    (code & 0xfffe) === 0xfffe
  );
}

/** Decode HTML character references: named and numeric, the longest-prefix
 * fallback for unknown names, and the numeric-reference overrides. */
export function unescapeHtml(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(CHARREF_RE, (match, body: string) => {
    if (body[0] !== "#") {
      const decoded = HTML5_ENTITIES[body];
      if (decoded !== undefined) return decoded;
      // The longest prefix that names an entity, remainder kept as-is.
      for (let end = body.length - 1; end > 1; end--) {
        const name = body.slice(0, end);
        const prefix = HTML5_ENTITIES[name];
        if (prefix !== undefined) return prefix + body.slice(end);
      }
      return match;
    }
    const hex = body[1] === "x" || body[1] === "X";
    const digits = hex ? body.slice(2) : body.slice(1);
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (Number.isNaN(code) || digits === "") return match;
    const override = INVALID_CHARREFS[code];
    if (override !== undefined) return override;
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
    if (isInvalidCodepoint(code)) return "";
    return String.fromCodePoint(code);
  });
}

/** Collapse whitespace and drop the invisible characters UBC's CMS emits. */
export function clean(text: string): string {
  let out = "";
  for (const char of text ?? "") {
    const mapped = INVISIBLE[char.charCodeAt(0)];
    out += mapped === undefined ? char : (mapped ?? "");
  }
  return out.replace(/\s+/g, " ").trim();
}

export interface Heading {
  level: number;
  text: string;
}

export interface Table {
  headers: string[];
  rows: string[][];
}

export type Block = Heading | Table;

function isHeading(block: Block): block is Heading {
  return typeof (block as Heading).level === "number";
}

type Token =
  | { kind: "data"; data: string; decoded: boolean }
  | { kind: "start"; tag: string }
  | { kind: "end"; tag: string }
  | { kind: "startend"; tag: string };

/** Tokenize with HTML5 raw-text semantics:
 * * data runs are entity-decoded, except inside <script>/<style>, whose
 *   contents are raw text (and the readers drop anyway)
 * * comments and markup declarations are skipped: no data, no tag
 * * a self-closing tag fires a start and an end tag
 * * '<' that does not begin a tag (not followed by a letter, '/', '!' or '?')
 *   is ordinary data
 * * '>' inside a quoted attribute value does not end the tag */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let rawTag: string | null = null;
  const pushData = (start: number, end: number, decoded: boolean): void => {
    if (end > start) tokens.push({ kind: "data", data: html.slice(start, end), decoded });
  };

  while (i < html.length) {
    if (rawTag !== null) {
      const close = html.toLowerCase().indexOf(`</${rawTag}`, i);
      if (close < 0) {
        pushData(i, html.length, false);
        break;
      }
      const gt = html.indexOf(">", close);
      if (gt < 0) {
        pushData(i, html.length, false);
        break;
      }
      pushData(i, close, false);
      tokens.push({ kind: "end", tag: rawTag });
      i = gt + 1;
      rawTag = null;
      continue;
    }
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushData(i, html.length, true);
      break;
    }
    const after = html[lt + 1];
    // '<' not starting a tag (not followed by a letter, '/', '!' or '?') is
    // data itself, delivered as its own run.
    if (after === undefined || !/[a-zA-Z/!?]/.test(after ?? "")) {
      pushData(i, lt, true);
      pushData(lt, lt + 1, true);
      i = lt + 1;
      continue;
    }
    pushData(i, lt, true);
    if (after === "!") {
      if (html.startsWith("<!--", lt)) {
        // '--!?>' closes; otherwise an abrupt close '->' or '>' right after
        // '<!--' closes an empty comment.
        let end = -1;
        const close = /--!?>/.exec(html.slice(lt + 4));
        if (close) {
          end = lt + 4 + close.index + close[0].length;
        } else {
          const abrupt = /^(?:->|>)/.exec(html.slice(lt + 4));
          if (abrupt) end = lt + 4 + abrupt[0].length;
        }
        if (end < 0) break;
        i = end;
      } else if (html.startsWith("<![CDATA[", lt)) {
        const close = html.indexOf("]]>", lt + 9);
        i = close < 0 ? html.length : close + 3;
      } else {
        // <!DOCTYPE ...> and other markup declarations, ignored.
        const gt = html.indexOf(">", lt);
        i = gt < 0 ? html.length : gt + 1;
      }
      continue;
    }
    if (after === "?") {
      const gt = html.indexOf(">", lt);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    const closing = after === "/";
    // Only "</" + a letter is an end tag. "</>" is ignored,
    // "</" followed by anything else is a bogus comment (dropped), and a
    // bare "</" at end-of-input is data.
    const tagStart = lt + (closing ? 2 : 1);
    if (closing && !/[a-zA-Z]/.test(html[tagStart] ?? "")) {
      if (html[tagStart] === ">") {
        i = tagStart + 1;
        continue;
      }
      if (tagStart >= html.length) {
        pushData(lt, lt + 2, true);
        i = tagStart;
        continue;
      }
      // Bogus comment: no data, no tag (an unterminated one ends the input).
      const gt = html.indexOf(">", tagStart);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    let gt = -1;
    let quote = "";
    for (let j = tagStart; j < html.length; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        gt = j;
        break;
      }
    }
    if (gt < 0) {
      // Drop unterminated tags without delivering their contents as data.
      break;
    }
    const tagText = html.slice(tagStart, gt).trimStart();
    const tag = tagText.split(/[\s/>]/)[0]!.toLowerCase();
    if (!tag) {
      i = gt + 1;
      continue;
    }
    // Forward over any trailing garbage to the real '>' (e.g. '<a title="x>y">').
    const selfClosing = /\/\s*$/.test(tagText);
    if (closing) tokens.push({ kind: "end", tag });
    else if (selfClosing) tokens.push({ kind: "startend", tag });
    else {
      tokens.push({ kind: "start", tag });
      if (tag === "script" || tag === "style") rawTag = tag;
    }
    i = gt + 1;
  }
  return tokens;
}

/** Collects headings and tables; ignores everything else on the page. */
class Reader {
  blocks: Block[] = [];
  private ignore = 0;
  private heading: { level: number; chunks: string[] } | null = null;
  private tables: Table[] = [];
  private row: string[] | null = null;
  private rowIsHeader = false;
  private cell: string[] | null = null;

  feed(html: string): void {
    for (const token of tokenize(html ?? "")) {
      switch (token.kind) {
        case "data":
          this.handleData(token.decoded ? unescapeHtml(token.data) : token.data);
          break;
        case "start":
          this.handleStarttag(token.tag);
          break;
        case "end":
          this.handleEndtag(token.tag);
          break;
        case "startend":
          this.handleStarttag(token.tag);
          this.handleEndtag(token.tag);
          break;
      }
    }
    this.closeEverything();
  }

  private handleData(data: string): void {
    if (this.ignore) return;
    if (this.cell !== null) this.cell.push(data);
    else if (this.heading !== null) this.heading.chunks.push(data);
  }

  private handleStarttag(tag: string): void {
    if (IGNORED_TAGS.has(tag)) this.ignore += 1;
    else if (tag === "table") {
      // A table nested inside a cell ends that cell's text run.
      this.closeCell();
      this.tables.push({ headers: [], rows: [] });
    } else if (tag === "tr" && this.tables.length > 0) {
      this.closeRow();
      this.row = [];
      this.rowIsHeader = false;
    } else if ((tag === "td" || tag === "th") && this.tables.length > 0) {
      this.closeCell();
      if (this.row === null) {
        this.row = [];
        this.rowIsHeader = false;
      }
      this.cell = [];
      this.rowIsHeader = this.rowIsHeader || tag === "th";
    } else if (HEADING_TAGS[tag] && this.tables.length === 0) {
      this.closeHeading();
      this.heading = { level: HEADING_TAGS[tag]!, chunks: [] };
    } else if (BREAK_TAGS.has(tag)) {
      if (this.cell !== null) this.cell.push(" ");
      else if (this.heading !== null) this.heading.chunks.push(" ");
    }
  }

  private handleEndtag(tag: string): void {
    if (IGNORED_TAGS.has(tag)) this.ignore = Math.max(0, this.ignore - 1);
    else if (tag === "table") this.closeTable();
    else if (tag === "tr") this.closeRow();
    else if (tag === "td" || tag === "th") this.closeCell();
    else if (HEADING_TAGS[tag]) this.closeHeading();
  }

  private closeCell(): void {
    if (this.cell === null) return;
    const text = clean(this.cell.join(""));
    this.cell = null;
    if (this.row !== null) this.row.push(text);
  }

  private closeRow(): void {
    this.closeCell();
    const row = this.row;
    const isHeader = this.rowIsHeader;
    this.row = null;
    this.rowIsHeader = false;
    if (!row?.some(Boolean) || this.tables.length === 0) return;
    const table = this.tables[this.tables.length - 1]!;
    // A leading all-<th> row is the header, whether or not it sits in a
    // <thead>; anything after the first row is data even if it uses <th>.
    if (isHeader && table.headers.length === 0 && table.rows.length === 0) table.headers = row;
    else table.rows.push(row);
  }

  private closeTable(): void {
    this.closeRow();
    if (this.tables.length === 0) return;
    const table = this.tables.pop()!;
    if (table.headers.length > 0 || table.rows.length > 0) this.blocks.push(table);
  }

  private closeHeading(): void {
    if (this.heading === null) return;
    const { level, chunks } = this.heading;
    this.heading = null;
    const text = clean(chunks.join(""));
    if (text) this.blocks.push({ level, text });
  }

  private closeEverything(): void {
    this.closeHeading();
    while (this.tables.length > 0) this.closeTable();
  }
}

/** Every heading and table on the page, in document order. */
export function blocks(html: string): Block[] {
  const reader = new Reader();
  reader.feed(html ?? "");
  return reader.blocks;
}

export function tables(html: string): Table[] {
  return blocks(html).filter((block): block is Table => !isHeading(block));
}

export function headings(html: string): Heading[] {
  return blocks(html).filter((block): block is Heading => isHeading(block));
}

export interface Section {
  level: number;
  heading: string;
  text: string;
  items: string[];
}

/** Splits a fragment into sections, keeping each `<li>` as its own string.
 * Content before the first heading lands in a section with an empty heading,
 * which is the normal case for the AJAX fragments. */
function prose(html: string): Section[] {
  const sections: Section[] = [{ level: 0, heading: "", text: "", items: [] }];
  let ignore = 0;
  let sink: string[] | null = null;
  let isHeading = false;
  let isItem = false;
  let pendingLevel = 0;
  let proseSink: string[] = [];

  const bankProse = (): void => {
    const text = clean(proseSink.join(""));
    proseSink = [];
    if (!text) return;
    const current = sections[sections.length - 1]!;
    current.text = current.text ? `${current.text} ${text}`.trim() : text;
  };
  const flush = (): void => {
    if (sink === null) return;
    const content = clean(sink.join(""));
    const wasHeading = isHeading;
    const wasItem = isItem;
    sink = null;
    isHeading = false;
    isItem = false;
    if (wasHeading) {
      // Prose sitting between the previous heading and this one belongs to
      // the previous heading, so bank it before opening the new section.
      bankProse();
      if (content) sections.push({ level: pendingLevel, heading: content, text: "", items: [] });
    } else if (wasItem && content) {
      bankProse();
      sections[sections.length - 1]!.items.push(content);
    }
  };

  const tokens = tokenize(html ?? "");
  const start = (tag: string): void => {
    if (IGNORED_TAGS.has(tag)) ignore += 1;
    else if (HEADING_TAGS[tag]) {
      flush();
      sink = [];
      isHeading = true;
      pendingLevel = HEADING_TAGS[tag]!;
    } else if (tag === "li") {
      flush();
      sink = [];
      isItem = true;
    } else if (BREAK_TAGS.has(tag)) {
      (sink ?? proseSink).push(" ");
    }
  };
  const end = (tag: string): void => {
    if (IGNORED_TAGS.has(tag)) ignore = Math.max(0, ignore - 1);
    else if (HEADING_TAGS[tag] || tag === "li") flush();
  };
  for (const token of tokens) {
    if (token.kind === "data") {
      if (!ignore) (sink ?? proseSink).push(token.decoded ? unescapeHtml(token.data) : token.data);
    } else if (token.kind === "start") start(token.tag);
    else if (token.kind === "end") end(token.tag);
    else {
      start(token.tag);
      end(token.tag);
    }
  }
  flush();
  bankProse();
  return sections.filter((s) => s.heading || s.text || s.items.length > 0);
}

/** Every heading in a fragment with the prose and list items beneath it. */
export function sections(html: string): Section[] {
  return prose(html);
}

/** The list items in a fragment, in order. Falls back to the fragment's prose
 * when UBC writes a requirement as a sentence instead of a list. */
export function items(html: string): string[] {
  const found = prose(html).flatMap((section) => section.items);
  if (found.length > 0) return found;
  const plain = text(html);
  return plain ? [plain] : [];
}

/** A fragment as plain text, list items included, whitespace collapsed. */
export function text(html: string): string {
  const parts: string[] = [];
  for (const section of sections(html)) {
    parts.push(...[section.heading, section.text, ...section.items].filter(Boolean));
  }
  return clean(parts.join(" "));
}
