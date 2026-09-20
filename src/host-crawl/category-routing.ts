import { constants } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ROOT } from "../base.ts";
import { assertDocumentCategory, categoryDocumentRoot, type DocumentCategory } from "./categories.ts";
import type { CompletedHost, SearchDocument, VettedHost } from "./contracts.ts";
import { exactObject, formatDocument, parseDocument, safeText, sha256 } from "./document-format.ts";
import {
  assertNoSymlinkPath,
  formatHostList,
  hostDocumentRoots,
  readRegularFile,
  validateVettedHost,
} from "./public-validation.ts";
import { normalizeHost } from "./urls.ts";

export interface CategoryRule {
  id: string;
  category: DocumentCategory;
  rationale: string;
  path_pattern?: string;
  title_pattern?: string;
}

export interface HostRoutingPolicy {
  version: 1;
  hostname: string;
  decision: {
    method: "model-assisted-first-classification" | "human-first-classification";
    authority: string;
    rationale: string;
    evidence: string[];
  };
  rules: CategoryRule[];
  fallback: Omit<CategoryRule, "path_pattern" | "title_pattern">;
}

export const HOST_REJECTIONS = {
  "about.canvas.ubc.ca": {
    reason: "Preserved homepage usefulness rejection",
    authority: "preserved owner admission policy",
    evidence: "https://about.canvas.ubc.ca/",
  },
  "democracy.network.arts.ubc.ca": {
    reason: "Explicit owner-confirmed hostname rejection; no reassessment",
    authority: "d1b9f3c0-5add-45c8-8377-a6612245e77f",
    evidence: "https://democracy.network.arts.ubc.ca/",
  },
  "irsslab.forestry.ubc.ca": {
    reason: "Explicit owner-confirmed Okanagan-only rejection",
    authority: "5cc613fe-c4e8-48ab-8c1c-cde6d90f5a5a",
    evidence: "https://irsslab.forestry.ubc.ca/",
  },
  "learningspaces.ok.ubc.ca": {
    reason:
      "Retained homepage limits space management to the Okanagan campus; classroom booking and AV support retain that local mandate. A linked cross-campus design guide does not extend this host's service scope.",
    authority: "content review under owner 5cc613fe-c4e8-48ab-8c1c-cde6d90f5a5a",
    evidence:
      "https://learningspaces.ok.ubc.ca/ | https://learningspaces.ok.ubc.ca/contact-us/ | https://learningspaces.ok.ubc.ca/useful-resources/help-support/",
  },
} as const;
export const REJECTED_HOSTS: ReadonlySet<string> = new Set(Object.keys(HOST_REJECTIONS));

export function assertAdmittedHostname(hostname: string): void {
  if (normalizeHost(hostname) !== hostname) throw new Error("Noncanonical routing hostname");
  if (REJECTED_HOSTS.has(hostname)) throw new Error(`Owner-rejected hostname: ${hostname}`);
}

function rule(value: unknown, fallback: boolean): asserts value is CategoryRule {
  const extra =
    value && typeof value === "object"
      ? ["path_pattern", "title_pattern"].filter((key) => Object.hasOwn(value, key))
      : [];
  exactObject(value, ["id", "category", "rationale", ...extra], "category rule");
  safeText(value.id, "category rule ID");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value.id)) throw new Error("Invalid category rule ID");
  assertDocumentCategory(value.category);
  safeText(value.rationale, "category rationale");
  if (fallback ? extra.length !== 0 : extra.length === 0) throw new Error("Invalid category rule selector");
  for (const key of extra) {
    safeText(value[key], "category selector");
    if ((value[key] as string).length > 512 || !(value[key] as string).startsWith("^"))
      throw new Error("Category selectors must be bounded anchored patterns");
    new RegExp(value[key] as string, "i");
  }
}

