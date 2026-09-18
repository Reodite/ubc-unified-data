import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bmlscScraper } from "../host-scrapers/bmlscpathology.med.ubc.ca/index.ts";
import { bullyingAndHarassmentScraper } from "../host-scrapers/bullyingandharassment.ubc.ca/index.ts";
import { coopScraper } from "../host-scrapers/coop.ubc.ca/index.ts";
import { createRegistry, getHostScraper, parseGenericHostnames, registeredHostnames } from "./registry.ts";
import { hostUrl, normalizeHost } from "./urls.ts";

const hostname = "bmlscpathology.med.ubc.ca";
describe("explicit hostname dispatch", () => {
  it("dispatches specialized modules and explicitly declared generic hostnames", () => {
    const root = new URL("../host-scrapers/", import.meta.url);
    const directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const generic = parseGenericHostnames(readFileSync(new URL("generic-hosts.json", root)));
    expect([...directories, ...generic].sort()).toEqual(registeredHostnames());
    for (const host of generic) expect(getHostScraper(host).adapter.kind).toBe("auto");
    for (const host of directories) {
      expect(existsSync(new URL(`${host}/index.ts`, root))).toBe(true);
      expect(existsSync(new URL(`${host}/index.test.ts`, root))).toBe(true);
    }
    expect(getHostScraper(hostname.toUpperCase())).toBe(bmlscScraper);
    expect(getHostScraper("BULLYINGANDHARASSMENT.UBC.CA")).toBe(bullyingAndHarassmentScraper);
    expect(getHostScraper("COOP.UBC.CA")).toBe(coopScraper);
  });
  it("rejects unregistered, duplicate and unnormalized definitions", () => {
    expect(() => getHostScraper("unknown.ubc.ca")).toThrow(/registered/);
    expect(() => createRegistry([bmlscScraper, bmlscScraper])).toThrow(/Duplicate/);
    expect(() => createRegistry([{ ...bmlscScraper, hostname: hostname.toUpperCase() }])).toThrow(/normalized/);
  });
  it.each([
    "ubc.ca.evil.test",
    "personal.example",
    "a..ubc.ca",
    "bmlscpathology.med.ubc.ca:443",
    "bmlscpathology.med.ubc.ca/path",
  ])("rejects invalid hostname %s", (value) => {
    expect(() => normalizeHost(value)).toThrow();
  });
  it.each([
    "http://bmlscpathology.med.ubc.ca/",
    "https://other.ubc.ca/",
    "https://user@bmlscpathology.med.ubc.ca/",
    "https://bmlscpathology.med.ubc.ca:444/",
  ])("rejects unsafe physical URL %s", (value) => {
    expect(() => hostUrl(value, hostname)).toThrow();
  });
  it("retains meaningful physical query and slash identities while removing fragments", () => {
    expect(hostUrl("/?p=42#section", hostname)).toBe(`https://${hostname}/?p=42`);
    expect(hostUrl("/guide", hostname)).not.toBe(hostUrl("/guide/", hostname));
  });
});
