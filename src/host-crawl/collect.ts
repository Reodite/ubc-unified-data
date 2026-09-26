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
import { validateSearchDocument } from "./document-format.ts";
import { assertRequiredQueryIdentity, validateRequiredDocumentQueries } from "./document-query-policy.ts";
import { htmlBaseUrl } from "./html-base.ts";
import { discoverMachineLinks } from "./machine-links.ts";
import type { MarkdownInspection } from "./markdown-contract.mjs";
import {
  assertMarkdownIdentity,
  discoverMarkdownAlternates,
  markdownSources,
  type MarkdownSourceDeclaration,
} from "./markdown-source-policy.ts";
import { parseSitemap } from "./sitemap.ts";
import { discoverReviewedUnavailableLinks } from "./unavailable-link-policy.ts";
import { hostUrl, inventoryUrl, nonDocumentInventoryUrl, pageExclusion, UNSUPPORTED_DOCUMENT } from "./urls.ts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const isPdfUrl = (value: string) => /\.pdf$/i.test(decodeURIComponent(new URL(value).pathname));
const robotsParser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  body: string,
) => {
  isDisallowed(url: string, agent: string): boolean | undefined;
  getSitemaps(): string[];
};

function pageLinks(
  observation: Observation,
  hostname: string,
  exactHost = false,
  nonDocuments?: Set<string>,
): string[] {
  return htmlLinks(observation.snapshot.body, hostname, observation.snapshot.url, exactHost, nonDocuments);
}

