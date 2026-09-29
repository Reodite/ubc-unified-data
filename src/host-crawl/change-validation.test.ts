import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "./categories.ts";
import { formatRoutingPolicy, routeSearchDocument, type HostRoutingPolicy } from "./category-routing.ts";
import { assertSingleHostChange, type ChangedFile, type HostChangeOptions } from "./change-validation.ts";
import type { SearchDocument, VettedHost } from "./contracts.ts";
import { documentFilename, formatDocument, parseDocument, sha256 } from "./document-format.ts";
import { formatHostList } from "./public-validation.ts";

const host = "fixture.ubc.ca";
function fixture(): ChangedFile[] {
  return [
    `src/host-scrapers/${host}/index.ts`,
    `src/host-scrapers/${host}/index.test.ts`,
    "src/host-crawl/registry.ts",
    "data/official-hosts.json",
    `data/documents/${host}/${"a".repeat(64)}.md`,
  ].map((path) => ({ path, bytes: Buffer.from("text\n") }));
}
describe("one-host staged publication boundary", () => {
  it("accepts one complete host with shared foundation code", () =>
    expect(
      assertSingleHostChange([...fixture(), { path: "src/host-crawl/collect.ts", bytes: Buffer.from("export {};\n") }]),
    ).toBe(host));
  it.each([
    "data/document-crawl/raw.json",
    "data/documents-crawl/markdown/final.md",
    "data/documentation-crawl/state.json",
    ".cache/document-crawl/state.sqlite",
    "DOMAINS.tsv",
    "CRAWL-COVERAGE.md",
    "data/prose/changed.json",
    "data/queue.jsonl",
  ])("rejects intermediate or unrelated dataset change %s", (path) =>
    expect(() => assertSingleHostChange([...fixture(), { path, bytes: Buffer.from("{}") }])).toThrow(),
  );
  it("rejects multiple hosts and incomplete commit units", () => {
    expect(() =>
      assertSingleHostChange([
        ...fixture(),
        { path: "src/host-scrapers/other.ubc.ca/index.ts", bytes: Buffer.from("code") },
      ]),
    ).toThrow(/exactly one/);
    for (let i = 0; i < fixture().length; i++)
      expect(() => assertSingleHostChange(fixture().filter((_entry, index) => index !== i))).toThrow();
  });
  it.each([
    Buffer.from([0xff]),
    Buffer.from("binary\0value"),
    Buffer.from("version https://git-lfs.github.com/spec/v1\n"),
    Buffer.alloc(1024 * 1024 + 1, "x"),
  ])("rejects unsafe or oversized bytes", (bytes) =>
    expect(() => assertSingleHostChange([...fixture(), { path: "extra.md", bytes }])).toThrow(),
  );
  it("accepts one generic declaration without bespoke files", () => {
    const files: ChangedFile[] = [
      {
        path: "src/host-scrapers/generic-hosts.json",
        previousBytes: Buffer.from("[]\n"),
        bytes: Buffer.from(JSON.stringify([host])),
      },
      { path: "data/official-hosts.json", bytes: Buffer.from("[]\n") },
      { path: `data/documents/${host}/${"a".repeat(64)}.md`, bytes: Buffer.from("text\n") },
    ];
    expect(assertSingleHostChange(files)).toBe(host);
    expect(() => assertSingleHostChange([{ ...files[0]!, previousBytes: undefined }, ...files.slice(1)])).toThrow(
      /baseline/,
    );
    expect(() =>
      assertSingleHostChange([
        { ...files[0]!, bytes: Buffer.from(JSON.stringify([host, "other.ubc.ca"])) },
        ...files.slice(1),
      ]),
    ).toThrow(/only the published/);
    expect(() =>
      assertSingleHostChange([{ ...files[0]!, previousBytes: Buffer.from('["old.ubc.ca"]') }, ...files.slice(1)]),
    ).toThrow(/only the published/);
  });
  it("rejects LFS attributes and deleted required source", () => {
    expect(() =>
      assertSingleHostChange([...fixture(), { path: ".gitattributes", bytes: Buffer.from("*.json filter=lfs\n") }]),
    ).toThrow(/LFS/);
    const files = fixture();
    files[0]!.bytes = null;
    expect(() => assertSingleHostChange(files)).toThrow(/Missing/);
  });
});

