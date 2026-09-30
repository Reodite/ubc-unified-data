import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { Observation } from "./contracts.ts";
import { hostUrl, normalizeHost } from "./urls.ts";

export interface ReviewedUnavailableLink {
  hostname: string;
  sourceUrl: string;
  sourceSnapshotSha256: string;
  targetUrl: string;
  anchorText: string;
  labelText: string;
  labelClass: string;
}

const reviewedUnavailableLinks: readonly ReviewedUnavailableLink[] = [
  {
    hostname: "www.math.ubc.ca",
    sourceUrl: "https://www.math.ubc.ca/events/apr-29-2025-organization-plant-cortical-microtubules",
    sourceSnapshotSha256: "5e6c436e53fc8db6a2b625e15eb1c7741ccecef0da9db79b22ee8c5df0bbaaf6",
    targetUrl: "https://www.math.ubc.ca/profiles/tim-tian",
    anchorText: "https://www.math.ubc.ca/profiles/tim-tian",
    labelText: "Speaker Link:",
    labelClass: "label-inline",
  },
  {
    hostname: "www.math.ubc.ca",
    sourceUrl: "https://www.math.ubc.ca/events/sep-17-2023-local-global-principle-higher-moments-natural-density",
    sourceSnapshotSha256: "801ef23b91ebcdf0b840e44925742924eb3561bee40ddf67147e089e85000f77",
    targetUrl: "https://www.math.ubc.ca/profiles/severin-schraven",
    anchorText: "https://www.math.ubc.ca/profiles/severin-schraven",
    labelText: "Speaker Link:",
    labelClass: "label-inline",
  },
  {
    hostname: "www.math.ubc.ca",
    sourceUrl: "https://www.math.ubc.ca/topic/number-theory?page=49",
    sourceSnapshotSha256: "c409edb003c79961dc59c3c2b4acee1dd02c4a5da77c971ea5ff57a9d72bffdf",
    targetUrl: "https://www.math.ubc.ca/profiles/severin-schraven",
    anchorText: "https://www.math.ubc.ca/profiles/severin-schraven",
    labelText: "Speaker Link:",
    labelClass: "label-inline",
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
    const matches = $("a[href]")
      .toArray()
      .filter((node) => {
        try {
          const anchor = $(node);
          const label = anchor.prev();
          return (
            hostUrl(anchor.attr("href")!, hostname, sourceUrl) === targetUrl &&
            text(anchor.text()) === declaration.anchorText &&
            label.hasClass(declaration.labelClass) &&
            text(label.text()) === declaration.labelText
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
