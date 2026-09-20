import { load } from "cheerio";
import { htmlBaseUrl } from "./html-base.ts";
import { inventoryUrl, pageExclusion } from "./urls.ts";

/** Identify exact feed and own-form refresh identities from observed HTML, without requesting either resource. */
export function discoverMachineLinks(html: string, hostname: string, sourceUrl: string): Set<string> {
  const $ = load(html);
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
  $("head link[rel][type][href]").each((_, node) => {
    const link = $(node);
    if (!(link.attr("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate")) return;
    const mime = link.attr("type")?.trim().toLowerCase();
    const suffix = mime === "application/atom+xml" ? ".atom" : mime === "application/rss+xml" ? ".rss" : null;
    if (!suffix) return;
    const url = candidate(link.attr("href"));
    if (url && new URL(url).pathname.toLowerCase().endsWith(suffix)) result.add(url);
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
    if (url && new URL(url).pathname === `/image-captcha-refresh/${id}`) result.add(url);
  });
  return result;
}
