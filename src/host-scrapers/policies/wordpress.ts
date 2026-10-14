import { load } from "cheerio";
import type { Observation } from "../../host-crawl/contracts.ts";
import { hostUrl } from "../../host-crawl/urls.ts";

const NON_DOCUMENT_TYPES = new Set([
  "attachment",
  "elementor_library",
  "elementor_snippet",
  "foundry_comp_block",
  "jp_act_log_event",
  "nav_menu_item",
  "wp_block",
  "wp_template",
  "wp_template_part",
  "wp_navigation",
  "wp_font_family",
  "wp_font_face",
  "wp_global_styles",
  "view",
  "view-template",
  "wpcf7_contact_form",
]);

const RECURRING_EVENT_HOSTS = new Set([
  "ischool.ubc.ca",
  "mediastudies.arts.ubc.ca",
  "migration.ubc.ca",
  "music.ubc.ca",
  "politics.ubc.ca",
  "psych.ubc.ca",
  "sppga.ubc.ca",
  "theatrefilm.ubc.ca",
]);

const VISIT_MISSING_LOCATION = "https://visit.ubc.ca/eat-drink-and-stay/accommodation/standard-suites/";
const VISIT_MISSING_RESTAURANT =
  "https://visit.ubc.ca/eat-drink-and-stay/restaurants/restaurants-lounges-and-pubs/biercraft/";
const VISIT_MISSING_LOCATION_RECORDS = new Map<number, readonly [string, string, string]>([
  [303, [VISIT_MISSING_RESTAURANT, "Sports Illustrated Clubhouse", "2025-01-14T22:32:49Z"]],
  [323, [VISIT_MISSING_LOCATION, "Gage Suites", "2024-06-17T17:33:55Z"]],
  [810, [VISIT_MISSING_LOCATION, "Standard Suites (Ponderosa Commons)", "2019-05-03T23:20:28Z"]],
]);
const ADVANCING_HEALTH_ORGANIZER_ROOT = "https://www.advancinghealth.ubc.ca/organizer/";
const ADVANCING_HEALTH_ORGANIZER_ROOT_RECORDS = new Map([
  [11041, ["VCH Research Institute", "2023-10-12T17:36:12Z"]],
  [13325, ["Clinical Trials BC", "2025-06-05T22:37:45Z"]],
  [13956, ["Providence Health", "2025-09-29T22:01:55Z"]],
  [14109, ["Clinical Trials British Columbia", "2026-01-13T18:11:12Z"]],
  [14140, ["UBC Centre for Health Services and Policy Research (CHSPR)", "2026-02-03T23:14:14Z"]],
]);

interface WordpressPolicyEvidence {
  types: Record<string, unknown>;
  routes: Record<string, unknown>;
  object(value: unknown): Record<string, unknown>;
  link(value: unknown, relation: string): string;
  routeUrl(key: string): string;
}

interface WordpressTypeEvidence {
  type: string;
  definition: Record<string, unknown>;
  namespace: string;
  restBase: string;
  collection: string;
}

export type WordpressRowDecision = "document" | "non-document" | "search-control" | "missing-location";

export interface WordpressCollectionPolicy {
  readonly allowIdenticalRecurrences: boolean;
  assertPage(count: number, pageCount: number, rowCount: number): void;
  beforeNormalizeRow(row: Record<string, unknown>, id: number): "normalize" | "omit";
  row(row: Record<string, unknown>, id: number, url: string, sourceModified: string | null): WordpressRowDecision;
  complete(): void;
}

export interface WordpressDiscoveryPolicy {
  isNonDocumentType(key: string): boolean;
  collection(evidence: WordpressTypeEvidence): WordpressCollectionPolicy;
}

