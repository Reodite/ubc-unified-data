import { load, type CheerioAPI } from "cheerio";
import { extractArticleFromDom } from "../prose/html.ts";
import type { ArticleInput } from "../prose/model.ts";
import { HTML_MEDIA_TYPE, normalizedText } from "../scraping/html.ts";
import type { HostScraper, Snapshot } from "./contracts.ts";
import { hostUrl, normalizeHost, pageUrlPolicy, type UrlExclusion } from "./urls.ts";

type PageDecision = ReturnType<HostScraper["extract"]>;

export interface HtmlHostOptions {
  hostname: string;
  title: string;
  scope: string;
  adapter?: HostScraper["adapter"];
  documentFormats?: HostScraper["documentFormats"];
  selectors?: readonly string[];
  officialHomepage?: ($: CheerioAPI, snapshot: Snapshot) => boolean;
  excludeUrl?: (url: string) => UrlExclusion | null;
  excludePage?: ($: CheerioAPI, snapshot: Snapshot) => string | null;
  validateSnapshot?: (snapshot: Snapshot) => void;
  extractPage?: ($: CheerioAPI, snapshot: Snapshot) => PageDecision;
  normalizeArticle?: (input: ArticleInput) => ArticleInput;
}

/** Share snapshot validation and extraction; sites declare content boundaries and evidence. */
export function defineHtmlHost(options: HtmlHostOptions): HostScraper {
  const hostname = normalizeHost(options.hostname);
  const home = `https://${hostname}/`;
  const excludeUrl = options.excludeUrl ?? ((url: string) => pageUrlPolicy(url, hostname));
  const adapter = options.adapter ?? { kind: "html", allowedTypes: [] };
  const validateSnapshot = (snapshot: Snapshot) => {
    hostUrl(snapshot.requested_url, hostname);
    hostUrl(snapshot.url, hostname);
    for (const hop of snapshot.redirects ?? []) {
      hostUrl(hop.url, hostname);
      hostUrl(hop.location, hostname, hop.url);
    }
    if (snapshot.status !== 200 || snapshot.binary || !HTML_MEDIA_TYPE.test(snapshot.headers["content-type"] ?? ""))
      throw new Error("A complete HTML observation is required");
    options.validateSnapshot?.(snapshot);
  };
  return {
    hostname,
    title: options.title,
    scope: options.scope,
    adapter,
    ...(options.documentFormats ? { documentFormats: options.documentFormats } : {}),
    ...(options.normalizeArticle ? { normalizeArticle: options.normalizeArticle } : {}),
    excludeUrl,
    vetHomepage(snapshot) {
      try {
        validateSnapshot(snapshot);
        if (hostUrl(snapshot.requested_url, hostname) !== home)
          return { accepted: false, reason: "Homepage must belong to the exact registered hostname" };
        const $ = load(snapshot.body);
        let accepted: boolean;
        if (options.officialHomepage) accepted = options.officialHomepage($, snapshot);
        else {
          $("script,style,noscript,template").remove();
          accepted = hostUrl(snapshot.url, hostname) === home && Boolean(normalizedText($("body").text()));
        }
        return {
          accepted,
          reason: accepted
            ? "Declared institutional homepage evidence matches"
            : "Institutional homepage evidence is missing",
        };
      } catch {
        return { accepted: false, reason: "Invalid homepage observation" };
      }
    },
    extract(snapshot) {
      validateSnapshot(snapshot);
      const excluded = excludeUrl(snapshot.requested_url) ?? excludeUrl(snapshot.url);
      if (excluded) return { kind: "excluded", reason: excluded.reason };
      const $ = load(snapshot.body);
      const reason = options.excludePage?.($, snapshot);
      if (reason) return { kind: "excluded", reason };
      const result: PageDecision = options.extractPage
        ? options.extractPage($, snapshot)
        : {
            kind: "document",
            input: extractArticleFromDom($, snapshot, {
              key: hostname,
              host: hostname,
              title: options.title,
              campus: null,
              strategy: adapter.kind === "wordpress" ? "wordpress" : "sitemap",
              selectors: options.selectors ? [...options.selectors] : undefined,
              strictSelectors: Boolean(options.selectors),
              scope: (url) => excludeUrl(url)?.reason ?? null,
            }),
          };
      if (result.kind === "excluded") return result;
      const input = options.normalizeArticle?.(result.input) ?? result.input;
      hostUrl(input.url, hostname);
      return { kind: "document", input };
    },
  };
}

export interface WordpressHostOptions extends Omit<HtmlHostOptions, "adapter" | "officialHomepage"> {
  selectors: readonly string[];
  officialHomepage: NonNullable<HtmlHostOptions["officialHomepage"]>;
}

export function defineWordpressHost(options: WordpressHostOptions): HostScraper {
  const hostname = normalizeHost(options.hostname);
  return defineHtmlHost({
    ...options,
    adapter: { kind: "wordpress", allowedTypes: ["page", "post"] },
    officialHomepage: ($, snapshot) =>
      hostUrl(snapshot.url, hostname) === `https://${hostname}/` && options.officialHomepage($, snapshot),
    excludePage($, snapshot) {
      const excluded = options.excludePage?.($, snapshot);
      if (excluded) return excluded;
      return $("body.blog").length && $(".hentry,article.archive-card-post").length > 1
        ? "Publisher post index; individual entries are discovered separately"
        : null;
    },
  });
}
