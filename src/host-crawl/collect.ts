import { createRequire } from "node:module";
import { load } from "cheerio";
import { REVIEWED_EMPTY_ARCHIVE_CLASSES } from "../host-scrapers/policies/archives.ts";
import {
  assertRequiredQueryIdentity,
  validateRequiredDocumentQueries,
} from "../host-scrapers/policies/document-query-policy.ts";
import { toSafeMarkdown } from "../prose/markdown.ts";
import type { ArticleInput } from "../prose/model.ts";
import { plainText } from "../source-documents.ts";
import { assertPublicViewIdentity, discoverPublicViews, verifyHtmlDiscovery } from "./adapters/html-discovery.ts";
import { wordpressRecordInput } from "./adapters/wordpress-content.ts";
import { advertisedWordpressRoots, discoverWordpress } from "./adapters/wordpress-discovery.ts";
import { assertPublishableArticle, isKnownEmptyArchiveBody } from "./article-quality.ts";
import { CollectionDocuments, prepareMarkdownSources, type CollectionFormats } from "./collection/documents.ts";
import { CollectionFrontier, isPdfUrl } from "./collection/frontier.ts";
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
import { htmlLinks } from "./discovery/links.ts";
import { sitemapPages } from "./discovery/sitemaps.ts";
import { isFatalCollectionError } from "./errors.ts";
import { hostUrl, inventoryUrl, pageUrlPolicy } from "./urls.ts";

