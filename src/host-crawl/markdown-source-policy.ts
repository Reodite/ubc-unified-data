import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { Observation, Snapshot } from "./contracts.ts";
import { htmlBaseUrl } from "./html-base.ts";

export interface MarkdownSourceDeclaration {
  readonly hostname: string;
  readonly source_url: string;
  readonly target_url: string;
}

export interface MarkdownWitness {
  readonly source_url: string;
  readonly snapshot_sha256: string;
  readonly target_url: string;
  readonly channel: "html-head" | "http-link";
  readonly title: string | null;
}

const DECLARATIONS: readonly MarkdownSourceDeclaration[] = Object.freeze(
  [
    ["manufacturing.engineering.ubc.ca", "1"],
    ["macisaacnursing.ubc.ca", "2421"],
    ["mining.ubc.ca", "1"],
    ["scarp.ubc.ca", "1"],
  ].map(([hostname, node]) =>
    Object.freeze({
      hostname: hostname!,
      source_url: `https://${hostname}/`,
      target_url: `https://${hostname}/node/${node}.md`,
    }),
  ),
);
const EMPTY: readonly never[] = Object.freeze([]);
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_LINKS = 256;
const MAX_PARAMETERS = 32;
const MAX_TAG_BYTES = 16 * 1024;
const MAX_ATTRIBUTES = 64;
const MAX_TITLE_LENGTH = 4096;
const MAX_REDIRECTS = 32;
const TOKEN_CHARACTER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const HTML_SPACE = /[\t\n\f\r ]/;

function fail(reason: string): never {
  throw new Error(`Markdown source policy: ${reason}`);
}

/** Return only the reviewed exact hostname pairs; unknown or differently spelled hosts have no policy. */
export function markdownSources(hostname: string): readonly MarkdownSourceDeclaration[] {
  return Object.freeze(DECLARATIONS.filter((item) => item.hostname === hostname));
}

function reviewed(declaration: MarkdownSourceDeclaration): MarkdownSourceDeclaration {
  const found = DECLARATIONS.find(
    (item) =>
      item.hostname === declaration.hostname &&
      item.source_url === declaration.source_url &&
      item.target_url === declaration.target_url,
  );
  return found ?? fail("declaration is not an exact reviewed source/target pair");
}

