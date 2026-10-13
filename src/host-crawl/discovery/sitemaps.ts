import {
  allowsReviewedSitemapHtmlMime,
  assertReviewedSitemapIdentity,
  assertReviewedSitemapInventory,
  reviewedSitemapAttachment,
  reviewedSitemapBody,
  reviewedUserArchiveSitemap,
} from "../../host-scrapers/policies/sitemaps.ts";
import type { HostScraper, Observation } from "../contracts.ts";
import { parseSitemap } from "../sitemap.ts";
import { hostUrl, inventoryUrl } from "../urls.ts";

export async function sitemapPages(
  starts: readonly string[],
  hostname: string,
  read: (url: string) => Promise<Observation>,
  policies: NonNullable<HostScraper["adapter"]["sitemaps"]> = [],
  exactHost = false,
): Promise<{
  pages: string[];
  nonDocuments: Set<string>;
  attachmentPages: Set<string>;
  userArchivePages: Set<string>;
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
  const userArchivePages = new Set<string>();
  const pages = new Set<string>();
  const advertisingSitemaps = new Map<string, Set<string>>();
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
    if (
      observation.snapshot.status !== 200 ||
      (!/xml/i.test(observation.snapshot.headers["content-type"] ?? "") &&
        !allowsReviewedSitemapHtmlMime(observation, hostname, url, exactHost))
    )
      throw new Error("An advertised sitemap lacks a complete XML observation");
    assertReviewedSitemapIdentity(observation, hostname, url, exactHost);
    const parsed = parseSitemap(reviewedSitemapBody(observation, hostname, url, exactHost));
    assertReviewedSitemapInventory(parsed, hostname, url, exactHost);
    const reviewedUsers = reviewedUserArchiveSitemap(observation, parsed, hostname, url, exactHost);
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
        if (reviewedUsers && location === target) {
          nonDocuments.add(target);
          userArchivePages.add(target);
        } else {
          const attachment =
            exactHost && location === target && observation.snapshot.requested_url === url
              ? reviewedSitemapAttachment(url, target, hostname)
              : null;
          if (attachment !== null) {
            nonDocuments.add(target);
            if (attachment === "permalink") attachmentPages.add(target);
          } else pages.add(target);
        }
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
  if ([...userArchivePages].some((url) => pages.has(url)))
    throw new Error("User archive conflicts with a required page");
  return {
    pages: [...pages].filter((url) => !nonDocuments.has(url)).sort(),
    nonDocuments,
    attachmentPages,
    userArchivePages,
    advertisingSitemaps,
  };
}