export type { CollectionFormats } from "./collection/documents.ts";
const robotsParser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  body: string,
) => {
  isDisallowed(url: string, agent: string): boolean | undefined;
  getSitemaps(): string[];
};

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
  const { declarations: markdownDeclarations, targets: markdownTargets } = prepareMarkdownSources(
    scraper,
    archive,
    formats,
  );
  const queryDeclarations = validateRequiredDocumentQueries(hostname, scraper.adapter.requiredQueries);
  const requiredQueries = new Set(queryDeclarations.map((entry) => entry.url));
  const assertQueryObservation = (requested: string, observation: Observation) => {
    assertRequiredQueryIdentity(hostname, queryDeclarations, requested, observation.snapshot);
    if (
      requiredQueries.has(requested) &&
      (observation.snapshot.status !== 200 ||
        observation.snapshot.binary ||
        !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(observation.snapshot.headers["content-type"] ?? ""))
    )
      throw new Error(`Required query needs a complete HTML observation: ${requested}`);
  };
  const exactHost = scraper.adapter.exactHostInventory === true;
  if (scraper.adapter.kind === "auto") {
    const advertised = advertisedWordpressRoots(archive.homepage).some((url) => {
      if (exactHost) return inventoryUrl(url, hostname) !== null;
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
        const excluded = scraper.excludeUrl ? scraper.excludeUrl(target) : pageUrlPolicy(target, hostname);
        if (excluded !== null)
          throw new DocumentPolicyError(`Document URL policy excludes ${target}: ${excluded.reason}`);
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
  const reviewedCmsNonDocuments = new Set<string>();
  const reviewedSearchControls = new Set<string>();
  const reviewedMissingLocations = new Set<string>();
  const discovered =
    scraper.adapter.kind === "wordpress"
      ? await discoverWordpress(
          scraper,
          archive.homepage,
          read,
          reviewedCmsNonDocuments,
          reviewedSearchControls,
          reviewedMissingLocations,
        )
      : [];
  const sitemaps = [...robots.getSitemaps(), ...(scraper.adapter.sitemaps ?? []).map((entry) => entry.path)]
    .map((url) => (exactHost ? inventoryUrl(url, hostname) : hostUrl(url, hostname)))
    .filter((url): url is string => url !== null);
  const {
    pages: seedPages,
    nonDocuments,
    attachmentPages,
    userArchivePages,
    advertisingSitemaps,
  } = await sitemapPages(sitemaps, hostname, read, scraper.adapter.sitemaps, exactHost);
  for (const declaration of queryDeclarations)
    if (!advertisingSitemaps.get(declaration.url)?.has(declaration.sitemap))
      throw new Error(`Required query lacks its advertised sitemap witness: ${declaration.url}`);
  const frontier = new CollectionFrontier(scraper, archive, {
    cmsPages: discovered.map((entry) => entry.url),
    seedPages,
    nonDocuments,
    requiredQueries,
    markdownTargets,
  });
  await frontier.acceptCmsEvidence(reviewedCmsNonDocuments, reviewedSearchControls, reviewedMissingLocations, read);
  frontier.assertSitemapRoles(attachmentPages, userArchivePages);
  frontier.seed(archive.homepage);
  const retained = new Map(archive.retained.map((document) => [document.source_url, document]));
  const documentBuilder = new CollectionDocuments(archive, producer, formats, retained);
  const declaredModified = new Map<string, string | null>();
  const ambiguousModified = new Set<string>();
  for (const entry of discovered) {
    if (ambiguousModified.has(entry.url)) continue;
    if (declaredModified.has(entry.url) && declaredModified.get(entry.url) !== entry.modified) {
      if (!exactHost || scraper.adapter.apiContentFallback)
        throw new Error("Conflicting source modification observations for one URL");
      // Distinct CMS records can refer to one HTML page without owning its publisher timestamp.
      ambiguousModified.add(entry.url);
      declaredModified.set(entry.url, null);
    } else declaredModified.set(entry.url, entry.modified);
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
    frontier.markEmitted(sourceUrl, observation, requested, physicalAlias);
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
  for (const source of markdownDeclarations) {
    const { document, observation, links } = await documentBuilder.markdown(source, robots);
    keep(document, observation, source.declaration.target_url, false);
    for (const link of links) frontier.add(new URL(link.url, observation.snapshot.url).href, true);
  }
  for (let requested = frontier.take(); requested !== undefined; requested = frontier.take()) {
    let observation: Observation;
    let apiInput: ArticleInput | undefined;
    let contentBase: string | undefined;
    try {
      observation = await read(requested, true);
    } catch (error) {
      if (frontier.isRequiredQuery(requested)) throw error;
      if (exactHost && archive.observedScopeExclusion?.(requested)) continue;
      if (error instanceof NonTextMediaError) {
        if (frontier.isRequiredView(requested))
          throw new Error(`Required HTML view returned non-text media: ${requested}`, { cause: error });
        continue;
      }
      if (isFatalCollectionError(error)) throw error;
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
    assertQueryObservation(requested, observation);
    if (observation.snapshot.binary) {
      if (!scraper.documentFormats?.includes("pdf")) {
        if (frontier.isRequiredView(requested))
          throw new Error(`Required HTML view returned a recorded binary: ${requested}`);
        continue;
      }
      keep(await documentBuilder.pdf(observation, requested), observation, requested);
      continue;
    }
    if (apiInput) {
      for (const url of htmlLinks(apiInput.html, hostname, contentBase!, exactHost)) frontier.add(url, true);
    } else {
      if ([404, 410].includes(observation.snapshot.status)) {
        if (frontier.isAdvertised(requested) || isPdfUrl(requested))
          throw new Error(`Advertised document is unavailable: ${requested}`);
        continue;
      }
      if (observation.snapshot.status !== 200 || !/html/i.test(observation.snapshot.headers["content-type"] ?? ""))
        throw new Error(`Missing complete HTML for ${requested}`);
      const links = frontier.observe(observation);
      for (const url of discoverPublicViews(scraper, observation.snapshot)) frontier.advertiseView(url);
      for (const url of links) frontier.add(url, true);
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
      assertQueryObservation(requested, observation);
      for (const url of frontier.retainedLinks(observation)) frontier.add(url, true);
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
      if (frontier.isRequired(requested))
        throw new Error(`Required linked document has no searchable representation: ${requested}`);
      continue;
    }
    const input = decision.input;
    if (scraper.adapter.kind === "html")
      for (const url of htmlLinks(input.html, hostname, sourceUrl, exactHost)) frontier.add(url, true);
    const title = plainText(input.title);
    if (!title) throw new Error("Extracted document lacks a title");
    const converted = toSafeMarkdown(input.html, contentBase ?? sourceUrl);
    const archiveClasses = REVIEWED_EMPTY_ARCHIVE_CLASSES[hostname];
    if (
      !apiInput &&
      archiveClasses &&
      isKnownEmptyArchiveBody(converted.markdown) &&
      archiveClasses.some((role) => load(observation.snapshot.body)("body.archive").hasClass(role))
    ) {
      frontier.assertEmptyArchive(requested, sourceUrl, observed, observation);
      continue;
    }
    if (!converted.markdown.trim()) {
      if (apiInput || frontier.isRequired(requested))
        throw new Error(`Required API text or document becomes empty after sanitization: ${sourceUrl}`);
      continue;
    }
    const ambiguousDate = ambiguousModified.has(sourceUrl) || ambiguousModified.has(requested);
    const document = documentBuilder.create(observation, {
      sourceUrl,
      title,
      markdown: converted.markdown,
      modified: previous
        ? previous.source_modified_at
        : ambiguousDate
          ? null
          : (declaredModified.get(sourceUrl) ?? input.sourceModifiedAt ?? null),
      warnings: [
        ...(input.warnings ?? []),
        ...converted.warnings,
        ...(ambiguousDate
          ? [
              "Multiple CMS records advertise conflicting modification dates; the HTML document has no assigned publisher modification time.",
            ]
          : []),
      ],
    });
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
  const coverage = frontier.coverage();
  for (const url of coverage.views)
    if (!result.some((document) => document.source_url === url || document.alternate_urls.includes(url)))
      throw new Error(`Required public view is missing from complete output: ${url}`);
  for (const url of coverage.queries)
    if (!result.some((document) => document.source_url === url || document.alternate_urls.includes(url)))
      throw new Error(`Required query is missing from complete output: ${url}`);
  for (const { declaration, witnesses } of markdownDeclarations) {
    const document = result.find((candidate) => candidate.source_url === declaration.target_url);
    if (
      document?.extraction?.format !== "markdown" ||
      JSON.stringify(document.extraction.witnesses) !== JSON.stringify(witnesses)
    )
      throw new Error(`Required Markdown target lacks its exact extracted witness context: ${declaration.target_url}`);
  }
  for (const document of result) assertPublishableArticle(document);
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
