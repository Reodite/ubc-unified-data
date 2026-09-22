import { assertSafeMarkdown } from "../../prose/markdown.ts";
import {
  childElements,
  descendants,
  nodeText,
  readOoxml,
  type OoxmlPackage,
  type OoxmlRelationship,
  type ReadOoxmlOptions,
  type XmlNode,
} from "./ooxml.ts";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export interface ExtractedDocx {
  title: string;
  markdown: string;
  warnings: string[];
  paragraphCount: number;
  tableCount: number;
  profileSha256: string;
  sourceSha256: string;
}

function markdownText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\ufffd]/gu, (character) =>
      character === "\t" || character === "\n" ? character : `\\u{${character.codePointAt(0)!.toString(16)}}`,
    )
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1");
}

function safeLink(target: string): string | undefined {
  try {
    const url = new URL(target);
    if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return undefined;
  }
}

function relationMap(relationships: readonly OoxmlRelationship[]): Map<string, OoxmlRelationship> {
  return new Map(relationships.map((relationship) => [relationship.id, relationship]));
}

interface ParagraphResult {
  text: string;
  heading?: number;
  list?: { ordered: boolean; level: number };
  fields: boolean;
  unsafeLinks: number;
}

function paragraph(
  node: XmlNode,
  relationships: Map<string, OoxmlRelationship>,
  numbering: ReadonlyMap<string, boolean>,
): ParagraphResult {
  let fields = false;
  let unsafeLinks = 0;
  const render = (current: XmlNode): string => {
    if (["instrText", "fldChar"].includes(current.local)) {
      fields = true;
      return "";
    }
    if (current.local === "fldSimple") {
      fields = true;
      return current.children.map((child) => (typeof child === "string" ? "" : render(child))).join("");
    }
    if (current.local === "tab") return "\t";
    if (current.local === "br" || current.local === "cr") return "\n";
    if (current.local === "t") return markdownText(nodeText(current));
    if (current.local === "hyperlink") {
      const label = current.children.map((child) => (typeof child === "string" ? "" : render(child))).join("");
      const id = current.attributes.id ?? current.attributes["r:id"];
      const anchor = current.attributes.anchor;
      const relationship = id ? relationships.get(id) : undefined;
      let target: string | undefined;
      if (relationship?.external) target = safeLink(relationship.target);
      else if (!id && anchor && /^[A-Za-z0-9_.-]+$/.test(anchor)) target = `#${encodeURIComponent(anchor)}`;
      if ((id || anchor) && !target) unsafeLinks++;
      return target && label.trim() ? `[${label}](${target})` : label;
    }
    return current.children.map((child) => (typeof child === "string" ? "" : render(child))).join("");
  };
  const properties = childElements(node, "pPr")[0];
  const style = properties ? childElements(properties, "pStyle")[0]?.attributes.val : undefined;
  const match = style?.match(/^Heading([1-6])$/i);
  const numberingProperties = properties ? childElements(properties, "numPr")[0] : undefined;
  const listId = numberingProperties ? childElements(numberingProperties, "numId")[0]?.attributes.val : undefined;
  const levelValue = numberingProperties ? childElements(numberingProperties, "ilvl")[0]?.attributes.val : undefined;
  const level = Math.max(0, Math.min(8, Number.parseInt(levelValue ?? "0", 10) || 0));
  const styledList = style?.match(/^List(Bullet|Number)(\d*)$/i);
  const list =
    listId !== undefined
      ? { ordered: numbering.get(`${listId}:${level}`) ?? false, level }
      : styledList
        ? { ordered: styledList[1]!.toLowerCase() === "number", level: Math.max(0, Number(styledList[2] || 1) - 1) }
        : undefined;
  return {
    text: render(node)
      .replace(/[ \t]+\n/g, "\n")
      .trim(),
    heading: match ? Number(match[1]) : undefined,
    list,
    fields,
    unsafeLinks,
  };
}

interface TableResult {
  markdown: string;
  complex: boolean;
  paragraphCount: number;
  firstText: string;
}

