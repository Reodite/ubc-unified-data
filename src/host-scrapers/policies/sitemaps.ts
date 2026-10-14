import type { Observation } from "../../host-crawl/contracts.ts";
import type { parseSitemap } from "../../host-crawl/sitemap.ts";

const MDRU_CHILDREN = [
  "posts-post",
  "posts-page",
  "posts-location",
  "posts-event",
  "posts-mdru-projects",
  "posts-mdru-publications",
  "posts-mdru-theses",
  "taxonomies-category",
  "taxonomies-post_tag",
  "users",
].map((kind) => `https://www.mdru.ubc.ca/wp-sitemap-${kind}-1.xml`);

function reviewedMdruSitemapKind(hostname: string, url: string, exactHost: boolean): "index" | "pages" | null {
  if (!exactHost || hostname !== "www.mdru.ubc.ca") return null;
  if (url === `https://${hostname}/wp-sitemap.xml`) return "index";
  return MDRU_CHILDREN.includes(url) ? "pages" : null;
}

function reviewedAmsEventsSitemap(hostname: string, url: string, exactHost: boolean): boolean {
  return exactHost && hostname === "www.ams.ubc.ca" && url === `https://${hostname}/tec_recurring_events-sitemap.xml`;
}

export function allowsReviewedSitemapHtmlMime(
  observation: Observation,
  hostname: string,
  url: string,
  exactHost: boolean,
): boolean {
  return (
    reviewedMdruSitemapKind(hostname, url, exactHost) !== null &&
    observation.snapshot.headers["content-type"] === "text/html; charset=UTF-8"
  );
}

export function assertReviewedSitemapIdentity(
  observation: Observation,
  hostname: string,
  url: string,
  exactHost: boolean,
): void {
  if (
    reviewedMdruSitemapKind(hostname, url, exactHost) !== null &&
    (observation.snapshot.requested_url !== url ||
      observation.snapshot.url !== url ||
      !observation.snapshot.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  )
    throw new Error("Reviewed MDRU sitemap identity changed");
}

export function reviewedSitemapBody(
  observation: Observation,
  hostname: string,
  url: string,
  exactHost: boolean,
): string {
  let sitemapBody = observation.snapshot.body;
  if (reviewedAmsEventsSitemap(hostname, url, exactHost)) {
    const marker = '>"\\n"\t<url>';
    if (
      observation.snapshot.requested_url !== url ||
      observation.snapshot.url !== url ||
      observation.snapshot.headers["content-type"] !== "text/xml; charset=UTF-8" ||
      !sitemapBody.startsWith('<?xml version="1.0" encoding="UTF-8"?>') ||
      sitemapBody.indexOf(marker) < 0 ||
      sitemapBody.indexOf(marker) !== sitemapBody.lastIndexOf(marker) ||
      sitemapBody.indexOf(marker) > sitemapBody.indexOf("</urlset>")
    )
      throw new Error("Reviewed AMS sitemap artifact changed");
    sitemapBody = sitemapBody.replace(marker, ">\t<url>");
  }
  return sitemapBody;
}

export function assertReviewedSitemapInventory(
  parsed: ReturnType<typeof parseSitemap>,
  hostname: string,
  url: string,
  exactHost: boolean,
): void {
  if (
    reviewedAmsEventsSitemap(hostname, url, exactHost) &&
    (parsed.kind !== "pages" ||
      parsed.locations.length !== 65 ||
      parsed.locations.some((target) => !target.startsWith(`https://${hostname}/event/`)))
  )
    throw new Error("Reviewed AMS event sitemap changed");
  const mdruKind = reviewedMdruSitemapKind(hostname, url, exactHost);
  if (
    mdruKind === "index" &&
    (parsed.kind !== "index" || JSON.stringify(parsed.locations) !== JSON.stringify(MDRU_CHILDREN))
  )
    throw new Error("Reviewed MDRU sitemap children changed");
  if (mdruKind === "pages" && parsed.kind !== "pages") throw new Error("Reviewed MDRU sitemap child changed");
}

export function reviewedUserArchiveSitemap(
  observation: Observation,
  parsed: ReturnType<typeof parseSitemap>,
  hostname: string,
  url: string,
  exactHost: boolean,
): boolean {
  const reviewedUsers =
    exactHost && hostname === "sportfacilities.ubc.ca" && url === `https://${hostname}/wp-sitemap-users-1.xml`;
  const reviewedUserTargets = [`https://${hostname}/author/agmiu/`, `https://${hostname}/author/webadmin/`];
  if (
    reviewedUsers &&
    (parsed.kind !== "pages" ||
      observation.snapshot.requested_url !== url ||
      observation.snapshot.url !== url ||
      parsed.locations.length !== 2 ||
      !reviewedUserTargets.every((target) => parsed.locations.includes(target)))
  )
    throw new Error("Reviewed users sitemap changed");
  return reviewedUsers;
}

export function reviewedSitemapAttachment(
  sitemap: string,
  target: string,
  hostname: string,
): "query" | "permalink" | null {
  if (!/(?:^|\/)attachment-sitemap(?:\d+)?\.xml$/i.test(new URL(sitemap).pathname)) return null;
  const url = new URL(target);
  if (url.searchParams.size === 1 && /^\d+$/.test(url.searchParams.get("attachment_id") ?? "")) return "query";
  return hostname === "moa.ubc.ca" && !url.search && !url.hash && url.pathname !== "/" && url.pathname.endsWith("/")
    ? "permalink"
    : null;
}
