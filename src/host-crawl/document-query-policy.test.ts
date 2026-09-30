import { describe, expect, it } from "vitest";
import type { CompletedHost, RequiredDocumentQuery, Snapshot } from "./contracts.ts";
import { sha256 } from "./document-format.ts";
import {
  assertRequiredQueryIdentity,
  requiredDocumentQueries,
  validateRequiredDocumentQueries,
} from "./document-query-policy.ts";
import { cheapGuardCompletedHost, createGenericScraper } from "./generic.ts";

const host = "ccli.ubc.ca";
const home = `https://${host}/`;
const query = `${home}?post_type=team-member&p=3962`;
const declared: RequiredDocumentQuery = { hostname: host, url: query, sitemap: `${home}team-member-sitemap.xml` };
const snapshot = (): Snapshot => ({
  requested_url: query,
  url: query,
  status: 200,
  headers: { "content-type": "text/html" },
  body: "<title>Guide</title><main><p>Public guidance.</p></main>",
  bytes: 68,
  retrieved_at: "2026-01-01T00:00:00Z",
});

function completed(url = query): CompletedHost {
  const title = "Guide";
  const body = "Public guidance.";
  const hash = sha256("synthetic evidence");
  return {
    complete: true,
    host: {
      hostname: host,
      title: host,
      scope: "Public guidance",
      homepage_url: home,
      homepage_retrieved_at: "2026-01-01T00:00:00Z",
      homepage_sha256: hash,
      document_root: `data/documents/${host}`,
      document_count: 1,
    },
    documents: [
      {
        id: `documents:official-web:${sha256(url).slice(0, 24)}`,
        hostname: host,
        title,
        source_url: url,
        retrieved_at: "2026-01-01T00:00:00Z",
        source_modified_at: null,
        snapshot_sha256: hash,
        input_sha256: hash,
        body_sha256: sha256(body),
        content_sha256: sha256(`${title}\n${body}`),
        content_markdown: body,
        warnings: [],
        alternate_urls: [],
        producer: {
          inputs_sha256: hash,
          runtime: { node: "26.0.0", icu: "78.1", unicode: "17.0", platform: "linux", arch: "x64" },
        },
      },
    ],
  };
}

describe("immutable required document query declarations", () => {
  it("returns one shared frozen policy only for the exact namespace", () => {
    const policy = requiredDocumentQueries(host);
    expect(policy).toEqual([declared]);
    expect(policy).toBe(requiredDocumentQueries(host));
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy[0])).toBe(true);
    expect(createGenericScraper(host).adapter.requiredQueries).toBe(policy);
    expect(() => {
      (policy as RequiredDocumentQuery[]).push(declared);
    }).toThrow();
    expect(() => {
      Object.assign(policy[0]!, { hostname: "other.ubc.ca" });
    }).toThrow();
    for (const namespace of ["other.ubc.ca", "CCLI.UBC.CA", "ccli.ubc.ca."])
      expect(requiredDocumentQueries(namespace)).toEqual([]);
    expect(validateRequiredDocumentQueries(host, [declared])).toBe(policy);
  });
  it("rejects copying the unchanged policy to another namespace", () => {
    expect(() => validateRequiredDocumentQueries("other.ubc.ca", [declared])).toThrow();
  });
  it("rejects copying and rebinding all fields to another namespace", () => {
    expect(() =>
      validateRequiredDocumentQueries("other.ubc.ca", [
        {
          hostname: "other.ubc.ca",
          url: query.replace(host, "other.ubc.ca"),
          sitemap: declared.sitemap.replace(host, "other.ubc.ca"),
        },
      ]),
    ).toThrow();
  });
  it.each([
    { hostname: "other.ubc.ca" },
    { url: home },
    { url: `${query}&` },
    { url: `${query}#fragment` },
    { url: query.replace("3962", "3963") },
    { url: query.replace("post_type=team-member&p=3962", "p=3962&post_type=team-member") },
    { sitemap: `${declared.sitemap}?page=1` },
    { sitemap: `${declared.sitemap}#fragment` },
    { sitemap: declared.sitemap.replace(host, "other.ubc.ca") },
    { sitemap: declared.sitemap.replace(host, `user@${host}`) },
    { sitemap: `${home}wrong.xml` },
    { sitemap: "/team-member-sitemap.xml" },
  ])("rejects invalid declaration %j", (patch) => {
    expect(() => validateRequiredDocumentQueries(host, [{ ...declared, ...patch }])).toThrow();
  });
  it("rejects duplicate declarations", () => {
    expect(() => validateRequiredDocumentQueries(host, [declared, declared])).toThrow();
  });
});

