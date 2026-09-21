export declare const MARKDOWN_INSPECTION_LIMITS: Readonly<{
  inputBytes: 1048576;
  lineBytes: 16384;
  lines: 16384;
  tokens: 50000;
  links: 2048;
  nesting: 32;
  titleBytes: 4096;
  metadataBytes: 262144;
  advertisedTitles: 6;
  advertisedTitleCodeUnits: 4096;
}>;

export declare const MARKDOWN_INSPECTION_DIALECT: "ubc-markdown-verbatim-v1/markdown-it-15.0.2";

export type MarkdownTitleOrigin =
  Readonly<{ kind: "markdown-body" }> | Readonly<{ kind: "advertisement"; witness_index: number }>;

export interface MarkdownInspection {
  readonly source_bytes: number;
  readonly source_bytes_sha256: string;
  readonly title: string;
  readonly title_origin: MarkdownTitleOrigin;
  readonly links: readonly Readonly<{ text: string; url: string }>[];
  readonly stats: Readonly<{ emitted_tokens: number; links: number; max_depth: number }>;
}

export declare function hasUnsafeMarkdownCharacter(value: string): boolean;

export declare function fail(reason: string): never;

export declare function validateTitle(title: string): string;

export declare function validateAdvertisements(titles: readonly (string | null)[]):
  | {
      title: string;
      title_origin: { kind: "advertisement"; witness_index: number };
    }
  | undefined;

export declare function validateDestination(value: string, lexical?: boolean): void;
