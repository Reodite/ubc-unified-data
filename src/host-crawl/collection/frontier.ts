import { reviewedGalleryAttachments } from "../../host-scrapers/policies/gallery.ts";
import { discoverReviewedMslUnavailableLinks } from "../../host-scrapers/policies/msl-unavailable-citations.ts";
import { discoverReviewedUnavailableLinks } from "../../host-scrapers/policies/unavailable-link-policy.ts";
import { publicViewUrl } from "../adapters/html-discovery.ts";
import type { HostArchive, HostScraper, Observation } from "../contracts.ts";
import { pageLinks } from "../discovery/links.ts";
import { discoverMachineLinks } from "../machine-links.ts";
import { hostUrl, inventoryUrl, nonDocumentInventoryUrl, pageUrlPolicy } from "../urls.ts";

export const isPdfUrl = (value: string) => /\.pdf$/i.test(decodeURIComponent(new URL(value).pathname));

interface FrontierInventory {
  cmsPages: readonly string[];
  seedPages: readonly string[];
  nonDocuments: ReadonlySet<string>;
  requiredQueries: ReadonlySet<string>;
  markdownTargets: ReadonlySet<string>;
}

/** Own discovery roles and FIFO dispatch without letting exclusion evidence erase required identities. */
export class CollectionFrontier {
  private readonly hostname: string;
  private readonly exactHost: boolean;
  private readonly homepageIdentities: Set<string>;
  private readonly cmsPages: Set<string>;
  private readonly seedPages: Set<string>;
  private readonly requiredViews: Set<string>;
  private readonly requiredQueries: ReadonlySet<string>;
  private readonly markdownTargets: ReadonlySet<string>;
  private readonly advertisedPages: Set<string>;
  private readonly viewBases: Set<string>;
  private readonly retainedSources: Set<string>;
  private readonly frozenSeedUrls: Set<string>;
  private readonly nonDocuments: Set<string>;
  private readonly initialPages: string[];
  private readonly emittedIdentities = new Set<string>();
  private readonly machineLinks = new Set<string>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();

  constructor(
    private readonly scraper: HostScraper,
    archive: HostArchive,
    inventory: FrontierInventory,
  ) {
    const hostname = scraper.hostname;
    this.hostname = hostname;
    this.exactHost = scraper.adapter.exactHostInventory === true;
    this.homepageIdentities = new Set([
      `https://${hostname}/`,
      hostUrl(archive.homepage.snapshot.requested_url, hostname),
      hostUrl(archive.homepage.snapshot.url, hostname),
      ...(archive.homepage.snapshot.redirects ?? []).flatMap((hop) => [
        hostUrl(hop.url, hostname),
        hostUrl(hop.location, hostname, hop.url),
      ]),
    ]);
    this.cmsPages = new Set(inventory.cmsPages);
    this.seedPages = new Set(inventory.seedPages);
    this.requiredViews = new Set(
      (scraper.adapter.views ?? []).flatMap((view) => view.values.map((value) => publicViewUrl(hostname, view, value))),
    );
    this.requiredQueries = inventory.requiredQueries;
    this.markdownTargets = inventory.markdownTargets;
    this.advertisedPages = new Set([
      ...this.cmsPages,
      ...this.seedPages,
      ...this.requiredViews,
      ...this.requiredQueries,
      ...this.markdownTargets,
    ]);
    this.viewBases = new Set((scraper.adapter.views ?? []).map((view) => hostUrl(view.path, hostname)));
    this.retainedSources = new Set(archive.retained.map((document) => document.source_url));
    this.frozenSeedUrls = new Set(archive.urls.map((row) => row.url));
    this.nonDocuments = new Set(inventory.nonDocuments);
    this.initialPages = [
      ...inventory.cmsPages,
      ...inventory.seedPages,
      ...inventory.requiredQueries,
      ...archive.urls.map((row) => row.url),
    ].sort();
  }

  private conflictsWithAttachment(url: string): boolean {
    return (
      this.homepageIdentities.has(url) ||
      this.cmsPages.has(url) ||
      this.requiredViews.has(url) ||
      this.requiredQueries.has(url) ||
      this.markdownTargets.has(url) ||
      this.retainedSources.has(url) ||
      this.frozenSeedUrls.has(url)
    );
  }

