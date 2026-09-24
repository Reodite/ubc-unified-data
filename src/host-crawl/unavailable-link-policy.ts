import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { Observation } from "./contracts.ts";
import { hostUrl, normalizeHost } from "./urls.ts";

export interface ReviewedUnavailableLink {
  hostname: string;
  sourceUrl: string;
  sourceSnapshotSha256: string;
  targetUrl: string;
  linkText: string;
  containerClass: string;
}

const reviewedUnavailableLinks: readonly ReviewedUnavailableLink[] = [
  {
    hostname: "www.math.ubc.ca",
    sourceUrl: "https://www.math.ubc.ca/events/apr-29-2025-organization-plant-cortical-microtubules",
    sourceSnapshotSha256: "5e6c436e53fc8db6a2b625e15eb1c7741ccecef0da9db79b22ee8c5df0bbaaf6",
    targetUrl: "https://www.math.ubc.ca/profiles/tim-tian",
    linkText: "Speaker Link",
    containerClass: "field-name-field-speaker-link",
  },
];

const snapshotDigest = (observation: Observation) =>
  createHash("sha256").update(JSON.stringify(observation.snapshot)).digest("hex");
const text = (value: string) => value.replace(/\s+/g, " ").trim();

/** Return only unavailable citations backed by the exact reviewed source observation and link context. */
export function discoverReviewedUnavailableLinks(
  observation: Observation,
  value: string,
  declarations: readonly ReviewedUnavailableLink[] = reviewedUnavailableLinks,
): string[] {
  const hostname = normalizeHost(value);
  const sourceUrl = hostUrl(observation.snapshot.url, hostname);
  const digest = snapshotDigest(observation);
  const $ = load(observation.snapshot.body);
  const targets = new Set<string>();
  for (const declaration of declarations) {
    if (
      declaration.hostname !== hostname ||
      declaration.sourceUrl !== sourceUrl ||
      declaration.sourceSnapshotSha256 !== digest
    )
      continue;
    const targetUrl = hostUrl(declaration.targetUrl, hostname);
    const matches = $(`.${declaration.containerClass} a[href]`)
      .toArray()
      .filter((node) => {
        try {
          return (
            hostUrl($(node).attr("href")!, hostname, sourceUrl) === targetUrl &&
            text($(node).text()) === declaration.linkText
          );
        } catch {
          return false;
        }
      });
    if (matches.length !== 1) throw new Error("Reviewed unavailable citation evidence is ambiguous");
    targets.add(targetUrl);
  }
  return [...targets].sort();
}
