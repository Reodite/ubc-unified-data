import { describe, expect, it } from "vitest";
import { discoverMachineLinks } from "./machine-links.ts";

const host = "fixture.ubc.ca";
const source = `https://${host}/index.php/journal/about`;
const generator = '<meta name="generator" content="Open Journal Systems 3.3.0.21">';
const path = (plugin: string, format: string) => `/index.php/journal/gateway/plugin/${plugin}/${format}`;
const link = (href: string, mime: string) => `<link rel="alternate" type="${mime}" href="${href}">`;
const html = (head: string, body = "<p>Journal submission guidance.</p>") =>
  `<html><head><title>Journal</title>${head}</head><body>${body}</body></html>`;
const formats = [
  ["atom", "application/atom+xml"],
  ["rss", "application/rdf+xml"],
  ["rss2", "application/rss+xml"],
] as const;

describe("observed OJS feed controls", () => {
  it.each(["AnnouncementFeedGatewayPlugin", "WebFeedGatewayPlugin"])(
    "recognizes typed %s feeds advertised by the same journal",
    (plugin) => {
      const body = html(generator + formats.map(([format, mime]) => link(path(plugin, format), mime)).join(""));
      expect([...discoverMachineLinks(body, host, source)].sort()).toEqual(
        formats.map(([format]) => `https://${host}${path(plugin, format)}`).sort(),
      );
    },
  );

  it.each([
    ["missing generator", "", path("AnnouncementFeedGatewayPlugin", "atom"), "application/atom+xml"],
    [
      "wrong generator",
      generator.replace("Open Journal Systems", "Unrelated CMS"),
      path("AnnouncementFeedGatewayPlugin", "atom"),
      "application/atom+xml",
    ],
    ["MIME mismatch", generator, path("AnnouncementFeedGatewayPlugin", "rss2"), "application/atom+xml"],
    ["unrelated plugin", generator, path("ArticleGatewayPlugin", "atom"), "application/atom+xml"],
    [
      "different journal",
      generator,
      path("AnnouncementFeedGatewayPlugin", "atom").replace("/journal/", "/other/"),
      "application/atom+xml",
    ],
    [
      "different host",
      generator,
      `https://other.ubc.ca${path("AnnouncementFeedGatewayPlugin", "atom")}`,
      "application/atom+xml",
    ],
    [
      "query variant",
      generator,
      `${path("AnnouncementFeedGatewayPlugin", "atom")}?format=html`,
      "application/atom+xml",
    ],
    ["fragment variant", generator, `${path("AnnouncementFeedGatewayPlugin", "atom")}#details`, "application/atom+xml"],
    ["extra path", generator, `${path("AnnouncementFeedGatewayPlugin", "atom")}/guide`, "application/atom+xml"],
    ["resource vocabulary", generator, "/guidance/AnnouncementFeedGatewayPlugin/atom", "application/atom+xml"],
  ])("keeps %s eligible", (_, meta, target, mime) => {
    expect([...discoverMachineLinks(html(meta + link(target, mime)), host, source)]).toEqual([]);
  });

  it("requires a physical source within the journal rather than an HTML base", () => {
    const target = path("AnnouncementFeedGatewayPlugin", "atom");
    const body = html(`<base href="${source}">${generator}${link(target, "application/atom+xml")}`);
    expect([...discoverMachineLinks(body, host, `https://${host}/`)]).toEqual([]);
  });

  it.each(["body generator", "body link", "template", "noscript", "unclosed head"])(
    "does not use %s as original head evidence",
    (placement) => {
      const feed = link(path("AnnouncementFeedGatewayPlugin", "atom"), "application/atom+xml");
      const body =
        placement === "body generator"
          ? html(feed, generator)
          : placement === "body link"
            ? html(generator, feed)
            : placement === "unclosed head"
              ? `<html><head>${generator}${feed}<body><p>Journal.</p></body></html>`
              : html(`<${placement}>${generator}${feed}</${placement}>`);
      expect([...discoverMachineLinks(body, host, source)]).toEqual([]);
    },
  );
});
