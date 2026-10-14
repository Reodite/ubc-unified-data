import type { CheerioAPI } from "cheerio";
import { normalizedText } from "./html.ts";

interface UbcBranding {
  homepage: string;
  unit: string;
  faculty?: string;
  footer?: string;
  allowHttpWordmark?: boolean;
}

/** Check publisher branding separately from the site's substantive homepage evidence. */
export function hasUbcBranding($: CheerioAPI, pageUrl: string, expected: UbcBranding): boolean {
  const wordmark = $("#ubc7-header #ubc7-wordmark a").first();
  const unit = $("#ubc7-unit-name a").first();
  if (!wordmark.attr("href") || !unit.attr("href")) return false;
  const institution = new URL(wordmark.attr("href")!, pageUrl).href;
  return (
    normalizedText(wordmark.text()) === "The University of British Columbia" &&
    (institution === "https://www.ubc.ca/" ||
      (expected.allowHttpWordmark === true && institution === "http://www.ubc.ca/")) &&
    new URL(unit.attr("href")!, pageUrl).href === expected.homepage &&
    normalizedText(unit.find("#ubc7-unit-identifier").text()) === expected.unit &&
    (expected.faculty === undefined || normalizedText(unit.find("#ubc7-unit-faculty").text()) === expected.faculty) &&
    (expected.footer === undefined ||
      normalizedText($("#ubc7-footer #ubc7-address-unit-name").text()) === expected.footer)
  );
}