const otherHost = "other.ubc.ca";
const indexPath = "data/official-hosts.json";
const registryPath = "src/host-scrapers/generic-hosts.json";
const routingPath = `src/host-scrapers/routing/${host}.json`;
const modes = ["publish", "migrate", "withdraw"] as const;

function sourceDocument(route = "/student"): SearchDocument {
  const source_url = `https://${host}${route}`;
  const title = "Original source title";
  const body = "Original **source** prose.\r\n\nCafé without a final newline";
  return {
    id: `documents:official-web:${sha256(source_url).slice(0, 24)}`,
    hostname: host,
    title,
    source_url,
    retrieved_at: "2026-01-02T03:04:05.000Z",
    source_modified_at: null,
    snapshot_sha256: sha256("snapshot"),
    input_sha256: sha256("input"),
    body_sha256: sha256(body),
    content_sha256: sha256(`${title}\n${body}`),
    content_markdown: body,
    warnings: ["Source warning"],
    alternate_urls: [`https://${host}${route}/alternate`],
    producer: {
      inputs_sha256: sha256("producer"),
      runtime: { node: "v26.8.1", icu: "78.2", unicode: "17.0", platform: "linux", arch: "x64" },
    },
    ...(route.endsWith(".pdf")
      ? {
          extraction: {
            format: "pdf" as const,
            source_bytes_sha256: sha256("raw PDF"),
            source_bytes: 1234,
            pages: 2,
            profile_sha256: sha256("native profile"),
          },
        }
      : {}),
  };
}

function policy(category: DocumentCategory = "support"): HostRoutingPolicy {
  return {
    version: 1,
    hostname: host,
    decision: {
      method: "human-first-classification",
      authority: "Fixture owner",
      rationale: "Original reviewed support and news material",
      evidence: [`https://${host}/`],
    },
    rules: [{ id: "news-path", category: "news", rationale: "News section", path_pattern: "^/news/" }],
    fallback: { id: "default", category, rationale: "Reviewed host default" },
  };
}

function legacyHost(hostname = host, count = 2): VettedHost {
  return {
    hostname,
    title: "Original host title",
    homepage_url: `https://${hostname}/`,
    homepage_retrieved_at: "2026-01-02T03:04:05.000Z",
    homepage_sha256: sha256("homepage"),
    scope: "Public student-facing prose",
    document_root: `data/documents/${hostname}`,
    document_count: count,
  };
}

function indexBytes(hosts: VettedHost[]): Buffer {
  return formatHostList(
    hosts,
    hosts.map((entry) => entry.hostname),
  );
}

function categoryFixture(mode: NonNullable<HostChangeOptions["mode"]>, category: DocumentCategory = "support") {
  const routing = policy(category);
  const original = [sourceDocument(), sourceDocument("/news/guide.pdf")];
  const routed = original.map((document) => routeSearchDocument(document, routing));
  const { document_root: _root, ...metadata } = legacyHost();
  const categorized: VettedHost = {
    ...metadata,
    document_roots: [...new Set(routed.map((document) => document.category!))].sort().map((name) => ({
      category: name,
      path: `data/documents/${name}/${host}`,
      document_count: routed.filter((document) => document.category === name).length,
    })),
  };
  const files: ChangedFile[] = [
    {
      path: indexPath,
      previousBytes: indexBytes([legacyHost(otherHost, 1), ...(mode === "publish" ? [] : [legacyHost()])]),
      bytes: indexBytes([legacyHost(otherHost, 1), ...(mode === "withdraw" ? [] : [categorized])]),
    },
  ];
  if (mode !== "publish")
    files.push(
      ...original.map((document) => ({
        path: `data/documents/${host}/${documentFilename(document.id)}`,
        previousBytes: formatDocument(document),
        bytes: null,
      })),
    );
  if (mode !== "withdraw") {
    files.push({ path: routingPath, previousBytes: null, bytes: formatRoutingPolicy(routing) });
    files.push(
      ...routed.map((document) => ({
        path: `data/documents/${document.category}/${host}/${documentFilename(document.id)}`,
        previousBytes: null,
        bytes: formatDocument(document),
      })),
    );
  }
  if (mode === "publish")
    files.push({ path: registryPath, previousBytes: Buffer.from("[]\n"), bytes: Buffer.from(JSON.stringify([host])) });
  return files;
}

