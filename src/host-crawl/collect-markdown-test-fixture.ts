import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { CollectionFormats, collectRecordedHost } from "./collect.ts";
import type {
  HostArchive,
  HostScraper,
  MarkdownDocumentExtraction,
  Observation,
  ProducerContext,
  SavedUrl,
  SearchDocument,
} from "./contracts.ts";
import { inspectMarkdownSource } from "./markdown-inspection.mjs";
import { pageExclusion } from "./urls.ts";

const hostname = "manufacturing.engineering.ubc.ca";
export const origin = `https://${hostname}`;
export const targetUrl = `${origin}/node/1.md`;
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const producer: ProducerContext = {
  inputs_sha256: hash("producer"),
  runtime: {
    node: process.versions.node,
    icu: process.versions.icu!,
    unicode: process.versions.unicode!,
    platform: process.platform,
    arch: process.arch,
  },
};

export function fixture() {
  const values = new Map<string, Observation>();
  const put = (url: string, body: string, contentType: string, status = 200): Observation => {
    const snapshot = {
      url,
      requested_url: url,
      status,
      headers: { "content-type": contentType },
      body,
      bytes: Buffer.byteLength(body),
      retrieved_at: "2026-01-01T00:00:00Z",
    };
    const observation = { snapshot, sha256: hash(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const refresh = (observation: Observation) => {
    observation.sha256 = hash(JSON.stringify(observation.snapshot));
    values.set(observation.snapshot.requested_url, observation);
  };
  const homepage = put(
    `${origin}/`,
    '<html><head><link rel="alternate" type="text/markdown" href="/node/1.md" title="Manufacturing guide"></head><body><main><h1>Manufacturing</h1><p>Official program guidance.</p><a href="/node/1.md">Markdown source</a></main></body></html>',
    "text/html; charset=utf-8",
  );
  const robots = put(`${origin}/robots.txt`, "User-agent: *\n", "text/plain");
  const markdownBytes = Buffer.from("# Body heading\r\n\r\nExact [program link](https://engineering.ubc.ca/).", "utf8");
  const target = put(targetUrl, markdownBytes.toString("utf8"), "text/markdown; charset=utf-8");
  const savedTarget: SavedUrl = {
    url: targetUrl,
    kind: "page",
    state: "pending",
    disposition: null,
    reason: null,
    snapshot: null,
    article_id: null,
    source_modified_at: null,
  };
  const scraper: HostScraper = {
    hostname,
    title: "Manufacturing Engineering",
    scope: "Synthetic complete host with one exact Markdown source.",
    adapter: { kind: "html", allowedTypes: [], exactHostInventory: true },
    documentFormats: ["markdown"],
    excludeUrl: (url) => pageExclusion(url, hostname),
    vetHomepage: () => ({ accepted: true, reason: "fixture" }),
    extract(snapshot) {
      return {
        kind: "document",
        input: {
          url: snapshot.url,
          title: "Manufacturing Engineering",
          html: snapshot.body,
          retrievedAt: snapshot.retrieved_at,
          sourceModifiedAt: null,
        },
      };
    },
  };
  let receiptBytes = Buffer.from(markdownBytes);
  let receiptSha256 = hash(receiptBytes);
  const archive: HostArchive = {
    hostname,
    input_sha256: hash("input"),
    homepage,
    urls: [savedTarget],
    retained: [],
    read: vi.fn(async (url) => {
      const observation = values.get(url);
      if (!observation) throw new Error(`Missing fixture observation: ${url}`);
      return observation;
    }),
    readSnapshot: vi.fn(async (sha256) => {
      const observation = [...values.values()].find((value) => value.sha256 === sha256);
      if (!observation) throw new Error(`Missing fixture snapshot: ${sha256}`);
      return observation;
    }),
    readTextBytes: vi.fn(async (sha256) => {
      if (sha256 !== target.sha256) throw new Error("Unexpected Markdown byte receipt");
      return { bytes: Buffer.from(receiptBytes), sha256: receiptSha256 };
    }),
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  const profileSha256 = hash("closed runtime profile");
  const inspect = vi.fn(async (bytes: Uint8Array, titles: readonly (string | null)[]) => ({
    inspection: inspectMarkdownSource(Buffer.from(bytes), titles),
    profile_sha256: profileSha256,
    termination: "observed-pid-absence" as const,
  }));
  const formats: CollectionFormats = {
    markdown: { profile_sha256: profileSha256, inspect },
  };
  return {
    values,
    put,
    refresh,
    homepage,
    robots,
    target,
    scraper,
    archive,
    formats,
    inspect,
    markdownBytes,
    setReceipt(bytes: Uint8Array, sha256 = hash(bytes)) {
      receiptBytes = Buffer.from(bytes);
      receiptSha256 = sha256;
    },
  };
}

export function markdownDocument(
  result: Awaited<ReturnType<typeof collectRecordedHost>>,
): SearchDocument & { extraction: MarkdownDocumentExtraction } {
  const document = result.documents.find((candidate) => candidate.source_url === targetUrl);
  if (document?.extraction?.format !== "markdown") throw new Error("Missing Markdown fixture output");
  return document as SearchDocument & { extraction: MarkdownDocumentExtraction };
}
