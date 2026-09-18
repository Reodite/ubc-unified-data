import { bmlscScraper } from "../host-scrapers/bmlscpathology.med.ubc.ca/index.ts";
import { bullyingAndHarassmentScraper } from "../host-scrapers/bullyingandharassment.ubc.ca/index.ts";
import { coopScraper } from "../host-scrapers/coop.ubc.ca/index.ts";
import type { HostScraper } from "./contracts.ts";
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
const registry = createRegistry([bmlscScraper, bullyingAndHarassmentScraper, coopScraper]);
export function registeredHostnames(): string[] {
  return [...registry.keys()].sort();
}
export function getHostScraper(hostname: string): HostScraper {
  const result = registry.get(normalizeHost(hostname));
  if (!result) throw new Error("Hostname has no explicitly registered accepted scraper");
  return result;
}