function editIndex(
  files: ChangedFile[],
  change: (hosts: VettedHost[]) => VettedHost[],
  side: "bytes" | "previousBytes" = "bytes",
) {
  const index = files.find((file) => file.path === indexPath)!;
  index[side] = indexBytes(change(JSON.parse(Buffer.from(index[side]!).toString())));
}

function addedDocument(files: ChangedFile[]) {
  return files.find((file) => file.path.startsWith("data/documents/") && file.bytes !== null)!;
}

function removedDocument(files: ChangedFile[]) {
  return files.find((file) => file.path.startsWith("data/documents/") && file.bytes === null)!;
}

function rewriteDocument(file: ChangedFile, mutate: (document: SearchDocument) => void) {
  const document = parseDocument(file.bytes!);
  mutate(document);
  document.body_sha256 = sha256(document.content_markdown);
  document.content_sha256 = sha256(`${document.title}\n${document.content_markdown}`);
  file.bytes = formatDocument(document);
}

describe("category-first atomic changes", () => {
  it.each(modes)("accepts one complete %s unit without changing other hosts", (mode) => {
    expect(assertSingleHostChange(categoryFixture(mode), { mode, expectedHostname: host })).toBe(host);
  });

  it.each(DOCUMENT_CATEGORIES)("accepts the declared %s category", (category) => {
    expect(assertSingleHostChange(categoryFixture("publish", category))).toBe(host);
    expect(assertSingleHostChange(categoryFixture("migrate", category), { mode: "migrate" })).toBe(host);
  });

  it.each(modes)("rejects cross-host index metadata tampering during %s", (mode) => {
    const files = categoryFixture(mode);
    editIndex(files, (hosts) =>
      hosts.map((entry) => (entry.hostname === otherHost ? { ...entry, scope: "Tampered scope" } : entry)),
    );
    expect(() => assertSingleHostChange(files, { mode })).toThrow(/Other-host/);
  });

  it.each(modes)("rejects cross-host index additions or removals during %s", (mode) => {
    for (const remove of [false, true]) {
      const files = categoryFixture(mode);
      editIndex(files, (hosts) =>
        remove ? hosts.filter((entry) => entry.hostname !== otherHost) : [...hosts, legacyHost("third.ubc.ca", 1)],
      );
      expect(() => assertSingleHostChange(files, { mode })).toThrow(/Other-host/);
    }
  });

  it.each(modes)("requires explicit old index bytes for %s", (mode) => {
    const files = categoryFixture(mode);
    files[0]!.previousBytes = undefined;
    expect(() => assertSingleHostChange(files, { mode })).toThrow(/baseline/);
    if (mode !== "publish") {
      files[0]!.previousBytes = null;
      expect(() => assertSingleHostChange(files, { mode })).toThrow(/baseline/);
    }
  });

  it("accepts an absent index baseline only for the first new publication", () => {
    const files = categoryFixture("publish");
    files[0]!.previousBytes = null;
    editIndex(files, (hosts) => hosts.filter((entry) => entry.hostname === host));
    expect(assertSingleHostChange(files)).toBe(host);
  });

  it.each(modes)("rejects an unchanged index for %s", (mode) => {
    const files = categoryFixture(mode);
    files[0]!.bytes = files[0]!.previousBytes!;
    expect(() => assertSingleHostChange(files, { mode })).toThrow();
  });

  it.each(modes)("rejects an invalid expected host and mismatched owner for %s", (mode) => {
    for (const expectedHostname of [otherHost, "Fixture.ubc.ca", "fixture.ubc.ca.", "../fixture.ubc.ca"])
      expect(() => assertSingleHostChange(categoryFixture(mode), { mode, expectedHostname })).toThrow();
  });

  it.each(modes)("rejects another host's documents and routing policy during %s", (mode) => {
    for (const path of [
      `data/documents/support/${otherHost}/${"b".repeat(64)}.md`,
      `src/host-scrapers/routing/${otherHost}.json`,
      `src/host-scrapers/${otherHost}/index.ts`,
      `test/fixtures/host-scrapers/${otherHost}/home.html`,
    ])
      expect(() =>
        assertSingleHostChange([...categoryFixture(mode), { path, bytes: Buffer.from("{}") }], { mode }),
      ).toThrow(/exactly one/);
  });

  it.each([
    "data/documents/misc/fixture.ubc.ca/",
    "data/documents/Support/fixture.ubc.ca/",
    "data/documents/support/../fixture.ubc.ca/",
    "data/documents/support/./fixture.ubc.ca/",
    "data/documents/support//fixture.ubc.ca/",
    "/data/documents/support/fixture.ubc.ca/",
    "data/documents/support/fixture.ubc.ca/nested/",
    "data/documents/support/%66ixture.ubc.ca/",
    "data/documents/support/Fixture.ubc.ca/",
    "data/documents/support/fixture.ubc.ca./",
    "data/documents/support/fixture.ubc.ca\\escape/",
  ])("rejects a spoofed or escaped category path %s", (prefix) => {
    const files = categoryFixture("publish");
    const document = addedDocument(files);
    document.path = `${prefix}${document.path.split("/").at(-1)}`;
    expect(() => assertSingleHostChange(files)).toThrow();
  });

  it.each(["publish", "migrate"] as const)("binds %s documents to the staged canonical routing decision", (mode) => {
    const files = categoryFixture(mode);
    expect(() =>
      assertSingleHostChange(
        files.filter((file) => file.path !== routingPath),
        { mode },
      ),
    ).toThrow(/routing policy/);
    for (const mutate of [
      (document: SearchDocument) => {
        document.category = "academics";
      },
      (document: SearchDocument) => {
        document.routing!.rule_id = "spoofed";
      },
      (document: SearchDocument) => {
        document.routing!.policy_sha256 = sha256("another policy");
      },
    ]) {
      const forged = categoryFixture(mode);
      rewriteDocument(addedDocument(forged), mutate);
      expect(() => assertSingleHostChange(forged, { mode })).toThrow();
    }
    const spoofed = categoryFixture(mode);
    const document = addedDocument(spoofed);
    rewriteDocument(document, (doc) => {
      doc.category = "academics";
    });
    document.path = document.path.replace("/support/", "/academics/");
    editIndex(spoofed, (hosts) =>
      hosts.map((entry) =>
        entry.hostname === host
          ? {
              ...entry,
              document_roots: entry
                .document_roots!.map((root) =>
                  root.category === "support"
                    ? {
                        ...root,
                        category: "academics" as const,
                        path: `data/documents/academics/${host}`,
                      }
                    : root,
                )
                .sort((a, b) => a.category.localeCompare(b.category)),
            }
          : entry,
      ),
    );
    expect(() => assertSingleHostChange(spoofed, { mode })).toThrow(/classification/);
  });

  it("rejects routing policy owner spoofing, noncanonical bytes and replaced first decisions", () => {
    for (const value of [
      formatRoutingPolicy({ ...policy(), hostname: otherHost }),
      Buffer.from(JSON.stringify(policy())),
    ]) {
      const files = categoryFixture("publish");
      files.find((file) => file.path === routingPath)!.bytes = value;
      expect(() => assertSingleHostChange(files)).toThrow();
    }
    const files = categoryFixture("migrate");
    files.find((file) => file.path === routingPath)!.previousBytes = formatRoutingPolicy(policy("research"));
    expect(() => assertSingleHostChange(files, { mode: "migrate" })).toThrow(/immutable/);
  });

  it.each(modes)("rejects missing document operations and duplicate paths during %s", (mode) => {
    const files = categoryFixture(mode);
    expect(() =>
      assertSingleHostChange(
        files.filter((file) => !file.path.startsWith("data/documents/")),
        { mode },
      ),
    ).toThrow(/no final documents|exactly one/);
    expect(() => assertSingleHostChange([...files, files[0]!], { mode })).toThrow(/Duplicate/);
    expect(() => assertSingleHostChange([], { mode, expectedHostname: host })).toThrow(/exactly one/);
  });

  it("rejects unknown operation modes", () => {
    expect(() => assertSingleHostChange(fixture(), { mode: "replace" as HostChangeOptions["mode"] })).toThrow(/mode/);
  });
});

