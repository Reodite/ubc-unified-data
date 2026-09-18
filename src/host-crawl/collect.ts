import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { load } from "cheerio";
import { toSafeMarkdown } from "../prose/markdown.ts";
import type { ArticleInput } from "../prose/model.ts";
import { plainText } from "../source-documents.ts";
import {
  assertPublicViewIdentity,
  discoverPublicViews,
  publicViewUrl,
  verifyHtmlDiscovery,
} from "./adapters/html-discovery.ts";
import { wordpressRecordInput } from "./adapters/wordpress-content.ts";
import { advertisedWordpressRoots, discoverWordpress } from "./adapters/wordpress-discovery.ts";
import {
  DocumentPolicyError,
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
const isPdfUrl = (value: string) => /\.pdf$/i.test(decodeURIComponent(new URL(value).pathname));
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
  policies: NonNullable<HostScraper["adapter"]["sitemaps"]> = [],
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
    const policy = policies.find((entry) => hostUrl(entry.path, hostname) === url);
    // A declared deployment-root placeholder supplies no page inventory; additional entries still require validation.
    if (parsed.kind === "pages" && parsed.locations.length === 1 && parsed.locations[0] === policy?.rootOnlyLocation)
      continue;
    for (const location of parsed.locations) {
      const target = hostUrl(location, hostname, observation.snapshot.url);
      if (parsed.kind === "index") queue.push(target);
      else pages.add(target);
    }
  }
  return [...pages].sort();
}

export interface CollectionFormats {
  pdf?: {
    profile_sha256: string;
    extract(
      bytes: Uint8Array,
      sourceUrl: string,
    ): Promise<{ title: string; markdown: string; warnings: string[]; pageCount: number }>;
  };
}

