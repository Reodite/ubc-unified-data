import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { collectRecordedHost, type CollectionFormats } from "./collect.ts";
import type { HostArchive, HostScraper, Observation, ProducerContext, SavedUrl } from "./contracts.ts";
import { formatDocument, MARKDOWN_DOCUMENT_FORMAT_VERSION, parseDocument } from "./document-format.ts";
import { inspectMarkdownSource } from "./markdown-inspection.mjs";
import { pageExclusion } from "./urls.ts";

const hostname = "manufacturing.engineering.ubc.ca";
const origin = `https://${hostname}`;
const targetUrl = `${origin}/node/1.md`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const producer: ProducerContext = {
  inputs_sha256: hash("producer"),
  runtime: {
    node: process.versions.node,
    icu: process.versions.icu!,
    unicode: process.versions.unicode!,
    platform: process.platform,
    arch: process.arch,
  },
};

function fixture() {
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

function markdownDocument(result: Awaited<ReturnType<typeof collectRecordedHost>>) {
  const document = result.documents.find((candidate) => candidate.source_url === targetUrl);
  if (document?.extraction?.format !== "markdown") throw new Error("Missing Markdown fixture output");
  return document;
}

describe("exact witnessed Markdown collection", () => {
  it("publishes verbatim target bytes with v4 witness and runtime provenance", async () => {
    const f = fixture();
    const result = await collectRecordedHost(f.scraper, f.archive, producer, f.formats);
    const document = markdownDocument(result);
    expect(result.documents).toHaveLength(2);
    expect(document.title).toBe("Body heading");
    expect(document.content_markdown).toBe(f.markdownBytes.toString("utf8"));
    expect(document.body_sha256).toBe(hash(f.markdownBytes));
    expect(document.alternate_urls).toEqual([]);
    expect(document.extraction).toEqual({
      format: "markdown",
      source_bytes_sha256: hash(f.markdownBytes),
      source_bytes: f.markdownBytes.length,
      profile_sha256: f.formats.markdown!.profile_sha256,
      termination: "observed-pid-absence",
      title_origin: { kind: "markdown-body" },
      witnesses: [
        {
          source_url: `${origin}/`,
          snapshot_sha256: f.homepage.sha256,
          target_url: targetUrl,
          channel: "html-head",
          title: "Manufacturing guide",
        },
      ],
    });
    expect(f.inspect).toHaveBeenCalledTimes(1);
    expect(f.inspect).toHaveBeenCalledWith(f.markdownBytes, ["Manufacturing guide"]);
    expect(f.archive.read).toHaveBeenCalledWith(targetUrl);
    expect(f.archive.readTextBytes).toHaveBeenCalledWith(f.target.sha256);
    const wire = formatDocument(document);
    expect(JSON.parse(wire.subarray(4, wire.indexOf(Buffer.from("\n---\n"), 4)).toString())).toMatchObject({
      format_version: MARKDOWN_DOCUMENT_FORMAT_VERSION,
    });
    expect(parseDocument(wire)).toEqual(document);
    expect(f.archive.assertUnchanged).toHaveBeenCalledOnce();
  });

  it("extracts one target when both the saved frontier and HTML links name it", async () => {
    const f = fixture();
    const result = await collectRecordedHost(f.scraper, f.archive, producer, f.formats);
    expect(result.documents.filter((document) => document.source_url === targetUrl)).toHaveLength(1);
    expect(f.inspect).toHaveBeenCalledOnce();
    expect(f.archive.read).toHaveBeenCalledWith(targetUrl);
  });

  it("refuses retained Markdown without an explicit extraction comparison policy", async () => {
    const f = fixture();
    const original = markdownDocument(await collectRecordedHost(f.scraper, f.archive, producer, f.formats));
    f.archive.retained = [
      {
        id: original.id,
        source_url: original.source_url,
        title: original.title,
        snapshot: original.snapshot_sha256,
        retrieved_at: original.retrieved_at,
        source_modified_at: original.source_modified_at,
        body_sha256: original.body_sha256,
        content_sha256: original.content_sha256,
        content_markdown: original.content_markdown,
      },
    ];
    const changed = Buffer.from("# Changed heading\n\nChanged body.", "utf8");
    f.target.snapshot.body = changed.toString("utf8");
    f.target.snapshot.bytes = changed.length;
    f.refresh(f.target);
    f.setReceipt(changed);
    await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow(
      /Retained Markdown needs an explicit extraction comparison policy/,
    );
  });

  it.each([
    "text/plain",
    "text/markdown; charset=iso-8859-1",
    "text/markdown; charset=utf-8; version=1",
    "text/markdown, text/plain",
  ])("rejects ambiguous or unsupported Markdown media type %s", async (mediaType) => {
    const f = fixture();
    f.target.snapshot.headers["content-type"] = mediaType;
    f.refresh(f.target);
    await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow(/text\/markdown/);
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it.each(["status", "range", "identity", "robots"])("rejects invalid required target %s", async (kind) => {
    const f = fixture();
    if (kind === "status") f.target.snapshot.status = 404;
    if (kind === "range") f.target.snapshot.headers["content-range"] = `bytes 0-${f.markdownBytes.length - 1}/*`;
    if (kind === "identity") f.target.snapshot.url = `${origin}/node/2.md`;
    if (kind === "robots") f.robots.snapshot.body = "User-agent: *\nDisallow: /node/1.md\n";
    f.refresh(kind === "robots" ? f.robots : f.target);
    await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow();
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it.each(["receipt hash", "receipt bytes", "BOM", "runtime bytes", "runtime profile"])(
    "rejects mismatched %s without emitting metadata",
    async (kind) => {
      const f = fixture();
      if (kind === "receipt hash") f.setReceipt(f.markdownBytes, hash("wrong receipt"));
      if (kind === "receipt bytes") f.setReceipt(Buffer.from("# Changed\n"));
      if (kind === "BOM") {
        const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), f.markdownBytes]);
        f.setReceipt(bytes);
        f.target.snapshot.bytes = bytes.length;
        f.refresh(f.target);
      }
      if (kind === "runtime bytes" || kind === "runtime profile")
        f.formats.markdown!.inspect = vi.fn(async (bytes, titles) => {
          const inspection = inspectMarkdownSource(Buffer.from(bytes), titles);
          return {
            inspection:
              kind === "runtime bytes"
                ? { ...inspection, source_bytes_sha256: hash("wrong runtime bytes") }
                : inspection,
            profile_sha256:
              kind === "runtime profile" ? hash("wrong runtime profile") : f.formats.markdown!.profile_sha256,
            termination: "observed-pid-absence" as const,
          };
        });
      await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow();
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    },
  );

  it.each(["advertisement title", "termination"])("rejects invalid runtime %s evidence", async (kind) => {
    const f = fixture();
    const inspect = f.formats.markdown!.inspect;
    f.formats.markdown!.inspect = async (bytes, titles) => {
      const result = await inspect(bytes, titles);
      if (kind === "advertisement title")
        return {
          ...result,
          inspection: {
            ...result.inspection,
            title: "Forged advertisement",
            title_origin: { kind: "advertisement" as const, witness_index: 0 },
          },
        };
      return { ...result, termination: "invalid" as never };
    };
    await expect(collectRecordedHost(f.scraper, f.archive, producer, f.formats)).rejects.toThrow();
    expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
  });

  it("requires the exact source witness, byte reader and runtime adapter", async () => {
    const missingWitness = fixture();
    missingWitness.homepage.snapshot.body = "<html><head></head><body><p>Official guidance.</p></body></html>";
    missingWitness.homepage.snapshot.bytes = Buffer.byteLength(missingWitness.homepage.snapshot.body);
    missingWitness.refresh(missingWitness.homepage);
    await expect(
      collectRecordedHost(missingWitness.scraper, missingWitness.archive, producer, missingWitness.formats),
    ).rejects.toThrow(/witness/);

    const missingReader = fixture();
    delete missingReader.archive.readTextBytes;
    await expect(
      collectRecordedHost(missingReader.scraper, missingReader.archive, producer, missingReader.formats),
    ).rejects.toThrow(/unavailable/);

    const missingRuntime = fixture();
    delete missingRuntime.formats.markdown;
    await expect(
      collectRecordedHost(missingRuntime.scraper, missingRuntime.archive, producer, missingRuntime.formats),
    ).rejects.toThrow(/unavailable/);
  });
});
