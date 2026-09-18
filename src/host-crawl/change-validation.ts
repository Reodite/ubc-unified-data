import { normalizeHost } from "./urls.ts";

export interface ChangedFile {
  path: string;
  bytes: Uint8Array | null;
}

/** Check a new hostname's atomic publication unit; byte-bearing crawl intermediates are never publishable data. */
export function assertSingleHostChange(files: readonly ChangedFile[]): string {
  const hosts = new Set<string>();
  const paths = new Set(files.map((file) => file.path));
  for (const { path, bytes } of files) {
    if (path.split("/").some((part) => !part || part === "." || part === "..") || /[\\\r\n\0]/.test(path))
      throw new Error("Unsafe changed path");
    if (
      /(?:^|\/)(?:\.cache|documents?-crawl|documentation-crawl)(?:\/|$)/.test(path) ||
      /(?:^|\/)(?:DOMAINS\.(?:md|tsv)|CRAWL-(?:COVERAGE\.md|REPORTS\.json))$/i.test(path) ||
      /\.(?:sqlite(?:-wal|-shm|-journal)?|jsonl)$/i.test(path)
    )
      throw new Error(`Crawl intermediate cannot be committed: ${path}`);
    const document = /^data\/documents\/([^/]+)\/([a-f0-9]{64}\.md)$/.exec(path);
    if (path.startsWith("data/") && path !== "data/official-hosts.json" && !document)
      throw new Error(`Only final host text/index may change under data/: ${path}`);
    const owner = document?.[1] ?? /^(?:src\/host-scrapers|test\/fixtures\/host-scrapers)\/([^/]+)\//.exec(path)?.[1];
    if (owner) {
      if (normalizeHost(owner) !== owner) throw new Error("Unnormalized hostname path");
      hosts.add(owner);
    }
    if (bytes !== null) {
      if (bytes.byteLength > 1024 * 1024) throw new Error(`Oversized staged file: ${path}`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0") || text.startsWith("version https://git-lfs.github.com/spec/v1"))
        throw new Error(`Binary or LFS content is forbidden: ${path}`);
      if (path === ".gitattributes" && /\bfilter=lfs\b/.test(text)) throw new Error("LFS attributes are forbidden");
    }
  }
  if (hosts.size !== 1) throw new Error("A hostname commit must contain exactly one accepted hostname");
  const host = [...hosts][0]!;
  for (const required of [
    `src/host-scrapers/${host}/index.ts`,
    `src/host-scrapers/${host}/index.test.ts`,
    "src/host-crawl/registry.ts",
    "data/official-hosts.json",
  ])
    if (!paths.has(required) || files.find((file) => file.path === required)?.bytes === null)
      throw new Error(`Missing hostname commit component: ${required}`);
  if (!files.some((file) => file.path.startsWith(`data/documents/${host}/`) && file.bytes !== null))
    throw new Error("Hostname commit has no final documents");
  return host;
}
