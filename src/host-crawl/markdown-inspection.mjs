import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import MarkdownIt from "markdown-it";
import {
  fail,
  hasUnsafeMarkdownCharacter,
  MARKDOWN_INSPECTION_LIMITS as LIMITS,
  validateAdvertisements,
  validateDestination,
  validateTitle,
} from "./markdown-contract.mjs";

export { MARKDOWN_INSPECTION_DIALECT, MARKDOWN_INSPECTION_LIMITS } from "./markdown-contract.mjs";

const UNSAFE_SOURCE = /[\p{Cf}\p{Cs}\uFFFD]|(?![\t\r\n])\p{Cc}/u;
const RESIDUAL = /[[\]`|{}]|:::|\$\$|~~/;
const ALLOWED = new Set([
  "heading_open",
  "heading_close",
  "paragraph_open",
  "paragraph_close",
  "blockquote_open",
  "blockquote_close",
  "bullet_list_open",
  "bullet_list_close",
  "ordered_list_open",
  "ordered_list_close",
  "list_item_open",
  "list_item_close",
  "inline",
  "hr",
  "fence",
  "text",
  "text_special",
  "code_inline",
  "softbreak",
  "hardbreak",
  "em_open",
  "em_close",
  "strong_open",
  "strong_close",
  "link_open",
  "link_close",
]);
const UNSUPPORTED = new Map([
  ["reference_definition", "reference definitions"],
  ["table_open", "tables"],
  ["code_block", "indented code"],
  ["image", "images"],
  ["html_inline", "raw HTML"],
  ["html_block", "raw HTML"],
  ["s_open", "strikethrough"],
  ["s_close", "strikethrough"],
]);

function allowedToken(type) {
  if (!ALLOWED.has(type)) fail(UNSUPPORTED.get(type) ?? "unsupported token");
}

function copySource(bytes) {
  if (!(bytes instanceof Uint8Array)) fail("invalid byte input");
  if (bytes.buffer instanceof SharedArrayBuffer) fail("shared buffer");
  if (!bytes.byteLength) fail("empty source");
  if (bytes.byteLength > LIMITS.inputBytes) fail("input byte limit");
  const copy = new Uint8Array(bytes);
  if (copy[0] === 0xef && copy[1] === 0xbb && copy[2] === 0xbf) fail("BOM");
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy);
  } catch {
    fail("invalid UTF-8");
  }
  if (UNSAFE_SOURCE.test(source)) fail("unsafe source character");
  const lines = source.split(/\r\n?|\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > LIMITS.lines) fail("line count limit");
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > LIMITS.lineBytes) fail("line byte limit");
  }
  const initial = lines.find((line) => /\S/.test(line));
  if (initial !== undefined && /^ {0,3}(?:---|\+\+\+)[\t ]*$/.test(initial)) fail("reserved frontmatter");
  return { copy, source };
}

function pinnedRule(ruler, name) {
  const rule = ruler.__rules__?.find((entry) => entry.name === name);
  if (!rule?.enabled || typeof rule.fn !== "function") fail("parser implementation mismatch");
  return rule;
}

function checkFence(token, lines) {
  const [start, end] = token.map ?? [];
  if (token.level !== 0 || !lines[start]?.startsWith(token.markup)) fail("root column-zero fence required");
  if (token.info !== "") fail("fence info is unsupported");
  const marker = token.markup[0];
  if ((marker !== "`" && marker !== "~") || token.markup.length < 3) fail("parser implementation mismatch");
  const closing = new RegExp(`^ {0,3}${marker}{${token.markup.length},}[ \\t]*$`);
  if (end < start + 2 || !closing.test(lines[end - 1] ?? "")) fail("unclosed fence");
}

function flatten(tokens) {
  return tokens
    .map((token) => (token.type === "softbreak" || token.type === "hardbreak" ? " " : token.content))
    .join("");
}

