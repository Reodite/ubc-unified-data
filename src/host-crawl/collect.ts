import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { load } from "cheerio";
import { toSafeMarkdown } from "../prose/markdown.ts";
import type { ArticleInput } from "../prose/model.ts";
import { plainText } from "../source-documents.ts";
import { wordpressRecordInput } from "./adapters/wordpress-content.ts";
import { discoverWordpress } from "./adapters/wordpress-discovery.ts";
import {
  NonTextMediaError,
  type CompletedHost,
  type HostArchive,
  type HostScraper,
  type Observation,
  type ProducerContext,
  type SearchDocument,
} from "./contracts.ts";
import { parseSitemap } from "./sitemap.ts";
import { hostUrl, pageExclusion, UNSUPPORTED_DOCUMENT } from "./urls.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const robotsParser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  body: string,
) => {
  isDisallowed(url: string, agent: string): boolean | undefined;
  getSitemaps(): string[];
};

function pageLinks(observation: Observation, hostname: string): string[] {
  return htmlLinks(observation.snapshot.body, hostname, observation.snapshot.url);
}

function htmlLinks(html: string, hostname: string, base: string): string[] {
  const $ = load(html);
  if ($("base[href]").length) throw new Error("HTML base URL requires an explicit extraction policy");
  const links = new Set<string>();
  $("a[href]").each((_, node) => {
    const value = $(node).attr("href")?.trim();
    if (!value || value.startsWith("#")) return;
    let url: string;
    try {
      url = hostUrl(value, hostname, base);
    } catch {
      return;
    }
    links.add(url);
  });
  return [...links].sort();
}

async function sitemapPages(
  starts: readonly string[],
  hostname: string,
  read: (url: string) => Promise<Observation>,
): Promise<string[]> {
  const queue = [...starts];
  const seen = new Set<string>();
  const pages = new Set<string>();
  while (queue.length) {
    const url = hostUrl(queue.shift()!, hostname);
    if (seen.has(url)) continue;
    seen.add(url);
    const observation = await read(url);
    if (observation.snapshot.status !== 200 || !/xml/i.test(observation.snapshot.headers["content-type"] ?? ""))
      throw new Error("An advertised sitemap lacks a complete XML observation");
    const parsed = parseSitemap(observation.snapshot.body);
    for (const location of parsed.locations) {
      const target = hostUrl(location, hostname, observation.snapshot.url);
      if (parsed.kind === "index") queue.push(target);
      else pages.add(target);
    }
  }
  return [...pages].sort();
}

