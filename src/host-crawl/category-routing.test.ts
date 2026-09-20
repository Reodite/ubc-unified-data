import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRoutingPolicy,
  loadRoutingPolicy,
  loadSavedClassifications,
  parseRoutingPolicy,
  routeCompletedHost,
  routeSearchDocument,
  saveFirstRoutingPolicy,
  type HostRoutingPolicy,
} from "./category-routing.ts";
import type { CompletedHost, SearchDocument } from "./contracts.ts";
import { documentFilename, formatDocument, parseDocument, sha256 } from "./document-format.ts";
import { EXTERNAL_BOUNDARY } from "./paths.ts";
import { formatHostList, hostDocumentRoots, validatePublishedHosts } from "./public-validation.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function policy(): HostRoutingPolicy {
  return {
    version: 1,
    hostname: "example.ubc.ca",
    decision: {
      method: "model-assisted-first-classification",
      authority: "fixture-owner-decision",
      rationale: "The retained homepage describes a student academic program; news and openings use distinct paths.",
      evidence: ["https://example.ubc.ca/", "https://example.ubc.ca/news/", "https://example.ubc.ca/jobs/"],
    },
    rules: [
      {
        id: "openings",
        category: "opportunities",
        rationale: "Saved participation section",
        path_pattern: "^/jobs(?:/|$)",
      },
      { id: "recaps", category: "news", rationale: "Saved announcement section", path_pattern: "^/news(?:/|$)" },
    ],
    fallback: { id: "program", category: "academics", rationale: "Saved host program classification" },
  };
}

function document(path = "/program"): SearchDocument {
  const source_url = `https://example.ubc.ca${path}`;
  const content_markdown = "Unmodified source **text** with exact spacing.\n";
  const title = "Source heading";
  return {
    id: `documents:official-web:${sha256(source_url).slice(0, 24)}`,
    hostname: "example.ubc.ca",
    title,
    source_url,
    retrieved_at: "2026-09-18T01:02:03.000Z",
    source_modified_at: null,
    snapshot_sha256: sha256("snapshot"),
    input_sha256: sha256("sealed input"),
    body_sha256: sha256(content_markdown),
    content_sha256: sha256(`${title}\n${content_markdown}`),
    content_markdown,
    warnings: [],
    alternate_urls: [],
    producer: {
      inputs_sha256: sha256("original producer"),
      runtime: { node: "26.8.1", icu: "78.3", unicode: "17.0", platform: "linux", arch: "x64" },
    },
  };
}

function completed(): CompletedHost {
  const doc = document();
  return {
    complete: true,
    host: {
      hostname: doc.hostname,
      title: "Source program",
      homepage_url: "https://example.ubc.ca/",
      homepage_retrieved_at: doc.retrieved_at,
      homepage_sha256: sha256("homepage"),
      scope: "Public source text",
      document_root: "data/documents/example.ubc.ca",
      document_count: 3,
    },
    documents: [doc, document("/news/recap"), document("/jobs/research-assistant")],
  };
}

async function fixture() {
  await mkdir(EXTERNAL_BOUNDARY, { recursive: true });
  const root = await mkdtemp(join(EXTERNAL_BOUNDARY, "category-test-"));
  roots.push(root);
  const result = routeCompletedHost(completed(), policy());
  for (const entry of result.documents) {
    const directory = join(root, "data/documents", entry.category!, entry.hostname);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, documentFilename(entry.id)), formatDocument(entry));
  }
  await writeFile(join(root, "data/official-hosts.json"), formatHostList([result.host], [result.host.hostname]));
  return {
    root,
    result,
    options: { repositoryRoot: root, registeredHosts: [result.host.hostname], requireCategories: true },
  };
}

