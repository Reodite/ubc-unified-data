import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { CONTENT_TYPES, makeZip, rootRelationships } from "./ooxml-test-helper.ts";
import { extractPptx } from "./pptx.ts";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

function presentation(ids = ["slide2", "slide1"]): string {
  return `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${ids.map((id, index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`).join("")}</p:sldIdLst></p:presentation>`;
}

function shape(text: string, type = "body", x = 0, y = 0): string {
  return `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function slide(contents: string): string {
  return `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${contents}</p:spTree></p:cSld></p:sld>`;
}

function packageWith(
  options: {
    presentation?: string;
    slides?: Record<string, string>;
    extra?: Array<{ name: string; body: string }>;
  } = {},
): Buffer {
  const slides = options.slides ?? {
    "ppt/slides/slide1.xml": slide(`${shape("First title", "title")}${shape("First body")}`),
    "ppt/slides/slide2.xml": slide(`${shape("Second body", "body", 200, 300)}${shape("Second title", "title", 0, 0)}`),
  };
  return makeZip([
    { name: "[Content_Types].xml", body: CONTENT_TYPES },
    { name: "_rels/.rels", body: rootRelationships("ppt/presentation.xml") },
    { name: "ppt/presentation.xml", body: options.presentation ?? presentation() },
    {
      name: "ppt/_rels/presentation.xml.rels",
      body: `<Relationships xmlns="${RELS}"><Relationship Id="slide1" Type="${R}/slide" Target="slides/slide1.xml"/><Relationship Id="slide2" Type="${R}/slide" Target="slides/slide2.xml"/></Relationships>`,
    },
    ...Object.entries(slides).map(([name, body]) => ({ name, body })),
    ...(options.extra ?? []),
  ]);
}

describe("PPTX extraction", () => {
  it("uses presentation relationship order and deterministic XML z-order for title and body text", async () => {
    const result = await extractPptx({ bytes: packageWith() });
    expect(result.markdown.indexOf("Slide 1: Second title")).toBeLessThan(
      result.markdown.indexOf("Slide 2: First title"),
    );
    expect(result.markdown).toContain("Second body");
    expect(result.markdown).toContain("First body");
    expect(result.title).toBe("Second title");
    expect(result.slideCount).toBe(2);
    expect(result.shapeCount).toBe(4);
    expect(new MarkdownIt({ html: true }).render(result.markdown)).not.toContain("<script>");
  });

  it("uses coordinate fallback for an unlabelled title and preserves merged table metadata", async () => {
    const table = `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc gridSpan="2" rowSpan="2"><a:txBody><a:p><a:r><a:t>Merged</a:t></a:r></a:p></a:txBody></a:tc><a:tc hMerge="1"><a:txBody><a:p><a:r><a:t>Continuation</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const only = slide(`${shape("Lower body", "body", 0, 500)}${shape("Top inferred title", "body", 50, 10)}${table}`);
    const result = await extractPptx({
      bytes: packageWith({ presentation: presentation(["slide1"]), slides: { "ppt/slides/slide1.xml": only } }),
    });
    expect(result.title).toBe("Top inferred title");
    expect(result.markdown).toContain("gridSpan 2");
    expect(result.markdown).toContain("rowSpan 2");
    expect(result.markdown).toContain("hMerge 1");
    expect(result.tableCount).toBe(1);
    expect(result.warnings.join(" ")).toContain("merged cells");
  });

  it("includes internal speaker notes while excluding footer, date, and slide-number placeholders", async () => {
    const notes = `<p:notes xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${shape("Speaker-only detail", "body")}${shape("Confidential footer", "ftr")}${shape("2026-01-01", "dt")}${shape("7", "sldNum")}</p:spTree></p:cSld></p:notes>`;
    const result = await extractPptx({
      bytes: packageWith({
        extra: [
          {
            name: "ppt/slides/_rels/slide2.xml.rels",
            body: `<Relationships xmlns="${RELS}"><Relationship Id="notes" Type="${R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="image" Type="${R}/image" Target="../media/image1.png"/></Relationships>`,
          },
          { name: "ppt/notesSlides/notesSlide1.xml", body: notes },
        ],
      }),
    });
    expect(result.markdown).toContain("### Speaker notes\n\nSpeaker-only detail");
    expect(result.markdown).not.toContain("Confidential footer");
    expect(result.markdown).not.toContain("2026-01-01");
    expect(result.noteCount).toBe(1);
    expect(result.warnings.join(" ")).toContain("unsupported media");
  });

  it("rejects missing, repeated, active, contradictory, and empty presentations", async () => {
    await expect(extractPptx({ bytes: packageWith({ presentation: presentation(["missing"]) }) })).rejects.toThrow(
      "missing or contradictory",
    );
    await expect(
      extractPptx({ bytes: packageWith({ presentation: presentation(["slide1", "slide1"]) }) }),
    ).rejects.toThrow("repeats");
    await expect(
      extractPptx({ bytes: packageWith({ extra: [{ name: "ppt/activeX/activeX1.bin", body: "active" }] }) }),
    ).rejects.toThrow("active");
    await expect(
      extractPptx({
        bytes: packageWith({
          presentation: presentation(["slide1"]),
          slides: { "ppt/slides/slide1.xml": slide("") },
        }),
      }),
    ).rejects.toThrow("no usable");
  });

  it("is deterministic for safe Markdown, structural counts, and profile identity", async () => {
    const bytes = packageWith({
      presentation: presentation(["slide1"]),
      slides: { "ppt/slides/slide1.xml": slide(shape("&lt;script&gt;alert(1)&lt;/script&gt;", "title")) },
    });
    const first = await extractPptx({ bytes });
    expect(first).toEqual(await extractPptx({ bytes }));
    expect(first.markdown).toContain("\\<script\\>");
    expect(new MarkdownIt({ html: true }).render(first.markdown)).not.toMatch(/<script>/);
  });
});
