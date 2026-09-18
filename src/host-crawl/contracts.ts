import type { ProseResponse } from "../prose/client.ts";
import type { ArticleInput } from "../prose/model.ts";

export interface Snapshot extends ProseResponse {
  bytes: number;
  binary?: { media_type: "application/pdf"; sha256: string };
  redirects?: Array<{ url: string; location: string; status: number; snapshot: string }>;
}

export class DocumentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentPolicyError";
  }
}

export class NonTextMediaError extends Error {
  constructor(mediaType: string) {
    super(`Observed non-text media: ${mediaType}`);
    this.name = "NonTextMediaError";
  }
}

export interface Observation {
  sha256: string;
  snapshot: Snapshot;
}

export interface PublicGetView {
  path: string;
  parameter: string;
  values: readonly string[];
  placeholder: string;
}

export interface HostScraper {
  hostname: string;
  title: string;
  scope: string;
  adapter: {
    kind: "wordpress" | "html" | "auto";
    allowedTypes: readonly string[];
    allPublicTypes?: boolean;
    apiContentFallback?: boolean;
    views?: readonly PublicGetView[];
    optionalAbsent?: readonly string[];
    sitemaps?: readonly { path: string; rootOnlyLocation?: string }[];
  };
  documentFormats?: readonly "pdf"[];
  excludeUrl?(url: string): string | null;
  normalizeArticle?(input: ArticleInput): ArticleInput;
  vetHomepage(snapshot: Snapshot): { accepted: boolean; reason: string };
  extract(snapshot: Snapshot): { kind: "document"; input: ArticleInput } | { kind: "excluded"; reason: string };
}

export interface ProducerContext {
  inputs_sha256: string;
  runtime: { node: string; icu: string; unicode: string; platform: string; arch: string };
}

export interface DocumentExtraction {
  format: "pdf";
  source_bytes_sha256: string;
  source_bytes: number;
  pages: number;
  profile_sha256: string;
}

export interface SearchDocument {
  id: string;
  hostname: string;
  title: string;
  source_url: string;
  retrieved_at: string;
  source_modified_at: string | null;
  snapshot_sha256: string;
  input_sha256: string;
  body_sha256: string;
  content_sha256: string;
  content_markdown: string;
  warnings: string[];
  alternate_urls: string[];
  producer: ProducerContext;
  extraction?: DocumentExtraction;
}

export interface RetainedDocument {
  id: string;
  source_url: string;
  title: string;
  snapshot: string;
  retrieved_at: string;
  source_modified_at: string | null;
  body_sha256: string;
  content_sha256: string;
  content_markdown: string;
}

export interface SavedUrl {
  url: string;
  kind: string;
  state: string;
  disposition: string | null;
  reason: string | null;
  snapshot: string | null;
  article_id: string | null;
  source_modified_at: string | null;
}

export interface HostArchive {
  hostname: string;
  input_sha256: string;
  homepage: Observation;
  urls: readonly SavedUrl[];
  retained: readonly RetainedDocument[];
  read(url: string): Promise<Observation>;
  readDocument?(url: string): Promise<Observation>;
  readSnapshot(sha256: string): Promise<Observation>;
  readBytes?(snapshotSha256: string): Promise<Uint8Array>;
  observedDestination?(url: string): string;
  apiFallbackEligible?(url: string): boolean;
  assertUnchanged(): Promise<void>;
  close(): void;
}

export interface VettedHost {
  hostname: string;
  title: string;
  homepage_url: string;
  homepage_retrieved_at: string;
  homepage_sha256: string;
  scope: string;
  /** Repository-relative path: data/documents/<hostname>. */
  document_root: string;
  document_count: number;
}

export interface CompletedHost {
  host: VettedHost;
  documents: readonly SearchDocument[];
  complete: true;
}
