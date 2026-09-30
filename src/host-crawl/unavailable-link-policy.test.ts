import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Observation, Snapshot } from "./contracts.ts";
import { discoverReviewedUnavailableLinks, type ReviewedUnavailableLink } from "./unavailable-link-policy.ts";

const hostname = "example.ubc.ca";
const sourceUrl = `https://${hostname}/event`;
const targetUrl = `https://${hostname}/profiles/speaker`;
const observation = (body: string): Observation => {
  const snapshot: Snapshot = {
    requested_url: sourceUrl,
    url: sourceUrl,
    status: 200,
    headers: { "content-type": "text/html" },
    body,
    retrieved_at: "2026-01-01T00:00:00.000Z",
    bytes: Buffer.byteLength(body),
  };
  return {
    snapshot,
    sha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  };
};
const declaration = (item: Observation): ReviewedUnavailableLink => ({
  hostname,
  sourceUrl,
  sourceSnapshotSha256: item.sha256,
  targetUrl,
  anchorText: targetUrl,
  labelText: "Speaker Link:",
  labelClass: "label-inline",
});

describe("reviewed unavailable article links", () => {
  it("requires the exact source snapshot, target, label and structural context", () => {
    const item = observation(
      `<div class="label-inline">Speaker Link:</div><a href="/profiles/speaker">${targetUrl}</a>`,
    );
    const policy = declaration(item);
    expect(discoverReviewedUnavailableLinks(item, hostname, [policy])).toEqual([targetUrl]);
    const changed = observation(`${item.snapshot.body}<p>Changed source.</p>`);
    expect(discoverReviewedUnavailableLinks(changed, hostname, [policy])).toEqual([]);
    for (const body of [
      `<div>Speaker Link:</div><a href="/profiles/speaker">${targetUrl}</a>`,
      `<div class="label-inline">Speaker Link:</div><a href="/profiles/other">${targetUrl}</a>`,
      `<div class="label-inline">Speaker Link:</div><a href="/profiles/speaker">Speaker profile</a>`,
    ]) {
      const negative = observation(body);
      expect(discoverReviewedUnavailableLinks(negative, hostname, [policy])).toEqual([]);
    }
  });

  it("rejects ambiguous matching citations within a reviewed snapshot", () => {
    const item = observation(
      `<div class="label-inline">Speaker Link:</div><a href="/profiles/speaker">${targetUrl}</a><div class="label-inline">Speaker Link:</div><a href="/profiles/speaker">${targetUrl}</a>`,
    );
    expect(() => discoverReviewedUnavailableLinks(item, hostname, [declaration(item)])).toThrow(/ambiguous/);
  });
});
