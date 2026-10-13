import { load } from "cheerio";
import type { Observation } from "../../host-crawl/contracts.ts";
import { htmlBaseUrl } from "../../host-crawl/html-base.ts";
import { inventoryUrl } from "../../host-crawl/urls.ts";

export function reviewedGalleryAttachments(observation: Observation, hostname: string): Set<string> {
  const links = new Set<string>();
  if (hostname === "www.msl.ubc.ca") {
    if (
      observation.snapshot.requested_url !== observation.snapshot.url ||
      !observation.snapshot.body.includes("wp-att-")
    )
      return links;
    const source = new URL(observation.snapshot.url);
    if (source.search || source.hash) return links;
    const $ = load(observation.snapshot.body);
    $("a[href][rel*='wp-att-']").each((_, node) => {
      const anchor = $(node);
      const match = (anchor.attr("rel") ?? "").trim().match(/^attachment wp-att-([1-9]\d*)$/);
      const image = anchor.children("img");
      if (
        !match ||
        image.length !== 1 ||
        anchor.children().length !== 1 ||
        anchor.text().trim() ||
        !image.attr("class")?.split(/\s+/).includes(`wp-image-${match[1]}`)
      )
        return;
      try {
        const photo = new URL(image.attr("src")!, source);
        const raw = new URL(anchor.attr("href")!, source).href;
        const target = inventoryUrl(raw, hostname);
        if (
          photo.origin === `https://${hostname}` &&
          photo.pathname.startsWith("/wp-content/uploads/") &&
          target === raw &&
          !new URL(target).search &&
          !new URL(target).hash &&
          new URL(target).pathname.startsWith(source.pathname) &&
          target !== observation.snapshot.url
        )
          links.add(target);
      } catch {
        return;
      }
    });
    return links;
  }
  if (hostname !== "rbsc.library.ubc.ca" && hostname !== "smp.med.ubc.ca" && hostname !== "mech.ubc.ca") return links;
  const $ = load(observation.snapshot.body);
  const base = htmlBaseUrl(observation.snapshot.body, hostname, observation.snapshot.url, true);
  $("dt.gallery-icon > a[href]").each((_, node) => {
    const anchor = $(node);
    const image = anchor.children("img");
    if (
      image.length !== 1 ||
      anchor.children().length !== 1 ||
      anchor.text().trim() ||
      !/(?:^|\s)attachment-(?:medium|medium_large|thumbnail|large|full|\d+x\d+)(?:\s|$)/.test(image.attr("class") ?? "")
    )
      return;
    try {
      const source = new URL(image.attr("src") ?? "", base);
      if (source.origin !== `https://${hostname}` || !/^\/(?:files|wp-content\/uploads)\//.test(source.pathname))
        return;
      const raw = new URL(anchor.attr("href")!, base).href;
      const target = inventoryUrl(raw, hostname);
      if (target === raw && !new URL(target).search && !new URL(target).hash) links.add(target);
    } catch {
      return;
    }
  });
  if (hostname === "smp.med.ubc.ca" && observation.snapshot.requested_url === observation.snapshot.url) {
    const entry = $("body.singular-attachment.attachment-image .entry-content");
    const photo = entry.find("> p.attachment-image > img[src]");
    const navigation = entry.find("> nav#image-navigation");
    const content = entry.clone();
    content.find("nav#image-navigation").remove();
    if (
      entry.length === 1 &&
      photo.length === 1 &&
      navigation.length === 1 &&
      !content.text().trim() &&
      new URL(photo.attr("src")!, base).origin === `https://${hostname}` &&
      /^\/wp-content\/uploads\//.test(new URL(photo.attr("src")!, base).pathname)
    ) {
      const parentPath = new URL(observation.snapshot.url).pathname.replace(/[^/]+\/$/, "");
      navigation.find("li.previous-image > a[href],li.next-image > a[href]").each((_, node) => {
        const anchor = $(node);
        if (anchor.text().trim() !== (anchor.parent().hasClass("previous-image") ? "Previous" : "Next")) return;
        try {
          const raw = new URL(anchor.attr("href")!, base).href;
          const target = inventoryUrl(raw, hostname);
          if (
            target === raw &&
            !new URL(target).search &&
            !new URL(target).hash &&
            new URL(target).pathname.startsWith(parentPath) &&
            target !== observation.snapshot.url
          )
            links.add(target);
        } catch {
          return;
        }
      });
    }
  }
  return links;
}
