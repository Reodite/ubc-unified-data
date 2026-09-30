import { publicUbcUrl } from "../prose/client.ts";
import type { RequiredDocumentQuery, Snapshot } from "./contracts.ts";
import { hostUrl, normalizeHost } from "./urls.ts";

const CCLI_QUERY: RequiredDocumentQuery = Object.freeze({
  hostname: "ccli.ubc.ca",
  url: "https://ccli.ubc.ca/?post_type=team-member&p=3962",
  sitemap: "https://ccli.ubc.ca/team-member-sitemap.xml",
});
const CCLI_QUERIES = Object.freeze([CCLI_QUERY]);
const NO_QUERIES: readonly RequiredDocumentQuery[] = Object.freeze([]);

/** Return the immutable namespace policy; CMS membership cannot add or remove identities. */
export function requiredDocumentQueries(hostname: string): readonly RequiredDocumentQuery[] {
  return hostname === CCLI_QUERY.hostname ? CCLI_QUERIES : NO_QUERIES;
}

/** Reject undeclared identities and declarations copied across hostname boundaries. */
export function validateRequiredDocumentQueries(
  hostname: string,
  declarations: readonly RequiredDocumentQuery[] = NO_QUERIES,
): readonly RequiredDocumentQuery[] {
  const policy = requiredDocumentQueries(hostname);
  if (normalizeHost(hostname) !== hostname || declarations.length > policy.length)
    throw new Error("Invalid required query namespace declaration");
  for (const declaration of declarations) {
    if (
      declaration.hostname !== hostname ||
      publicUbcUrl(hostUrl(declaration.url, hostname)) !== declaration.url ||
      !new URL(declaration.url).search ||
      publicUbcUrl(hostUrl(declaration.sitemap, hostname)) !== declaration.sitemap ||
      new URL(declaration.sitemap).search ||
      !policy.some((entry) => entry.url === declaration.url && entry.sitemap === declaration.sitemap)
    )
      throw new Error("Invalid required query namespace declaration");
  }
  return declarations.length ? policy : NO_QUERIES;
}

/** Every observed identity touching a required selection must retain that exact selection. */
export function assertRequiredQueryIdentity(
  hostname: string,
  declarations: readonly RequiredDocumentQuery[],
  requested: string,
  snapshot: Snapshot,
): void {
  const identities = [
    requested,
    snapshot.requested_url,
    snapshot.url,
    ...(snapshot.redirects ?? []).flatMap((hop) => [hop.url, new URL(hop.location, hop.url).href]),
  ];
  for (const declaration of validateRequiredDocumentQueries(hostname, declarations)) {
    if (identities.includes(declaration.url) && identities.some((url) => url !== declaration.url))
      throw new Error(`Required query response lost its selected identity: ${declaration.url}`);
  }
}
