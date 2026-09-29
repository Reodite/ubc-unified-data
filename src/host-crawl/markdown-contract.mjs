export const MARKDOWN_INSPECTION_LIMITS = Object.freeze({
  inputBytes: 1048576,
  lineBytes: 16384,
  lines: 16384,
  tokens: 50000,
  links: 2048,
  nesting: 32,
  titleBytes: 4096,
  metadataBytes: 262144,
  advertisedTitles: 6,
  advertisedTitleCodeUnits: 4096,
});
export const MARKDOWN_INSPECTION_DIALECT = "ubc-markdown-verbatim-v2/markdown-it-15.0.2";

const LIMITS = MARKDOWN_INSPECTION_LIMITS;
const UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u;
const MAILBOX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

export function hasUnsafeMarkdownCharacter(value) {
  return UNSAFE_CHARACTER.test(value);
}

export function fail(reason) {
  throw new Error(`Markdown inspection: ${reason}.`);
}

export function validateTitle(title) {
  if (UNSAFE_CHARACTER.test(title) || /[<>]/.test(title)) fail("unsafe title");
  if (!/\S/.test(title)) fail("empty title");
  if (Buffer.byteLength(title, "utf8") > LIMITS.titleBytes) fail("title byte limit");
  return title;
}

export function validateAdvertisements(titles) {
  if (!Array.isArray(titles)) fail("invalid advertisement input");
  if (titles.length > LIMITS.advertisedTitles) fail("advertisement limit");
  let selected;
  for (const [index, title] of titles.entries()) {
    if (title === null) continue;
    if (typeof title !== "string") fail("invalid advertisement input");
    if (title.length > LIMITS.advertisedTitleCodeUnits) fail("advertisement title limit");
    if (UNSAFE_CHARACTER.test(title)) fail("unsafe title in advertisement");
    if (title === "") continue;
    if (selected && selected.title !== title) fail("conflicting advertisement titles");
    selected ??= { title, title_origin: { kind: "advertisement", witness_index: index } };
  }
  return selected;
}

function percentDecode(value) {
  return value.replace(/(?:%[\da-f]{2})+/gi, (sequence) => {
    try {
      return decodeURIComponent(sequence);
    } catch {
      return sequence.replace(/%([\da-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
  });
}

function safeMailboxes(value) {
  return value.split(",").every((mailbox) => MAILBOX.test(mailbox));
}

export function validateDestination(value, lexical = false) {
  let decoded = value;
  for (let depth = 0; depth < 8; depth++) {
    if (UNSAFE_CHARACTER.test(decoded) || decoded.includes("\\")) fail("unsafe link destination");
    const absolute = /^(?:https?:\/\/[^/\s]|mailto:|tel:)/i.test(decoded);
    let url;
    try {
      if (absolute) {
        url = new URL(decoded);
      } else {
        if (/\s/.test(decoded) || !/^(?:\/(?!\/)|\.\.?\/|\?|#)/.test(decoded)) fail("unsafe link destination");
        url = new URL(decoded, "https://markdown.invalid/source");
        if (url.origin !== "https://markdown.invalid") fail("unsafe link destination");
      }
    } catch {
      fail("unsafe link destination");
    }
    if (/^[^/?]*&(?:#(?:x[\da-f]+|\d+);?|(?:colon|tab|newline|amp);)/i.test(decoded)) {
      fail("unsafe link destination");
    }
    if (absolute && (url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(decoded)))
      fail("unsafe link destination");
    const next = percentDecode(decoded);
    if (next !== decoded) {
      decoded = next;
      continue;
    }
    if (!absolute) return;
    if (!lexical && url.protocol === "mailto:") {
      if (!safeMailboxes(url.pathname) || url.hash) fail("unsafe link destination");
      for (const [key, content] of url.searchParams) {
        if (UNSAFE_CHARACTER.test(content) || content.includes("\\")) fail("unsafe link destination");
        if (!["subject", "body", "cc", "bcc"].includes(key.toLowerCase())) fail("unsafe link destination");
        if (["cc", "bcc"].includes(key.toLowerCase()) && !safeMailboxes(content)) fail("unsafe link destination");
      }
    }
    if (!lexical && url.protocol === "tel:") {
      if (url.search || url.hash || !/^\+?[\d(). -]+(?:;ext=\d+)?$/i.test(url.pathname) || !/\d/.test(url.pathname)) {
        fail("unsafe link destination");
      }
    }
    return;
  }
  fail("unsafe link destination");
}
