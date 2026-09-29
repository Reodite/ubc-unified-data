import { describe, expect, it } from "vitest";
import type { Observation } from "../contracts.ts";
import { wordpressRecordInput } from "./wordpress-content.ts";

const hostname = "example.ubc.ca";
const expected = {
  id: 7,
  type: "page",
  url: `https://${hostname}/guide/`,
  api_url: `https://${hostname}/wp-json/wp/v2/pages/7`,
  modified: "2026-01-02T03:04:05Z",
};
function fixture() {
  const row = {
    id: 7,
    type: "page",
    status: "publish",
    link: expected.url,
    modified_gmt: "2026-01-02T03:04:05",
    title: { rendered: "Requirements &amp; exceptions" },
    content: { rendered: "<p>Complete the listed prerequisites before entry.</p>", protected: false },
  };
  const observation: Observation = {
    sha256: "a".repeat(64),
    snapshot: {
      url: expected.api_url,
      requested_url: expected.api_url,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row),
      retrieved_at: "2026-01-03T00:00:00Z",
      bytes: 1,
    },
  };
  return { row, observation };
}
describe("independently published WordPress API text", () => {
  it("retains actual API provenance and identifies the unavailable publisher page", () => {
    const f = fixture(),
      result = wordpressRecordInput(f.observation, expected, hostname);
    expect(result.url).toBe(expected.api_url);
    expect(result.retrievedAt).toBe(f.observation.snapshot.retrieved_at);
    expect(result.html).toBe(f.row.content.rendered);
    expect(result.title).toBe("Requirements & exceptions");
    expect(result.warnings).toEqual([expect.stringContaining(expected.url)]);
  });
  it.each(["id", "type", "status", "link", "protected", "modified", "empty", "shortcode"])(
    "rejects unavailable or inconsistent %s input",
    (kind) => {
      const f = fixture();
      if (kind === "id") f.row.id = 8;
      if (kind === "type") f.row.type = "post";
      if (kind === "status") f.row.status = "private";
      if (kind === "link") f.row.link = `https://${hostname}/different/`;
      if (kind === "protected") f.row.content.protected = true;
      if (kind === "modified") f.row.modified_gmt = "2026-01-02T03:04:06";
      if (kind === "empty") f.row.content.rendered = "";
      if (kind === "shortcode") f.row.content.rendered = "[accordion]Required content[/accordion]";
      f.observation.snapshot.body = JSON.stringify(f.row);
      expect(() => wordpressRecordInput(f.observation, expected, hostname)).toThrow();
    },
  );
  it.each(['[gallery ids="7,8"]', '[unknown-widget id="7"]', "<p>Read the requirements.</p>[custom_shortcode]"])(
    "rejects unresolved API bracket commands: %s",
    (html) => {
      const f = fixture();
      f.row.content.rendered = html;
      f.observation.snapshot.body = JSON.stringify(f.row);
      expect(() => wordpressRecordInput(f.observation, expected, hostname)).toThrow(
        /requires unavailable rendered HTML/,
      );
    },
  );

  it.each([401, 403, 404, 500])("never substitutes a failed HTTP %s API response", (status) => {
    const f = fixture();
    f.observation.snapshot.status = status;
    expect(() => wordpressRecordInput(f.observation, expected, hostname)).toThrow();
  });
});