/** Keep reviewed evidence local to one discovery; the adapter owns ordinary identity, route and total checks. */
export function createWordpressDiscoveryPolicy(
  hostname: string,
  homepage: Observation,
  { types, routes, object, link, routeUrl }: WordpressPolicyEvidence,
): WordpressDiscoveryPolicy {
  let corroboratedOrthopaedicsHomepage = false;
  return {
    isNonDocumentType(key) {
      if (NON_DOCUMENT_TYPES.has(key)) return true;
      if (hostname === "www.bioteach.ubc.ca" && key === "jp_pay_order") {
        const item = object(types[key]);
        const endpoint = `https://${hostname}/wp-json/wp/v2/jp_pay_order`;
        return (
          item.name === "Order" &&
          item.slug === key &&
          item.has_archive === false &&
          item.rest_namespace === "wp/v2" &&
          item.rest_base === key &&
          link(item, "wp:items") === endpoint &&
          routeUrl(`/wp/v2/${key}`) === endpoint
        );
      }
      const label =
        hostname === "ires.ubc.ca" && key === "wpa-helper"
          ? "WordPress Archives Blocks"
          : hostname === "korean.arts.ubc.ca" && key === "ubcvrpress"
            ? "Tours"
            : null;
      if (!label || Object.hasOwn(routes, `/wp/v2/${key}`)) return false;
      const item = object(types[key]);
      return (
        item.name === label &&
        item.slug === key &&
        item.has_archive === false &&
        item.rest_namespace === "wp/v2" &&
        item.rest_base === key &&
        link(item, "wp:items") === `https://${hostname}/wp-json/wp/v2/${key}`
      );
    },
    collection({ type, definition, namespace, restBase, collection }) {
      const reviewedOrganizer = hostname === "www.advancinghealth.ubc.ca" && type === "tribe_organizer";
      if (
        reviewedOrganizer &&
        (definition.name !== "Organizers" ||
          definition.slug !== type ||
          definition.has_archive !== false ||
          namespace !== "wp/v2" ||
          restBase !== type ||
          collection !== `https://${hostname}/wp-json/wp/v2/${type}`)
      )
        throw new Error("Reviewed organizer type changed");
      const reviewedVisitLocation = hostname === "visit.ubc.ca" && type === "location";
      if (
        reviewedVisitLocation &&
        (definition.name !== "Locations" ||
          definition.slug !== type ||
          definition.has_archive !== false ||
          namespace !== "wp/v2" ||
          restBase !== type ||
          collection !== `https://${hostname}/wp-json/wp/v2/${type}`)
      )
        throw new Error("Reviewed location type changed");
      const reviewedVisitSearch = hostname === "visit.ubc.ca" && type === "page";
      if (
        reviewedVisitSearch &&
        (definition.name !== "Pages" ||
          definition.slug !== type ||
          definition.has_archive !== false ||
          namespace !== "wp/v2" ||
          restBase !== "pages" ||
          collection !== `https://${hostname}/wp-json/wp/v2/pages`)
      )
        throw new Error("Reviewed search page type changed");
      const allowIdenticalRecurrences =
        type === "event" &&
        RECURRING_EVENT_HOSTS.has(hostname) &&
        definition.name === "Events" &&
        definition.slug === "event" &&
        definition.has_archive === "events/event" &&
        namespace === "wp/v2" &&
        restBase === "events";
      const reviewedOrganizerIds = new Set<number>();
      const reviewedLocationIds = new Set<number>();
      let reviewedSearchPage = false;
      return {
        allowIdenticalRecurrences,
        assertPage(count, pageCount, rowCount) {
          if (reviewedOrganizer && (count !== 12 || pageCount !== 1 || rowCount !== 12))
            throw new Error("Reviewed organizer inventory changed");
          if (reviewedVisitLocation && (count !== 60 || pageCount !== 1 || rowCount !== 60))
            throw new Error("Reviewed location inventory changed");
          if (reviewedVisitSearch && (count !== 68 || pageCount !== 1 || rowCount !== 68))
            throw new Error("Reviewed search inventory changed");
        },
        beforeNormalizeRow(row, id) {
          if (
            hostname === "orthopaedics.med.ubc.ca" &&
            type === "post" &&
            id === 5444 &&
            row.link === `https://${hostname}/` &&
            row.modified_gmt === "-0001-11-30T07:00:00" &&
            object(row.title).rendered === "" &&
            corroboratedOrthopaedicsHomepage
          )
            return "omit";
          return "normalize";
        },
        row(row, id, url, sourceModified) {
          if (
            reviewedVisitLocation &&
            (VISIT_MISSING_LOCATION_RECORDS.has(id) ||
              url === VISIT_MISSING_LOCATION ||
              url === VISIT_MISSING_RESTAURANT)
          ) {
            const expected = VISIT_MISSING_LOCATION_RECORDS.get(id);
            if (
              !expected ||
              row.link !== expected[0].replace("https://", "http://") ||
              url !== expected[0] ||
              object(row.title).rendered !== expected[1] ||
              sourceModified !== expected[2]
            )
              throw new Error("Reviewed location identity changed");
            reviewedLocationIds.add(id);
            return "missing-location";
          }
          if (reviewedVisitSearch && (id === 970 || url === "https://visit.ubc.ca/?s=search")) {
            if (
              id !== 970 ||
              url !== "https://visit.ubc.ca/?s=search" ||
              object(row.title).rendered !== "Search" ||
              sourceModified !== "2019-10-23T15:47:35Z"
            )
              throw new Error("Reviewed search page identity changed");
            const $ = load(homepage.snapshot.body);
            const forms = $("form")
              .toArray()
              .filter((node) => {
                const form = $(node);
                const action = form.attr("action");
                if (form.attr("method")?.toLowerCase() !== "get" || !action) return false;
                try {
                  return (
                    hostUrl(action, hostname, homepage.snapshot.url) === `https://${hostname}/` &&
                    form.find('input[name="s"][type="text"]').length === 1
                  );
                } catch {
                  return false;
                }
              });
            if (forms.length !== 1) throw new Error("Reviewed search page lacks its source form");
            reviewedSearchPage = true;
            return "search-control";
          }
          if (reviewedOrganizer) {
            const expected = ADVANCING_HEALTH_ORGANIZER_ROOT_RECORDS.get(id);
            if (url === ADVANCING_HEALTH_ORGANIZER_ROOT || expected) {
              if (
                url !== ADVANCING_HEALTH_ORGANIZER_ROOT ||
                !expected ||
                object(row.title).rendered !== expected[0] ||
                sourceModified !== expected[1]
              )
                throw new Error("Reviewed organizer identity changed");
              reviewedOrganizerIds.add(id);
              return "non-document";
            }
          }
          if (
            hostname === "orthopaedics.med.ubc.ca" &&
            type === "page" &&
            id === 133 &&
            url === `https://${hostname}/` &&
            object(row.title).rendered === "UBC Orthopaedics" &&
            sourceModified === "2026-07-07T22:50:50Z"
          )
            corroboratedOrthopaedicsHomepage = true;
          return "document";
        },
        complete() {
          if (reviewedOrganizer && reviewedOrganizerIds.size !== ADVANCING_HEALTH_ORGANIZER_ROOT_RECORDS.size)
            throw new Error("Reviewed organizer inventory changed");
          if (reviewedVisitSearch && !reviewedSearchPage) throw new Error("Reviewed search inventory changed");
          if (reviewedVisitLocation && reviewedLocationIds.size !== VISIT_MISSING_LOCATION_RECORDS.size)
            throw new Error("Reviewed location inventory changed");
        },
      };
    },
  };
}
