import { readFileSync } from "node:fs";
import { bmlscScraper } from "../host-scrapers/bmlscpathology.med.ubc.ca/index.ts";
import { bullyingAndHarassmentScraper } from "../host-scrapers/bullyingandharassment.ubc.ca/index.ts";
import { coopScraper } from "../host-scrapers/coop.ubc.ca/index.ts";
import { assertAdmittedHostname } from "./category-routing.ts";
import type { HostScraper } from "./contracts.ts";
import { createGenericScraper } from "./generic.ts";
import { normalizeHost } from "./urls.ts";

export function createRegistry(scrapers: readonly HostScraper[]): ReadonlyMap<string, HostScraper> {
  const result = new Map<string, HostScraper>();
  for (const scraper of scrapers) {
    const host = normalizeHost(scraper.hostname);
    if (result.has(host)) throw new Error(`Duplicate registered hostname: ${host}`);
    if (host !== scraper.hostname) throw new Error("Registered hostname must be normalized");
    result.set(host, scraper);
  }
  return result;
}
export function parseGenericHostnames(bytes: Uint8Array): string[] {
  const names: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !Array.isArray(names) ||
    names.some(
      (name, index) =>
        typeof name !== "string" || normalizeHost(name) !== name || (index > 0 && names[index - 1] >= name),
    )
  )
    throw new Error("Generic host registry must contain sorted unique official hostnames");
  return names as string[];
}
const genericHostnames = parseGenericHostnames(
  readFileSync(new URL("../host-scrapers/generic-hosts.json", import.meta.url)),
);
const registry = createRegistry([
  bmlscScraper,
  bullyingAndHarassmentScraper,
  coopScraper,
  ...genericHostnames.map(createGenericScraper),
]);
export function registeredHostnames(): string[] {
  return [...registry.keys()].sort();
}
export function getHostScraper(hostname: string): HostScraper {
  assertAdmittedHostname(normalizeHost(hostname));
  const result = registry.get(normalizeHost(hostname));
  if (!result) throw new Error("Hostname has no explicitly registered accepted scraper");
  return result;
}