describe("saved first category decisions", () => {
  it("reuses authoritative first classification without a model or network dependency", async () => {
    const { root } = await fixture();
    await saveFirstRoutingPolicy(policy(), root);
    const savedBytes = await readFile(join(root, "src/host-scrapers/routing/example.ubc.ca.json"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("No model or network during regeneration");
      }),
    );
    const saved = await loadRoutingPolicy("example.ubc.ca", root);
    const first = routeSearchDocument(document("/jobs/research-assistant"), saved);
    expect(first.category).toBe("opportunities");
    expect(routeSearchDocument(first, await loadRoutingPolicy("example.ubc.ca", root))).toEqual(first);
    expect(routeSearchDocument(document("/jobs/new-opening"), saved).category).toBe("opportunities");
    expect(await readFile(join(root, "src/host-scrapers/routing/example.ubc.ca.json"))).toEqual(savedBytes);
    expect(fetch).not.toHaveBeenCalled();
    await saveFirstRoutingPolicy(saved, root);
    const changed = { ...saved, fallback: { ...saved.fallback, category: "research" as const } };
    await expect(saveFirstRoutingPolicy(changed, root)).rejects.toThrow(/immutable/);
    expect(() => routeSearchDocument(first, changed)).toThrow(/cannot be replaced/);
  });

  it("reuses a path's stored assignment when a rescrape changes its title", async () => {
    const saved = policy();
    saved.rules.unshift({
      id: "new-announcements",
      category: "news",
      rationale: "Saved title selector for new paths",
      title_pattern: "^Announcement:",
    });
    const first = routeCompletedHost(completed(), saved);
    const fresh = completed();
    const old = fresh.documents[0]!;
    const title = "Announcement: updated program";
    fresh.documents = [
      { ...old, title, content_sha256: sha256(`${title}\n${old.content_markdown}`) },
      ...fresh.documents.slice(1),
    ];
    expect(routeCompletedHost(fresh, saved).documents[0]!.category).toBe("news");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("No classification during rescrape");
      }),
    );
    const reused = routeCompletedHost(fresh, saved, first.documents);
    expect(reused.documents[0]!.category).toBe("academics");
    expect(reused.documents[0]!.routing).toEqual(first.documents[0]!.routing);
    expect(reused.documents[0]!.title).toBe(title);
    expect(fetch).not.toHaveBeenCalled();
    expect(routeCompletedHost(reused, saved, first.documents)).toEqual(reused);
  });

  it("loads category assignments from every manifest root without assuming one host directory", async () => {
    const f = await fixture();
    const saved = await loadSavedClassifications(f.root, f.result.host.hostname);
    expect(saved.map((document) => document.id).sort()).toEqual(
      f.result.documents.map((document) => document.id).sort(),
    );
    expect(routeCompletedHost(completed(), policy(), saved)).toEqual(f.result);
  });

  it("fails on missing classification rather than calling a model or guessing", async () => {
    const { root } = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Forbidden classification");
      }),
    );
    await expect(loadRoutingPolicy("example.ubc.ca", root)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves original identities, body bytes, retrieval and extraction provenance", () => {
    const old = document();
    const pdf = {
      ...old,
      extraction: {
        format: "pdf" as const,
        source_bytes_sha256: sha256("PDF"),
        source_bytes: 123,
        pages: 1,
        profile_sha256: sha256("archived profile"),
      },
    };
    for (const source of [old, pdf]) {
      const before = structuredClone(source);
      const routed = routeSearchDocument(source, policy());
      const { category: _category, routing: _routing, ...rest } = routed;
      expect(rest).toEqual(source);
      expect(source).toEqual(before);
      expect(documentFilename(routed.id)).toBe(documentFilename(source.id));
      const bytes = formatDocument(routed);
      expect(bytes.toString()).toContain('"format_version": 3');
      expect(parseDocument(bytes, { category: "academics" })).toEqual(routed);
      expect(formatDocument(parseDocument(bytes))).toEqual(bytes);
      expect(() => parseDocument(bytes, { category: "support" })).toThrow(/category mismatch/);
    }
  });

  it("keeps taxonomy closed and decisions auditable", () => {
    const saved = policy();
    expect(parseRoutingPolicy(formatRoutingPolicy(saved))).toEqual(saved);
    for (const mutated of [
      { ...saved, hostname: "democracy.network.arts.ubc.ca" },
      { ...saved, fallback: { ...saved.fallback, category: "misc" } },
      { ...saved, decision: { ...saved.decision, evidence: [] } },
      { ...saved, rules: [{ ...saved.rules[0], path_pattern: "jobs" }] },
      { ...saved, rules: [saved.rules[0], saved.rules[0]] },
      { ...saved, classify: () => "support" },
    ])
      expect(() => formatRoutingPolicy(mutated as HostRoutingPolicy)).toThrow();
  });

  it("uses saved rule precedence and metadata only, never article body wording", () => {
    const saved = policy();
    saved.rules.unshift({
      id: "recap-title",
      category: "news",
      rationale: "Recorded recap title routing",
      title_pattern: "^Recap:",
    });
    const source = document("/jobs/recap");
    const title = "Recap: student positions";
    expect(
      routeSearchDocument({ ...source, title, content_sha256: sha256(`${title}\n${source.content_markdown}`) }, saved)
        .category,
    ).toBe("news");
    expect(routeSearchDocument(document("/newsletters"), saved).category).toBe("academics");
  });
});

describe("category-first discovery", () => {
  it("discovers a host across nested categories and accepts empty known category parents", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "data/documents/stories"));
    expect(await validatePublishedHosts(f.options)).toEqual([f.result.host]);
    expect(hostDocumentRoots(f.result.host).map((root) => root.category)).toEqual([
      "academics",
      "news",
      "opportunities",
    ]);
  });

  it("rejects wrong category placement, duplicates and stale legacy paths", async () => {
    const f = await fixture();
    const doc = f.result.documents[0]!;
    const source = join(f.root, "data/documents/academics/example.ubc.ca", documentFilename(doc.id));
    const wrong = join(f.root, "data/documents/news/example.ubc.ca", documentFilename(doc.id));
    await writeFile(wrong, await readFile(source));
    await expect(validatePublishedHosts(f.options)).rejects.toThrow();
    await rm(wrong);
    await mkdir(join(f.root, "data/documents/example.ubc.ca"));
    await expect(validatePublishedHosts(f.options)).rejects.toThrow(/directories and index/);
  });

  it("rejects unknown category and category-parent symlinks", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "data/documents/misc"));
    await expect(validatePublishedHosts(f.options)).rejects.toThrow();
    await rm(join(f.root, "data/documents/misc"), { recursive: true });
    const path = join(f.root, "data/documents/academics");
    await rename(path, join(f.root, "kept-academics"));
    await symlink(join(f.root, "kept-academics"), path);
    await expect(validatePublishedHosts(f.options)).rejects.toThrow(/Symlink/);
  });

  it("rejects invalid manifest roots, counts, duplicate categories and mixed layout metadata", () => {
    const host = routeCompletedHost(completed(), policy()).host;
    const roots = host.document_roots!;
    for (const value of [
      { ...host, document_root: "data/documents/example.ubc.ca" },
      { ...host, document_roots: [...roots, roots[0]!] },
      { ...host, document_count: 99 },
      { ...host, document_roots: [{ ...roots[0]!, path: "data/documents/academics/../example.ubc.ca" }] },
    ])
      expect(() => formatHostList([value], [host.hostname])).toThrow();
  });
});
