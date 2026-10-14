import { createHash } from "node:crypto";
import {
  assertMarkdownIdentity,
  discoverMarkdownAlternates,
  markdownSources,
  type MarkdownSourceDeclaration,
  type MarkdownWitness,
} from "../../host-scrapers/policies/markdown-source-policy.ts";
import { plainText } from "../../source-documents.ts";
import type {
  HostArchive,
  HostScraper,
  Observation,
  ProducerContext,
  RetainedDocument,
  SearchDocument,
} from "../contracts.ts";
import { validateSearchDocument } from "../document-format.ts";
import type { MarkdownInspection } from "../markdown-contract.mjs";
import { hostUrl } from "../urls.ts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export interface CollectionFormats {
  pdf?: {
    profile_sha256: string;
    extract(
      bytes: Uint8Array,
      sourceUrl: string,
    ): Promise<{ title: string; markdown: string; warnings: string[]; pageCount: number }>;
  };
  markdown?: {
    profile_sha256: string;
    inspect(
      bytes: Uint8Array,
      advertisedTitles: readonly (string | null)[],
    ): Promise<{
      inspection: MarkdownInspection;
      profile_sha256: string;
      termination: "observed-pid-absence" | "identity-matched-unreaped-zombie";
    }>;
  };
}

interface MarkdownSource {
  declaration: MarkdownSourceDeclaration;
  witnesses: readonly MarkdownWitness[];
}

export function prepareMarkdownSources(scraper: HostScraper, archive: HostArchive, formats: CollectionFormats) {
  const declared = scraper.documentFormats?.includes("markdown") ? markdownSources(scraper.hostname) : [];
  if (scraper.documentFormats?.includes("markdown") && !declared.length)
    throw new Error("Markdown format lacks an exact reviewed source declaration");
  const declarations: MarkdownSource[] = declared.map((declaration) => ({
    declaration,
    witnesses: discoverMarkdownAlternates(archive.homepage, [declaration]),
  }));
  const targets = new Set(declarations.map(({ declaration }) => declaration.target_url));
  if (targets.size !== declarations.length)
    throw new Error("Markdown declarations contain a duplicate required target");
  if (declarations.length && (!formats.markdown || !archive.readTextBytes))
    throw new Error("Required Markdown extraction is unavailable");
  return { declarations, targets };
}

function markdownHeader(observation: Observation, name: string): string | undefined {
  const fields = Object.entries(observation.snapshot.headers).filter(([key]) => key.toLowerCase() === name);
  if (fields.length > 1) throw new Error(`Markdown response has duplicate ${name} fields`);
  return fields[0]?.[1];
}

function assertMarkdownResponse(declaration: MarkdownSourceDeclaration, observation: Observation): void {
  assertMarkdownIdentity(declaration, observation);
  if (
    observation.snapshot.status !== 200 ||
    observation.snapshot.binary !== undefined ||
    markdownHeader(observation, "content-range") !== undefined
  )
    throw new Error("Required Markdown target is not a complete status-200 text response");
  const mediaType = markdownHeader(observation, "content-type");
  if (!mediaType || !/^text\/markdown(?:[\t ]*;[\t ]*charset[\t ]*=[\t ]*(?:utf-8|"utf-8"))?[\t ]*$/i.test(mediaType))
    throw new Error("Required Markdown target needs unambiguous UTF-8 text/markdown");
}

interface DocumentContent {
  sourceUrl: string;
  title: string;
  markdown: string;
  modified: string | null;
  warnings: string[];
  bodySha256?: string;
  extraction?: SearchDocument["extraction"];
}

/** Construct documents from observed text; binary and Markdown paths require their recorded extraction evidence. */
export class CollectionDocuments {
  constructor(
    private readonly archive: HostArchive,
    private readonly producer: ProducerContext,
    private readonly formats: CollectionFormats,
    private readonly retained: ReadonlyMap<string, RetainedDocument>,
  ) {}