function inspectTokens(tokens, lines, counters, recordDepth) {
  const stack = [];
  const lists = [];
  const links = [];
  const seen = new Set();
  let heading;
  let semantic = false;

  function sequence(items, base) {
    const inlineStack = [];
    let citation;
    for (const token of items) {
      allowedToken(token.type);
      if (token.type === "text" && RESIDUAL.test(token.content)) fail("residual syntax");
      if (token.type === "text_special") {
        if (!["entity", "escape"].includes(token.info)) fail("parser implementation mismatch");
        if (hasUnsafeMarkdownCharacter(token.content)) fail("unsafe entity");
      }
      if (token.type === "text" && /[^\s*_]/.test(token.content)) semantic = true;
      if (["text_special", "code_inline"].includes(token.type) && /\S/.test(token.content)) semantic = true;
      if (token.type === "link_open") {
        if (token.markup === "autolink" || token.info === "auto") fail("autolinks");
        if (citation || token.meta?.label) fail("unsupported link");
        const url = token.attrGet("href");
        if (typeof url !== "string") fail("parser implementation mismatch");
        validateDestination(url);
        const title = token.attrGet("title");
        if (title !== null && hasUnsafeMarkdownCharacter(title)) fail("unsafe link title");
        citation = { url, children: [] };
      } else if (token.type === "link_close") {
        if (!citation) fail("unbalanced tokens");
        const text = flatten(citation.children);
        const key = JSON.stringify([text, citation.url]);
        if (!seen.has(key)) {
          links.push({ text, url: citation.url });
          seen.add(key);
        }
        citation = undefined;
      } else if (citation) citation.children.push(token);
      balance(token, inlineStack, base, recordDepth);
    }
    if (inlineStack.length || citation) fail("unbalanced tokens");
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    allowedToken(token.type);
    if (token.type === "heading_open" && token.tag === "h1" && stack.length === 0) {
      if (heading !== undefined) fail("multiple root H1");
      const inline = tokens[index + 1];
      if (inline?.type !== "inline" || !Array.isArray(inline.children)) fail("parser implementation mismatch");
      heading = flatten(inline.children).replace(/^ +| +$/g, "");
    }
    if (token.type === "ordered_list_open" || token.type === "bullet_list_open") {
      lists.push({ ordered: token.type === "ordered_list_open", next: undefined });
    }
    if (token.type === "list_item_open") {
      const list = lists.at(-1);
      if (!list) fail("unbalanced tokens");
      if (list.ordered) {
        if (!/^\d{1,9}$/.test(token.info)) fail("ordered list ordinal");
        const ordinal = Number(token.info);
        if (list.next !== undefined && list.next !== ordinal) fail("ordered list ordinal");
        list.next = ordinal + 1;
      }
    }
    if (token.type === "ordered_list_close" || token.type === "bullet_list_close") lists.pop();
    if (token.type === "fence") {
      checkFence(token, lines);
      if (/\S/.test(token.content)) semantic = true;
    }
    if (token.type === "inline") sequence(token.children, stack.length);
    balance(token, stack, 0, recordDepth);
  }
  if (stack.length || lists.length) fail("unbalanced tokens");
  if (heading !== undefined) validateTitle(heading);
  if (!semantic) fail("missing semantic text");
  return {
    heading,
    links,
    stats: { emitted_tokens: counters.tokens, links: counters.links, max_depth: counters.depth },
  };
}

function balance(token, stack, base, recordDepth) {
  if (token.nesting === 1) {
    stack.push(token.type.replace(/_open$/, ""));
    recordDepth(base + stack.length);
  } else if (token.nesting === -1) {
    if (stack.pop() !== token.type.replace(/_close$/, "")) fail("unbalanced tokens");
  } else if (token.nesting !== 0) fail("parser implementation mismatch");
}