/** Build complete host documents from observations supplied by an acquisition or offline archive, never retained Markdown. */
export async function collectRecordedHost(
  scraper: HostScraper,
  archive: HostArchive,
  producer: ProducerContext,
): Promise<CompletedHost> {
  if (scraper.hostname !== archive.hostname) throw new Error("Scraper/archive hostname mismatch");
  const verdict = scraper.vetHomepage(archive.homepage.snapshot);
  if (!verdict.accepted) throw new Error(`Homepage is not vetted: ${verdict.reason}`);
  const hostname = scraper.hostname;
  const robotsUrl = `https://${hostname}/robots.txt`;
  const robotsObservation = await archive.read(robotsUrl);
  if (![200, 404, 410].includes(robotsObservation.snapshot.status))
    throw new Error("Robots observation is unavailable");
  const robots = robotsParser(
    robotsUrl,
    robotsObservation.snapshot.status === 200 ? robotsObservation.snapshot.body : "",
  );
  const assertObservedAccess = (observation: Observation) => {
    const destinations = [
      observation.snapshot.requested_url,
      observation.snapshot.url,
      ...(observation.snapshot.redirects ?? []).flatMap((hop) => [hop.url, hostUrl(hop.location, hostname, hop.url)]),
    ];
    for (const value of destinations) {
      const target = hostUrl(value, hostname);
      if (robots.isDisallowed(target, "ubc-data")) throw new Error("Recorded redirect violates robots policy");
    }
  };
  const read = async (value: string): Promise<Observation> => {
    const url = hostUrl(value, hostname);
    if (robots.isDisallowed(url, "ubc-data")) throw new Error("Recorded robots policy disallows a required request");
    const observation = await archive.read(url);
    assertObservedAccess(observation);
    return observation;
  };
  if (scraper.adapter.kind !== "wordpress") throw new Error("Unsupported registered discovery adapter");
  const discovered = await discoverWordpress(scraper, archive.homepage, read);
  const sitemaps = robots.getSitemaps().map((url) => hostUrl(url, hostname));
  const seedPages = await sitemapPages(sitemaps, hostname, read);
  const cmsPages = new Set(discovered.map((entry) => entry.url));
  const advertisedPages = new Set([...cmsPages, ...seedPages]);
  const queue: string[] = [];
  const queued = new Set<string>();
  const add = (value: string) => {
    const url = hostUrl(value, hostname);
    const exclusion = pageExclusion(url, hostname);
    if (advertisedPages.has(url) && exclusion === "Ambiguous repeated path separator")
      throw new Error("Publisher inventory advertises an ambiguous path");
    if (exclusion === UNSUPPORTED_DOCUMENT) throw new Error(`${exclusion}: ${url}`);
    if (
      exclusion !== null &&
      (cmsPages.has(url) || (advertisedPages.has(url) && exclusion === "Unsupported query or form selection"))
    )
      throw new Error(`Required publisher URL lacks a supported discovery policy: ${url} (${exclusion})`);
    if (exclusion !== null || queued.has(url)) return;
    queued.add(url);
    queue.push(url);
  };
  add(`https://${hostname}/`);
  for (const url of [
    ...discovered.map((entry) => entry.url),
    ...seedPages,
    ...archive.urls.map((row) => row.url),
  ].sort())
    add(url);
  const retained = new Map(archive.retained.map((document) => [document.source_url, document]));
  const declaredModified = new Map<string, string | null>();
  for (const entry of discovered) {
    if (declaredModified.has(entry.url) && declaredModified.get(entry.url) !== entry.modified)
      throw new Error("Conflicting source modification observations for one URL");
    declaredModified.set(entry.url, entry.modified);
  }
  const records = new Map(discovered.map((entry) => [entry.url, entry]));
  if (scraper.adapter.apiContentFallback && records.size !== discovered.length)
    throw new Error("Ambiguous publisher URLs cannot select independent API records");
  const unavailable: string[] = [];
  const documents = new Map<string, SearchDocument>();
  const representatives = new Map<string, string>();
  const aliases = new Map<string, Set<string>>();
  while (queue.length) {
    const requested = queue.shift()!;
    let observation: Observation;
    let apiInput: ArticleInput | undefined;
    let contentBase: string | undefined;
    try {
      observation = await read(requested);
    } catch (error) {
      if (error instanceof NonTextMediaError) continue;
      if (/budget|duration exhausted|changed|corrupt|ENOENT|EIO|ENOSPC/i.test(String(error))) throw error;
      const record = records.get(archive.observedDestination?.(requested) ?? requested);
      if (!scraper.adapter.apiContentFallback || !record || archive.apiFallbackEligible?.(requested) !== true) {
        unavailable.push(`${requested}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      try {
        observation = await read(record.api_url);
        const parsed = wordpressRecordInput(observation, record, hostname);
        apiInput = scraper.normalizeArticle?.(parsed) ?? parsed;
        contentBase = record.url;
      } catch (itemError) {
        throw new Error(
          `Publisher HTML and independent API text are unavailable for ${requested}: ${String(itemError)}`,
          { cause: itemError },
        );
      }
    }
    if (apiInput) {
      for (const url of htmlLinks(apiInput.html, hostname, contentBase!)) add(url);
    } else {
      if ([404, 410].includes(observation.snapshot.status)) {
        if (advertisedPages.has(requested)) throw new Error(`Advertised document is unavailable: ${requested}`);
        continue;
      }
      if (observation.snapshot.status !== 200 || !/html/i.test(observation.snapshot.headers["content-type"] ?? ""))
        throw new Error(`Missing complete HTML for ${requested}`);
      for (const url of pageLinks(observation, hostname)) add(url);
    }
    const sourceUrl = hostUrl(observation.snapshot.url, hostname);
    const observed = observation;
    const previous = retained.get(sourceUrl);
    if (previous && previous.snapshot !== observation.sha256) {
      if (apiInput) throw new Error("Retained API text requires an explicit recorded representative policy");
      observation = await archive.readSnapshot(previous.snapshot);
      if (hostUrl(observation.snapshot.url, hostname) !== sourceUrl)
        throw new Error("Retained representative has a different physical URL");
      assertObservedAccess(observation);
      for (const url of pageLinks(observation, hostname)) add(url);
    }
    const decision = apiInput ? { kind: "document" as const, input: apiInput } : scraper.extract(observation.snapshot);
    if (observed.sha256 !== observation.sha256) {
      const current = scraper.extract(observed.snapshot);
      if (
        current.kind !== decision.kind ||
        (current.kind === "document" &&
          decision.kind === "document" &&
          (plainText(current.input.title) !== plainText(decision.input.title) ||
            toSafeMarkdown(current.input.html, sourceUrl).markdown !==
              toSafeMarkdown(decision.input.html, sourceUrl).markdown))
      )
        throw new Error("Retained representative would hide changed observed text or classification");
    }
    if (decision.kind === "excluded") continue;
    const input = decision.input;
    const title = plainText(input.title);
    if (!title) throw new Error("Extracted document lacks a title");
    const converted = toSafeMarkdown(input.html, contentBase ?? sourceUrl);
    if (!converted.markdown.trim()) {
      if (apiInput) throw new Error(`Required API text becomes empty after sanitization: ${sourceUrl}`);
      continue;
    }
    const observedAliases = aliases.get(sourceUrl) ?? new Set<string>();
    if (!apiInput) observedAliases.add(requested);
    observedAliases.add(hostUrl(observation.snapshot.requested_url, hostname));
    aliases.set(sourceUrl, observedAliases);
    const document: SearchDocument = {
      id: `documents:official-web:${sha256(sourceUrl).slice(0, 24)}`,
      hostname,
      title,
      source_url: sourceUrl,
      retrieved_at: observation.snapshot.retrieved_at,
      source_modified_at: previous
        ? previous.source_modified_at
        : (declaredModified.get(sourceUrl) ?? input.sourceModifiedAt ?? null),
      snapshot_sha256: observation.sha256,
      input_sha256: archive.input_sha256,
      body_sha256: sha256(converted.markdown),
      content_sha256: sha256(`${title}\n${converted.markdown}`),
      content_markdown: converted.markdown,
      warnings: [...new Set([...(input.warnings ?? []), ...converted.warnings])].sort(),
      alternate_urls: [],
      producer,
    };
    if (
      previous &&
      ["id", "title", "retrieved_at", "source_modified_at", "body_sha256", "content_sha256", "content_markdown"].some(
        (key) => document[key as keyof SearchDocument] !== previous[key as keyof typeof previous],
      )
    )
      throw new Error(`Retained text or provenance changes for ${sourceUrl}; review code before publication`);
    const existing = documents.get(sourceUrl);
    if (existing && existing.content_sha256 !== document.content_sha256)
      throw new Error("Conflicting document representations require a recorded selection policy");
    const rank = `${observation.snapshot.requested_url === sourceUrl ? "0" : "1"}:${new Date(document.retrieved_at).toISOString()}:${document.snapshot_sha256}`;
    if (!existing || rank < representatives.get(sourceUrl)!) {
      documents.set(sourceUrl, document);
      representatives.set(sourceUrl, rank);
    }
  }
  if (unavailable.length)
    throw new Error(`Required page observations are unavailable (${unavailable.length}):\n${unavailable.join("\n")}`);
  for (const previous of archive.retained)
    if (!documents.has(previous.source_url)) throw new Error(`Retained document would be lost: ${previous.source_url}`);
  const result = [...documents.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!result.length) throw new Error("Host has no accepted searchable documents");
  for (const document of result)
    document.alternate_urls = [...(aliases.get(document.source_url) ?? [])]
      .filter((url) => url !== document.source_url)
      .sort();
  await archive.assertUnchanged();
  return {
    complete: true,
    host: {
      hostname,
      title: scraper.title,
      homepage_url: `https://${hostname}/`,
      homepage_retrieved_at: archive.homepage.snapshot.retrieved_at,
      homepage_sha256: archive.homepage.sha256,
      scope: scraper.scope,
      document_root: `data/documents/${hostname}`,
      document_count: result.length,
    },
    documents: result,
  };
}
