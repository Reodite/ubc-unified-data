import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { extractDocx } from "./docx.ts";
import { CONTENT_TYPES, makeZip, rootRelationships } from "./ooxml-test-helper.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

function packageWith(document: string, extras: Array<{ name: string; body: string }> = []): Buffer {
  return makeZip([
    { name: "[Content_Types].xml", body: CONTENT_TYPES },
    { name: "_rels/.rels", body: rootRelationships("word/document.xml") },
    { name: "word/document.xml", body: document },
    ...extras,
  ]);
}

function document(body: string): string {
  return `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`;
}

describe("DOCX extraction", () => {
  it("preserves body order, headings, runs, tabs, breaks, and safe hyperlink labels", async () => {
    const bytes = packageWith(
      document(`
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Program &lt;guide&gt;</w:t></w:r></w:p>
        <w:p><w:r><w:t>First</w:t><w:tab/><w:t>Second</w:t><w:br/><w:t>line</w:t></w:r></w:p>
        <w:p><w:hyperlink r:id="link"><w:r><w:t>UBC label</w:t></w:r></w:hyperlink></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Course</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Credits</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>CPSC 110</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>4</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      `),
      [
        {
          name: "word/_rels/document.xml.rels",
          body: `<Relationships xmlns="${RELS}"><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.ubc.ca/a(b)" TargetMode="External"/></Relationships>`,
        },
      ],
    );
    const result = await extractDocx({ bytes });
    expect(result.title).toBe("Program <guide>");
    expect(result.markdown).toContain("# Program \\<guide\\>");
    expect(result.markdown).toContain("First\tSecond\nline");
    expect(result.markdown).toContain("[UBC label](https://www.ubc.ca/a%28b%29)");
    expect(result.markdown).toContain("| Course | Credits |");
    expect(result.paragraphCount).toBe(7);
    expect(result.tableCount).toBe(1);
    expect(new MarkdownIt({ html: true }).render(result.markdown)).not.toMatch(/<guide>/);
  });

  it("labels complex table spans and includes valid notes, headers, and footers", async () => {
    const rel = (id: string, type: string, target: string) =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
    const bytes = packageWith(
      document(`
        <w:p><w:r><w:t>Main text</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Spanned</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Nested</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>
      `),
      [
        {
          name: "word/_rels/document.xml.rels",
          body: `<Relationships xmlns="${RELS}">${rel("f", "footnotes", "footnotes.xml")}${rel("h", "header", "header1.xml")}${rel("z", "footer", "footer1.xml")}</Relationships>`,
        },
        {
          name: "word/footnotes.xml",
          body: `<w:footnotes xmlns:w="${W}"><w:footnote w:id="1"><w:p><w:r><w:t>Footnote text</w:t></w:r></w:p></w:footnote></w:footnotes>`,
        },
        {
          name: "word/header1.xml",
          body: `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>`,
        },
        {
          name: "word/footer1.xml",
          body: `<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>Footer text</w:t></w:r></w:p></w:ftr>`,
        },
      ],
    );
    const result = await extractDocx({ bytes });
    expect(result.markdown).toMatch(/Table 1 \(complex layout/);
    expect(result.markdown).toContain("column span 2");
    expect(result.markdown).toContain("vertical merge restart");
    expect(result.markdown).toContain("contains nested table");
    expect(result.markdown).toContain("## Footnotes\n\nFootnote text");
    expect(result.markdown).toContain("## Header\n\nHeader text");
    expect(result.markdown).toContain("## Footer\n\nFooter text");
    expect(result.warnings.join(" ")).toContain("labelled fallback");
  });

  it("does not execute fields, omits unsafe links, and rejects empty or active documents", async () => {
    const bytes = packageWith(
      document(
        `<w:p><w:fldSimple w:instr="DDEAUTO cmd"><w:r><w:t>Stored result</w:t></w:r></w:fldSimple><w:hyperlink r:id="bad"><w:r><w:t>Unsafe label</w:t></w:r></w:hyperlink></w:p>`,
      ),
      [
        {
          name: "word/_rels/document.xml.rels",
          body: `<Relationships xmlns="${RELS}"><Relationship Id="bad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///private" TargetMode="External"/></Relationships>`,
        },
      ],
    );
    const result = await extractDocx({ bytes });
    expect(result.markdown).toContain("Unsafe label");
    expect(result.markdown).not.toContain("file:");
    expect(result.markdown).not.toContain("DDEAUTO");
    expect(result.warnings.join(" ")).toMatch(/fields|field instructions/);
    await expect(extractDocx({ bytes: packageWith(document("<w:p/>")) })).rejects.toThrow("no usable text");
    await expect(
      extractDocx({
        bytes: packageWith(document("<w:p><w:r><w:t>Text</w:t></w:r></w:p>"), [
          { name: "word/activeX/activeX1.bin", body: "active" },
        ]),
      }),
    ).rejects.toThrow("active");
  });

  it("is deterministic for output, counts, and profile identity", async () => {
    const bytes = packageWith(document("<w:p><w:r><w:t>Stable text</w:t></w:r></w:p>"));
    expect(await extractDocx({ bytes })).toEqual(await extractDocx({ bytes }));
  });
});
