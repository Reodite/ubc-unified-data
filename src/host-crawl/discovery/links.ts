import { load } from "cheerio";
import type { Observation } from "../contracts.ts";
import { htmlBaseUrl } from "../html-base.ts";
import { hostUrl, inventoryUrl } from "../urls.ts";

export function pageLinks(
  observation: Observation,
  hostname: string,
  exactHost = false,
  nonDocuments?: Set<string>,
): string[] {
  return htmlLinks(observation.snapshot.body, hostname, observation.snapshot.url, exactHost, nonDocuments);
}

export function htmlLinks(
  html: string,
  hostname: string,
  base: string,
  exactHost = false,
  nonDocuments?: Set<string>,
): string[] {
  const $ = load(html);
  const source = new URL(base);
  base = htmlBaseUrl(html, hostname, base, exactHost);
  const links = new Set<string>();
  $("a[href]").each((_, node) => {
    const value = $(node).attr("href")?.trim();
    if (!value || value.startsWith("#")) return;
    let url: string;
    try {
      const target = exactHost ? inventoryUrl(value, hostname, base) : hostUrl(value, hostname, base);
      if (!target) return;
      url = target;
    } catch {
      return;
    }
    if (exactHost && nonDocuments && !source.search) {
      const link = $(node);
      const rel = (link.attr("rel") ?? "").toLowerCase().split(/\s+/);
      const commentMetadata =
        link.closest("#comments-template,#comments,.comments-area").length > 0 &&
        (rel.includes("trackback") ||
          (link.attr("title") === "Trackback URL for this post" &&
            link.closest("p.comments-closed.pings-open").length > 0));
      const endpoint = new URL(`${source.pathname.replace(/\/$/, "")}/trackback/`, source).href;
      // Comment metadata identifies this page's machine action, not pages discussing trackbacks.
      if (commentMetadata && url === endpoint) nonDocuments.add(url);
    }
    links.add(url);
  });
  return [...links].sort();
}
