import { load, type CheerioAPI } from "cheerio";
import { publicUbcUrl } from "../prose/client.ts";
import { plainText } from "../source-documents.ts";
import type { CompletedHost, HostScraper, SearchDocument, Snapshot } from "./contracts.ts";
import { digest, formatDocument, safeText, timestamp } from "./document-format.ts";
import { htmlBaseUrl } from "./html-base.ts";
import { documentPageExclusion, hostUrl, normalizeHost } from "./urls.ts";

const HTML = /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i;
const HEADINGS = "h1,h2,h3,h4,h5,h6";
const BOUNDARIES = [".entry-content", "main#main-content", "article,main,[role=main],.region-content", "body"];
const FURNITURE = [
  "script,style,noscript,template,nav,[role=navigation],[role=banner],[role=contentinfo]",
  "form,input,select,textarea,.form-actions",
  "body > header,body > footer,#header,#footer,#masthead,#colophon,.site-header,.site-footer,.region-header,.region-footer",
  "#ubc7-header,#ubc7-footer,#ubc7-global-menu,#ubc7-unit-menu,#ubc7-unit-name",
  ".navbar,.navigation,.menu,.breadcrumb,.breadcrumbs,.sidebar,.region-help",
  ".entry-utility",
  ".ubc-accordion-tabs__tab-list",
  "#comments,#comments-template,#respond,.comments-area",
  ".share-links,.social-share,.addtoany_share_save_container,.ubc7-back-to-top",
  ".skip-link,svg[aria-hidden=true]",
].join(",");
const TRIGGERS = [
  "summary,button[aria-expanded],button[aria-controls],a[aria-expanded],[role=button][aria-controls]",
  "[data-toggle=collapse],[data-bs-toggle=collapse]",
  ".accordion__trigger,.accordion-trigger,.accordion-toggle,.accordion-button,.ui-accordion-header",
].join(",");
const text = (value: string) => value.replace(/\s+/g, " ").trim();
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function excludeUrl(value: string, hostname: string): string | null {
  const excluded = documentPageExclusion(value, hostname, ["pdf"]);
  if (excluded !== null) return excluded;
  const path = decodeURIComponent(new URL(hostUrl(value, hostname)).pathname).replace(/\.pdf$/i, "");
  if (
    /\/(?:admin|user|login|login_required|signin|logout|auth|private|antibot|core|modules|themes|libraries|jsonapi|system|batch|search)(?:\/|$)/i.test(
      path,
    ) ||
    /\/(?:media\/oembed|views\/ajax|node\/\d+\/(?:edit|delete|revisions))(?:\/|$)/i.test(path) ||
    /\/(?:update|install|authorize)\.php(?:\/|$)/i.test(path) ||
    /^\/sites\/[^/]+\/files\/(?:css|js|styles)(?:\/|$)/i.test(path)
  )
    return "Administration, private content, form action or embedded resource";
  return null;
}

function assertPublicSnapshot(snapshot: Snapshot, hostname: string): void {
  for (const value of [
    snapshot.requested_url,
    snapshot.url,
    ...(snapshot.redirects ?? []).flatMap((hop) => [hop.url, hostUrl(hop.location, hostname, hop.url)]),
  ]) {
    publicUbcUrl(hostUrl(value, hostname));
    const excluded = excludeUrl(value, hostname);
    if (excluded !== null) throw new Error(`Non-public document observation: ${excluded}`);
  }
  if (snapshot.status !== 200 || snapshot.binary || !HTML.test(snapshot.headers["content-type"] ?? ""))
    throw new Error("A complete public HTML observation is required");
}

