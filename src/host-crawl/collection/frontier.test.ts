import { describe, expect, it, vi } from "vitest";
import { collectRecordedHost } from "../collect.ts";
import type { HostArchive, Observation, ProducerContext } from "../contracts.ts";
import { sha256 } from "../document-format.ts";
import { createGenericScraper } from "../generic.ts";

const producer: ProducerContext = {
  inputs_sha256: sha256("frontier producer"),
  runtime: { node: "26", icu: "78", unicode: "17", platform: "linux", arch: "x64" },
};
const html = (body = "", head = "") =>
  `<html><head><title>Public guide</title>${head}</head><body><main><p>Public programme eligibility and application guidance.</p>${body}</main></body></html>`;
const link = (path: string) => `<a href="${path}">Public guide</a>`;
const feed = (path: string) => `<link rel="alternate" type="application/atom+xml" href="${path}">`;
const gallery = (path: string) =>
  `<dt class="gallery-icon"><a href="${path}"><img class="attachment-medium" src="/files/photo.jpg"></a></dt>`;

function fixture(body = html(), hostname = "fixture.ubc.ca") {
  const home = `https://${hostname}/`;
  const values = new Map<string, Observation>();
  const put = (path: string, body = html()) => {
    const url = new URL(path, home).href;
    const snapshot: Observation["snapshot"] = {
      requested_url: url,
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      bytes: Buffer.byteLength(body),
      retrieved_at: "2026-01-01T00:00:00Z",
    };
    const observation = { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
    values.set(url, observation);
    return observation;
  };
  const homepage = put("/", body);
  put("/robots.txt", "User-agent: *\n");
  const archive: HostArchive = {
    hostname,
    homepage,
    input_sha256: sha256("frontier input"),
    urls: [],
    retained: [],
    read: vi.fn(async (url) => {
      const observation = values.get(url);
      if (!observation) throw new Error(`Missing fixture ${url}`);
      return observation;
    }),
    readDocument: vi.fn(async (url) => archive.read(url)),
    readSnapshot: async () => {
      throw new Error("No retained fixture");
    },
    assertUnchanged: vi.fn(async () => {}),
    close() {},
  };
  const seed = (...paths: string[]) => {
    archive.urls = paths.map((path) => ({
      url: new URL(path, home).href,
      kind: "page",
      state: "pending",
      disposition: null,
      reason: null,
      snapshot: null,
      article_id: null,
      source_modified_at: null,
    }));
  };
  const scraper = createGenericScraper(hostname);
  return { home, put, seed, archive, scraper, collect: () => collectRecordedHost(scraper, archive, producer) };
}

describe("collection frontier role ordering", () => {
  it("keeps view bases, sorted seeds and FIFO links ordered while cancelling a later witnessed machine action", async () => {
    const f = fixture(html(link("/linked-first") + link("/linked-second")));
    f.scraper.adapter.views = [{ path: "/faq", parameter: "page_id", values: ["7"], placeholder: "0" }];
    const form =
      '<form method="get" action="/faq"><select name="page_id"><option value="0">Select</option><option value="7">Guide</option></select></form>';
    f.put("/faq", html(form));
    f.put("/faq?page_id=7", html(form));
    f.seed("/z-feed.atom", "/b-source", "/a-seed");
    f.put("/a-seed", html(link("/linked-second") + link("/last")));
    f.put("/b-source", html(link("/z-feed.atom"), feed("/z-feed.atom")));
    for (const path of ["/linked-first", "/linked-second", "/last"]) f.put(path);
    const result = await f.collect();
    expect(vi.mocked(f.archive.readDocument!).mock.calls.map(([url]) => url)).toEqual(
      ["/", "/faq", "/a-seed", "/b-source", "/linked-first", "/linked-second", "/faq?page_id=7", "/last"].map(
        (path) => new URL(path, f.home).href,
      ),
    );
    expect(result.documents).toHaveLength(8);
    expect(f.archive.assertUnchanged).toHaveBeenCalledOnce();
  });

  it("does not let machine evidence erase a frozen gallery identity on the same page", async () => {
    const target = "/photo.atom";
    const f = fixture(html(gallery(target), feed(target)), "rbsc.library.ubc.ca");
    f.seed(target);
    await expect(f.collect()).rejects.toThrow(`Gallery attachment conflicts with a required page: ${f.home}photo.atom`);
    expect(f.archive.read).toHaveBeenCalledExactlyOnceWith(`${f.home}robots.txt`);
    expect(f.archive.readDocument).not.toHaveBeenCalled();
  });

  it.each(["url", "requested_url"] as const)(
    "rejects an emitted alias into an already witnessed machine %s identity",
    async (identity) => {
      const f = fixture(html(link("/alias") + link("/later"), feed("/status.atom")));
      const alias = f.put("/alias");
      alias.snapshot[identity] = `${f.home}status.atom`;
      f.put("/later");
      await expect(f.collect()).rejects.toThrow(
        `Machine-link evidence conflicts with emitted text: ${f.home}status.atom`,
      );
      expect(f.archive.readDocument).toHaveBeenCalledWith(`${f.home}alias`);
      expect(f.archive.readDocument).not.toHaveBeenCalledWith(`${f.home}later`);
      expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
    },
  );

  it("rejects late gallery evidence for an emitted redirect destination absent from every inventory", async () => {
    const f = fixture(html(link("/alias") + link("/gallery")), "rbsc.library.ubc.ca");
    const alias = f.put("/alias");
    alias.snapshot.url = `${f.home}photo`;
    f.put("/gallery", html(gallery("/photo")));
    await expect(f.collect()).rejects.toThrow(`Gallery attachment conflicts with a required page: ${f.home}photo`);
    expect(vi.mocked(f.archive.readDocument!).mock.calls.map(([url]) => url)).toEqual([
      f.home,
      `${f.home}alias`,
      `${f.home}gallery`,
    ]);
    expect(f.archive.assertUnchanged).not.toHaveBeenCalled();
  });
});