/** Build complete host documents from observations supplied by an acquisition or offline archive, never retained Markdown. */
export async function collectRecordedHost(
  scraper: HostScraper,
  archive: HostArchive,
  producer: ProducerContext,
  formats: CollectionFormats = {},
): Promise<CompletedHost> {
  if (scraper.hostname !== archive.hostname) throw new Error("Scraper/archive hostname mismatch");
  const verdict = scraper.vetHomepage(archive.homepage.snapshot);
  if (!verdict.accepted) throw new Error(`Homepage is not vetted: ${verdict.reason}`);
  const hostname = scraper.hostname;
  if (scraper.adapter.kind === "auto") {
    const advertised = advertisedWordpressRoots(archive.homepage).some((url) => {
      try {
        hostUrl(url, hostname);
        return true;
      } catch {
        return false;
      }
    });
    // Same-host advertised CMS failures remain fatal; they cannot establish an HTML-only inventory.
    scraper = { ...scraper, adapter: { ...scraper.adapter, kind: advertised ? "wordpress" : "html" } };
  }
  const robotsUrl = `https://${hostname}/robots.txt`;
  const robotsObservation = await archive.read(robotsUrl);
  if (![200, 404, 410].includes(robotsObservation.snapshot.status))
    throw new Error("Robots observation is unavailable");
  const robots = robotsParser(
    robotsUrl,
    robotsObservation.snapshot.status === 200 ? robotsObservation.snapshot.body : "",
  );
  const assertObservedAccess = (observation: Observation, document = false) => {
    const destinations = [
      observation.snapshot.requested_url,
      observation.snapshot.url,
      ...(observation.snapshot.redirects ?? []).flatMap((hop) => [hop.url, hostUrl(hop.location, hostname, hop.url)]),
    ];
    for (const value of destinations) {
      const target = hostUrl(value, hostname);
      if (robots.isDisallowed(target, "ubc-data")) throw new Error("Recorded redirect violates robots policy");
      if (document) {
        const excluded = scraper.excludeUrl ? scraper.excludeUrl(target) : pageExclusion(target, hostname);
        if (excluded !== null) throw new DocumentPolicyError(`Document URL policy excludes ${target}: ${excluded}`);
      }
    }
  };
  const read = async (value: string, document = false): Promise<Observation> => {
    const url = hostUrl(value, hostname);
    if (robots.isDisallowed(url, "ubc-data")) throw new Error("Recorded robots policy disallows a required request");
    const observation = document && archive.readDocument ? await archive.readDocument(url) : await archive.read(url);
    assertObservedAccess(observation, document);
    return observation;
  };
  if (scraper.adapter.kind === "html") await verifyHtmlDiscovery(scraper, read);
  else if (scraper.adapter.kind !== "wordpress") throw new Error("Unsupported registered discovery adapter");
  const discovered =
    scraper.adapter.kind === "wordpress" ? await discoverWordpress(scraper, archive.homepage, read) : [];
  const sitemaps = [...robots.getSitemaps(), ...(scraper.adapter.sitemaps ?? []).map((entry) => entry.path)].map(
    (url) => hostUrl(url, hostname),
  );
  const seedPages = await sitemapPages(sitemaps, hostname, read, scraper.adapter.sitemaps);
  const cmsPages = new Set(discovered.map((entry) => entry.url));
  const requiredViews = new Set(
    (scraper.adapter.views ?? []).flatMap((view) => view.values.map((value) => publicViewUrl(hostname, view, value))),
  );
  const advertisedPages = new Set([...cmsPages, ...seedPages, ...requiredViews]);
  const queue: string[] = [];
  const queued = new Set<string>();
  const add = (value: string, linked = false) => {
    const url = hostUrl(value, hostname);
    const exclusion = scraper.excludeUrl ? scraper.excludeUrl(url) : pageExclusion(url, hostname);
    if (advertisedPages.has(url) && exclusion === "Ambiguous repeated path separator")
      throw new Error("Publisher inventory advertises an ambiguous path");
    if (exclusion === UNSUPPORTED_DOCUMENT) throw new Error(`${exclusion}: ${url}`);
    const parsed = new URL(url);
    if (
      scraper.adapter.kind === "html" &&
      linked &&
      exclusion === "Unsupported query or form selection" &&
      [...parsed.searchParams.keys()].some((key) => ["page", "paged"].includes(key))
    )
      throw new Error(`Linked pagination requires a declared complete query policy: ${url}`);
    if (
      exclusion !== null &&
      scraper.adapter.views?.some(
        (view) => parsed.pathname === view.path && view.values.includes(parsed.searchParams.get(view.parameter) ?? ""),
      )
    )
      throw new Error(`A linked public view requires an explicit complete query policy: ${url}`);
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
  for (const view of scraper.adapter.views ?? []) add(hostUrl(view.path, hostname));
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
  const keep = (document: SearchDocument, observation: Observation, requested: string, physicalAlias = true) => {
    const sourceUrl = document.source_url;
    const observedAliases = aliases.get(sourceUrl) ?? new Set<string>();
    if (physicalAlias) observedAliases.add(requested);
    observedAliases.add(hostUrl(observation.snapshot.requested_url, hostname));
    aliases.set(sourceUrl, observedAliases);
    const existing = documents.get(sourceUrl);
    if (existing && existing.content_sha256 !== document.content_sha256)
      throw new Error("Conflicting document representations require a recorded selection policy");
    const rank = `${observation.snapshot.requested_url === sourceUrl ? "0" : "1"}:${new Date(document.retrieved_at).toISOString()}:${document.snapshot_sha256}`;
    if (!existing || rank < representatives.get(sourceUrl)!) {
      documents.set(sourceUrl, document);
      representatives.set(sourceUrl, rank);
    }
  };
  while (queue.length) {
    const requested = queue.shift()!;
    let observation: Observation;
    let apiInput: ArticleInput | undefined;
    let contentBase: string | undefined;
    try {
      observation = await read(requested, true);
    } catch (error) {
      if (error instanceof NonTextMediaError) {
        if (isPdfUrl(requested) || requiredViews.has(requested))
          throw new Error(`Required document returned non-text media: ${requested}`, { cause: error });
        continue;
      }
      if (
        error instanceof DocumentPolicyError ||
        /budget|duration exhausted|changed|corrupt|ENOENT|EIO|ENOSPC/i.test(String(error))
      )
        throw error;
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
    assertPublicViewIdentity(scraper, requested, observation.snapshot);
    if (observation.snapshot.binary) {
      if (
        observation.snapshot.status !== 200 ||
        !scraper.documentFormats?.includes("pdf") ||
        !formats.pdf ||
        !archive.readBytes
      )
        throw new Error(`Required PDF extraction is unavailable: ${requested}`);
      const sourceUrl = hostUrl(observation.snapshot.url, hostname);
      if (retained.has(sourceUrl)) throw new Error("Retained PDF needs an explicit extraction comparison policy");
      const bytes = await archive.readBytes(observation.sha256);
      if (
        createHash("sha256").update(bytes).digest("hex") !== observation.snapshot.binary.sha256 ||
        bytes.length !== observation.snapshot.bytes
      )
        throw new Error("PDF bytes differ from their recorded observation");
      const converted = await formats.pdf.extract(bytes, sourceUrl);
      const title = plainText(converted.title);
      if (!title || !converted.markdown.trim()) throw new Error("Required PDF has no searchable text");
      keep(
        {
          id: `documents:official-web:${sha256(sourceUrl).slice(0, 24)}`,
          hostname,
          title,
          source_url: sourceUrl,
          retrieved_at: observation.snapshot.retrieved_at,
          source_modified_at: null,
          snapshot_sha256: observation.sha256,
          input_sha256: archive.input_sha256,
          body_sha256: sha256(converted.markdown),
          content_sha256: sha256(`${title}\n${converted.markdown}`),
          content_markdown: converted.markdown,
          warnings: [...new Set(converted.warnings)].sort(),
          alternate_urls: [],
          producer,
          extraction: {
            format: "pdf",
            source_bytes_sha256: observation.snapshot.binary.sha256,
            source_bytes: bytes.length,
            pages: converted.pageCount,
            profile_sha256: formats.pdf.profile_sha256,
          },
        },
        observation,
        requested,
      );
      continue;
    }
    if (apiInput) {
      for (const url of htmlLinks(apiInput.html, hostname, contentBase!)) add(url, true);
    } else {
      if ([404, 410].includes(observation.snapshot.status)) {
        if (advertisedPages.has(requested) || isPdfUrl(requested))
          throw new Error(`Advertised document is unavailable: ${requested}`);
        continue;
      }
      if (observation.snapshot.status !== 200 || !/html/i.test(observation.snapshot.headers["content-type"] ?? ""))
        throw new Error(`Missing complete HTML for ${requested}`);
      for (const url of discoverPublicViews(scraper, observation.snapshot)) {
        advertisedPages.add(url);
        add(url);
      }
      for (const url of pageLinks(observation, hostname)) add(url, true);
    }
    const sourceUrl = hostUrl(observation.snapshot.url, hostname);
    const observed = observation;
    const previous = retained.get(sourceUrl);
    if (previous && previous.snapshot !== observation.sha256) {
      if (apiInput) throw new Error("Retained API text requires an explicit recorded representative policy");
      observation = await archive.readSnapshot(previous.snapshot);
      if (hostUrl(observation.snapshot.url, hostname) !== sourceUrl)
        throw new Error("Retained representative has a different physical URL");
      assertObservedAccess(observation, true);
      for (const url of pageLinks(observation, hostname)) add(url, true);
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
    if (decision.kind === "excluded") {
      if (requiredViews.has(requested) || isPdfUrl(requested))
        throw new Error(`Required linked document has no searchable representation: ${requested}`);
      continue;
    }
    const input = decision.input;
    if (scraper.adapter.kind === "html") for (const url of htmlLinks(input.html, hostname, sourceUrl)) add(url, true);
    const title = plainText(input.title);
    if (!title) throw new Error("Extracted document lacks a title");
    const converted = toSafeMarkdown(input.html, contentBase ?? sourceUrl);
    if (!converted.markdown.trim()) {
      if (apiInput || requiredViews.has(requested) || isPdfUrl(requested))
        throw new Error(`Required API text or document becomes empty after sanitization: ${sourceUrl}`);
      continue;
    }
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
    keep(document, observation, requested, !apiInput);
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
  for (const url of requiredViews)
    if (!result.some((document) => document.source_url === url || document.alternate_urls.includes(url)))
      throw new Error(`Required public view is missing from complete output: ${url}`);
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