function cleanStructure($: CheerioAPI): void {
  $(FURNITURE).remove();
  const candidates = $(TRIGGERS);
  const nodes = new Set(candidates.toArray());
  const seen = new Set<string>();
  candidates
    .filter(
      (_, node) =>
        !$(node)
          .parents()
          .toArray()
          .some((parent) => nodes.has(parent)),
    )
    .each((_, node) => {
      const trigger = $(node);
      trigger.find("svg,[aria-hidden=true],.icon").remove();
      const label = text(trigger.text());
      const target =
        trigger.attr("aria-controls") ||
        trigger.find("[aria-controls]").first().attr("aria-controls") ||
        trigger.attr("data-target") ||
        trigger.attr("data-bs-target") ||
        trigger.attr("href");
      const key = target ? JSON.stringify([target.replace(/^#/, ""), label]) : undefined;
      if (!label || /^(?:expand|collapse|open|close) all(?:\s.*)?$/i.test(label) || (key && seen.has(key))) {
        trigger.remove();
        return;
      }
      if (key) seen.add(key);
      trigger.find("button,a,[role=button]").each((_, control) => {
        $(control).replaceWith($(control).contents());
      });
      if (trigger.is(HEADINGS)) {
        trigger.removeAttr("role");
        return;
      }
      if (trigger.find(HEADINGS).length || trigger.parents(HEADINGS).length) trigger.replaceWith(trigger.contents());
      else trigger.replaceWith($("<h3>").append(trigger.contents()));
    });
  // Collapsed answer panels remain intact; only their interactive controls are omitted.
  $("button,[role=button]").remove();
  $("a,span,strong,em,b,i").each((_, node) => {
    const next = node.nextSibling;
    if (next?.type !== "tag" || !$(next).is("a,span,strong,em,b,i")) return;
    if (/[\p{L}\p{N}]$/u.test($(node).text()) && /^[\p{L}\p{N}]/u.test($(next).text())) $(node).after(" ");
  });
}

/** Extract exact-host public prose; usefulness admission belongs to the caller's homepage queue. */
export function createGenericScraper(value: string): HostScraper {
  const hostname = normalizeHost(value);
  const home = `https://${hostname}/`;
  publicUbcUrl(home);
  return {
    hostname,
    title: hostname,
    scope: "Public HTML prose and native PDF text on this exact hostname.",
    adapter: { kind: "auto", allowedTypes: [], allPublicTypes: true, exactHostInventory: true },
    documentFormats: ["pdf"],
    excludeUrl: (url) => excludeUrl(url, hostname),
    vetHomepage(snapshot) {
      try {
        assertPublicSnapshot(snapshot, hostname);
        const $ = load(snapshot.body);
        $("script,style,noscript,template").remove();
        const accepted = hostUrl(snapshot.requested_url, hostname) === home && Boolean(text($("body").text()));
        return {
          accepted,
          reason: accepted ? "Public nonempty exact-host HTML homepage" : "Empty or non-homepage observation",
        };
      } catch {
        return {
          accepted: false,
          reason: "Invalid public exact-host HTML homepage",
        };
      }
    },
    extract(snapshot) {
      assertPublicSnapshot(snapshot, hostname);
      const $ = load(snapshot.body);
      const base = htmlBaseUrl(snapshot.body, hostname, snapshot.url, true);
      if (base !== snapshot.url)
        $("a[href],img[src]").each((_, node) => {
          const attribute = $(node).is("a") ? "href" : "src";
          $(node).attr(attribute, new URL($(node).attr(attribute)!, base).href);
        });
      const pageTitle = text($("title").text());
      cleanStructure($);
      const title =
        $("h1")
          .toArray()
          .map((node) => plainText($(node).html() ?? ""))
          .find(Boolean) || plainText(pageTitle);
      if (/just a moment|access denied|captcha|sign in.*cwl|cwl.*login|page not found|404 not found/i.test(pageTitle))
        throw new Error("Access interstitial instead of public prose");
      for (const selector of BOUNDARIES) {
        if (
          selector === ".entry-content" &&
          !$(selector)
            .toArray()
            .some((node) => text($(node).text()))
        )
          continue;
        const candidates = $(selector === ".entry-content" ? ".entry-content,.carousel-caption" : selector);
        const nodes = new Set(candidates.toArray());
        const roots = candidates.filter(
          (_, node) =>
            !$(node)
              .parents()
              .toArray()
              .some((parent) => nodes.has(parent)),
        );
        if (!roots.length) continue;
        const content = $("<div>");
        roots.each((_, node) => {
          content.append($(node).clone());
        });
        content
          .find("h1")
          .filter((_, node) => plainText($(node).html() ?? "") === title)
          .remove();
        if (!text(content.text())) continue;
        if (!title) throw new Error("Extracted public prose lacks a source title");
        return {
          kind: "document",
          input: {
            url: hostUrl(snapshot.url, hostname),
            title,
            html: content.html() ?? "",
            retrievedAt: snapshot.retrieved_at,
            sourceModifiedAt: null,
          },
        };
      }
      return {
        kind: "excluded",
        reason: "No nonempty public prose after removing page furniture",
      };
    },
  };
}

/** Validate output and coalesce exact title/body duplicates, retaining only observed URL aliases. */
export function cheapGuardCompletedHost(completed: CompletedHost): CompletedHost {
  const { host } = completed;
  const hostname = normalizeHost(host.hostname);
  if (
    completed.complete !== true ||
    hostname !== host.hostname ||
    host.homepage_url !== `https://${hostname}/` ||
    host.document_root !== `data/documents/${hostname}` ||
    !completed.documents.length ||
    host.document_count !== completed.documents.length
  )
    throw new Error("Empty, incomplete or inconsistent completed host");
  publicUbcUrl(host.homepage_url);
  safeText(host.title, "host title");
  safeText(host.scope, "host scope");
  timestamp(host.homepage_retrieved_at, "homepage retrieval");
  digest(host.homepage_sha256, "homepage snapshot");
  const validated = completed.documents
    .map((document) => {
      const bytes = formatDocument(document);
      if (document.hostname !== hostname) throw new Error("Off-host completed document");
      for (const url of [document.source_url, ...document.alternate_urls])
        if (excludeUrl(url, hostname) !== null) throw new Error(`Unsafe completed document URL: ${url}`);
      return { document, bytes };
    })
    .sort((a, b) => compare(a.document.source_url, b.document.source_url) || Buffer.compare(a.bytes, b.bytes));
  const groups = new Map<string, SearchDocument>();
  const urls = new Map<string, string>();
  for (const { document } of validated) {
    const key = JSON.stringify([
      document.title,
      document.content_markdown,
      document.source_modified_at,
      document.extraction ?? null,
    ]);
    const observed = [document.source_url, ...document.alternate_urls];
    for (const url of observed) {
      if (urls.has(url) && urls.get(url) !== key) throw new Error("Conflicting content for an observed URL");
      urls.set(url, key);
    }
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...document,
        alternate_urls: [...document.alternate_urls],
        warnings: [...document.warnings],
      });
      continue;
    }
    existing.alternate_urls = [...new Set([...existing.alternate_urls, ...observed])]
      .filter((url) => url !== existing.source_url)
      .sort();
    existing.warnings = [...new Set([...existing.warnings, ...document.warnings])].sort();
  }
  const documents = [...groups.values()].sort((a, b) => compare(a.id, b.id));
  for (const document of documents) formatDocument(document);
  return {
    ...completed,
    host: { ...host, document_count: documents.length },
    documents,
  };
}