describe("retained-host category migration", () => {
  it("preserves canonical HTML v1 and PDF v2 originals byte for byte", () => {
    const files = categoryFixture("migrate");
    for (const file of files.filter((entry) => entry.path.startsWith("data/documents/") && entry.bytes !== null)) {
      const { category: _category, routing: _routing, ...original } = parseDocument(file.bytes!);
      const before = files.find((entry) => entry.bytes === null && entry.path.endsWith(documentFilename(original.id)))!;
      expect(formatDocument(original)).toEqual(before.previousBytes);
    }
    expect(
      assertSingleHostChange([...files, { path: "src/host-crawl/collect.ts", bytes: Buffer.from("export {};\n") }], {
        mode: "migrate",
      }),
    ).toBe(host);
  });

  it.each([
    [
      "body",
      (doc: SearchDocument) => {
        doc.content_markdown += "\n";
      },
    ],
    [
      "title",
      (doc: SearchDocument) => {
        doc.title = "Rewritten title";
      },
    ],
    [
      "retrieval",
      (doc: SearchDocument) => {
        doc.retrieved_at = "2026-01-03T03:04:05.000Z";
      },
    ],
    [
      "source timestamp",
      (doc: SearchDocument) => {
        doc.source_modified_at = "2026-01-01T03:04:05.000Z";
      },
    ],
    [
      "snapshot",
      (doc: SearchDocument) => {
        doc.snapshot_sha256 = sha256("new snapshot");
      },
    ],
    [
      "input",
      (doc: SearchDocument) => {
        doc.input_sha256 = sha256("new input");
      },
    ],
    [
      "producer",
      (doc: SearchDocument) => {
        doc.producer.inputs_sha256 = sha256("new producer");
      },
    ],
    [
      "runtime",
      (doc: SearchDocument) => {
        doc.producer.runtime.node = "v26.9.0";
      },
    ],
    [
      "warnings",
      (doc: SearchDocument) => {
        doc.warnings = [];
      },
    ],
    [
      "alternates",
      (doc: SearchDocument) => {
        doc.alternate_urls = [];
      },
    ],
  ] as const)("rejects otherwise-valid %s rewriting", (_label, mutate) => {
    const files = categoryFixture("migrate");
    rewriteDocument(addedDocument(files), mutate);
    expect(() => assertSingleHostChange(files, { mode: "migrate" })).toThrow(/preserve original/);
  });

  it("rejects PDF extraction provenance mutation", () => {
    const files = categoryFixture("migrate");
    const pdf = files.find((file) => file.path.includes("/news/") && file.bytes)!;
    rewriteDocument(pdf, (doc) => {
      doc.extraction!.source_bytes_sha256 = sha256("different PDF");
    });
    expect(() => assertSingleHostChange(files, { mode: "migrate" })).toThrow(/preserve original/);
  });

  it("rejects a new valid identity even when the total document count is unchanged", () => {
    const files = categoryFixture("migrate");
    const file = addedDocument(files);
    const replacement = routeSearchDocument(sourceDocument("/different"), policy());
    file.bytes = formatDocument(replacement);
    file.path = `data/documents/support/${host}/${documentFilename(replacement.id)}`;
    expect(() => assertSingleHostChange(files, { mode: "migrate" })).toThrow(/migration pair/);
  });

  it.each(["old", "new"])("rejects a missing %s migration pair", (side) => {
    const files = categoryFixture("migrate");
    const missing = side === "old" ? removedDocument(files) : addedDocument(files);
    expect(() =>
      assertSingleHostChange(
        files.filter((file) => file !== missing),
        { mode: "migrate" },
      ),
    ).toThrow(/count|pair/);
  });

  it.each(["bytes", "previousBytes"] as const)("requires canonical document %s", (side) => {
    const files = categoryFixture("migrate");
    const document = side === "bytes" ? addedDocument(files) : removedDocument(files);
    document[side] = Buffer.from(Buffer.from(document[side]!).toString().replace('  "id":', '    "id":'));
    expect(() => assertSingleHostChange(files, { mode: "migrate" })).toThrow(/Noncanonical/);
  });

  it.each([null, undefined])("requires deleted original bytes: %s", (previousBytes) => {
    const files = categoryFixture("migrate");
    removedDocument(files).previousBytes = previousBytes;
    expect(() => assertSingleHostChange(files, { mode: "migrate" })).toThrow(/baseline/);
  });

  it("rejects category document overwrites and unchanged generic registry controls", () => {
    const files = categoryFixture("migrate");
    addedDocument(files).previousBytes = addedDocument(files).bytes;
    expect(() => assertSingleHostChange(files, { mode: "migrate" })).toThrow(/overwrites/);
    const unchanged = Buffer.from(JSON.stringify([host]));
    expect(() =>
      assertSingleHostChange(
        [...categoryFixture("migrate"), { path: registryPath, bytes: unchanged, previousBytes: unchanged }],
        { mode: "migrate" },
      ),
    ).toThrow(/registry/);
  });

  it.each(["title", "scope", "homepage_sha256", "homepage_retrieved_at"] as const)("preserves host %s", (key) => {
    const files = categoryFixture("migrate");
    const value =
      key === "homepage_sha256"
        ? sha256("new homepage")
        : key === "homepage_retrieved_at"
          ? "2026-01-03T03:04:05.000Z"
          : "Changed metadata";
    editIndex(files, (hosts) => hosts.map((entry) => (entry.hostname === host ? { ...entry, [key]: value } : entry)));
    expect(() => assertSingleHostChange(files, { mode: "migrate" })).toThrow(/preserve target/);
  });
});

