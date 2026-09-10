import { load } from "cheerio";
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import TurndownService from "turndown";
import { normalizedHref } from "./urls.ts";

export interface MarkdownResult {
  markdown: string;
  links: Array<{ text: string; url: string }>;
  warnings: string[];
}

type Token = ReturnType<typeof markdownParser.parse>[number];

const HTTP_SCHEMES = new Set(["http:", "https:"]);
const LINK_SCHEMES = new Set([...HTTP_SCHEMES, "mailto:", "tel:"]);
const REMOVED_CONTENT = ["script", "style", "form", "textarea", "select", "option", "xmp", "head"];
const MEDIA_TAGS = new Set(["iframe", "embed", "object", "video", "audio", "canvas", "svg"]);
const UNSAFE_URL_CHARACTERS = /[\\\p{Cc}\p{Cf}\uFFFD]/u;
const MAILBOX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const markdownParser = new MarkdownIt({ html: true, linkify: false });

// Expose unsafe destinations to validation instead of letting the parser hide them as text.
markdownParser.validateLink = () => true;

function inspectedUrl(value: string): string | undefined {
  let decoded = value;
  for (let depth = 0; depth < 8; depth++) {
    if (UNSAFE_URL_CHARACTERS.test(decoded)) return undefined;
    if (/^[^/?]*&(?:#(?:x[\da-f]+|\d+);?|(?:colon|tab|newline|amp);)/i.test(decoded)) return undefined;
    const scheme = /^([^/?#]*):/.exec(decoded)?.[1];
    if (scheme !== undefined && !LINK_SCHEMES.has(`${scheme.toLowerCase()}:`)) return undefined;
    const next = decoded.replace(/(?:%[\da-f]{2})+/gi, (sequence) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        return sequence.replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      }
    });
    if (next === decoded) return decoded;
    decoded = next;
  }
  return undefined;
}

function safeMailboxes(value: string): boolean {
  return value.split(",").every((mailbox) => MAILBOX.test(mailbox));
}

function safeUrl(value: string, base?: string, schemes = LINK_SCHEMES): string | undefined {
  value = normalizedHref(value);
  const inspected = inspectedUrl(value);
  if (inspected === undefined) return undefined;
  const trimmed = value.trim();
  if (/^https?:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    const url = base === undefined ? new URL(trimmed) : new URL(trimmed, base);
    const decodedUrl = base === undefined ? new URL(inspected.trim()) : new URL(inspected.trim(), base);
    if (!schemes.has(url.protocol) || url.username || url.password || decodedUrl.username || decodedUrl.password) {
      return undefined;
    }
    if (url.protocol === "mailto:") {
      if (!safeMailboxes(decodedUrl.pathname) || decodedUrl.hash) return undefined;
      for (const [key, content] of decodedUrl.searchParams) {
        if (!["subject", "body", "cc", "bcc"].includes(key.toLowerCase())) return undefined;
        if (["cc", "bcc"].includes(key.toLowerCase()) && !safeMailboxes(content)) return undefined;
      }
    }
    if (url.protocol === "tel:") {
      if (decodedUrl.search || decodedUrl.hash || !/^\+?[\d(). -]+(?:;ext=\d+)?$/i.test(decodedUrl.pathname)) {
        return undefined;
      }
      if (!/\d/.test(decodedUrl.pathname)) return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (character) => HTML_ENTITIES[character]!).replace(/[\\`*_{}[\]()#+.!|~=-]/g, "\\$&");
}

function linkDestination(url: string): string {
  return url
    .replace(/[\s<>()[\]`"'|\\]/g, (character) =>
      Array.from(
        new TextEncoder().encode(character),
        (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
      ).join(""),
    )
    .replace(/&/g, "&amp;");
}

function sanitizeProse(html: string, sourceUrl: string, warnings: Set<string>): string {
  const transform: sanitizeHtml.Transformer = (tagName, attribs): sanitizeHtml.Tag => {
    if (tagName === "a") {
      const href = attribs.href === undefined ? undefined : safeUrl(attribs.href, sourceUrl);
      if (attribs.href !== undefined && normalizedHref(attribs.href) !== attribs.href)
        warnings.add("Normalized an explicit email address or bare hostname into a link URL.");
      if (attribs.href !== undefined && href === undefined) warnings.add("Removed an unsafe or unsupported link URL.");
      return { tagName, attribs: href ? { href, title: attribs.title ?? "" } : {} };
    }
    if (tagName === "img") {
      const href = attribs.src === undefined ? undefined : safeUrl(attribs.src, sourceUrl, HTTP_SCHEMES);
      if (attribs.src && !href) warnings.add("Removed an unsafe or unsupported image URL.");
      return { tagName: "a", attribs: href ? { href } : {}, text: attribs.alt || attribs.title || "Image" };
    }
    if (MEDIA_TAGS.has(tagName)) {
      warnings.add("Embedded content is linked rather than embedded; consult the source for its full content.");
      const href = safeUrl(attribs.src ?? attribs.data ?? "", sourceUrl, HTTP_SCHEMES) ?? sourceUrl;
      return {
        tagName: "a",
        attribs: { href },
        text: attribs.title ? `Embedded content: ${attribs.title}` : `Embedded ${tagName} (view source)`,
      };
    }
    if (tagName === "source" || tagName === "track") {
      const href = attribs.src === undefined ? undefined : safeUrl(attribs.src, sourceUrl, HTTP_SCHEMES);
      return { tagName: "a", attribs: href ? { href } : {}, text: href ? attribs.label || "Media source" : "" };
    }
    if (
      tagName === "aside" ||
      (tagName === "div" &&
        (attribs.role === "alert" ||
          attribs.role === "note" ||
          /(?:^|\s)(?:alert(?:-[\w-]+)?|advisory|callout|warning|notice)(?:\s|$)/i.test(attribs.class ?? "")))
    ) {
      return { tagName: "blockquote", attribs: {} };
    }
    if (["noscript", "template", "picture"].includes(tagName)) return { tagName: "div", attribs: {} };
    if (tagName === "button") return { tagName: "strong", attribs: {} };
    if (["kbd", "samp"].includes(tagName)) return { tagName: "code", attribs: {} };
    if (tagName === "ol" && attribs.start !== undefined && !/^\d{1,9}$/.test(attribs.start)) {
      warnings.add("An unsupported ordered-list start value is omitted.");
      return { tagName, attribs: {} };
    }
    return { tagName, attribs };
  };
  return sanitizeHtml(html, {
    allowedTags: [
      "a",
      "abbr",
      "address",
      "article",
      "b",
      "blockquote",
      "br",
      "caption",
      "cite",
      "code",
      "dd",
      "del",
      "details",
      "dfn",
      "div",
      "dl",
      "dt",
      "em",
      "figcaption",
      "figure",
      "footer",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hr",
      "i",
      "label",
      "li",
      "main",
      "mark",
      "ol",
      "p",
      "q",
      "s",
      "section",
      "small",
      "pre",
      "span",
      "strike",
      "strong",
      "sub",
      "summary",
      "sup",
      "table",
      "tbody",
      "td",
      "tfoot",
      "th",
      "thead",
      "time",
      "tr",
      "u",
      "ul",
      "var",
      "wbr",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      abbr: ["title"],
      ol: ["start"],
      table: ["summary"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: [...LINK_SCHEMES].map((scheme) => scheme.slice(0, -1)),
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: REMOVED_CONTENT,
    parseStyleAttributes: false,
    enforceHtmlBoundary: false,
    // Named transforms retain replacement text; sanitize-html ignores text on its wildcard transform.
    transformTags: Object.fromEntries(["*", "img", ...MEDIA_TAGS, "source", "track"].map((tag) => [tag, transform])),
    onOpenTag(name, attributes) {
      if (REMOVED_CONTENT.includes(name) || Object.keys(attributes).some((attribute) => /^on/i.test(attribute))) {
        warnings.add("Removed executable markup, form controls, or event attributes.");
      }
    },
  });
}

function indent(text: string, spaces: number): string {
  return text
    .split("\n")
    .map((line) => `${" ".repeat(spaces)}${line}`)
    .join("\n");
}

function tableMarkdown(html: string, converter: TurndownService, warnings: Set<string>): string {
  const $ = load(html, {}, false);
  const table = $("table").first();
  const caption = table
    .children("caption")
    .toArray()
    .map((node) => converter.turndown($(node).html() ?? ""))
    .join("\n\n");
  const summary = table.attr("summary");
  const introduction = [caption, summary ? escapeText(summary) : ""].filter(Boolean).join("\n\n");
  const rows = table
    .find("tr")
    .toArray()
    .filter((node) => $(node).closest("table")[0] === table[0])
    .map((row) => ({
      footer: $(row).parent().is("tfoot"),
      cells: $(row)
        .children("th, td")
        .toArray()
        .map((cell) => ({
          markdown: converter.turndown($(cell).html() ?? ""),
          header: $(cell).is("th") || $(row).parent().is("thead"),
          colspan: $(cell).attr("colspan"),
          rowspan: $(cell).attr("rowspan"),
          block: $(cell).find("blockquote, ul, ol, dl, pre, table, h1, h2, h3, h4, h5, h6, details").length > 0,
          codePipe: $(cell)
            .find("code")
            .toArray()
            .some((code) => $(code).text().includes("|")),
        })),
    }));
  if (!rows.length) return `\n\n${introduction}\n\n`;
  const complex = rows.some((row) =>
    row.cells.some(
      (cell) =>
        cell.block ||
        cell.codePipe ||
        cell.markdown.includes("\n") ||
        (cell.colspan !== undefined && Number(cell.colspan) !== 1) ||
        (cell.rowspan !== undefined && Number(cell.rowspan) !== 1),
    ),
  );
  if (complex) {
    warnings.add("A complex table is represented as row/cell lists; merged-cell spans are labelled.");
    const body = rows
      .map((row, rowIndex) => {
        const cells = row.cells
          .map((cell, cellIndex) => {
            const spans = [
              cell.colspan === undefined ? "" : `colspan ${escapeText(cell.colspan)}`,
              cell.rowspan === undefined ? "" : `rowspan ${escapeText(cell.rowspan)}`,
            ].filter(Boolean);
            const label = `${cell.header ? "Header cell" : "Cell"} ${cellIndex + 1}${spans.length ? ` (${spans.join("; ")})` : ""}`;
            return `- **${label}:**\n\n${indent(cell.markdown || "(empty)", 2)}`;
          })
          .join("\n\n");
        return `- **${row.footer ? "Footer row" : "Row"} ${rowIndex + 1}**\n\n${indent(cells || "(empty)", 2)}`;
      })
      .join("\n\n");
    return `\n\n${[introduction, body].filter(Boolean).join("\n\n")}\n\n`;
  }
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.cells.length), 0);
  if (!width) return `\n\n${introduction}\n\n`;
  const hasHeader = rows[0]!.cells.length > 0 && rows[0]!.cells.every((cell) => cell.header);
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  const header = hasHeader ? rows[0]!.cells.map((cell) => cell.markdown) : [];
  if (!hasHeader)
    warnings.add("A headerless table receives an empty Markdown header; all source rows remain data rows.");
  const body = rows
    .slice(hasHeader ? 1 : 0)
    .map((row) =>
      line(row.cells.map((cell) => (cell.header && cell.markdown ? `**${cell.markdown}**` : cell.markdown))),
    );
  return `\n\n${[introduction, [line(header), line(Array<string>(width).fill("---")), ...body].join("\n")].filter(Boolean).join("\n\n")}\n\n`;
}

function codeFence(code: string, minimum: number): string {
  let length = minimum;
  for (const match of code.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return "`".repeat(length);
}

function codeBlockMarkdown(code: string): string {
  // A longer fence also protects code containing indented closing-fence candidates.
  const fence = codeFence(code, 3);
  return `\n\n${fence}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
}

function inlineCodeMarkdown(text: string): string {
  const code = text.replace(/\r\n?|\n/g, " ");
  if (!code) return "";
  const fence = codeFence(code, 1);
  const padding = /^`|`$|^ .* $/.test(code) && /\S/.test(code) ? " " : "";
  return `${fence}${padding}${code}${padding}${fence}`;
}

function converterFor(warnings: Set<string>): TurndownService {
  const converter = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    preformattedCode: true,
    hr: "---",
    blankReplacement(_content, node) {
      if (node.nodeName === "PRE") return codeBlockMarkdown(String(node.textContent ?? ""));
      if (node.nodeName === "CODE") return inlineCodeMarkdown(String(node.textContent ?? ""));
      return (node as { isBlock?: boolean }).isBlock ? "\n\n" : "";
    },
  });
  converter.escape = escapeText;
  converter.addRule("safeLinks", {
    filter: "a",
    replacement(content, node) {
      const href = node.getAttribute("href");
      if (!href) return content;
      const title = node.getAttribute("title");
      const titlePart = title
        ? ` "${title
            .replace(/[&<>]/g, (character: string) => HTML_ENTITIES[character]!)
            .replace(/[\\"]/g, "\\$&")
            .replace(/\s+/g, " ")}"`
        : "";
      const destination = `${linkDestination(href)}${titlePart}`;
      if (
        content.trim().includes("\n\n") ||
        node.querySelector("h1, h2, h3, h4, h5, h6, p, pre, table, blockquote, ul, ol, dl")
      ) {
        warnings.add("A link wrapping block content is shown as a separate source link.");
        return `\n\n${content.trim()}\n\n[${escapeText(title || "Source link")}](${destination})\n\n`;
      }
      const label = content.trim() || escapeText(title || href);
      return `[${label}](${destination})`;
    },
  });
  converter.addRule("codeBlocks", {
    filter: "pre",
    replacement: (_content, node) => codeBlockMarkdown(String(node.textContent ?? "")),
  });
  converter.addRule("inlineCode", {
    filter: "code",
    replacement: (_content, node) => inlineCodeMarkdown(String(node.textContent ?? "")),
  });
  converter.addRule("tablesWithoutHtml", {
    filter: "table",
    replacement: (_content, node) => tableMarkdown(node.outerHTML, converter, warnings),
  });
  converter.addRule("proseContainers", {
    filter: ["details", "figure", "figcaption", "summary", "dt", "dd", "dl"],
    replacement(content, node) {
      const value = content.trim();
      const emphasize =
        ["SUMMARY", "DT"].includes(node.nodeName) &&
        value &&
        !value.includes("\n") &&
        !node.querySelector("h1, h2, h3, h4, h5, h6, strong, b");
      return `\n\n${emphasize ? `**${value}**` : value}\n\n`;
    },
  });
  converter.addRule("strikethrough", {
    filter: ["del", "s", "strike"],
    replacement: (content) => (content ? `~~${content}~~` : ""),
  });
  converter.addRule("footnoteMarkers", { filter: "sup", replacement: (content) => `\\[${content}\\]` });
  converter.addRule("subscripts", { filter: "sub", replacement: (content) => `\\[subscript: ${content}\\]` });
  converter.addRule("abbreviations", {
    filter: "abbr",
    replacement(content, node) {
      const title = node.getAttribute("title");
      return title && title !== node.textContent ? `${content} (${escapeText(title)})` : content;
    },
  });
  return converter;
}

function* walkTokens(tokens: Token[]): Generator<Token> {
  for (const token of tokens) {
    yield token;
    if (token.children) yield* walkTokens(token.children);
  }
}

function safeTokens(markdown: string): Token[] {
  const tokens = markdownParser.parse(markdown, {});
  for (const token of walkTokens(tokens)) {
    if (token.type === "html_block" || token.type === "html_inline")
      throw new Error("Unsafe Markdown: raw HTML is forbidden.");
    if (token.type === "image") throw new Error("Unsafe Markdown: image embedding is forbidden.");
    const href = token.attrGet("href");
    if (href !== null && (typeof href !== "string" || safeUrl(href) === undefined)) {
      throw new Error("Unsafe Markdown: unsupported or unsafe link destination.");
    }
  }
  return tokens;
}

/** Reject raw HTML tokens, embedded images, and unsafe destinations; allow inert HTML spellings in code or escaped text. */
export function assertSafeMarkdown(markdown: string): void {
  safeTokens(markdown);
}

/**
 * Sanitize HTML before conversion without fetching resources or truncating prose.
 * Represent complex tables as labelled row/cell lists and media as links.
 * Throw for an invalid source URL or unsafe generated Markdown.
 */
export function toSafeMarkdown(html: string, sourceUrl: string): MarkdownResult {
  const source = safeUrl(sourceUrl, undefined, HTTP_SCHEMES);
  if (!source) throw new Error("A credential-free HTTP(S) source URL is required.");
  const warnings = new Set<string>();
  const sanitized = sanitizeProse(html, source, warnings);
  const markdown = converterFor(warnings).turndown(sanitized);
  return { markdown, links: markdownLinks(markdown), warnings: [...warnings] };
}

/** Validate Markdown and extract its normalized link metadata in document order. */
export function markdownLinks(markdown: string): MarkdownResult["links"] {
  const tokens = safeTokens(markdown);
  const links: MarkdownResult["links"] = [];
  const seen = new Set<string>();
  for (const token of walkTokens(tokens)) {
    if (!token.children) continue;
    for (const [index, child] of token.children.entries()) {
      if (child.type !== "link_open") continue;
      const url = child.attrGet("href");
      if (typeof url !== "string") throw new Error("Unsafe Markdown: a link has no destination.");
      const text: string[] = [];
      for (let position = index + 1; position < token.children.length; position++) {
        const sibling = token.children[position]!;
        if (sibling.type === "link_close") break;
        text.push(["softbreak", "hardbreak"].includes(sibling.type) ? " " : sibling.content);
      }
      const label = text.join("").replace(/\s+/g, " ").trim();
      const key = JSON.stringify([label, url]);
      if (!seen.has(key)) links.push({ text: label, url });
      seen.add(key);
    }
  }
  return links;
}