  private conflictsWithCmsEvidence(url: string): boolean {
    // Sitemap pages also protect CMS evidence; attachment/page overlaps are checked by sitemap discovery itself.
    return this.conflictsWithAttachment(url) || this.seedPages.has(url);
  }

  private conflictsWithObservedExclusion(url: string): boolean {
    return (
      this.advertisedPages.has(url) ||
      this.viewBases.has(url) ||
      this.homepageIdentities.has(url) ||
      this.retainedSources.has(url) ||
      this.emittedIdentities.has(url) ||
      isPdfUrl(url)
    );
  }

  private conflictsWithCitation(url: string): boolean {
    // Citations and gallery attachments protect frozen seeds; witnessed machine actions may supersede them.
    return this.frozenSeedUrls.has(url) || this.conflictsWithObservedExclusion(url);
  }

  async acceptCmsEvidence(
    nonDocuments: ReadonlySet<string>,
    searchControls: ReadonlySet<string>,
    missingLocations: ReadonlySet<string>,
    read: (url: string) => Promise<Observation>,
  ): Promise<void> {
    if ([...nonDocuments].some((url) => this.conflictsWithCmsEvidence(url)))
      throw new Error("Reviewed organizer identity conflicts with a required page");
    if ([...searchControls].some((url) => this.conflictsWithCmsEvidence(url)))
      throw new Error("Reviewed search control conflicts with a required page");
    if ([...missingLocations].some((url) => this.conflictsWithCmsEvidence(url)))
      throw new Error("Reviewed location identity conflicts with a required page");
    for (const url of searchControls) this.nonDocuments.add(url);
    for (const url of missingLocations) {
      const witnessed = await read(url);
      if (
        witnessed.snapshot.status !== 404 ||
        witnessed.snapshot.url !== url ||
        witnessed.snapshot.requested_url !== url
      )
        throw new Error("Reviewed location URL lacks its public 404 witness");
      this.nonDocuments.add(url);
    }
    for (const url of nonDocuments) {
      const witnessed = await read(url);
      if (
        witnessed.snapshot.status !== 404 ||
        witnessed.snapshot.url !== url ||
        witnessed.snapshot.requested_url !== url
      )
        throw new Error("Reviewed organizer root lacks its public 404 witness");
      this.nonDocuments.add(url);
    }
  }

  assertSitemapRoles(attachmentPages: ReadonlySet<string>, userArchivePages: ReadonlySet<string>): void {
    if ([...attachmentPages].some((url) => this.conflictsWithAttachment(url)))
      throw new Error("Attachment sitemap conflicts with a required page");
    if ([...userArchivePages].some((url) => this.conflictsWithAttachment(url)))
      throw new Error("User archive conflicts with a required page");
  }

  private excludedDiscovery(url: string): boolean {
    const machineLink = this.machineLinks.has(url);
    if (!this.nonDocuments.has(url) && !machineLink) return false;
    if (
      this.homepageIdentities.has(url) ||
      this.requiredViews.has(url) ||
      this.requiredQueries.has(url) ||
      this.markdownTargets.has(url) ||
      (machineLink && this.conflictsWithObservedExclusion(url))
    )
      throw new Error(`Non-document discovery conflicts with a required page: ${url}`);
    return true;
  }

  observe(observation: Observation): string[] {
    if (this.exactHost) {
      for (const url of [
        ...discoverReviewedUnavailableLinks(observation, this.hostname),
        ...discoverReviewedMslUnavailableLinks(observation, this.hostname),
      ]) {
        if (this.conflictsWithCitation(url))
          throw new Error(`Reviewed unavailable citation conflicts with a required page: ${url}`);
        this.nonDocuments.add(url);
      }
      for (const url of reviewedGalleryAttachments(observation, this.hostname)) {
        if (this.conflictsWithCitation(url))
          throw new Error(`Gallery attachment conflicts with a required page: ${url}`);
        this.nonDocuments.add(url);
      }
      for (const url of discoverMachineLinks(observation.snapshot.body, this.hostname, observation.snapshot.url)) {
        const exclusion = this.exclusion(url);
        if (exclusion !== null && exclusion.code !== "query") continue;
        this.machineLinks.add(url);
        this.excludedDiscovery(url);
      }
    }
    return this.retainedLinks(observation);
  }

  retainedLinks(observation: Observation): string[] {
    return pageLinks(observation, this.hostname, this.exactHost, this.nonDocuments);
  }

