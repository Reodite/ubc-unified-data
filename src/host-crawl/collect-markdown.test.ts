import { describe, expect, it, vi } from "vitest";
import { fixture, hash, markdownDocument, origin, producer, targetUrl } from "./collect-markdown-test-fixture.ts";
import { collectRecordedHost } from "./collect.ts";
import { formatDocument, MARKDOWN_DOCUMENT_FORMAT_VERSION, parseDocument } from "./document-format.ts";
import { inspectMarkdownSource } from "./markdown-inspection.mjs";

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

  it("resolves explicit relative Markdown references into the bounded host traversal", async () => {
    const f = fixture();
    const bytes = Buffer.from("# Body heading\n\n[Program details](/program).", "utf8");
    f.target.snapshot.body = bytes.toString("utf8");
    f.target.snapshot.bytes = bytes.length;
    f.refresh(f.target);
    f.setReceipt(bytes);
    f.put(
      `${origin}/program`,
      "<html><body><main><h1>Program details</h1><p>Academic requirements.</p></main></body></html>",
      "text/html; charset=utf-8",
    );
    const result = await collectRecordedHost(f.scraper, f.archive, producer, f.formats);
    const document = markdownDocument(result);
    expect(document.content_markdown).toBe(bytes.toString("utf8"));
    expect(document.body_sha256).toBe(hash(bytes));
    expect(document.extraction.source_bytes_sha256).toBe(hash(bytes));
    expect(result.documents.map((candidate) => candidate.source_url)).toContain(`${origin}/program`);
    expect(f.archive.read).toHaveBeenCalledWith(`${origin}/program`);
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