describe("selected query response identity", () => {
  it("accepts exact HTML and preserves relative redirect evidence with the same selection", () => {
    const value = snapshot();
    value.redirects = [
      { url: query, location: "/?post_type=team-member&p=3962", status: 302, snapshot: sha256("hop") },
    ];
    expect(() => assertRequiredQueryIdentity(host, [declared], query, value)).not.toThrow();
    expect(createGenericScraper(host).extract(value).kind).toBe("document");
  });
  it.each([home, `${home}team-member/unreviewed/`, `${home}?p=3962`, query.replace("3962", "3963"), `${query}#alias`])(
    "rejects unreviewed response alias %s",
    (url) => {
      const value = snapshot();
      value.url = url;
      expect(() => assertRequiredQueryIdentity(host, [declared], query, value)).toThrow(/Required query.*identity/);
      expect(() => createGenericScraper(host).extract(value)).toThrow();
    },
  );
  it.each(["requested_url", "url", "hop source", "hop destination"])(
    "rejects a chain that touches the query only at %s",
    (part) => {
      const value = { ...snapshot(), requested_url: home, url: home };
      if (part === "requested_url" || part === "url") value[part] = query;
      else
        value.redirects = [
          {
            url: part === "hop source" ? query : home,
            location: part === "hop destination" ? query : home,
            status: 302,
            snapshot: sha256("hop"),
          },
        ];
      expect(() => assertRequiredQueryIdentity(host, [declared], home, value)).toThrow(/Required query.*identity/);
      expect(() => createGenericScraper(host).extract(value)).toThrow(/Required query.*identity/);
    },
  );
  it("keeps ordinary numeric query redirects unchanged", () => {
    const value = { ...snapshot(), requested_url: `${home}?p=123`, url: `${home}ordinary/` };
    expect(() => assertRequiredQueryIdentity(host, [declared], value.requested_url, value)).not.toThrow();
    expect(createGenericScraper(host).extract(value).kind).toBe("document");
  });
});

describe("cheap completed-host query gate", () => {
  it("accepts exact query source URLs and observed duplicate aliases", () => {
    expect(cheapGuardCompletedHost(completed()).documents[0]!.source_url).toBe(query);
    const value = completed(home);
    value.documents[0]!.alternate_urls = [query];
    expect(cheapGuardCompletedHost(value).documents[0]!.alternate_urls).toEqual([query]);
  });
  it.each([
    query.replace("3962", "3963"),
    query.replace("post_type=team-member&p=3962", "p=3962&post_type=team-member"),
    `${home}private/`,
    `${home}guide.pdf?post_type=team-member&p=3962`,
  ])("rejects unsafe completed source and alias %s", (url) => {
    expect(() => cheapGuardCompletedHost(completed(url))).toThrow();
    const value = completed(home);
    value.documents[0]!.alternate_urls = [url];
    expect(() => cheapGuardCompletedHost(value)).toThrow();
  });
  it("rejects the selected query copied to a different host output", () => {
    const value = completed(query.replace(host, "other.ubc.ca"));
    value.host = {
      ...value.host,
      hostname: "other.ubc.ca",
      homepage_url: "https://other.ubc.ca/",
      document_root: "data/documents/other.ubc.ca",
    };
    value.documents[0]!.hostname = "other.ubc.ca";
    expect(() => cheapGuardCompletedHost(value)).toThrow(/Unsafe completed document URL/);
  });
});
