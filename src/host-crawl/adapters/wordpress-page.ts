import { load, type CheerioAPI } from "cheerio";
import { extractArticle } from "../../prose/html.ts";
import type { HostScraper, Snapshot } from "../contracts.ts";
import { hostUrl, normalizeHost, pageExclusion } from "../urls.ts";

export interface WordpressHostOptions {
  hostname: string;
  title: string;
  scope: string;
  selectors: readonly string[];
  officialHomepage: ($: CheerioAPI, snapshot: Snapshot) => boolean;
  excludePage?: ($: CheerioAPI, snapshot: Snapshot) => string | null;
}

/** Keep platform parsing shared; host definitions supply evidence predicates and genuine content boundaries. */
export function defineWordpressHost(options: WordpressHostOptions): HostScraper {
  const hostname = normalizeHost(options.hostname);
  return {
    hostname,
    title: options.title,
    scope: options.scope,
    adapter: { kind: "wordpress", allowedTypes: ["page", "post"] },
    vetHomepage(snapshot) {
      try {
        if (
          hostUrl(snapshot.requested_url, hostname) !== `https://${hostname}/` ||
          hostUrl(snapshot.url, hostname) !== `https://${hostname}/`
        )
          return { accepted: false, reason: "Homepage must belong to the exact registered hostname" };
        const accepted =
          snapshot.status === 200 &&
          /html/i.test(snapshot.headers["content-type"] ?? "") &&
          options.officialHomepage(load(snapshot.body), snapshot);
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
      hostUrl(snapshot.requested_url, hostname);
      hostUrl(snapshot.url, hostname);
      if (snapshot.status !== 200 || !/html/i.test(snapshot.headers["content-type"] ?? ""))
        throw new Error("A complete HTML observation is required");
      const excluded = pageExclusion(snapshot.url, hostname);
      if (excluded) return { kind: "excluded", reason: excluded };
      const $ = load(snapshot.body);
      const reason = options.excludePage?.($, snapshot);
      if (reason) return { kind: "excluded", reason };
      if ($("body.blog").length && $(".hentry,article.archive-card-post").length > 1)
        return { kind: "excluded", reason: "Publisher post index; individual entries are discovered separately" };
      const input = extractArticle(snapshot, {
        key: hostname,
        host: hostname,
        title: options.title,
        campus: null,
        strategy: "wordpress",
        selectors: [...options.selectors],
        strictSelectors: true,
        scope: (url) => pageExclusion(url, hostname),
      });
      hostUrl(input.url, hostname);
      return { kind: "document", input };
    },
  };
}