/** Resolve strict ASCII references without repairing authority spelling, encoded paths or dot segments. */
function reference(value: string, hostname: string, base: string): string {
  if (!value || /[^\x21-\x7e]|[?#%\\<>"`{}|^]/.test(value)) fail("unsafe URL reference");
  let path = value;
  if (value.startsWith("https://") || value.startsWith("//")) {
    const start = value.startsWith("//") ? 2 : 8;
    const end = value.indexOf("/", start);
    const authority = end === -1 ? value.slice(start) : value.slice(start, end);
    if (authority !== hostname) fail("URL authority differs from the exact host");
    path = end === -1 ? "" : value.slice(end);
  } else if (value.includes(":")) {
    fail("unsupported URL scheme or authority spelling");
  }
  if (path.includes("//") || path.split("/").some((part) => part === "." || part === "..")) fail("ambiguous URL path");
  const url = new URL(value, base);
  if (
    url.protocol !== "https:" ||
    url.hostname !== hostname ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    fail("URL is outside the exact source context");
  return url.href;
}

function exactIdentity(snapshot: Snapshot, expected: string): void {
  if (snapshot.requested_url !== expected || snapshot.url !== expected) fail("requested or final identity differs");
  if ((snapshot.redirects?.length ?? 0) > MAX_REDIRECTS) fail("redirect limit exceeded");
  for (const hop of snapshot.redirects ?? []) {
    // Recorded locations are resolved physical identities, not new alias declarations.
    if (hop.url !== expected || hop.location !== expected) fail("redirect identity differs");
  }
}

/** Check only response identities, not Markdown body eligibility, availability or HTML/Markdown equivalence. */
export function assertMarkdownIdentity(declaration: MarkdownSourceDeclaration, observation: Observation): void {
  exactIdentity(observation.snapshot, reviewed(declaration).target_url);
}

function responseHeader(snapshot: Snapshot, name: string): string | undefined {
  const fields = Object.entries(snapshot.headers).filter(([key]) => key.toLowerCase() === name);
  if (fields.length > 1) fail(`duplicate ${name} header fields`);
  return fields[0]?.[1];
}

function validateSource(observation: Observation, declaration: MarkdownSourceDeclaration): void {
  const snapshot = observation.snapshot;
  exactIdentity(snapshot, declaration.source_url);
  if (!/^[a-f0-9]{64}$/.test(observation.sha256)) fail("invalid snapshot digest");
  if (
    snapshot.status !== 200 ||
    snapshot.binary !== undefined ||
    responseHeader(snapshot, "content-range") !== undefined
  )
    fail("source is not complete nonbinary status-200 HTML");
  const type = responseHeader(snapshot, "content-type");
  if (
    !type ||
    !/^text\/html(?:[\t ]*;[\t ]*charset[\t ]*=[\t ]*(?:[A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"))?[\t ]*$/i.test(type)
  )
    fail("source requires unambiguous text/html media type");
  if (!Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 0 || typeof snapshot.body !== "string")
    fail("invalid complete source body");
  if (snapshot.body.length > MAX_HTML_BYTES || Buffer.byteLength(snapshot.body) > MAX_HTML_BYTES)
    fail("HTML parser byte limit exceeded");
  const link = responseHeader(snapshot, "link");
  if (link !== undefined && (link.length > MAX_HEADER_BYTES || Buffer.byteLength(link) > MAX_HEADER_BYTES))
    fail("HTTP Link byte limit exceeded");
  if (createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") !== observation.sha256)
    fail("snapshot digest does not bind the supplied observation");
}

function titleValue(title: string | undefined): string | null {
  if (title === undefined) return null;
  if (title.length > MAX_TITLE_LENGTH || FORBIDDEN_TEXT.test(title)) fail("unsafe or oversized title");
  return title;
}

function alternate(rel: string | undefined, mime: string | undefined, href: string | undefined): boolean {
  const trimHtmlSpace = (value: string) => value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  const relations = trimHtmlSpace(rel ?? "")
    .toLowerCase()
    .split(/[\t\n\f\r ]+/);
  if (!relations.includes("alternate")) return false;
  if (relations.some((value) => !/^[a-z][a-z0-9.-]*$/.test(value))) fail("unsupported relation token");
  const mediaType = mime === undefined ? undefined : trimHtmlSpace(mime).toLowerCase();
  if (mediaType !== "text/markdown") {
    if (mediaType?.startsWith("text/markdown") || /\.md(?:[?#]|$)/i.test(href ?? ""))
      fail("ambiguous Markdown media type");
    return false;
  }
  if (relations.includes("canonical") || relations.includes("shortlink")) fail("conflicting Markdown relation roles");
  return true;
}

/**
 * Check original start-tag syntax before using Cheerio's decoded attributes. Duplicate names,
 * malformed values and excessive attributes fail instead of relying on HTML error recovery.
 */
function validateTag(raw: string, expectedName: string): void {
  if (Buffer.byteLength(raw) > MAX_TAG_BYTES) fail("HTML start-tag limit exceeded");
  if (FORBIDDEN_TEXT.test(raw.replace(/[\t\n\f\r]/g, ""))) fail("unsafe original HTML attribute text");
  const prefix = new RegExp(`^<${expectedName}(?=[\\t\\n\\f\\r />])`, "i").exec(raw);
  if (!prefix) fail("missing original HTML start tag");
  let cursor = prefix[0].length;
  const names = new Set<string>();
  while (cursor < raw.length) {
    const previous = cursor;
    while (HTML_SPACE.test(raw[cursor] ?? "")) cursor++;
    if (raw.slice(cursor) === ">" || raw.slice(cursor) === "/>") return;
    if (cursor === previous) fail("HTML attributes require whitespace separators");
    const start = cursor;
    while (cursor < raw.length && !/[\t\n\f\r /=>]/.test(raw[cursor]!)) cursor++;
    const name = raw.slice(start, cursor).toLowerCase();
    if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name) || names.has(name)) fail("malformed or duplicate HTML attribute");
    names.add(name);
    if (names.size > MAX_ATTRIBUTES) fail("HTML attribute limit exceeded");
    const afterName = cursor;
    while (HTML_SPACE.test(raw[cursor] ?? "")) cursor++;
    if (raw[cursor] !== "=") {
      cursor = afterName;
      continue;
    }
    cursor++;
    while (HTML_SPACE.test(raw[cursor] ?? "")) cursor++;
    const quote = raw[cursor];
    if (quote === '"' || quote === "'") {
      const end = raw.indexOf(quote, ++cursor);
      if (end === -1) fail("unterminated HTML attribute");
      cursor = end + 1;
    } else {
      const startValue = cursor;
      while (cursor < raw.length && !/[\t\n\f\r >]/.test(raw[cursor]!)) {
        if (/["'<=`]/.test(raw[cursor]!)) fail("malformed unquoted HTML attribute");
        cursor++;
      }
      if (cursor === startValue) fail("missing HTML attribute value");
    }
  }
  fail("unterminated HTML start tag");
}

interface Advertisement {
  href: string;
  title: string | null;
}

function htmlAdvertisements(
  html: string,
  declaration: MarkdownSourceDeclaration,
): { base: string; links: Advertisement[] } {
  const $ = load(html, { sourceCodeLocationInfo: true });
  const headElement = $("head")[0];
  const head = headElement?.sourceCodeLocation;
  const bases = $("base[href]").toArray();
  // The shared base selector includes template contents and relocated nodes; neither can set this source context.
  for (const node of bases) {
    const location = node.sourceCodeLocation;
    if (
      !head?.startTag ||
      !head.endTag ||
      !location ||
      node.parent !== headElement ||
      location.startOffset < head.startTag.endOffset ||
      location.endOffset > head.endTag.startOffset
    )
      fail("HTML base is outside the active original head");
    validateTag(html.slice(location.startOffset, location.endOffset), "base");
  }
  const base = htmlBaseUrl(html, declaration.hostname, declaration.source_url, true);
  for (const node of bases) {
    if (reference($(node).attr("href")!, declaration.hostname, declaration.source_url) !== base)
      fail("HTML base requires URL repair");
  }
  const links: Advertisement[] = [];
  const nodes = $("head > link").toArray();
  if (nodes.length > MAX_LINKS) fail("HTML link count limit exceeded");
  if (!head?.startTag) return { base, links };
  if (!head.endTag) fail("original head is not explicitly closed");
  for (const node of nodes) {
    const location = node.sourceCodeLocation;
    if (!location || location.startOffset < head.startTag.endOffset || location.endOffset > head.endTag.startOffset)
      continue;
    validateTag(html.slice(location.startOffset, location.endOffset), "link");
    const attrs = node.attribs;
    if (!alternate(attrs.rel, attrs.type, attrs.href)) continue;
    if (attrs.href === undefined) fail("Markdown link lacks href");
    links.push({ href: attrs.href, title: titleValue(attrs.title) });
  }
  return { base, links };
}

interface HeaderLink {
  href: string;
  parameters: Map<string, string>;
}

/**
 * Accept comma-separated <URI-reference> values with unique case-insensitive token parameters.
 * Values are HTTP tokens or quoted strings with backslash quoted-pairs; MIME values need quotes.
 * Optional whitespace is SP/HTAB. Empty entries, extended parameters (including title*), bare
 * parameters, folded/control-bearing values and parser overflow fail for the entire field.
 */
function parseLinkHeader(value: string): HeaderLink[] {
  if (FORBIDDEN_TEXT.test(value.replaceAll("\t", ""))) fail("unsafe HTTP Link field");
  let cursor = 0;
  const whitespace = () => {
    while (value[cursor] === " " || value[cursor] === "\t") cursor++;
  };
  const token = () => {
    const start = cursor;
    while (cursor < value.length && TOKEN_CHARACTER.test(value[cursor]!)) cursor++;
    if (start === cursor) fail("missing HTTP Link token");
    return value.slice(start, cursor);
  };
  const parameterValue = () => {
    if (value[cursor] !== '"') return token();
    cursor++;
    const chars: string[] = [];
    while (cursor < value.length) {
      const character = value[cursor++]!;
      if (character === '"') return chars.join("");
      if (character === "\\") {
        if (cursor === value.length) fail("unfinished HTTP quoted-pair");
        chars.push(value[cursor++]!);
      } else {
        chars.push(character);
      }
    }
    return fail("unterminated HTTP quoted string");
  };
  const result: HeaderLink[] = [];
  while (true) {
    whitespace();
    if (value[cursor++] !== "<") fail("HTTP Link requires an angle-delimited reference");
    const start = cursor;
    while (cursor < value.length && value[cursor] !== ">") {
      if (/[\s<>"\\]/.test(value[cursor]!)) fail("malformed HTTP Link reference");
      cursor++;
    }
    if (cursor === value.length || start === cursor) fail("missing HTTP Link reference");
    const href = value.slice(start, cursor++);
    const parameters = new Map<string, string>();
    whitespace();
    while (value[cursor] === ";") {
      cursor++;
      whitespace();
      const name = token().toLowerCase();
      if (name.includes("*") || parameters.has(name)) fail("extended or duplicate HTTP Link parameter");
      whitespace();
      if (value[cursor++] !== "=") fail("HTTP Link parameter requires a value");
      whitespace();
      parameters.set(name, parameterValue());
      if (parameters.size > MAX_PARAMETERS) fail("HTTP Link parameter limit exceeded");
      whitespace();
    }
    result.push({ href, parameters });
    if (result.length > MAX_LINKS) fail("HTTP Link count limit exceeded");
    if (cursor === value.length) return result;
    if (value[cursor++] !== ",") fail("malformed HTTP Link separator");
  }
}

/**
 * Prove selected exact declarations from a complete recorded HTML source without acquisition.
 * The source digest must match the recorder's JSON.stringify(snapshot) encoding before parsing.
 * HTML evidence requires direct links inside an explicitly delimited original head; inert or
 * parser-relocated metadata is not evidence. Every base considered by the shared policy must also
 * occur in the active original head. HTML uses that explicit base; HTTP uses the response URL.
 * Titles retain their decoded spelling, including spaces, and never borrow H1 text.
 * Input is bounded to 4 MiB HTML, 64 KiB Link, 256 links/channel, 32 HTTP parameters, 64 attributes
 * per 16 KiB tag and 4096 title code units. URLs exclude percent escapes and dot segments entirely.
 * Results are deeply frozen and ordered by channel then literal title, with exact duplicates removed.
 */
export function discoverMarkdownAlternates(
  observation: Observation,
  declarations: readonly MarkdownSourceDeclaration[],
): readonly MarkdownWitness[] {
  if (!declarations.length) return EMPTY;
  const selected = declarations.map(reviewed);
  const declaration = selected[0]!;
  if (selected.some((item) => item !== declaration)) fail("selected sources do not share the exact context");
  validateSource(observation, declaration);
  const witnesses: MarkdownWitness[] = [];
  const record = (advertisement: Advertisement, channel: MarkdownWitness["channel"], base: string) => {
    const target = reference(advertisement.href, declaration.hostname, base);
    if (target !== declaration.target_url) fail("undeclared Markdown target in selected source context");
    witnesses.push(
      Object.freeze({
        source_url: declaration.source_url,
        snapshot_sha256: observation.sha256,
        target_url: declaration.target_url,
        channel,
        title: advertisement.title,
      }),
    );
  };
  const html = htmlAdvertisements(observation.snapshot.body, declaration);
  for (const advertisement of html.links) record(advertisement, "html-head", html.base);
  const header = responseHeader(observation.snapshot, "link");
  if (header !== undefined) {
    for (const { href, parameters } of parseLinkHeader(header)) {
      const anchor = parameters.get("anchor");
      if (
        anchor !== undefined &&
        reference(anchor, declaration.hostname, observation.snapshot.url) !== declaration.source_url
      )
        fail("HTTP Link changes source context");
      const title = titleValue(parameters.get("title"));
      if (alternate(parameters.get("rel"), parameters.get("type"), href))
        record({ href, title }, "http-link", observation.snapshot.url);
    }
  }
  if (!witnesses.length) fail("selected declaration has no Markdown witness");
  const titles = new Set(witnesses.map((item) => item.title).filter((title) => title !== null && title !== ""));
  if (titles.size > 1) fail("conflicting nonempty Markdown titles");
  const unique = new Map(witnesses.map((item) => [JSON.stringify(item), item]));
  return Object.freeze(
    [...unique.values()].sort((a, b) => {
      if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
      if (a.title === b.title) return 0;
      if (a.title === null) return -1;
      if (b.title === null) return 1;
      return a.title < b.title ? -1 : 1;
    }),
  );
}