describe("owner-rejected hostname withdrawal", () => {
  it("removes only the target from the generic registry", () => {
    const registry: ChangedFile = {
      path: registryPath,
      previousBytes: Buffer.from(JSON.stringify([host, otherHost])),
      bytes: Buffer.from(JSON.stringify([otherHost])),
    };
    expect(assertSingleHostChange([...categoryFixture("withdraw"), registry], { mode: "withdraw" })).toBe(host);
    for (const after of [[], [host], [host, otherHost], [otherHost, "third.ubc.ca"]])
      expect(() =>
        assertSingleHostChange(
          [...categoryFixture("withdraw"), { ...registry, bytes: Buffer.from(JSON.stringify(after)) }],
          { mode: "withdraw" },
        ),
      ).toThrow(/only the withdrawn/);
    expect(() =>
      assertSingleHostChange([...categoryFixture("withdraw"), { ...registry, previousBytes: undefined }], {
        mode: "withdraw",
      }),
    ).toThrow(/baseline/);
  });

  it("withdraws categorized documents and optionally deletes their routing config", () => {
    const published = categoryFixture("publish");
    const files = categoryFixture("withdraw").filter((file) => !file.path.startsWith("data/documents/"));
    files[0]!.previousBytes = published[0]!.bytes;
    files.push(
      ...published
        .filter((file) => file.path.startsWith("data/documents/") || file.path === routingPath)
        .map((file) => ({ ...file, previousBytes: file.bytes, bytes: null })),
    );
    expect(assertSingleHostChange(files, { mode: "withdraw" })).toBe(host);
    const routing = files.find((file) => file.path === routingPath)!;
    routing.bytes = routing.previousBytes!;
    expect(() => assertSingleHostChange(files, { mode: "withdraw" })).toThrow(/routing policy/);
  });

  it("requires every target document deletion and never accepts an empty retained host", () => {
    const files = categoryFixture("withdraw");
    expect(() =>
      assertSingleHostChange(
        files.filter((file) => file !== removedDocument(files)),
        { mode: "withdraw" },
      ),
    ).toThrow(/count/);
    const index = files[0]!;
    const hosts = JSON.parse(Buffer.from(index.previousBytes!).toString()) as VettedHost[];
    index.bytes = Buffer.from(
      `${JSON.stringify(
        hosts.map((entry) => (entry.hostname === host ? { ...entry, document_count: 0 } : entry)),
        null,
        2,
      )}\n`,
    );
    expect(() => assertSingleHostChange(files, { mode: "withdraw" })).toThrow(/positive/);
  });

  it("forbids additions even when all original documents are deleted", () => {
    const addition = addedDocument(categoryFixture("publish"));
    expect(() => assertSingleHostChange([...categoryFixture("withdraw"), addition], { mode: "withdraw" })).toThrow(
      /only target document deletions/,
    );
  });

  it("validates deleted identity, canonical bytes and provenance rather than trusting paths", () => {
    for (const previousBytes of [
      undefined,
      null,
      Buffer.from("not a document"),
      formatDocument(sourceDocument("/different")),
    ]) {
      const files = categoryFixture("withdraw");
      removedDocument(files).previousBytes = previousBytes;
      expect(() => assertSingleHostChange(files, { mode: "withdraw" })).toThrow();
    }
  });
});

