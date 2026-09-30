import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Observation, Snapshot } from "./contracts.ts";
import { discoverReviewedMslUnavailableLinks, type MslCitationWitness } from "./msl-unavailable-citations.ts";

const hostname = "www.msl.ubc.ca";
const sourceUrl = `https://${hostname}/story/`;
const targetUrl = `https://${hostname}/people/dr-cara-haney/`;
const observation = (body: string, url = sourceUrl): Observation => {
  const snapshot: Snapshot = {
    requested_url: url,
    url,
    status: 200,
    headers: { "content-type": "text/html" },
    body,
    retrieved_at: "2026-01-01T00:00:00.000Z",
    bytes: Buffer.byteLength(body),
  };
  return { snapshot, sha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
};
const evidence = (item: Observation, slug = "dr-cara-haney"): readonly MslCitationWitness[] => [
  ["/story/", item.sha256, [slug]],
];

describe("reviewed MSL unavailable profile citations", () => {
  it("requires an exact source snapshot, source, named person, target and paragraph context", () => {
    const item = observation(`<p>Research directed by <a href="${targetUrl}">Dr. Cara Haney</a>.</p>`);
    const witnesses = evidence(item);
    expect(discoverReviewedMslUnavailableLinks(item, hostname, witnesses)).toEqual([targetUrl]);
    expect(
      discoverReviewedMslUnavailableLinks(observation(`${item.snapshot.body}<p>Changed.</p>`), hostname, witnesses),
    ).toEqual([]);
    expect(discoverReviewedMslUnavailableLinks(item, "other.ubc.ca", witnesses)).toEqual([]);
    expect(
      discoverReviewedMslUnavailableLinks(
        observation(item.snapshot.body, `https://${hostname}/other/`),
        hostname,
        witnesses,
      ),
    ).toEqual([]);
    const changed = structuredClone(item);
    changed.snapshot.requested_url = `https://${hostname}/redirect/`;
    expect(discoverReviewedMslUnavailableLinks(changed, hostname, witnesses)).toEqual([]);
  });

  it.each([
    `<p>Research directed by <a href="https://${hostname}/people/other/">Dr. Cara Haney</a>.</p>`,
    `<p>Research directed by <a href="${targetUrl}">Other researcher</a>.</p>`,
    `<div><a href="${targetUrl}">Dr. Cara Haney</a></div>`,
  ])("refuses changed target, label or structural context", (body) => {
    const item = observation(body);
    expect(() => discoverReviewedMslUnavailableLinks(item, hostname, evidence(item))).toThrow(
      /citation (?:is missing|label changed|context changed)/,
    );
  });

  it("rejects unknown person IDs and unreviewed empty anchors", () => {
    const empty = observation(
      `<p><a href="${targetUrl}"><img src="https://${hostname}/wp-content/uploads/photo.jpg"></a></p>`,
    );
    expect(() => discoverReviewedMslUnavailableLinks(empty, hostname, evidence(empty))).toThrow(/context changed/);
    const other = observation(`<p><a href="https://${hostname}/people/unknown/">Unknown</a></p>`);
    expect(() => discoverReviewedMslUnavailableLinks(other, hostname, evidence(other, "unknown"))).toThrow(/Unknown/);
  });

  it("accepts only the reviewed Stephen Withers associate photo", () => {
    const source = `https://${hostname}/people/associate-members/`;
    const target = `https://${hostname}/people/dr-stephen-withers/`;
    const body = `<p><a href="${target}"><img class="wp-image-10531" src="https://${hostname}/wp-content/uploads/2018/10/Stephen_Withers-head-shot_crop.jpg"></a></p>`;
    const item = observation(body, source);
    const witnesses: readonly MslCitationWitness[] = [
      ["/people/associate-members/", item.sha256, ["dr-stephen-withers"]],
    ];
    expect(discoverReviewedMslUnavailableLinks(item, hostname, witnesses)).toEqual([target]);
    const changed = observation(body.replace("wp-image-10531", "wp-image-2"), source);
    const changedWitness: readonly MslCitationWitness[] = [
      ["/people/associate-members/", changed.sha256, ["dr-stephen-withers"]],
    ];
    expect(() => discoverReviewedMslUnavailableLinks(changed, hostname, changedWitness)).toThrow(/context changed/);
  });
});