  create(observation: Observation, content: DocumentContent): SearchDocument {
    const document: SearchDocument = {
      id: `documents:official-web:${sha256(content.sourceUrl).slice(0, 24)}`,
      hostname: this.archive.hostname,
      title: content.title,
      source_url: content.sourceUrl,
      retrieved_at: observation.snapshot.retrieved_at,
      source_modified_at: content.modified,
      snapshot_sha256: observation.sha256,
      input_sha256: this.archive.input_sha256,
      body_sha256: content.bodySha256 ?? sha256(content.markdown),
      content_sha256: sha256(`${content.title}\n${content.markdown}`),
      content_markdown: content.markdown,
      warnings: [...new Set(content.warnings)].sort(),
      alternate_urls: [],
      producer: this.producer,
    };
    if (content.extraction) document.extraction = content.extraction;
    return document;
  }

  async markdown(
    { declaration, witnesses }: MarkdownSource,
    robots: { isDisallowed(url: string, agent: string): boolean | undefined },
  ) {
    if (robots.isDisallowed(declaration.target_url, "ubc-data"))
      throw new Error("Recorded robots policy disallows a required Markdown target");
    const observation = await this.archive.read(declaration.target_url);
    assertMarkdownResponse(declaration, observation);
    const receipt = await this.archive.readTextBytes!(observation.sha256);
    const bytes = Buffer.from(receipt.bytes);
    const bytesSha256 = sha256(bytes);
    if (receipt.sha256 !== bytesSha256 || observation.snapshot.bytes !== bytes.length)
      throw new Error("Markdown bytes differ from their recorded receipt");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(content, "utf8").equals(bytes) || content !== observation.snapshot.body)
      throw new Error("Markdown target is not exact BOM-free UTF-8 source text");
    const profileSha256 = this.formats.markdown!.profile_sha256;
    if (!/^[a-f0-9]{64}$/.test(profileSha256)) throw new Error("Invalid Markdown runtime profile digest");
    const inspected = await this.formats.markdown!.inspect(
      bytes,
      witnesses.map((witness) => witness.title),
    );
    if (
      inspected.profile_sha256 !== profileSha256 ||
      inspected.inspection.source_bytes !== bytes.length ||
      inspected.inspection.source_bytes_sha256 !== bytesSha256
    )
      throw new Error("Markdown runtime evidence differs from the recorded source bytes or profile");
    const sourceUrl = declaration.target_url;
    if (this.retained.has(sourceUrl))
      throw new Error("Retained Markdown needs an explicit extraction comparison policy");
    const document = this.create(observation, {
      sourceUrl,
      title: inspected.inspection.title,
      markdown: content,
      modified: null,
      bodySha256: bytesSha256,
      warnings: [],
      extraction: {
        format: "markdown",
        source_bytes_sha256: bytesSha256,
        source_bytes: bytes.length,
        profile_sha256: profileSha256,
        termination: inspected.termination,
        title_origin: { ...inspected.inspection.title_origin },
        witnesses: witnesses.map((witness) => ({ ...witness })),
      },
    });
    validateSearchDocument(document);
    return { document, observation, links: inspected.inspection.links };
  }

  async pdf(observation: Observation, requested: string): Promise<SearchDocument> {
    if (observation.snapshot.status !== 200 || !this.formats.pdf || !this.archive.readBytes)
      throw new Error(`Required PDF extraction is unavailable: ${requested}`);
    const sourceUrl = hostUrl(observation.snapshot.url, this.archive.hostname);
    if (this.retained.has(sourceUrl)) throw new Error("Retained PDF needs an explicit extraction comparison policy");
    const bytes = await this.archive.readBytes(observation.sha256);
    if (sha256(bytes) !== observation.snapshot.binary!.sha256 || bytes.length !== observation.snapshot.bytes)
      throw new Error("PDF bytes differ from their recorded observation");
    const converted = await this.formats.pdf.extract(bytes, sourceUrl);
    const title = plainText(converted.title);
    if (!title || !converted.markdown.trim()) throw new Error("Required PDF has no searchable text");
    return this.create(observation, {
      sourceUrl,
      title,
      markdown: converted.markdown,
      modified: null,
      warnings: converted.warnings,
      extraction: {
        format: "pdf",
        source_bytes_sha256: observation.snapshot.binary!.sha256,
        source_bytes: bytes.length,
        pages: converted.pageCount,
        profile_sha256: this.formats.pdf.profile_sha256,
      },
    });
  }
}