function table(
  node: XmlNode,
  relationships: Map<string, OoxmlRelationship>,
  numbering: ReadonlyMap<string, boolean>,
  index: number,
): TableResult {
  const rows = childElements(node, "tr");
  const complex =
    descendants(node, "gridSpan").length > 0 ||
    descendants(node, "vMerge").length > 0 ||
    descendants(node, "tbl").length > 0;
  let paragraphCount = 0;
  const cells = rows.map((row) =>
    childElements(row, "tc").map((cell) => {
      const paragraphs = descendants(cell, "p").map((item) => {
        paragraphCount++;
        return paragraph(item, relationships, numbering).text;
      });
      return { node: cell, text: paragraphs.filter(Boolean).join(" / ") };
    }),
  );
  if (!complex && cells.length && cells.every((row) => row.length === cells[0]!.length)) {
    const width = cells[0]!.length;
    if (width > 0) {
      const line = (row: (typeof cells)[number]) =>
        `| ${row.map((cell) => cell.text.replace(/\|/g, "\\|") || " ").join(" | ")} |`;
      return {
        markdown: [
          line(cells[0]!),
          `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
          ...cells.slice(1).map(line),
        ].join("\n"),
        complex: false,
        paragraphCount,
        firstText: cells.flat().find((cell) => cell.text)?.text ?? "",
      };
    }
  }
  const lines = [`**Table ${index} (complex layout; spans and nesting are labelled)**`];
  cells.forEach((row, rowIndex) => {
    row.forEach((cell, cellIndex) => {
      const properties = childElements(cell.node, "tcPr")[0];
      const span = properties ? childElements(properties, "gridSpan")[0]?.attributes.val : undefined;
      const merge = properties ? childElements(properties, "vMerge")[0] : undefined;
      const labels = [`row ${rowIndex + 1}`, `column ${cellIndex + 1}`];
      if (span) labels.push(`column span ${span}`);
      if (merge) labels.push(`vertical merge ${merge.attributes.val || "continue"}`);
      if (descendants(cell.node, "tbl").length) labels.push("contains nested table");
      lines.push(`- ${labels.join(", ")}: ${cell.text || "(empty)"}`);
    });
  });
  return {
    markdown: lines.join("\n"),
    complex: true,
    paragraphCount,
    firstText: cells.flat().find((cell) => cell.text)?.text ?? "",
  };
}

function numberingFormats(
  pkg: OoxmlPackage,
  relationships: readonly OoxmlRelationship[],
): ReadonlyMap<string, boolean> {
  const relationship = relationships.find((item) => /\/numbering$/.test(item.type));
  if (!relationship) return new Map();
  if (relationship.external || !pkg.has(relationship.target))
    throw new Error("DOCX numbering part is missing or external");
  const root = pkg.xml(relationship.target);
  if (root.local !== "numbering" || root.uri !== WORD_NS) throw new Error("DOCX numbering part has an invalid root");
  const abstract = new Map<string, Map<number, boolean>>();
  for (const definition of childElements(root, "abstractNum")) {
    const id = definition.attributes.abstractNumId;
    if (!id || abstract.has(id)) throw new Error("DOCX numbering has duplicate or missing abstract identifiers");
    const levels = new Map<number, boolean>();
    for (const level of childElements(definition, "lvl")) {
      const index = Number(level.attributes.ilvl);
      const format = childElements(level, "numFmt")[0]?.attributes.val;
      if (!Number.isSafeInteger(index) || index < 0 || index > 8 || !format || levels.has(index))
        throw new Error("DOCX numbering has an invalid level");
      levels.set(index, format !== "bullet" && format !== "none");
    }
    abstract.set(id, levels);
  }
  const result = new Map<string, boolean>();
  for (const numbering of childElements(root, "num")) {
    const id = numbering.attributes.numId;
    const abstractId = childElements(numbering, "abstractNumId")[0]?.attributes.val;
    const levels = abstractId ? abstract.get(abstractId) : undefined;
    if (!id || !levels) throw new Error("DOCX numbering instance has an unresolved definition");
    for (const [level, ordered] of levels) result.set(`${id}:${level}`, ordered);
  }
  return result;
}

function renderStory(
  root: XmlNode,
  relationships: Map<string, OoxmlRelationship>,
  numbering: ReadonlyMap<string, boolean>,
  warnings: string[],
  tableOffset: number,
): { blocks: string[]; paragraphs: number; tables: number; firstText: string } {
  const container = root.local === "document" ? childElements(root, "body")[0] : root;
  if (!container) throw new Error("DOCX main document lacks a body");
  const blocks: string[] = [];
  let paragraphs = 0;
  let tables = 0;
  let firstText = "";
  for (const item of childElements(container)) {
    if (item.local === "p") {
      paragraphs++;
      const result = paragraph(item, relationships, numbering);
      if (result.fields)
        warnings.push(
          "Word fields are displayed only through stored result text; field instructions are not executed.",
        );
      if (result.unsafeLinks)
        warnings.push(`${result.unsafeLinks} hyperlink target(s) were omitted because they were unsafe or unresolved.`);
      if (result.text) {
        firstText ||= result.text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
        blocks.push(
          result.heading
            ? `${"#".repeat(result.heading)} ${result.text}`
            : result.list
              ? `${"  ".repeat(result.list.level)}${result.list.ordered ? "1." : "-"} ${result.text}`
              : result.text,
        );
      }
    } else if (item.local === "tbl") {
      tables++;
      const result = table(item, relationships, numbering, tableOffset + tables);
      paragraphs += result.paragraphCount;
      if (result.complex)
        warnings.push(
          `Table ${tableOffset + tables} uses merged, spanned, or nested layout; a labelled fallback preserves its cell metadata.`,
        );
      firstText ||= result.firstText;
      blocks.push(result.markdown);
    }
  }
  return { blocks, paragraphs, tables, firstText };
}

function validateStory(root: XmlNode, expectedRoot: string, name: string): void {
  if (root.local !== expectedRoot || root.uri !== WORD_NS)
    throw new Error(`DOCX related story has an invalid root: ${name}`);
}

export async function extractDocx(options: ReadOoxmlOptions | { package: OoxmlPackage }): Promise<ExtractedDocx> {
  const pkg = "package" in options ? options.package : await readOoxml(options);
  if (pkg.kind !== "docx") throw new Error("OOXML package is not a DOCX document");
  const main = pkg.xml(pkg.mainPart);
  if (main.local !== "document" || main.uri !== WORD_NS) throw new Error("DOCX main part has an invalid document root");
  const relationships = pkg.relationships(pkg.mainPart);
  const rels = relationMap(relationships);
  const numbering = numberingFormats(pkg, relationships);
  const warnings: string[] = [];
  const body = renderStory(main, rels, numbering, warnings, 0);
  const blocks = [...body.blocks];
  let firstText = body.firstText;
  let paragraphCount = body.paragraphs;
  let tableCount = body.tables;
  const relatedKinds: Array<[RegExp, string, string]> = [
    [/\/footnotes$/, "footnotes", "Footnotes"],
    [/\/endnotes$/, "endnotes", "Endnotes"],
    [/\/header$/, "hdr", "Header"],
    [/\/footer$/, "ftr", "Footer"],
  ];
  for (const relationship of relationships) {
    if (relationship.external) continue;
    const kind = relatedKinds.find(([pattern]) => pattern.test(relationship.type));
    if (!kind) continue;
    if (!pkg.has(relationship.target)) throw new Error(`DOCX related story is missing: ${relationship.target}`);
    const root = pkg.xml(relationship.target);
    validateStory(root, kind[1], relationship.target);
    const storyRelationships = relationMap(pkg.relationships(relationship.target));
    const containers = ["footnotes", "endnotes"].includes(root.local) ? childElements(root) : [root];
    const relatedBlocks: string[] = [];
    for (const container of containers) {
      const rendered = renderStory(container, storyRelationships, numbering, warnings, tableCount);
      paragraphCount += rendered.paragraphs;
      tableCount += rendered.tables;
      firstText ||= rendered.firstText;
      relatedBlocks.push(...rendered.blocks);
    }
    if (relatedBlocks.length) blocks.push(`## ${kind[2]}`, ...relatedBlocks);
  }
  if (!/[\p{L}\p{N}]/u.test(firstText)) throw new Error("DOCX contains no usable text");
  const markdown = `${blocks.join("\n\n")}\n`;
  assertSafeMarkdown(markdown);
  const title =
    firstText
      .replace(/[*_`\\]/g, "")
      .trim()
      .slice(0, 512) || "Word document";
  return {
    title,
    markdown,
    warnings: [...new Set(warnings)],
    paragraphCount,
    tableCount,
    profileSha256: pkg.profileSha256,
    sourceSha256: pkg.sourceSha256,
  };
}
