import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadRoutingPolicy, REJECTED_HOSTS, routeCompletedHost, routingPolicyPath } from "./category-routing.ts";
import type { CompletedHost, SearchDocument } from "./contracts.ts";
import { documentFilename, formatDocument, parseDocument, sha256 } from "./document-format.ts";
import { assertExternalPath } from "./paths.ts";
import { assertSameProducer, captureProducer } from "./provenance.ts";
import { hostDocumentRoots, readRegularFile, validatePublishedHosts } from "./public-validation.ts";
import { publishCompletedHost, withdrawPublishedHost } from "./publication.ts";

export interface MigrateHostOptions {
  hostname: string;
  repositoryRoot: string;
  externalRoot: string;
  registeredHosts: readonly string[];
  publish?: boolean;
  reject?: boolean;
}

async function preserve(path: string, bytes: Buffer): Promise<void> {
  assertExternalPath(path);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await readRegularFile(path, bytes.length)).equals(bytes)
    )
      throw error;
  }
}

/** Migrate verified retained documents without re-extracting, rewriting, or changing their extraction lineage. */
export async function migratePublishedHost(options: MigrateHostOptions) {
  const { hostname, repositoryRoot, externalRoot, registeredHosts, publish = false, reject = false } = options;
  if (reject !== REJECTED_HOSTS.has(hostname))
    throw new Error(reject ? "Withdrawal requires a saved owner rejection" : "Owner-rejected host requires withdrawal");
  const hosts = await validatePublishedHosts({ repositoryRoot, registeredHosts, documentHostnames: [hostname] });
  const host = hosts.find((entry) => entry.hostname === hostname);
  if (!host) throw new Error("Host is not published; migration cannot collect a missing host");
  const indexPath = join(repositoryRoot, "data/official-hosts.json");
  const indexBytes = await readRegularFile(indexPath, 16 * 1024 * 1024);
  const inputs: Array<{ path: string; sha256: string; bytes: Buffer; document: SearchDocument }> = [];
  const { readdir } = await import("node:fs/promises");
  for (const root of hostDocumentRoots(host)) {
    const directory = join(repositoryRoot, root.path);
    for (const filename of (await readdir(directory)).sort()) {
      const path = join(directory, filename);
      const bytes = await readRegularFile(path);
      const document = parseDocument(bytes, { hostname, filename, category: root.category });
      inputs.push({ path, sha256: sha256(bytes), bytes, document });
    }
  }
  const policy = reject ? undefined : await loadRoutingPolicy(hostname, repositoryRoot);
  const policyPath = policy ? routingPolicyPath(hostname, repositoryRoot) : undefined;
  const policyBytes = policyPath ? await readRegularFile(policyPath) : undefined;
  const legacy: CompletedHost = { complete: true, host, documents: inputs.map((input) => input.document) };
  const completed = policy ? routeCompletedHost(legacy, policy) : undefined;
  if (completed) {
    for (const document of completed.documents) {
      const before = inputs.find((input) => input.document.id === document.id)!.document;
      const { category: _beforeCategory, routing: _beforeRouting, ...beforeExtraction } = before;
      const { category: _afterCategory, routing: _afterRouting, ...afterExtraction } = document;
      if (!formatDocument(beforeExtraction).equals(formatDocument(afterExtraction)))
        throw new Error("Category migration changed original document provenance or text");
    }
  }
  const plan = {
    version: 1,
    hostname,
    operation: reject ? "owner-rejected-withdrawal" : "category-first-migration",
    original_index_sha256: sha256(indexBytes),
    original_host: host,
    policy_sha256: policyBytes ? sha256(policyBytes) : null,
    documents: inputs.map((input) => {
      const routed = completed?.documents.find((document) => document.id === input.document.id);
      return {
        id: input.document.id,
        original_path: relative(repositoryRoot, input.path),
        original_sha256: input.sha256,
        output_path: routed ? `data/documents/${routed.category}/${hostname}/${documentFilename(routed.id)}` : null,
        output_sha256: routed ? sha256(formatDocument(routed)) : null,
      };
    }),
  };
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const directory = assertExternalPath(
    join(externalRoot, "category-migrations", hostname, sha256(planBytes)),
    repositoryRoot,
  );
  await mkdir(join(directory, "original-documents"), { recursive: true, mode: 0o700 });
  await preserve(join(directory, "plan.json"), planBytes);
  await preserve(join(directory, "original-index.json"), indexBytes);
  for (const input of inputs)
    await preserve(join(directory, "original-documents", documentFilename(input.document.id)), input.bytes);
  const producer = await captureProducer(repositoryRoot);
  const verifyInputs = async () => {
    if (!(await readRegularFile(indexPath, 16 * 1024 * 1024)).equals(indexBytes))
      throw new Error("Migration index changed");
    for (const input of inputs) {
      if (!(await readRegularFile(input.path)).equals(input.bytes)) throw new Error("Retained migration input changed");
      if (
        !(await readRegularFile(join(directory, "original-documents", documentFilename(input.document.id)))).equals(
          input.bytes,
        )
      )
        throw new Error("Preserved migration backup changed");
    }
    if (policyPath && !(await readRegularFile(policyPath)).equals(policyBytes!))
      throw new Error("Saved routing decision changed");
    if (!(await readRegularFile(join(directory, "plan.json"), planBytes.length)).equals(planBytes))
      throw new Error("Migration plan changed");
    assertSameProducer(producer, await captureProducer(repositoryRoot));
  };
  await verifyInputs();
  const result = !publish
    ? null
    : reject
      ? await withdrawPublishedHost({
          hostname,
          repositoryRoot,
          externalRoot,
          registeredHosts,
          verifyInputs,
          incremental: true,
        })
      : await publishCompletedHost({
          completed: completed!,
          repositoryRoot,
          externalRoot,
          registeredHosts,
          verifyInputs,
          incremental: true,
        });
  return {
    hostname,
    operation: plan.operation,
    documents: inputs.length,
    published: Boolean(result),
    changed: result?.changed ?? false,
    plan: join(directory, "plan.json"),
  };
}
