import { needsRenderedHtml } from "../../prose/html.ts";
import type { ArticleInput } from "../../prose/model.ts";
import { plainText } from "../../source-documents.ts";
import type { Observation } from "../contracts.ts";
import { hostUrl } from "../urls.ts";
import type { DiscoveredPage } from "./wordpress-discovery.ts";

/** Read independently published API text without claiming that the publisher's HTML page was retrieved. */
export function wordpressRecordInput(
  observation: Observation,
  expected: DiscoveredPage,
  hostname: string,
): ArticleInput {
  const snapshot = observation.snapshot;
  if (
    snapshot.status !== 200 ||
    !/json/i.test(snapshot.headers["content-type"] ?? "") ||
    hostUrl(snapshot.url, hostname) !== expected.api_url ||
    hostUrl(snapshot.requested_url, hostname) !== expected.api_url
  )
    throw new Error("Public WordPress item observation is unavailable or redirected");
  const row = JSON.parse(snapshot.body);
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    row.id !== expected.id ||
    row.type !== expected.type ||
    row.status !== "publish" ||
    typeof row.link !== "string" ||
    hostUrl(row.link, hostname) !== expected.url ||
    row.content?.protected !== false ||
    typeof row.content?.rendered !== "string" ||
    typeof row.title?.rendered !== "string"
  )
    throw new Error("Public WordPress item disagrees with the advertised record");
  const modified = row.modified_gmt == null || row.modified_gmt === "" ? null : `${row.modified_gmt}Z`;
  if (modified !== expected.modified) throw new Error("WordPress item changed after inventory discovery");
  if (
    needsRenderedHtml(row.content.rendered) ||
    /\[\/?[A-Za-z][\w:-]*(?:\s+[^\]]*|\s*\/)?\]/.test(plainText(row.content.rendered))
  )
    throw new Error("WordPress API text requires unavailable rendered HTML");
  const title = plainText(row.title.rendered);
  if (!title) throw new Error("WordPress item lacks a title");
  return {
    url: snapshot.url,
    title,
    html: row.content.rendered,
    retrievedAt: snapshot.retrieved_at,
    sourceModifiedAt: modified,
    upstreamId: String(expected.id),
    warnings: [
      `Text is from the independently public WordPress REST record; the publisher HTML page was unavailable: ${expected.url}`,
    ],
  };
}
