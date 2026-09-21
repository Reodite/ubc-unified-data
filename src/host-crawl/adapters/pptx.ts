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

const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const SLIDE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

export interface ExtractedPptx {
  title: string;
  markdown: string;
  warnings: string[];
  slideCount: number;
  shapeCount: number;
  tableCount: number;
  noteCount: number;
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

function paragraphText(node: XmlNode): string {
  const chunks: string[] = [];
  const visit = (item: XmlNode) => {
    if (item.local === "t") chunks.push(markdownText(nodeText(item)));
    else if (item.local === "br") chunks.push("\n");
    else for (const child of childElements(item)) visit(child);
  };
  visit(node);
  return chunks.join("").trim();
}

function shapeText(shape: XmlNode): string {
  return descendants(shape, "p").map(paragraphText).filter(Boolean).join("\n");
}

function placeholderType(shape: XmlNode): string {
  return descendants(shape, "ph")[0]?.attributes.type ?? "";
}

function coordinates(shape: XmlNode): [number, number] {
  const off = descendants(shape, "off")[0];
  const x = Number(off?.attributes.x);
  const y = Number(off?.attributes.y);
  return [Number.isFinite(y) ? y : Number.MAX_SAFE_INTEGER, Number.isFinite(x) ? x : Number.MAX_SAFE_INTEGER];
}

function renderTable(node: XmlNode, index: number): { markdown: string; merged: boolean; firstText: string } {
  const rows = childElements(node, "tr");
  const cells = rows.map((row) =>
    childElements(row, "tc").map((cell) => ({
      node: cell,
      text: descendants(cell, "p").map(paragraphText).filter(Boolean).join(" / "),
    })),
  );
  const merged = cells.some((row) =>
    row.some((cell) =>
      ["gridSpan", "rowSpan", "hMerge", "vMerge"].some((name) => cell.node.attributes[name] !== undefined),
    ),
  );
  if (!merged && cells.length && cells[0]!.length && cells.every((row) => row.length === cells[0]!.length)) {
    const line = (row: (typeof cells)[number]) =>
      `| ${row.map((cell) => cell.text.replace(/\|/g, "\\|") || " ").join(" | ")} |`;
    return {
      markdown: [line(cells[0]!), `| ${cells[0]!.map(() => "---").join(" | ")} |`, ...cells.slice(1).map(line)].join(
        "\n",
      ),
      merged: false,
      firstText: cells.flat().find((cell) => cell.text)?.text ?? "",
    };
  }
  const lines = [`**Table ${index} (merged layout; spans are labelled)**`];
  for (const [rowIndex, row] of cells.entries()) {
    for (const [columnIndex, cell] of row.entries()) {
      const labels = [`row ${rowIndex + 1}`, `column ${columnIndex + 1}`];
      for (const name of ["gridSpan", "rowSpan", "hMerge", "vMerge"])
        if (cell.node.attributes[name] !== undefined) labels.push(`${name} ${cell.node.attributes[name] || "true"}`);
      lines.push(`- ${labels.join(", ")}: ${cell.text || "(empty)"}`);
    }
  }
  return {
    markdown: lines.join("\n"),
    merged: true,
    firstText: cells.flat().find((cell) => cell.text)?.text ?? "",
  };
}

function relatedWarnings(relationships: readonly OoxmlRelationship[], warnings: string[], slideNumber: number): void {
  const categories = new Set<string>();
  for (const relationship of relationships) {
    if (/\/(?:image|audio|video)$/.test(relationship.type)) categories.add("media");
    else if (/\/chart$/.test(relationship.type)) categories.add("chart");
    else if (/\/(?:diagramData|diagramLayout|diagramColors|diagramQuickStyle)$/.test(relationship.type))
      categories.add("diagram");
  }
  if (categories.size)
    warnings.push(
      `Slide ${slideNumber} contains unsupported ${[...categories].sort().join(", ")} content; only stored text and tables are extracted.`,
    );
}

function slideRelationships(pkg: OoxmlPackage, presentation: XmlNode): OoxmlRelationship[] {
  const byId = new Map(pkg.relationships(pkg.mainPart).map((relationship) => [relationship.id, relationship]));
  const ids = descendants(presentation, "sldId");
  if (!ids.length) throw new Error("PPTX presentation has no slides");
  const seenTargets = new Set<string>();
  return ids.map((slide) => {
    const id = slide.attributes["r:id"] ?? slide.attributes.id;
    const relationship = id ? byId.get(id) : undefined;
    if (!relationship || relationship.type !== SLIDE_REL || relationship.external)
      throw new Error("PPTX slide order has a missing or contradictory relationship");
    if (seenTargets.has(relationship.target)) throw new Error("PPTX slide order repeats a slide target");
    seenTargets.add(relationship.target);
    return relationship;
  });
}

function notesText(pkg: OoxmlPackage, slidePart: string, relationships: readonly OoxmlRelationship[]): string[] {
  const notes = relationships.filter((relationship) => /\/notesSlide$/.test(relationship.type));
  if (notes.length > 1) throw new Error(`PPTX slide has contradictory notes relationships: ${slidePart}`);
  const relationship = notes[0];
  if (!relationship) return [];
  if (relationship.external || !pkg.has(relationship.target))
    throw new Error("PPTX speaker notes part is missing or external");
  const root = pkg.xml(relationship.target);
  if (root.local !== "notes" || root.uri !== PRESENTATION_NS)
    throw new Error("PPTX speaker notes part has an invalid root");
  const excluded = new Set(["dt", "ftr", "sldNum", "hdr"]);
  return descendants(root, "sp")
    .filter((shape) => !excluded.has(placeholderType(shape)))
    .map(shapeText)
    .filter(Boolean);
}

export async function extractPptx(options: ReadOoxmlOptions | { package: OoxmlPackage }): Promise<ExtractedPptx> {
  const pkg = "package" in options ? options.package : await readOoxml(options);
  if (pkg.kind !== "pptx") throw new Error("OOXML package is not a PPTX presentation");
  const presentation = pkg.xml(pkg.mainPart);
  if (presentation.local !== "presentation" || presentation.uri !== PRESENTATION_NS)
    throw new Error("PPTX main part has an invalid presentation root");
  const orderedSlides = slideRelationships(pkg, presentation);
  const blocks: string[] = [];
  const warnings: string[] = [];
  let shapeCount = 0;
  let tableCount = 0;
  let noteCount = 0;
  let documentTitle = "";
  let hasUsableText = false;
  for (const [slideIndex, relationship] of orderedSlides.entries()) {
    if (!pkg.has(relationship.target)) throw new Error(`PPTX slide part is missing: ${relationship.target}`);
    const slide = pkg.xml(relationship.target);
    if (slide.local !== "sld" || slide.uri !== PRESENTATION_NS) throw new Error("PPTX slide part has an invalid root");
    const relationships = pkg.relationships(relationship.target);
    relatedWarnings(relationships, warnings, slideIndex + 1);
    const tree = descendants(slide, "spTree")[0];
    if (!tree) throw new Error("PPTX slide lacks a shape tree");
    const treeChildren = childElements(tree);
    const shapes = treeChildren.filter((node) => node.local === "sp");
    const unsupported = treeChildren.filter(
      (node) =>
        ["pic", "cxnSp", "grpSp"].includes(node.local) ||
        (node.local === "graphicFrame" && descendants(node, "tbl").length === 0),
    ).length;
    if (unsupported)
      warnings.push(
        `Slide ${slideIndex + 1} contains ${unsupported} unsupported drawing object(s); only stored shape text and tables are extracted.`,
      );
    const records = shapes
      .map((shape, xmlOrder) => ({
        shape,
        xmlOrder,
        text: shapeText(shape),
        placeholder: placeholderType(shape),
        position: coordinates(shape),
      }))
      .filter((record) => record.text);
    shapeCount += records.length;
    if (records.some((record) => /[\p{L}\p{N}]/u.test(record.text))) hasUsableText = true;
    let title = records.find((record) => ["title", "ctrTitle"].includes(record.placeholder));
    if (!title && records.length) {
      title = [...records].sort(
        (left, right) =>
          left.position[0] - right.position[0] ||
          left.position[1] - right.position[1] ||
          left.xmlOrder - right.xmlOrder,
      )[0];
    }
    const titleText = title?.text.replace(/\n/g, " ") ?? `Slide ${slideIndex + 1}`;
    documentTitle ||= titleText;
    const slideBlocks = [`## Slide ${slideIndex + 1}: ${titleText}`];
    for (const record of records.sort((left, right) => left.xmlOrder - right.xmlOrder)) {
      if (record === title) continue;
      slideBlocks.push(record.text);
    }
    for (const tableNode of descendants(tree, "tbl")) {
      tableCount++;
      const rendered = renderTable(tableNode, tableCount);
      if (rendered.merged) warnings.push(`Table ${tableCount} uses merged cells; labelled span metadata is retained.`);
      if (/[\p{L}\p{N}]/u.test(rendered.firstText)) hasUsableText = true;
      slideBlocks.push(rendered.markdown);
    }
    const notes = notesText(pkg, relationship.target, relationships);
    if (notes.length) {
      noteCount++;
      if (notes.some((note) => /[\p{L}\p{N}]/u.test(note))) hasUsableText = true;
      slideBlocks.push("### Speaker notes", ...notes);
    }
    blocks.push(slideBlocks.join("\n\n"));
  }
  if (!hasUsableText) throw new Error("PPTX contains no usable slide or speaker-note text");
  const markdown = `${blocks.join("\n\n")}\n`;
  assertSafeMarkdown(markdown);
  return {
    title:
      documentTitle
        .replace(/[*_`\\]/g, "")
        .trim()
        .slice(0, 512) || "PowerPoint presentation",
    markdown,
    warnings: [...new Set(warnings)],
    slideCount: orderedSlides.length,
    shapeCount,
    tableCount,
    noteCount,
    profileSha256: pkg.profileSha256,
    sourceSha256: pkg.sourceSha256,
  };
}
