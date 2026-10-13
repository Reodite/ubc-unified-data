import type { CheerioAPI } from "cheerio";
import type { Snapshot } from "../../host-crawl/contracts.ts";
import { normalizedText as text } from "../../scraping/html.ts";

/** Recognize an image-only attachment after generic page furniture removal. */
export function isReviewedEmptyImageAttachment($: CheerioAPI, hostname: string, snapshot: Snapshot): boolean {
  const photo = $(".entry-content p.attachment-image img[src]");
  return Boolean(
    hostname === "smp.med.ubc.ca" &&
    snapshot.requested_url === snapshot.url &&
    $("body").is(".singular-attachment.attachment-image") &&
    $(".entry-content").length === 1 &&
    photo.length === 1 &&
    photo.attr("src")?.startsWith(`https://${hostname}/wp-content/uploads/`) &&
    !text($(".entry-content").text()),
  );
}
