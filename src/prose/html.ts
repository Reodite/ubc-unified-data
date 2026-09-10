import { load } from "cheerio";
import { plainText, webUrl } from "../source-documents.ts";
import { publicUbcUrl, type ProseResponse } from "./client.ts";
import type { ArticleInput, ProseSource } from "./model.ts";
import { normalizedHref, secureUbcLink } from "./urls.ts";

const ASSET =
  /\.(?:pdf|docx?|xlsx?|pptx?|zip|gz|png|jpe?g|gif|webp|svg|ico|mp[34]|mov|avi|ics|xml|json|csv|txt|woff2?|ttf)(?:$|\/)/i;
const SHORTCODE =
  /\[(?:\/?(?:vc_|et_pb_|fusion_|ubc_|titled_box|column|row|accordion|tab|display-posts)[\w-]*)(?:\s|\]|=)/i;
const BOILERPLATE =
  "script,style,noscript,template,nav,[role=navigation],.breadcrumb,.breadcrumbs,.site-header,.site-footer,.navbar,.ubc7-back-to-top,.share-links,.social-share,.addtoany_share_save_container,svg[aria-hidden=true],#secondary-navigation,.region-help,#comments-template,#comments,#respond,.comments-area,.entry-meta,.entry-utility,.byline,.entry-byline,.entry-date,.read-more,#primary.sidebar,#primary-secondary.sidebar,#secondary.sidebar";

export class NonArticleError extends Error {
  override name = "NonArticleError";
}

export function needsRenderedHtml(html: string | undefined): boolean {
  return !html || !plainText(html) || SHORTCODE.test(html);
}

export function articleLinks(html: string, source: ProseSource, base: string): string[] {
  const $ = load(html);
  const found = new Set<string>();
  $("a[href]").each((_, node) => {
    const raw = $(node).attr("href")?.trim();
    if (!raw || raw.startsWith("#")) return;
    const resolved = webUrl(normalizedHref(raw), base);
    if (!resolved) return;
    const url = new URL(resolved);
    if (url.hostname !== source.host || ASSET.test(url.pathname)) return;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|_ga|fbclid|gclid)/.test(key)) url.searchParams.delete(key);
    }
    if ([...url.searchParams].some(([key, value]) => !["p", "page", "paged"].includes(key) || !/^\d+$/.test(value)))
      return;
    url.hash = "";
    try {
      if (source.scope(url.href) === null) found.add(publicUbcUrl(secureUbcLink(url.href)));
    } catch {
      return;
    }
  });
  return [...found];
}

/** Extract page content without global navigation; collapsed FAQ panels remain in document order. */
export function extractArticle(response: ProseResponse, source: ProseSource): ArticleInput {
  const $ = load(response.body);
  const pageTitle = $("title").text().trim();
  const fullArticle = $("#primary-content article.node--view-mode-full, main article").first();
  const pageTypes = `${$("body").attr("class") ?? ""} ${fullArticle.attr("class") ?? ""}`;
  if (
    /\b(?:node--type-|node-type-|type-)(?:ubc-profile|student-listing|profile|alumni-profile|ubc-event|event|ajde_events|page-sandbox)\b/.test(
      pageTypes,
    ) ||
    /\b(?:single|singular)-(?:profile|alumni-profile)(?:\s|$|-\d)/.test(pageTypes)
  )
    throw new NonArticleError(
      `Publisher identifies a profile, student listing, event or sandbox rather than a prose article: ${response.url}`,
    );
  if (/just a moment|access denied|captcha|sign in.*cwl|cwl.*login|page not found|404 not found/i.test(pageTitle))
    throw new Error(`Access interstitial instead of article content: ${response.url}`);
  const canonicalValue = $("link[rel=canonical]").attr("href");
  const canonical = canonicalValue
    ? publicUbcUrl(secureUbcLink(canonicalValue, response.url))
    : publicUbcUrl(response.url);
  const title = $("h1").first().html() || $(".s-la-faq-title").first().html() || pageTitle.split(/\s[|–]\s/)[0] || "";
  const selectors = [
    ...new Set([
      ...(source.selectors ?? []),
      ".s-la-faq-answer",
      ".entry-content",
      "#s-lg-guide-main",
      ".admissions-content",
      "article .field--name-body",
      "article .field-name-body",
      "#unit-content",
      "article",
      "main",
      "#content",
      "[role=main]",
    ]),
  ];
  let html: string | null = null;
  let matchedContainer = false;
  let selected = "";
  for (const selector of selectors) {
    const candidates = $(selector);
    const roots = candidates.filter(
      (_, element) =>
        !$(element)
          .parents()
          .toArray()
          .some((parent) => candidates.toArray().includes(parent)),
    );
    if (!roots.length) continue;
    matchedContainer = true;
    const fragment = load(
      roots
        .toArray()
        .map((element) => $.html(element))
        .join("\n"),
      {},
      false,
    );
    fragment(BOILERPLATE).remove();
    fragment("h1")
      .filter((_, element) => plainText(fragment(element).html() ?? "") === plainText(title))
      .remove();
    if (plainText(fragment.root().html() ?? "") || fragment("img,iframe,video,audio,object,embed,canvas,svg").length) {
      html = fragment.root().html() ?? "";
      selected = selector;
      break;
    }
    if (selector === ".entry-content" && ["learning-commons", "student-housing"].includes(source.key)) {
      html = "";
      selected = selector;
      break;
    }
  }
  if (html === null && matchedContainer) html = "";
  if (html === null) throw new Error(`No recognized prose container at ${response.url}`);
  const id = /\b(?:page-id|postid|page-node)-(\d+)\b/.exec($("body").attr("class") ?? "")?.[1];
  const modified =
    $("meta[property='article:modified_time'],meta[property='og:updated_time']").first().attr("content") || null;
  return {
    url: canonical,
    title,
    html: /\b(?:archive|post-type-archive(?:-\S+)?)\b/.test($("body").attr("class") ?? "") ? "" : html,
    upstreamId: id,
    retrievedAt: response.retrieved_at,
    sourceModifiedAt: modified,
    warnings: SHORTCODE.test(html)
      ? [`Unexpanded source shortcode remains in ${selected}; review the rendered page.`]
      : [],
  };
}