export function validateRoutingPolicy(value: unknown): asserts value is HostRoutingPolicy {
  exactObject(value, ["version", "hostname", "decision", "rules", "fallback"], "routing policy");
  if (value.version !== 1 || typeof value.hostname !== "string") throw new Error("Unknown routing policy");
  assertAdmittedHostname(value.hostname);
  exactObject(value.decision, ["method", "authority", "rationale", "evidence"], "classification provenance");
  if (!["model-assisted-first-classification", "human-first-classification"].includes(String(value.decision.method)))
    throw new Error("Unknown first-classification method");
  safeText(value.decision.authority, "classification authority");
  safeText(value.decision.rationale, "classification rationale");
  if (!Array.isArray(value.decision.evidence) || !value.decision.evidence.length)
    throw new Error("First classification requires evidence");
  for (const evidence of value.decision.evidence) safeText(evidence, "classification evidence");
  if (!Array.isArray(value.rules) || value.rules.length > 128) throw new Error("Invalid routing rules");
  const ids = new Set<string>();
  for (const item of value.rules) {
    rule(item, false);
    if (ids.has(item.id)) throw new Error("Duplicate category rule ID");
    ids.add(item.id);
  }
  rule(value.fallback, true);
  if (ids.has(value.fallback.id)) throw new Error("Duplicate fallback rule ID");
}

export function formatRoutingPolicy(policy: HostRoutingPolicy): Buffer {
  validateRoutingPolicy(policy);
  const encodeRule = (item: CategoryRule) => ({
    id: item.id,
    category: item.category,
    rationale: item.rationale,
    ...(item.path_pattern === undefined ? {} : { path_pattern: item.path_pattern }),
    ...(item.title_pattern === undefined ? {} : { title_pattern: item.title_pattern }),
  });
  return Buffer.from(
    `${JSON.stringify(
      {
        version: policy.version,
        hostname: policy.hostname,
        decision: {
          method: policy.decision.method,
          authority: policy.decision.authority,
          rationale: policy.decision.rationale,
          evidence: policy.decision.evidence,
        },
        rules: policy.rules.map(encodeRule),
        fallback: encodeRule(policy.fallback),
      },
      null,
      2,
    )}\n`,
  );
}

export function parseRoutingPolicy(bytes: Uint8Array): HostRoutingPolicy {
  const buffer = Buffer.from(bytes);
  const policy: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  validateRoutingPolicy(policy);
  if (!formatRoutingPolicy(policy).equals(buffer)) throw new Error("Noncanonical saved category policy");
  return policy;
}

export function routingPolicyPath(hostname: string, repositoryRoot = ROOT): string {
  assertAdmittedHostname(hostname);
  return join(repositoryRoot, "src/host-scrapers/routing", `${hostname}.json`);
}

export async function loadRoutingPolicy(hostname: string, repositoryRoot = ROOT): Promise<HostRoutingPolicy> {
  const policy = parseRoutingPolicy(await readRegularFile(routingPolicyPath(hostname, repositoryRoot)));
  if (policy.hostname !== hostname) throw new Error("Saved category policy owner mismatch");
  return policy;
}