async function runCommand(files: ChangedFile[], args: string[], publishedHosts?: VettedHost[]) {
  const calls: string[][] = [];
  const index = files.find((file) => file.path === indexPath)!;
  const finalHosts = publishedHosts ?? JSON.parse(Buffer.from(index.bytes!).toString());
  const validate = vi.fn(async () => finalHosts);
  const git = vi.fn((command: string, flags: string[]) => {
    expect(command).toBe("git");
    expect(flags[0]).toBe("--no-optional-locks");
    const args = flags.slice(1);
    calls.push(args);
    if (args[0] === "diff" && args[1] === "--name-only") return Buffer.alloc(0);
    if (args[0] === "ls-files") return Buffer.alloc(0);
    if (args[0] === "diff" && args[1] === "--cached")
      return Buffer.from(
        files
          .map((file) => `${file.bytes === null ? "D" : file.previousBytes == null ? "A" : "M"}\0${file.path}\0`)
          .join(""),
      );
    if (args[0] === "show") {
      const baseline = args[1]!.startsWith("HEAD:");
      const path = args[1]!.slice(baseline ? 5 : 1);
      const file = files.find((file) => file.path === path)!;
      return Buffer.from((baseline ? file.previousBytes : file.bytes)!);
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  });
  const argv = process.argv;
  const exitCode = process.exitCode;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  vi.doMock("node:child_process", () => ({ execFileSync: git }));
  vi.doMock("../base.ts", () => ({ ROOT: "/fixture" }));
  vi.doMock("./registry.ts", () => ({ registeredHostnames: () => [host, otherHost] }));
  vi.doMock("./public-validation.ts", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./public-validation.ts")>()),
    readRegularFile: async (path: string) =>
      Buffer.from(files.find((file) => `/fixture/${file.path}` === path)!.bytes!),
    validatePublishedHosts: validate,
  }));
  try {
    process.argv = [process.execPath, "/fixture/src/validate-host-change.ts", ...args];
    process.exitCode = undefined;
    await import("../validate-host-change.ts");
    return {
      calls,
      exitCode: process.exitCode,
      output: output.mock.calls.map(([value]) => JSON.parse(value as string)),
      errors: errors.mock.calls.map(([value]) => String(value)),
      validation: validate.mock.calls,
    };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    output.mockRestore();
    errors.mockRestore();
    vi.doUnmock("node:child_process");
    vi.doUnmock("../base.ts");
    vi.doUnmock("./registry.ts");
    vi.doUnmock("./public-validation.ts");
    vi.resetModules();
  }
}

