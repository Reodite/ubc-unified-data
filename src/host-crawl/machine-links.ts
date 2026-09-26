import { load } from "cheerio";
import { htmlBaseUrl } from "./html-base.ts";
import { inventoryUrl, pageExclusion } from "./urls.ts";

/** Identify exact feeds, own-form refreshes and labeled BibTeX exports from observed HTML without requesting them. */
export function discoverMachineLinks(html: string, hostname: string, sourceUrl: string): Set<string> {
  const $ = load(html, { sourceCodeLocationInfo: true });
  const base = htmlBaseUrl(html, hostname, sourceUrl, true);
  const result = new Set<string>();
  const candidate = (value: string | undefined): string | null => {
    const href = value?.trim();
    if (!href || /[?#\\\p{Cc}\s]/u.test(href)) return null;
    try {
      // URL resolution erases dot segments and empty query/fragment delimiters; reject them before resolving.
      const decoded = decodeURIComponent(href);
      if (/[\\\p{Cc}]/u.test(decoded) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded)) return null;
      const url = inventoryUrl(href, hostname, base);
      return url && pageExclusion(url, hostname) === null ? url : null;
    } catch {
      return null;
    }
  };
  const head = $("head")[0]?.sourceCodeLocation;
  const originalHead = new Set(
    $("head > meta,head > link")
      .filter((_, node) => {
        const location = node.sourceCodeLocation;
        return Boolean(
          head?.startTag &&
          head.endTag &&
          location &&
          location.startOffset >= head.startTag.endOffset &&
          location.endOffset <= head.endTag.startOffset,
        );
      })
      .toArray(),
  );
  const generators = $("head > meta[name=generator]");
  const ojs =
    generators.length === 1 &&
    originalHead.has(generators[0]!) &&
    /^Open Journal Systems 3(?:\.\d+){1,3}$/.test(generators.attr("content") ?? "");
  const journal = new URL(sourceUrl).pathname.match(/^\/index\.php\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1];
  $("head link[rel][type][href]").each((_, node) => {
    const link = $(node);
    if (!(link.attr("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate")) return;
    const mime = link.attr("type")?.trim().toLowerCase();
    const suffix = mime === "application/atom+xml" ? ".atom" : mime === "application/rss+xml" ? ".rss" : null;
    const url = candidate(link.attr("href"));
    if (!url) return;
    const path = new URL(url).pathname;
    if (suffix && path.toLowerCase().endsWith(suffix)) result.add(url);
    if (!ojs || !journal || !originalHead.has(node)) return;
    const gateway = path.match(
      /^\/index\.php\/([A-Za-z0-9_-]+)\/gateway\/plugin\/(?:AnnouncementFeedGatewayPlugin|WebFeedGatewayPlugin)\/(atom|rss|rss2)$/,
    );
    const format =
      mime === "application/atom+xml"
        ? "atom"
        : mime === "application/rdf+xml"
          ? "rss"
          : mime === "application/rss+xml"
            ? "rss2"
            : null;
    if (gateway && gateway[1] === journal && gateway[2] === format) result.add(url);
  });
  $("li.biblio_bibtex a[href][title][rel]").each((_, node) => {
    const link = $(node);
    if (
      link.text().replace(/\s+/g, " ").trim().toLowerCase() !== "bibtex" ||
      link.attr("title")?.trim().toLowerCase() !== "click to download the bibtex formatted file" ||
      !(link.attr("rel") ?? "").toLowerCase().split(/\s+/).includes("nofollow")
    )
      return;
    const url = candidate(link.attr("href"));
    if (url && /^\/biblio\/export\/bibtex\/[1-9]\d*$/.test(new URL(url).pathname)) result.add(url);
  });
  $("a.reload-captcha[href]").each((_, node) => {
    const link = $(node);
    const fieldset = link.closest("fieldset.captcha.captcha-type-challenge--image");
    const form = link.closest("form");
    if (!fieldset.length || !form.length || form.attr("method")?.trim().toLowerCase() !== "post") return;
    if (fieldset.closest("form")[0] !== form[0]) return;
    const ownsAssociation = (association: string | undefined) => {
      if (association === undefined) return true;
      return (
        association.length > 0 &&
        association === form.attr("id") &&
        $("form[id]").filter((_, element) => $(element).attr("id") === association).length === 1
      );
    };
    if (!ownsAssociation(fieldset.attr("form"))) return;
    const owns = (control: ReturnType<typeof $>) =>
      control.closest("form")[0] === form[0] && ownsAssociation(control.attr("form"));
    const ids = form.find('input[name="form_id"]');
    if (ids.length !== 1 || ids.attr("type")?.toLowerCase() !== "hidden" || !owns(ids)) return;
    const id = ids.attr("value");
    if (!id || !/^[A-Za-z0-9_]+$/.test(id)) return;
    for (const [name, type] of [
      ["captcha_sid", "hidden"],
      ["captcha_token", "hidden"],
      ["captcha_response", "text"],
    ] as const) {
      const controls = fieldset.find(`input[name="${name}"]`);
      if (
        controls.length !== 1 ||
        (controls.attr("type") ?? "text").toLowerCase() !== type ||
        controls.closest("fieldset")[0] !== fieldset[0] ||
        !owns(controls)
      )
        return;
    }
    const url = candidate(link.attr("href"));
    if (!url) return;
    const endpoint = `/image-captcha-refresh/${id}`;
    const pathname = new URL(url).pathname;
    if (pathname === endpoint) {
      result.add(url);
      return;
    }
    const source = new URL(sourceUrl);
    const prefix = source.pathname.match(/^\/index%2[eE]php(?=\/)/)?.[0];
    if (!prefix || source.search || source.hash) return;
    if (/(?:^|\/)index(?:\.|%2e)php(?:\/|$)/i.test(source.pathname.slice(prefix.length))) return;
    // The observed form and source must agree on one prefix spelling; this does not establish URL aliases.
    if (pathname === `${prefix}${endpoint}` && candidate(form.attr("data-action")) === source.href) result.add(url);
  });
  return result;
}