/** Install a reviewed first decision once; rescrapes never create or replace classification policy. */
export async function saveFirstRoutingPolicy(policy: HostRoutingPolicy, repositoryRoot = ROOT): Promise<void> {
  const bytes = formatRoutingPolicy(policy);
  const path = routingPolicyPath(policy.hostname, repositoryRoot);
  await assertNoSymlinkPath(path);
  await mkdir(dirname(path), { recursive: true });
  await assertNoSymlinkPath(path);
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o644,
  ).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    if (!(await readRegularFile(path)).equals(bytes)) throw new Error("Saved first classification is immutable");
    return null;
  });
  if (!file) return;
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Apply saved URL/title selectors only; no model, network, text transformation or clock is involved. */
export function routeSearchDocument(document: SearchDocument, policy: HostRoutingPolicy): SearchDocument {
  formatDocument(document);
  validateRoutingPolicy(policy);
  if (document.hostname !== policy.hostname) throw new Error("Routing policy hostname mismatch");
  const policyHash = sha256(formatRoutingPolicy(policy));
  if (document.category) {
    const savedRule = [...policy.rules, policy.fallback].find((item) => item.id === document.routing?.rule_id);
    if (!savedRule || savedRule.category !== document.category || document.routing?.policy_sha256 !== policyHash)
      throw new Error("Saved classification cannot be replaced during regeneration");
    return { ...document, routing: { ...document.routing } };
  }
  const path = decodeURIComponent(new URL(document.source_url).pathname);
  const selected =
    policy.rules.find(
      (item) =>
        (item.path_pattern === undefined || new RegExp(item.path_pattern, "i").test(path)) &&
        (item.title_pattern === undefined || new RegExp(item.title_pattern, "i").test(document.title)),
    ) ?? policy.fallback;
  const routing = { rule_id: selected.id, policy_sha256: policyHash };
  const routed = { ...document, category: selected.category, routing };
  formatDocument(routed);
  return routed;
}

export async function loadSavedClassifications(repositoryRoot: string, hostname: string): Promise<SearchDocument[]> {
  assertAdmittedHostname(hostname);
  let bytes: Buffer;
  try {
    bytes = await readRegularFile(join(repositoryRoot, "data/official-hosts.json"), 16 * 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const hosts: VettedHost[] = JSON.parse(bytes.toString("utf8"));
  if (
    !Array.isArray(hosts) ||
    !formatHostList(
      hosts,
      hosts.map((host) => host.hostname),
    ).equals(bytes)
  )
    throw new Error("Invalid saved classification index");
  const host = hosts.find((item) => item.hostname === hostname);
  if (!host?.document_roots) return [];
  validateVettedHost(host, [hostname]);
  const documents: SearchDocument[] = [];
  for (const root of hostDocumentRoots(host)) {
    const files = (await readdir(join(repositoryRoot, root.path))).sort();
    if (files.length !== root.document_count) throw new Error("Saved classification count differs");
    for (const filename of files)
      documents.push(
        parseDocument(await readRegularFile(join(repositoryRoot, root.path, filename)), {
          hostname,
          category: root.category,
          filename,
        }),
      );
  }
  return documents;
}

export function routeCompletedHost(
  completed: CompletedHost,
  policy: HostRoutingPolicy,
  previous: readonly SearchDocument[] = [],
): CompletedHost {
  if (
    completed.complete !== true ||
    completed.host.hostname !== policy.hostname ||
    completed.documents.length !== completed.host.document_count ||
    !completed.documents.length
  )
    throw new Error("Incomplete host cannot be categorized");
  const saved = new Map<string, SearchDocument>();
  for (const document of previous) {
    if (!document.category) continue;
    const verified = routeSearchDocument(document, policy);
    for (const url of [verified.source_url, ...verified.alternate_urls]) {
      if (saved.has(url)) throw new Error("Duplicate saved classification URL");
      saved.set(url, verified);
    }
  }
  const documents = completed.documents.map((document) => {
    const old = saved.get(document.source_url);
    if (
      old &&
      document.category &&
      (document.category !== old.category || JSON.stringify(document.routing) !== JSON.stringify(old.routing))
    )
      throw new Error("Existing path classification cannot be replaced");
    return routeSearchDocument(old ? { ...document, category: old.category, routing: old.routing } : document, policy);
  });
  const counts = new Map<DocumentCategory, number>();
  for (const document of documents) counts.set(document.category!, (counts.get(document.category!) ?? 0) + 1);
  const { document_root: _legacy, document_roots: _roots, ...host } = completed.host;
  return {
    complete: true,
    host: {
      ...host,
      document_roots: [...counts]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([category, count]) => ({
          category,
          path: categoryDocumentRoot(category, host.hostname),
          document_count: count,
        })),
    },
    documents,
  };
}
