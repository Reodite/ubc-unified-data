import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPublishableArticle } from "./article-quality.ts";
import { collectRecordedHost } from "./collect.ts";
import type { HostArchive, HostScraper, Observation, ProducerContext } from "./contracts.ts";
import { sha256 } from "./document-format.ts";

const lorem =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Fusce eget lobortis nibh. Phasellus risus mi, interdum eu tristique et, vestibulum vel tellus. Aliquam lectus nisi, lacinia vitae egestas vel, feugiat non tortor. Aenean nec eros eu urna mollis rutrum. Fusce nec lacus vel arcu tempus elementum. Nunc rutrum nibh vel leo tempus at interdum ipsum dignissim. Pellentesque tincidunt, est in bibendum euismod, ante orci interdum lacus, at dictum ante eros vitae massa.";
const construction =
  "**Under Construction** – this page is currently under construction and will be updated soon.\n\nYou must be logged in as an instructor to view this content.";
const escapedConstruction = construction.replace(/[*.]/g, "\\$&");
const firstLoremSentence =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";
const placeholders = [
  "Apologies, but no events were found for the requested venue.",
  "Apologies, but no events were found for the requested category\\.\n",
  "Apologies, but no results were found for the requested archive\\.",
  "You must be logged in as an instructor to view this content\\.",
  firstLoremSentence,
  Array(3)
    .fill(
      `${firstLoremSentence} Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`,
    )
    .join("\n\n"),
  "Lorem ipsum…\n\nLorem ipsum…\n\nLorem ipsum…",
  "  \nLorem Ipsum is simply dummy text of the printing and typesetting industry\\. Lorem Ipsum has been the industry’s standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book\\. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged\\. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum\\.",
  "Apologies, but no results were found",
  "Apologies, but no results were found.",
  "Apologies, but no results were found\\.\n",
  "On this page",
  " \n On\tthis\npage \n",
  "**On this page**\n",
  "_On this page_\n",
  lorem,
  lorem.replaceAll(".", "\\."),
  construction,
  escapedConstruction,
  escapedConstruction.replaceAll(" ", "\t").replaceAll("\n", "\r\n"),
];
const source_url = "https://fixture.ubc.ca/page/";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No network in article-quality tests");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("whole-body article quality", () => {
  it.each(placeholders.map((body, index) => ({ body, index })))(
    "rejects observed placeholder variant $index without rewriting text",
    ({ body }) => {
      const document = Object.freeze({ source_url, content_markdown: body });
      expect(() => assertPublishableArticle(document)).toThrow(/known placeholder/);
      expect(() => assertPublishableArticle(document)).toThrow(source_url);
      expect(document.content_markdown).toBe(body);
    },
  );

  it.each(placeholders.map((body, index) => ({ body, index })))(
    "preserves substantive prose containing placeholder variant $index",
    ({ body }) => {
      for (const content_markdown of [
        `${body}\n\nIf this message appears, contact the service desk for help with your registration.\n`,
        `The following message identifies an unavailable resource:\n\n${body}\n`,
      ]) {
        const document = Object.freeze({ source_url, content_markdown });
        expect(() => assertPublishableArticle(document)).not.toThrow();
        expect(document.content_markdown).toBe(content_markdown);
      }
    },
  );

  it.each([
    "Open.",
    "No results were found for the experiment, so the team revised its methods.",
    "On this page: registration deadlines and procedures.",
    "Lorem ipsum is sample typesetting text.",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
    lorem.replace("Fusce eget lobortis nibh.", "The application deadline is Friday."),
    "Under Construction is the title of this exhibition.",
    `${construction}\n\nThe public course outline is available from the department.`,
  ])("does not impose a minimum length or a substring rule: %s", (content_markdown) => {
    expect(() => assertPublishableArticle({ source_url, content_markdown })).not.toThrow();
  });
});

function collectionFixture(html: string) {
  const hostname = "fixture.ubc.ca";
  const origin = `https://${hostname}`;
  const values = new Map<string, Observation>();
  const put = (url: string, body: string, mediaType: string) => {
    const snapshot = {
      url,
      requested_url: url,
      status: 200,
      headers: { "content-type": mediaType },
      body,
      bytes: Buffer.byteLength(body),
      retrieved_at: "2026-01-02T03:04:05.000Z",
    };
    const observation = { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const homepage = put(`${origin}/`, "<p>Public registration guidance.</p>", "text/html");
  put(`${origin}/robots.txt`, "User-agent: *\nDisallow:\n", "text/plain");
  put(
    `${origin}/sitemap.xml`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${source_url}</loc></url></urlset>`,
    "application/xml",
  );
  put(source_url, html, "text/html");
  const scraper: HostScraper = {
    hostname,
    title: "Fixture registration",
    scope: "Synthetic public articles",
    adapter: { kind: "html", allowedTypes: [], sitemaps: [{ path: "/sitemap.xml" }] },
    vetHomepage: () => ({ accepted: true, reason: "Synthetic homepage" }),
    extract: (snapshot) => ({
      kind: "document",
      input: { url: snapshot.url, title: "Registration", html: snapshot.body, retrievedAt: snapshot.retrieved_at },
    }),
  };
  const archive: HostArchive = {
    hostname,
    input_sha256: sha256("input"),
    homepage,
    urls: [],
    retained: [],
    read: vi.fn(async (url) => {
      const observation = values.get(url);
      if (!observation) throw new Error(`Unrecorded fixture URL: ${url}`);
      return observation;
    }),
    readSnapshot: async () => {
      throw new Error("No retained fixture snapshots");
    },
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  const producer: ProducerContext = {
    inputs_sha256: sha256("producer"),
    runtime: {
      node: process.versions.node,
      icu: process.versions.icu!,
      unicode: process.versions.unicode!,
      platform: process.platform,
      arch: process.arch,
    },
  };
  return { archive, scraper, producer };
}

describe("collection article-quality completion", () => {
  it.each([
    { name: "no results", html: "<p>Apologies, but no results were found.</p>" },
    { name: "navigation only", html: "<p>On this page</p>" },
    { name: "Lorem placeholder", html: `<p>${lorem}</p>` },
    { name: "instructor interstitial", html: `<p>${construction.replace("\n\n", "</p><p>")}</p>` },
  ])("fails the entire host for a required $name body instead of filtering it", async ({ html }) => {
    const { archive, scraper, producer } = collectionFixture(html);
    await expect(collectRecordedHost(scraper, archive, producer)).rejects.toThrow(/known placeholder/);
    expect(archive.read).toHaveBeenCalledWith(source_url);
    expect(archive.assertUnchanged).not.toHaveBeenCalled();
  });

  it("completes with every useful required page and preserves quoted error text", async () => {
    const { archive, scraper, producer } = collectionFixture(
      "<p>Apologies, but no results were found.</p><p>If this message appears, contact the registration service desk.</p>",
    );
    const completed = await collectRecordedHost(scraper, archive, producer);
    expect(completed.complete).toBe(true);
    expect(completed.host.document_count).toBe(2);
    expect(completed.documents).toHaveLength(2);
    expect(completed.documents.find((doc) => doc.source_url === source_url)?.content_markdown).toBe(
      "Apologies, but no results were found\\.\n\nIf this message appears, contact the registration service desk\\.",
    );
    expect(archive.assertUnchanged).toHaveBeenCalledTimes(1);
  });
});
