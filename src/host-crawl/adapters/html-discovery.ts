import { load } from "cheerio";
import type { HostScraper, Observation, PublicGetView, Snapshot } from "../contracts.ts";
import { hostUrl } from "../urls.ts";

export function publicViewUrl(hostname: string, view: PublicGetView, value: string): string {
  if (!view.values.includes(value)) throw new Error("Undeclared public GET selection");
  const url = new URL(hostUrl(view.path, hostname));
  if (
    url.search ||
    !view.parameter ||
    new Set(view.values).size !== view.values.length ||
    view.values.includes(view.placeholder)
  )
    throw new Error("Invalid public GET declaration");
  url.search = `${encodeURIComponent(view.parameter)}=${encodeURIComponent(value)}`;
  return url.href;
}

export async function verifyHtmlDiscovery(
  scraper: HostScraper,
  read: (url: string) => Promise<Observation>,
): Promise<void> {
  if (scraper.adapter.kind !== "html") throw new Error("Expected HTML discovery policy");
  for (const path of scraper.adapter.optionalAbsent ?? []) {
    const response = await read(hostUrl(path, scraper.hostname));
    if (![404, 410].includes(response.snapshot.status))
      throw new Error(`Optional inventory requires a supported complete representation: ${path}`);
  }
}

/** Enumerate only declared finite GET views after validating the publisher's actual form. */
export function discoverPublicViews(scraper: HostScraper, snapshot: Snapshot): string[] {
  const source = new URL(hostUrl(snapshot.url, scraper.hostname));
  const result: string[] = [];
  const $ = load(snapshot.body);
  for (const view of scraper.adapter.views ?? []) {
    if (source.pathname !== view.path) continue;
    const selections = $("select").filter((_, node) => $(node).attr("name") === view.parameter);
    if (
      selections.length !== 1 ||
      selections.attr("multiple") !== undefined ||
      selections.attr("disabled") !== undefined
    )
      throw new Error("Declared public view lacks one enabled single-select control");
    const form = selections.closest("form");
    if (form.length !== 1 || (form.attr("method") ?? "get").toLowerCase() !== "get")
      throw new Error("Declared public view is not a GET form");
    const action = new URL(hostUrl(form.attr("action") || snapshot.url, scraper.hostname, snapshot.url));
    if (action.pathname !== view.path || action.search) throw new Error("Public GET action differs from declaration");
    const named = form.find("input[name],select[name],textarea[name],button[name]");
    if (named.length !== 1 || named[0] !== selections[0]) throw new Error("Public GET form has undeclared controls");
    const options = selections
      .find("option")
      .toArray()
      .map((node) => {
        if ($(node).attr("disabled") !== undefined) throw new Error("Public GET option is disabled");
        const value = $(node).attr("value");
        if (value === undefined) throw new Error("Public GET option lacks a value");
        return value;
      });
    const expected = [view.placeholder, ...view.values];
    if (
      options.length !== expected.length ||
      new Set(options).size !== options.length ||
      expected.some((value) => !options.includes(value))
    )
      throw new Error("Public GET options differ from the declared finite set");
    result.push(...view.values.map((value) => publicViewUrl(scraper.hostname, view, value)));
  }
  return [...new Set(result)].sort();
}

export function assertPublicViewIdentity(scraper: HostScraper, requested: string, snapshot: Snapshot): void {
  const url = new URL(hostUrl(requested, scraper.hostname));
  for (const view of scraper.adapter.views ?? []) {
    if (url.pathname !== view.path || !url.search) continue;
    const pairs = [...url.searchParams];
    if (pairs.length !== 1 || pairs[0]![0] !== view.parameter || !view.values.includes(pairs[0]![1]))
      throw new Error("Undeclared public GET query");
    const actual = new URL(hostUrl(snapshot.url, scraper.hostname));
    if (actual.pathname !== url.pathname || JSON.stringify([...actual.searchParams]) !== JSON.stringify(pairs))
      throw new Error("Public GET response lost its selected view");
  }
}