function htmlLinks(
  html: string,
  hostname: string,
  base: string,
  exactHost = false,
  nonDocuments?: Set<string>,
): string[] {
  const $ = load(html);
  const source = new URL(base);
  base = htmlBaseUrl(html, hostname, base, exactHost);
  const links = new Set<string>();
  $("a[href]").each((_, node) => {
    const value = $(node).attr("href")?.trim();
    if (!value || value.startsWith("#")) return;
    let url: string;
    try {
      const target = exactHost ? inventoryUrl(value, hostname, base) : hostUrl(value, hostname, base);
      if (!target) return;
      url = target;
    } catch {
      return;
    }
    if (exactHost && nonDocuments && !source.search) {
      const link = $(node);
      const rel = (link.attr("rel") ?? "").toLowerCase().split(/\s+/);
      const commentMetadata =
        link.closest("#comments-template,#comments,.comments-area").length > 0 &&
        (rel.includes("trackback") ||
          (link.attr("title") === "Trackback URL for this post" &&
            link.closest("p.comments-closed.pings-open").length > 0));
      const endpoint = new URL(`${source.pathname.replace(/\/$/, "")}/trackback/`, source).href;
      // Comment metadata identifies this page's machine action, not pages discussing trackbacks.
      if (commentMetadata && url === endpoint) nonDocuments.add(url);
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
  exactHost = false,
): Promise<{
  pages: string[];
  nonDocuments: Set<string>;
  attachmentPages: Set<string>;
  advertisingSitemaps: Map<string, Set<string>>;
}> {
  const htmlSitemap = (url: string) => /\.html?$/i.test(new URL(url).pathname);
  const queue = [...starts];
  if (exactHost) queue.sort((a, b) => Number(htmlSitemap(a)) - Number(htmlSitemap(b)));
  const initial = new Set(starts);
  const seen = new Set<string>();
  const xmlObserved = new Set<string>();
  const requiredChildren = new Set<string>();
  const nonDocuments = new Set<string>();
  const attachmentPages = new Set<string>();
  const pages = new Set<string>();
  const advertisingSitemaps = new Map<string, Set<string>>();
  const wordpressAttachment = (sitemap: string, target: string) => {
    if (!/(?:^|\/)attachment-sitemap(?:\d+)?\.xml$/i.test(new URL(sitemap).pathname)) return false;
    const url = new URL(target);
    if (url.searchParams.size === 1 && /^\d+$/.test(url.searchParams.get("attachment_id") ?? "")) return true;
    return hostname === "moa.ubc.ca" && !url.search && !url.hash && url.pathname !== "/" && url.pathname.endsWith("/");
  };
  while (queue.length) {
    const url = hostUrl(queue.shift()!, hostname);
    if (seen.has(url)) continue;
    seen.add(url);
    const observation = await read(url);
    if (exactHost && initial.has(url) && htmlSitemap(url) && [404, 410].includes(observation.snapshot.status)) {
      const counterpart = new URL(url);
      counterpart.pathname = counterpart.pathname.replace(/\.html?$/i, ".xml");
      const companion = new URL(url);
      const stem = companion.pathname.replace(/\.html?$/i, "");
      const identities = [
        url,
        observation.snapshot.requested_url,
        observation.snapshot.url,
        ...(observation.snapshot.redirects ?? []).flatMap((hop) => [hop.url, hostUrl(hop.location, hostname, hop.url)]),
      ].map((value) => hostUrl(value, hostname));
      // Only the advertised companion and its same-path extensionless redirects are non-documents.
      // The XML index and all children still have to close before these identities leave discovery.
      if (
        initial.has(counterpart.href) &&
        xmlObserved.has(counterpart.href) &&
        !companion.search &&
        identities.every((identity) => {
          const target = new URL(identity);
          return (
            !target.search &&
            [companion.pathname, stem, `${stem}/`].includes(target.pathname) &&
            target.pathname !== "/"
          );
        })
      ) {
        for (const identity of identities) nonDocuments.add(identity);
        continue;
      }
    }
    if (observation.snapshot.status !== 200 || !/xml/i.test(observation.snapshot.headers["content-type"] ?? ""))
      throw new Error("An advertised sitemap lacks a complete XML observation");
    const parsed = parseSitemap(observation.snapshot.body);
    xmlObserved.add(url);
    const policy = policies.find((entry) => hostUrl(entry.path, hostname) === url);
    // A declared deployment-root placeholder supplies no page inventory; additional entries still require validation.
    if (parsed.kind === "pages" && parsed.locations.length === 1 && parsed.locations[0] === policy?.rootOnlyLocation)
      continue;
    for (const location of parsed.locations) {
      const target = exactHost
        ? inventoryUrl(location, hostname, observation.snapshot.url)
        : hostUrl(location, hostname, observation.snapshot.url);
      if (!target) continue;
      if (parsed.kind === "index") {
        requiredChildren.add(target);
        queue.push(target);
      } else {
        if (
          exactHost &&
          location === target &&
          observation.snapshot.requested_url === url &&
          wordpressAttachment(url, target)
        ) {
          nonDocuments.add(target);
          if (hostname === "moa.ubc.ca" && !new URL(target).search) attachmentPages.add(target);
        } else pages.add(target);
        // Only the literal page entry and requested XML identity witness an exact query declaration.
        if (!nonDocuments.has(target) && location === target && observation.snapshot.requested_url === url) {
          const witnesses = advertisingSitemaps.get(target) ?? new Set<string>();
          witnesses.add(url);
          advertisingSitemaps.set(target, witnesses);
        }
      }
    }
  }
  if ([...requiredChildren].some((url) => nonDocuments.has(url)))
    throw new Error("An advertised sitemap child lacks a complete XML observation");
  if ([...attachmentPages].some((url) => pages.has(url)))
    throw new Error("Attachment sitemap conflicts with a required page");
  return {
    pages: [...pages].filter((url) => !nonDocuments.has(url)).sort(),
    nonDocuments,
    attachmentPages,
    advertisingSitemaps,
  };
}

function markdownHeader(observation: Observation, name: string): string | undefined {
  const fields = Object.entries(observation.snapshot.headers).filter(([key]) => key.toLowerCase() === name);
  if (fields.length > 1) throw new Error(`Markdown response has duplicate ${name} fields`);
  return fields[0]?.[1];
}

function assertMarkdownResponse(declaration: MarkdownSourceDeclaration, observation: Observation): void {
  assertMarkdownIdentity(declaration, observation);
  if (
    observation.snapshot.status !== 200 ||
    observation.snapshot.binary !== undefined ||
    markdownHeader(observation, "content-range") !== undefined
  )
    throw new Error("Required Markdown target is not a complete status-200 text response");
  const mediaType = markdownHeader(observation, "content-type");
  if (!mediaType || !/^text\/markdown(?:[\t ]*;[\t ]*charset[\t ]*=[\t ]*(?:utf-8|"utf-8"))?[\t ]*$/i.test(mediaType))
    throw new Error("Required Markdown target needs unambiguous UTF-8 text/markdown");
}

export interface CollectionFormats {
  pdf?: {
    profile_sha256: string;
    extract(
      bytes: Uint8Array,
      sourceUrl: string,
    ): Promise<{ title: string; markdown: string; warnings: string[]; pageCount: number }>;
  };
  markdown?: {
    profile_sha256: string;
    inspect(
      bytes: Uint8Array,
      advertisedTitles: readonly (string | null)[],
    ): Promise<{
      inspection: MarkdownInspection;
      profile_sha256: string;
      termination: "observed-pid-absence" | "identity-matched-unreaped-zombie";
    }>;
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
  const declaredMarkdown = scraper.documentFormats?.includes("markdown") ? markdownSources(hostname) : [];
  if (scraper.documentFormats?.includes("markdown") && !declaredMarkdown.length)
    throw new Error("Markdown format lacks an exact reviewed source declaration");
  const markdownDeclarations = declaredMarkdown.map((declaration) => ({
    declaration,
    witnesses: discoverMarkdownAlternates(archive.homepage, [declaration]),
  }));
  const markdownTargets = new Set(markdownDeclarations.map(({ declaration }) => declaration.target_url));
  if (markdownTargets.size !== markdownDeclarations.length)
    throw new Error("Markdown declarations contain a duplicate required target");
  if (markdownDeclarations.length && (!formats.markdown || !archive.readTextBytes))
    throw new Error("Required Markdown extraction is unavailable");
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
  const readMarkdown = async (declaration: MarkdownSourceDeclaration): Promise<Observation> => {
    if (robots.isDisallowed(declaration.target_url, "ubc-data"))
      throw new Error("Recorded robots policy disallows a required Markdown target");
    const observation = await archive.read(declaration.target_url);
    assertMarkdownResponse(declaration, observation);
    return observation;
  };
  if (scraper.adapter.kind === "html") await verifyHtmlDiscovery(scraper, read);
  else if (scraper.adapter.kind !== "wordpress") throw new Error("Unsupported registered discovery adapter");
  const discovered =
    scraper.adapter.kind === "wordpress" ? await discoverWordpress(scraper, archive.homepage, read) : [];
  const sitemaps = [...robots.getSitemaps(), ...(scraper.adapter.sitemaps ?? []).map((entry) => entry.path)]
    .map((url) => (exactHost ? inventoryUrl(url, hostname) : hostUrl(url, hostname)))
    .filter((url): url is string => url !== null);
  const {
    pages: seedPages,
    nonDocuments,
    attachmentPages,
    advertisingSitemaps,
  } = await sitemapPages(sitemaps, hostname, read, scraper.adapter.sitemaps, exactHost);
  for (const declaration of queryDeclarations)
    if (!advertisingSitemaps.get(declaration.url)?.has(declaration.sitemap))
      throw new Error(`Required query lacks its advertised sitemap witness: ${declaration.url}`);
  const homepageIdentities = new Set([
    `https://${hostname}/`,
    hostUrl(archive.homepage.snapshot.requested_url, hostname),
    hostUrl(archive.homepage.snapshot.url, hostname),
    ...(archive.homepage.snapshot.redirects ?? []).flatMap((hop) => [
      hostUrl(hop.url, hostname),
      hostUrl(hop.location, hostname, hop.url),
    ]),
  ]);
  const cmsPages = new Set(discovered.map((entry) => entry.url));
  const requiredViews = new Set(
    (scraper.adapter.views ?? []).flatMap((view) => view.values.map((value) => publicViewUrl(hostname, view, value))),
  );
  const advertisedPages = new Set([
    ...cmsPages,
    ...seedPages,
    ...requiredViews,
    ...requiredQueries,
    ...markdownTargets,
  ]);
  const viewBases = new Set((scraper.adapter.views ?? []).map((view) => hostUrl(view.path, hostname)));
  const retainedSources = new Set(archive.retained.map((document) => document.source_url));
  const requiredAttachmentConflicts = new Set([
    ...homepageIdentities,
    ...cmsPages,
    ...requiredViews,
    ...requiredQueries,
    ...markdownTargets,
    ...retainedSources,
    ...archive.urls.map((row) => row.url),
  ]);
  if ([...attachmentPages].some((url) => requiredAttachmentConflicts.has(url)))
    throw new Error("Attachment sitemap conflicts with a required page");
  const emittedIdentities = new Set<string>();
  const machineLinks = new Set<string>();
  const excludedDiscovery = (url: string) => {
    const machineLink = machineLinks.has(url);
    if (!nonDocuments.has(url) && !machineLink) return false;
    if (
      homepageIdentities.has(url) ||
      requiredViews.has(url) ||
      requiredQueries.has(url) ||
      markdownTargets.has(url) ||
      (machineLink &&
        (advertisedPages.has(url) ||
          viewBases.has(url) ||
          retainedSources.has(url) ||
          emittedIdentities.has(url) ||
          isPdfUrl(url)))
    )
      throw new Error(`Non-document discovery conflicts with a required page: ${url}`);
    return true;
  };
  const observedPageLinks = (observation: Observation) => {
    if (exactHost) {
      for (const url of discoverReviewedUnavailableLinks(observation, hostname)) nonDocuments.add(url);
      for (const url of discoverMachineLinks(observation.snapshot.body, hostname, observation.snapshot.url)) {
        const exclusion = scraper.excludeUrl ? scraper.excludeUrl(url) : pageExclusion(url, hostname);
        if (exclusion !== null && exclusion !== "Unsupported query or form selection") continue;
        machineLinks.add(url);
        excludedDiscovery(url);
      }
    }
    return pageLinks(observation, hostname, exactHost, nonDocuments);
  };
  // Register homepage roles before CMS records or the frozen frontier can dispatch them.
  if (exactHost) observedPageLinks(archive.homepage);
  const queue: string[] = [];
  const queued = new Set<string>();
  const add = (value: string, linked = false) => {
    const url = exactHost ? inventoryUrl(value, hostname) : hostUrl(value, hostname);
    if (!url || excludedDiscovery(url)) return;
    if (markdownTargets.has(url)) return;
    const exclusion = scraper.excludeUrl ? scraper.excludeUrl(url) : pageExclusion(url, hostname);
    if (advertisedPages.has(url) && exclusion === "Ambiguous repeated path separator")
      throw new Error("Publisher inventory advertises an ambiguous path");
    if (exclusion === UNSUPPORTED_DOCUMENT) return;
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
      ((cmsPages.has(url) && !(exactHost && nonDocumentInventoryUrl(url, hostname))) ||
        (advertisedPages.has(url) && exclusion === "Unsupported query or form selection"))
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
    ...requiredQueries,
    ...archive.urls.map((row) => row.url),
  ].sort())
    add(url);
  const retained = new Map(archive.retained.map((document) => [document.source_url, document]));
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
    for (const identity of [
      sourceUrl,
      hostUrl(observation.snapshot.requested_url, hostname),
      ...(physicalAlias ? [requested] : []),
    ]) {
      if (machineLinks.has(identity)) throw new Error(`Machine-link evidence conflicts with emitted text: ${identity}`);
      emittedIdentities.add(identity);
    }
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
  for (const { declaration, witnesses } of markdownDeclarations) {
    const observation = await readMarkdown(declaration);
    const receipt = await archive.readTextBytes!(observation.sha256);
    const bytes = Buffer.from(receipt.bytes);
    const bytesSha256 = sha256(bytes);
    if (receipt.sha256 !== bytesSha256 || observation.snapshot.bytes !== bytes.length)
      throw new Error("Markdown bytes differ from their recorded receipt");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(content, "utf8").equals(bytes) || content !== observation.snapshot.body)
      throw new Error("Markdown target is not exact BOM-free UTF-8 source text");
    const profileSha256 = formats.markdown!.profile_sha256;
    if (!/^[a-f0-9]{64}$/.test(profileSha256)) throw new Error("Invalid Markdown runtime profile digest");
    const inspected = await formats.markdown!.inspect(
      bytes,
      witnesses.map((witness) => witness.title),
    );
    if (
      inspected.profile_sha256 !== profileSha256 ||
      inspected.inspection.source_bytes !== bytes.length ||
      inspected.inspection.source_bytes_sha256 !== bytesSha256
    )
      throw new Error("Markdown runtime evidence differs from the recorded source bytes or profile");
    const sourceUrl = declaration.target_url;
    if (retained.has(sourceUrl)) throw new Error("Retained Markdown needs an explicit extraction comparison policy");
    const document: SearchDocument = {
      id: `documents:official-web:${sha256(sourceUrl).slice(0, 24)}`,
      hostname,
      title: inspected.inspection.title,
      source_url: sourceUrl,
      retrieved_at: observation.snapshot.retrieved_at,
      source_modified_at: null,
      snapshot_sha256: observation.sha256,
      input_sha256: archive.input_sha256,
      body_sha256: bytesSha256,
      content_sha256: sha256(`${inspected.inspection.title}\n${content}`),
      content_markdown: content,
      warnings: [],
      alternate_urls: [],
      producer,
      extraction: {
        format: "markdown",
        source_bytes_sha256: bytesSha256,
        source_bytes: bytes.length,
        profile_sha256: profileSha256,
        termination: inspected.termination,
        title_origin: { ...inspected.inspection.title_origin },
        witnesses: witnesses.map((witness) => ({ ...witness })),
      },
    };
    validateSearchDocument(document);
    keep(document, observation, sourceUrl, false);
    for (const link of inspected.inspection.links) add(new URL(link.url, observation.snapshot.url).href, true);
  }
  while (queue.length) {
    const requested = queue.shift()!;
    if (excludedDiscovery(requested)) continue;
    let observation: Observation;
    let apiInput: ArticleInput | undefined;
    let contentBase: string | undefined;
    try {
      observation = await read(requested, true);
    } catch (error) {
      if (requiredQueries.has(requested)) throw error;
      if (exactHost && archive.observedScopeExclusion?.(requested)) continue;
      if (error instanceof NonTextMediaError) {
        if (requiredViews.has(requested))
          throw new Error(`Required HTML view returned non-text media: ${requested}`, { cause: error });
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
    assertQueryObservation(requested, observation);
    if (observation.snapshot.binary) {
      if (!scraper.documentFormats?.includes("pdf")) {
        if (requiredViews.has(requested))
          throw new Error(`Required HTML view returned a recorded binary: ${requested}`);
        continue;
      }
      if (observation.snapshot.status !== 200 || !formats.pdf || !archive.readBytes)
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
      for (const url of htmlLinks(apiInput.html, hostname, contentBase!, exactHost)) add(url, true);
    } else {
      if ([404, 410].includes(observation.snapshot.status)) {
        if (advertisedPages.has(requested) || isPdfUrl(requested))
          throw new Error(`Advertised document is unavailable: ${requested}`);
        continue;
      }
      if (observation.snapshot.status !== 200 || !/html/i.test(observation.snapshot.headers["content-type"] ?? ""))
        throw new Error(`Missing complete HTML for ${requested}`);
      const links = observedPageLinks(observation);
      for (const url of discoverPublicViews(scraper, observation.snapshot)) {
        advertisedPages.add(url);
        add(url);
      }
      for (const url of links) add(url, true);
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
      for (const url of pageLinks(observation, hostname, exactHost, nonDocuments)) add(url, true);
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
      if (requiredViews.has(requested) || requiredQueries.has(requested) || isPdfUrl(requested))
        throw new Error(`Required linked document has no searchable representation: ${requested}`);
      continue;
    }
    const input = decision.input;
    if (scraper.adapter.kind === "html")
      for (const url of htmlLinks(input.html, hostname, sourceUrl, exactHost)) add(url, true);
    const title = plainText(input.title);
    if (!title) throw new Error("Extracted document lacks a title");
    const converted = toSafeMarkdown(input.html, contentBase ?? sourceUrl);
    if (!converted.markdown.trim()) {
      if (apiInput || requiredViews.has(requested) || requiredQueries.has(requested) || isPdfUrl(requested))
        throw new Error(`Required API text or document becomes empty after sanitization: ${sourceUrl}`);
      continue;
    }
    const ambiguousDate = ambiguousModified.has(sourceUrl) || ambiguousModified.has(requested);
    const document: SearchDocument = {
      id: `documents:official-web:${sha256(sourceUrl).slice(0, 24)}`,
      hostname,
      title,
      source_url: sourceUrl,
      retrieved_at: observation.snapshot.retrieved_at,
      source_modified_at: previous
        ? previous.source_modified_at
        : ambiguousDate
          ? null
          : (declaredModified.get(sourceUrl) ?? input.sourceModifiedAt ?? null),
      snapshot_sha256: observation.sha256,
      input_sha256: archive.input_sha256,
      body_sha256: sha256(converted.markdown),
      content_sha256: sha256(`${title}\n${converted.markdown}`),
      content_markdown: converted.markdown,
      warnings: [
        ...new Set([
          ...(input.warnings ?? []),
          ...converted.warnings,
          ...(ambiguousDate
            ? [
                "Multiple CMS records advertise conflicting modification dates; the HTML document has no assigned publisher modification time.",
              ]
            : []),
        ]),
      ].sort(),
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
  for (const url of requiredQueries)
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