describe("staged hostname command", () => {
  it.each(modes)("reads HEAD baselines and reports %s honestly", async (mode) => {
    const files = categoryFixture(mode);
    const result = await runCommand(files, ["--mode", mode, "--host", host]);
    expect(result.errors).toEqual([]);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toEqual([
      {
        hostname: host,
        mode,
        staged_files: files.length,
        ...(mode === "withdraw" ? { withdrawn: true } : { publishable: true }),
      },
    ]);
    expect(result.calls).toContainEqual(["show", `HEAD:${indexPath}`]);
    for (const file of files.filter((file) => file.bytes === null))
      expect(result.calls).toContainEqual(["show", `HEAD:${file.path}`]);
    expect(result.validation).toEqual([
      [
        {
          repositoryRoot: "/fixture",
          registeredHosts: [host, otherHost],
          documentHostnames: mode === "withdraw" ? [] : [host],
        },
      ],
    ]);
  });

  it("defaults to publish and refuses a mismatched expected hostname", async () => {
    const files = categoryFixture("publish");
    const published = await runCommand(files, []);
    expect(published.errors).toEqual([]);
    expect(published.output[0].mode).toBe("publish");
    const mismatch = await runCommand(files, ["--host", otherHost]);
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.output).toEqual([]);
    expect(mismatch.errors[0]).toMatch(/expected hostname/);
    expect(mismatch.validation).toEqual([]);
  });

  it.each([["--mode", "replace"], ["--host"], ["unexpected"], ["--unknown"]])(
    "rejects invalid CLI arguments %j before reading Git",
    async (...args) => {
      const result = await runCommand(categoryFixture("publish"), args);
      expect(result.exitCode).toBe(1);
      expect(result.calls).toEqual([]);
      expect(result.output).toEqual([]);
    },
  );

  it.each(["migrate", "withdraw"] as const)("checks final host presence for %s", async (mode) => {
    const files = categoryFixture(mode);
    const result = await runCommand(files, ["--mode", mode], mode === "withdraw" ? [legacyHost()] : []);
    expect(result.exitCode).toBe(1);
    expect(result.output).toEqual([]);
    expect(result.errors[0]).toMatch(/final vetted index/);
  });
});