  private exclusion(url: string) {
    return this.scraper.excludeUrl ? this.scraper.excludeUrl(url) : pageUrlPolicy(url, this.hostname);
  }

  add(value: string, linked = false): void {
    const url = this.exactHost ? inventoryUrl(value, this.hostname) : hostUrl(value, this.hostname);
    if (!url || this.excludedDiscovery(url)) return;
    if (this.markdownTargets.has(url)) return;
    const exclusion = this.exclusion(url);
    if (this.advertisedPages.has(url) && exclusion?.code === "ambiguous-path")
      throw new Error("Publisher inventory advertises an ambiguous path");
    if (exclusion?.code === "unsupported-document") return;
    const parsed = new URL(url);
    if (
      this.scraper.adapter.kind === "html" &&
      linked &&
      exclusion?.code === "query" &&
      [...parsed.searchParams.keys()].some((key) => ["page", "paged"].includes(key))
    )
      throw new Error(`Linked pagination requires a declared complete query policy: ${url}`);
    if (
      exclusion !== null &&
      this.scraper.adapter.views?.some(
        (view) => parsed.pathname === view.path && view.values.includes(parsed.searchParams.get(view.parameter) ?? ""),
      )
    )
      throw new Error(`A linked public view requires an explicit complete query policy: ${url}`);
    if (
      exclusion !== null &&
      ((this.cmsPages.has(url) && !(this.exactHost && nonDocumentInventoryUrl(url, this.hostname))) ||
        (this.advertisedPages.has(url) && exclusion?.code === "query"))
    )
      throw new Error(`Required publisher URL lacks a supported discovery policy: ${url} (${exclusion.reason})`);
    if (exclusion !== null || this.queued.has(url)) return;
    this.queued.add(url);
    this.queue.push(url);
  }

  seed(homepage: Observation): void {
    // Register homepage roles before CMS records or the frozen frontier can dispatch them.
    if (this.exactHost) this.observe(homepage);
    this.add(`https://${this.hostname}/`);
    for (const view of this.scraper.adapter.views ?? []) this.add(hostUrl(view.path, this.hostname));
    for (const url of this.initialPages) this.add(url);
  }

  take(): string | undefined {
    while (this.queue.length) {
      const requested = this.queue.shift()!;
      if (!this.excludedDiscovery(requested)) return requested;
    }
    return undefined;
  }

  advertiseView(url: string): void {
    this.advertisedPages.add(url);
    this.add(url);
  }

  isRequiredView(url: string): boolean {
    return this.requiredViews.has(url);
  }

  isRequiredQuery(url: string): boolean {
    return this.requiredQueries.has(url);
  }

  isRequired(url: string): boolean {
    return this.isRequiredView(url) || this.isRequiredQuery(url) || isPdfUrl(url);
  }

  isAdvertised(url: string): boolean {
    return this.advertisedPages.has(url);
  }

  coverage(): { views: readonly string[]; queries: readonly string[] } {
    return { views: [...this.requiredViews], queries: [...this.requiredQueries] };
  }

  markEmitted(sourceUrl: string, observation: Observation, requested: string, physicalAlias: boolean): void {
    for (const identity of [
      sourceUrl,
      hostUrl(observation.snapshot.requested_url, this.hostname),
      ...(physicalAlias ? [requested] : []),
    ]) {
      if (this.machineLinks.has(identity))
        throw new Error(`Machine-link evidence conflicts with emitted text: ${identity}`);
      this.emittedIdentities.add(identity);
    }
  }

  assertEmptyArchive(requested: string, sourceUrl: string, observed: Observation, representative: Observation): void {
    const identities = new Set(
      [
        requested,
        sourceUrl,
        ...[observed, representative].flatMap(({ snapshot }) => [
          snapshot.requested_url,
          snapshot.url,
          ...(snapshot.redirects ?? []).flatMap((hop) => [hop.url, hostUrl(hop.location, this.hostname, hop.url)]),
        ]),
      ].map((url) => hostUrl(url, this.hostname)),
    );
    if (
      [...identities].some(
        (url) =>
          this.conflictsWithCmsEvidence(url) ||
          this.advertisedPages.has(url) ||
          this.viewBases.has(url) ||
          this.emittedIdentities.has(url),
      )
    )
      throw new Error(`Reviewed empty archive conflicts with a required page: ${requested}`);
  }
}
