import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveFirstRoutingPolicy, type HostRoutingPolicy } from "./category-routing.ts";
import type { SearchDocument, VettedHost } from "./contracts.ts";
import { documentFilename, formatDocument, parseDocument, sha256 } from "./document-format.ts";
import { migratePublishedHost } from "./migration.ts";
import { EXTERNAL_BOUNDARY } from "./paths.ts";
import { formatHostList, hostDocumentRoots, validatePublishedHosts } from "./public-validation.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(hostname = "example.ubc.ca") {
  await mkdir(EXTERNAL_BOUNDARY, { recursive: true });
  const root = await mkdtemp(join(EXTERNAL_BOUNDARY, "host-migration-test-"));
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  const externalRoot = join(root, "external");
  await mkdir(join(repositoryRoot, "src"), { recursive: true });
  await writeFile(join(repositoryRoot, "src/example.ts"), "export const fixture = true;\n");
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"])
    await writeFile(join(repositoryRoot, name), "{}\n");
  const source_url = `https://${hostname}/guide`;
  const body = "Keep original text exactly, including its final newline.\n";
  const doc: SearchDocument = {
    id: `documents:official-web:${sha256(source_url).slice(0, 24)}`,
    hostname,
    title: "Guide",
    source_url,
    retrieved_at: "2026-09-18T01:02:03.000Z",
    source_modified_at: null,
    snapshot_sha256: sha256("snapshot"),
    input_sha256: sha256("original input"),
    body_sha256: sha256(body),
    content_sha256: sha256(`Guide\n${body}`),
    content_markdown: body,
    warnings: [],
    alternate_urls: [],
    producer: {
      inputs_sha256: sha256("original producer"),
      runtime: { node: "26.8.1", icu: "78.3", unicode: "17.0", platform: "linux", arch: "x64" },
    },
  };
  const host: VettedHost = {
    hostname,
    title: "Example",
    homepage_url: `https://${hostname}/`,
    homepage_retrieved_at: doc.retrieved_at,
    homepage_sha256: sha256("home"),
    scope: "Public text",
    document_root: `data/documents/${hostname}`,
    document_count: 1,
  };
  const path = join(repositoryRoot, host.document_root!, documentFilename(doc.id));
  await mkdir(join(repositoryRoot, host.document_root!), { recursive: true });
  const bytes = formatDocument(doc);
  await writeFile(path, bytes);
  await writeFile(join(repositoryRoot, "data/official-hosts.json"), formatHostList([host], [hostname]));
  const policy: HostRoutingPolicy = {
    version: 1,
    hostname,
    decision: {
      method: "human-first-classification",
      authority: "fixture",
      rationale: "Reviewed source guide",
      evidence: [source_url],
    },
    rules: [],
    fallback: { id: "guide", category: "support", rationale: "Saved guide classification" },
  };
  if (hostname !== "democracy.network.arts.ubc.ca") await saveFirstRoutingPolicy(policy, repositoryRoot);
  return {
    repositoryRoot,
    externalRoot,
    hostname,
    doc,
    bytes,
    path,
    options: { hostname, repositoryRoot, externalRoot, registeredHosts: [hostname] },
  };
}

describe("retained host migration", () => {
  it("plans and backs up without changing published files or invoking extraction", async () => {
    const f = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("No acquisition or model allowed");
      }),
    );
    const result = await migratePublishedHost(f.options);
    expect(result.published).toBe(false);
    expect(await readFile(f.path)).toEqual(f.bytes);
    const plan = JSON.parse(await readFile(result.plan, "utf8"));
    expect(plan.documents[0].original_sha256).toBe(sha256(f.bytes));
    expect(plan.documents[0].output_path).toBe(`data/documents/support/${f.hostname}/${documentFilename(f.doc.id)}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("moves the host atomically and reproduces the same categorized bytes on regeneration", async () => {
    const f = await fixture();
    const result = await migratePublishedHost({ ...f.options, publish: true });
    expect(result.changed).toBe(true);
    await expect(readFile(f.path)).rejects.toThrow();
    const hosts = await validatePublishedHosts({ ...f.options, requireCategories: true });
    const target = join(f.repositoryRoot, hostDocumentRoots(hosts[0]!)[0]!.path, documentFilename(f.doc.id));
    const bytes = await readFile(target);
    const migrated = parseDocument(bytes);
    const { category: _category, routing: _routing, ...original } = migrated;
    expect(original).toEqual(f.doc);
    expect(migrated.category).toBe("support");
    expect(await migratePublishedHost({ ...f.options, publish: true })).toMatchObject({ changed: false, documents: 1 });
    expect(await readFile(target)).toEqual(bytes);
  });

  it("refuses changed preserved evidence without losing published input", async () => {
    const f = await fixture();
    const plan = await migratePublishedHost(f.options);
    const directory = plan.plan.slice(0, -"plan.json".length);
    await writeFile(join(directory, "original-documents", documentFilename(f.doc.id)), "tampered");
    await expect(migratePublishedHost({ ...f.options, publish: true })).rejects.toThrow();
    expect(await readFile(f.path)).toEqual(f.bytes);
  });

  it("withdraws only a saved owner-rejected hostname and preserves original files externally", async () => {
    const f = await fixture("democracy.network.arts.ubc.ca");
    await expect(migratePublishedHost(f.options)).rejects.toThrow(/withdrawal/);
    const result = await migratePublishedHost({ ...f.options, publish: true, reject: true });
    expect(result).toMatchObject({ operation: "owner-rejected-withdrawal", documents: 1, changed: true });
    expect(await validatePublishedHosts(f.options)).toEqual([]);
    const backup = join(result.plan.slice(0, -"plan.json".length), "original-documents", documentFilename(f.doc.id));
    expect(await readFile(backup)).toEqual(f.bytes);
  });

  it("does not turn a normal hostname into an arbitrary deletion", async () => {
    const f = await fixture();
    await expect(migratePublishedHost({ ...f.options, publish: true, reject: true })).rejects.toThrow(
      /saved owner rejection/,
    );
    expect(await readFile(f.path)).toEqual(f.bytes);
  });
});