function instrumentParser() {
  const md = new MarkdownIt("default", {
    html: true,
    linkify: false,
    typographer: false,
    breaks: false,
    highlight: null,
    maxNesting: 64,
  });
  const counters = { tokens: 0, links: 0, depth: 0 };
  const recordDepth = (depth) => {
    if (depth < 0 || depth > LIMITS.nesting) fail("nesting limit");
    counters.depth = Math.max(counters.depth, depth);
  };
  const emitted = (type, level, nesting) => {
    allowedToken(type);
    if (++counters.tokens > LIMITS.tokens) fail("token limit");
    if (type === "link_open" && ++counters.links > LIMITS.links) fail("link limit");
    recordDepth(level + Math.max(0, nesting));
  };
  const BlockState = md.block.State;
  const InlineState = md.inline.State;
  for (const hook of [
    BlockState?.prototype.push,
    InlineState?.prototype.push,
    InlineState?.prototype.pushPending,
    md.block.tokenize,
    md.inline.tokenize,
    md.inline.skipToken,
    md.normalizeLink,
    md.helpers.parseLinkDestination,
  ]) {
    if (typeof hook !== "function") fail("parser implementation mismatch");
  }
  for (const name of ["normalize", "block", "strip_references", "inline", "text_join"]) pinnedRule(md.core.ruler, name);
  for (const name of ["table", "code", "fence", "reference", "html_block"]) pinnedRule(md.block.ruler, name);
  for (const name of ["backticks", "image", "autolink", "html_inline", "entity", "strikethrough"])
    pinnedRule(md.inline.ruler, name);
  for (const name of ["balance_pairs", "strikethrough", "emphasis", "fragments_join"])
    pinnedRule(md.inline.ruler2, name);

  md.block.State = class extends BlockState {
    push(type, tag, nesting) {
      // Table and reference emissions must fail before cell expansion or reference stripping.
      emitted(type, this.level, nesting);
      return super.push(type, tag, nesting);
    }
  };
  md.inline.State = class extends InlineState {
    push(type, tag, nesting) {
      emitted(type, this.level, nesting);
      return super.push(type, tag, nesting);
    }
    pushPending() {
      emitted("text", this.pendingLevel, 0);
      return super.pushPending();
    }
  };
  let recursion = 0;
  for (const [parser, method] of [
    [md.block, "tokenize"],
    [md.inline, "tokenize"],
    [md.inline, "skipToken"],
  ]) {
    const original = parser[method];
    parser[method] = function (state, ...args) {
      recordDepth(state.level + (method === "skipToken" ? 1 : 0));
      recordDepth(++recursion);
      try {
        return original.call(this, state, ...args);
      } finally {
        recursion--;
      }
    };
  }

  const backticks = pinnedRule(md.inline.ruler, "backticks").fn;
  md.inline.ruler.at("backticks", (state, silent) => {
    const start = state.pos;
    const count = state.tokens.length;
    const matched = backticks(state, silent);
    const token = state.tokens.at(-1);
    if (!silent && state.tokens.length > count && token.type === "code_inline") {
      const raw = state.src.slice(start + token.markup.length, state.pos - token.markup.length);
      if (raw !== token.content) fail("code span normalization");
    }
    return matched;
  });

  // Wrap helpers per instance without changing the original helper table.
  const helpers = md.helpers;
  md.helpers = {
    ...helpers,
    parseLinkDestination(source, start, max) {
      const parsed = helpers.parseLinkDestination(source, start, max);
      if (parsed.ok) {
        const angled = source[start] === "<";
        validateDestination(source.slice(start + (angled ? 1 : 0), parsed.pos - (angled ? 1 : 0)), true);
        validateDestination(parsed.str);
      }
      return parsed;
    },
  };
  const normalizeLink = md.normalizeLink;
  md.normalizeLink = (value) => {
    validateDestination(value);
    const normalized = normalizeLink(value);
    validateDestination(normalized);
    return normalized;
  };
  md.validateLink = (value) => {
    validateDestination(value);
    return true;
  };
  let inspected;
  md.core.ruler.before("text_join", "inspect_verbatim", (state) => {
    inspected = inspectTokens(state.tokens, state.src.split("\n"), counters, recordDepth);
  });
  return {
    parse(source) {
      md.parse(source, Object.create(null));
      if (!inspected) fail("parser implementation mismatch");
      return inspected;
    },
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Inspect the restricted dialect without returning a body; this synchronous function is not a resource sandbox. */
export function inspectMarkdownSource(bytes, advertisedTitles) {
  const { copy, source } = copySource(bytes);
  const advertisement = validateAdvertisements(advertisedTitles);
  const { heading, links, stats } = instrumentParser().parse(source);
  const selection = heading === undefined ? advertisement : { title: heading, title_origin: { kind: "markdown-body" } };
  if (!selection) fail("missing title");
  validateTitle(selection.title);
  const result = {
    source_bytes: copy.byteLength,
    source_bytes_sha256: createHash("sha256").update(copy).digest("hex"),
    ...selection,
    links,
    stats,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > LIMITS.metadataBytes) fail("metadata byte limit");
  return deepFreeze(result);
}
