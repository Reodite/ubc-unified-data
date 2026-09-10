import { load } from "cheerio";
import type { Http, Output } from "../base.ts";
import { InvalidValueError, register, utcnow, wants } from "../base.ts";
import { FACT_COLUMNS, publishFacts } from "../public-facts.ts";
import {
  contentLinks,
  document,
  plainText,
  uniqueRows,
  wordpressDocument,
  wordpressPages,
  type Row,
  type SourceDocument,
} from "../source-documents.ts";

export const HOUSING_HOST = "vancouver.housing.ubc.ca";
export const HOUSING_BASE = `https://${HOUSING_HOST}`;
const RESIDENCE_SITEMAP = `${HOUSING_BASE}/wp-sitemap-posts-residences-1.xml`;
const ROOM_SITEMAP = `${HOUSING_BASE}/wp-sitemap-posts-rooms-1.xml`;

// Selected public application, first-year, waitlist, payment and move-in guidance pages.
export const GUIDANCE_IDS = [
  46, 50, 54, 56, 58, 65, 381, 885, 887, 895, 911, 2623, 6747, 16817, 17282, 17468, 21598, 21697, 23325, 23333,
];

export interface HousingEntry {
  url: string;
  lastmod: string | null;
}

export function housingSitemap(xml: string, section: "residences" | "rooms"): HousingEntry[] {
  const $ = load(xml, { xml: true });
  if ($("urlset").length !== 1) throw new InvalidValueError(`Expected the housing ${section} sitemap`);
  const entries = $("urlset > url")
    .map((_, node) => ({
      url: $(node).children("loc").text().trim(),
      lastmod: $(node).children("lastmod").text().trim() || null,
    }))
    .get();
  for (const entry of entries) {
    const url = new URL(entry.url);
    if (url.origin !== HOUSING_BASE || !new RegExp(`^/${section}/[^/]+/$`).test(url.pathname))
      throw new InvalidValueError(`Unexpected housing sitemap URL: ${entry.url}`);
  }
  if (!entries.length || new Set(entries.map((entry) => entry.url)).size !== entries.length)
    throw new InvalidValueError(`Empty or duplicate housing ${section} sitemap`);
  return entries;
}

export function housingPage(html: string, entry: HousingEntry, kind: "residence" | "room", at: string): SourceDocument {
  const $ = load(html);
  const body = $(".entry-content").first();
  const title = $("h1").first().html() ?? "";
  if (!body.length || !plainText(body.html() ?? "") || !title)
    throw new InvalidValueError(`Missing housing content: ${entry.url}`);
  const canonical = $("link[rel=canonical]").attr("href") || entry.url;
  if (new URL(canonical).origin !== HOUSING_BASE || new URL(canonical).pathname !== new URL(entry.url).pathname)
    throw new InvalidValueError(`Unexpected housing canonical URL: ${canonical}`);
  const slug = new URL(entry.url).pathname.split("/").filter(Boolean).at(-1)!;
  const page = document({
    sourceId: `housing_${kind}`,
    upstreamId: slug,
    url: canonical,
    campus: "vancouver",
    title,
    html: body.html() ?? "",
    modified: entry.lastmod,
    retrievedAt: at,
  });
  const facts = $("#quickfacts").first();
  const factsText = plainText(facts.html() ?? "");
  const bedMatch = /\b([\d,]+)\s+beds\b/i.exec(factsText);
  return {
    ...page,
    slug,
    quick_facts_text: factsText,
    undergraduate_audience: /\bundergraduate\b/i.test(factsText),
    beds: kind === "residence" && bedMatch ? Number(bedMatch[1]!.replaceAll(",", "")) : null,
    front_desk_text: kind === "residence" ? plainText($("#address").first().html() ?? "") || null : null,
    fee_urls: contentLinks(facts.html() ?? "", entry.url)
      .filter((link) => new URL(link.url).pathname.startsWith("/applications/fees-payments/"))
      .map((link) => link.url),
    room_urls: contentLinks(body.html() ?? "", entry.url)
      .filter(
        (link) => new URL(link.url).origin === HOUSING_BASE && /^\/rooms\/[^/]+\/?$/.test(new URL(link.url).pathname),
      )
      .map((link) => link.url),
    residence_urls: contentLinks(body.html() ?? "", entry.url)
      .filter(
        (link) =>
          new URL(link.url).origin === HOUSING_BASE && /^\/residences\/[^/]+\/?$/.test(new URL(link.url).pathname),
      )
      .map((link) => link.url),
  };
}

/** WordPress page routes treat a trailing slash or fragment as the same citation target. */
export function housingUrlKey(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

function hasHousingLink(values: unknown, target: string): boolean {
  return (values as string[]).some((value) => housingUrlKey(value) === housingUrlKey(target));
}

export function undergraduateResidence(page: SourceDocument): boolean {
  return /\bundergraduate\b/i.test(String(page.quick_facts_text));
}

/** Extract price observations with short row/column/date labels, without including table markup or prose. */
export function housingFeeTables(page: SourceDocument, residenceIds: string[]): Row[] {
  const $ = load(page.content_html, {}, false);
  const headings: Array<{ level: number; title: string }> = [];
  const result: Row[] = [];
  $("h1,h2,h3,h4,h5,h6,table").each((_, element) => {
    const node = $(element);
    if (node.parents("table").length) return;
    if (/^h[1-6]$/.test(element.tagName)) {
      const level = Number(element.tagName[1]);
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, title: plainText(node.html() ?? "") });
      return;
    }
    const sectionLabels = headings.map((heading) => heading.title).filter((heading) => /\b20\d{2}\b/.test(heading));
    let labels: string[] | null = null;
    let period: string | null = null;
    const values: Row[] = [];
    node.find("tr").each((rowIndex, tr) => {
      const cells = $(tr).children("th,td").toArray();
      const texts = cells.map((cell) => plainText($(cell).html() ?? ""));
      const nonempty = texts.filter(Boolean);
      if (!texts.some((value) => value.includes("$"))) {
        if (nonempty.length === 1 && /\b(?:contract|term|session)\b/i.test(nonempty[0]!)) {
          period = nonempty[0]!;
        } else if (labels === null && texts.length >= 2) {
          if (
            cells.some(
              (cell) => Number($(cell).attr("colspan") ?? 1) !== 1 || Number($(cell).attr("rowspan") ?? 1) !== 1,
            )
          ) {
            throw new InvalidValueError(`Ambiguous housing fee header: ${page.source_url}`);
          }
          labels = texts;
        }
        return;
      }
      if (!labels || !texts[0] || texts[0].includes("$"))
        throw new InvalidValueError(`Missing housing fee labels: ${page.source_url}`);
      for (let column = 1; column < texts.length; column++) {
        const value = texts[column]!;
        const match = /^\$((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?(?:\s*\/\s*(person))?(\*{0,3})$/i.exec(value);
        if (!match && !/^(?:[—–-]|\s*)$/.test(value))
          throw new InvalidValueError(`Unrecognized housing amount: ${value}`);
        if (!labels[column] && !value) continue;
        if (
          !labels[column] ||
          Number($(cells[column]!).attr("colspan") ?? 1) !== 1 ||
          Number($(cells[column]!).attr("rowspan") ?? 1) !== 1
        ) {
          throw new InvalidValueError(`Ambiguous housing amount column: ${page.source_url}`);
        }
        values.push({
          source_row: rowIndex,
          source_column: column,
          row_label: texts[0],
          column_label: labels[column],
          period_label: period,
          amount_text: value,
          amount_cents: match
            ? Number(match[1]!.replaceAll(",", "")) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
            : null,
          amount_basis: match?.[3] ? "per_person" : null,
          footnote_markers: [...new Set(`${texts[0]} ${labels[column]} ${value}`.match(/\*+/g) ?? [])],
        });
      }
    });
    if (!values.length) return;
    const index = result.length;
    result.push({
      id: `${page.id}:table:${index}`,
      page_id: page.id,
      residence_ids: residenceIds,
      campus: "vancouver",
      title: page.title,
      table_index: index,
      section_labels: sectionLabels,
      values,
      source_context_required: true,
      source_url: page.source_url,
      source_modified_at: page.source_modified_at,
      retrieved_at: page.retrieved_at,
    });
  });
  return result;
}

export const Housing = register(
  class {
    name = "housing";
    folder = "housing";
    title = "Undergraduate residences, housing fees and application guidance";
    description =
      "Residences whose official quick facts explicitly identify undergraduate residents, their room types and fee tables, plus selected first-year, eligibility, waitlist and application guidance. No vacancies, waitlist positions or housing offers are collected.";
    sources = [
      RESIDENCE_SITEMAP,
      ROOM_SITEMAP,
      `${HOUSING_BASE}/wp-json/wp/v2/pages?parent=48`,
      `${HOUSING_BASE}/applications/`,
    ];

    async collect(http: Http, out: Output): Promise<void> {
      const at = utcnow();
      if (!wants("vancouver")) {
        await out.json("_source.json", {
          scope: "undergraduate",
          campus: "vancouver",
          skipped: "Housing source is Vancouver-only",
          retrieved_at: at,
        });
        return;
      }
      const entries = housingSitemap(await http.getText(RESIDENCE_SITEMAP), "residences");
      const allResidences = await http.map(
        async (entry) => housingPage(await http.getText(entry.url), entry, "residence", at),
        entries,
        Math.min(http.workers, 3),
      );
      const residences = allResidences.filter(undergraduateResidence);
      if (!residences.length) throw new InvalidValueError("No explicitly undergraduate housing found");
      const roomsIndex = housingSitemap(await http.getText(ROOM_SITEMAP), "rooms");
      const roomUrls = new Set(residences.flatMap((page) => page.room_urls as string[]).map(housingUrlKey));
      const allRooms = await http.map(
        async (entry) => housingPage(await http.getText(entry.url), entry, "room", at),
        roomsIndex,
        Math.min(http.workers, 3),
      );
      const rooms = allRooms.filter(
        (room) =>
          roomUrls.has(housingUrlKey(room.source_url)) ||
          residences.some((residence) => hasHousingLink(room.residence_urls, residence.source_url)),
      );
      for (const room of rooms) {
        room.residence_ids = residences
          .filter(
            (residence) =>
              hasHousingLink(residence.room_urls, room.source_url) ||
              hasHousingLink(room.residence_urls, residence.source_url),
          )
          .map((residence) => residence.id);
      }
      const feeSource = await wordpressPages(http, HOUSING_HOST, { parent: 48 });
      const linkedFees = new Set(residences.flatMap((page) => page.fee_urls as string[]).map(housingUrlKey));
      const fees = feeSource
        .filter((row) => linkedFees.has(housingUrlKey(String(row.link))) || [2113, 2122].includes(Number(row.id)))
        .map((row) => wordpressDocument(row, "housing_page", HOUSING_HOST, "vancouver", at));
      const guidanceSource = await wordpressPages(http, HOUSING_HOST, { include: GUIDANCE_IDS.join(",") });
      if (guidanceSource.length !== GUIDANCE_IDS.length)
        throw new InvalidValueError("Selected housing guidance pages are missing");
      const guidance = guidanceSource.map((row) =>
        wordpressDocument(row, "housing_page", HOUSING_HOST, "vancouver", at),
      );
      const feeTables = fees.flatMap((page) =>
        housingFeeTables(
          page,
          residences
            .filter((residence) => hasHousingLink(residence.fee_urls, page.source_url))
            .map((residence) => residence.id),
        ),
      );
      if (!rooms.length || !fees.length || !feeTables.length)
        throw new InvalidValueError("Housing source is missing rooms or fee tables");
      for (const residence of residences) {
        residence.fee_page_ids = fees
          .filter((page) => hasHousingLink(residence.fee_urls, page.source_url))
          .map((page) => page.id);
        if ((residence.fee_urls as string[]).length > 0 && (residence.fee_page_ids as string[]).length === 0) {
          throw new InvalidValueError(`Unresolved residence fee link: ${residence.source_url}`);
        }
        residence.room_type_ids = rooms
          .filter((room) => (room.residence_ids as string[]).includes(residence.id))
          .map((room) => room.id);
      }
      const datasets = [
        ["residences", residences, "one residence explicitly described as serving undergraduate students"],
        ["room_types", rooms, "one room-type page linked to at least one retained undergraduate residence"],
        ["fee_pages", fees, "one fee page for retained residences or shared summer/early-arrival guidance"],
        [
          "guidance",
          guidance,
          "one selected undergraduate/shared housing guidance page; this is not a full site mirror",
        ],
      ] as const;
      for (const [stem, rows] of datasets) uniqueRows(rows, stem);
      uniqueRows(feeTables, "housing fee tables");
      for (const [stem, rows, grain] of datasets) {
        out.describe(stem, {
          grain,
          columns: {
            ...FACT_COLUMNS,
            beds: "Published bed count, not vacancies or rooms; null if no unambiguous count appears",
            front_desk_text: "Published front-desk contact/address, which can be in a different residence",
            undergraduate_audience:
              "True when UBC's quick facts explicitly mention an undergraduate audience; not an eligibility guarantee",
            residence_ids: "Links to housing/residences.id",
          },
          joins:
            stem === "residences"
              ? ["room_type_ids[] -> housing/room_types.id", "fee_page_ids[] -> housing/fee_pages.id"]
              : stem === "room_types"
                ? ["residence_ids[] -> housing/residences.id"]
                : stem === "fee_pages"
                  ? ["id -> housing/fee_tables.page_id"]
                  : [],
        });
        await publishFacts(
          out,
          `housing/${stem}`,
          rows,
          stem === "residences"
            ? RESIDENCE_SITEMAP
            : stem === "room_types"
              ? ROOM_SITEMAP
              : `${HOUSING_BASE}/wp-json/wp/v2/pages`,
        );
      }
      out.describe("fee_tables", {
        grain:
          "one source fee table represented as labelled numeric observations, not copied HTML or inferred annual prices",
        columns: {
          ...FACT_COLUMNS,
          page_id: "Source index entry in housing/fee_pages",
          residence_ids: "Residence ids when a direct official fee link exists; empty for shared guidance",
          section_labels: "Short source labels identifying fee year/building, when available",
          values:
            "Numeric price observations with row, column and contract-date labels; amount_cents is exact, while a source dash/blank remains null",
          source_context_required:
            "Always true: eligibility, approval conditions and footnote prose are not reproduced. Consult source_url before applying a rate. Never add payment instalments to a total or assume all variants are undergraduate-eligible.",
        },
        joins: ["page_id -> housing/fee_pages.id", "residence_ids[] -> housing/residences.id"],
      });
      await publishFacts(out, "housing/fee_tables", feeTables, `${HOUSING_BASE}/wp-json/wp/v2/pages?parent=48`);
      await out.json("_source.json", {
        authority: "UBC Student Housing and Community Services",
        scope: "undergraduate",
        representation: "facts_and_links",
        campus: "vancouver",
        retrieved_at: at,
        sources: this.sources,
        robots_url: `${HOUSING_BASE}/robots.txt`,
        residences: residences.length,
        room_types: rooms.length,
        upstream_room_types: allRooms.length,
        excluded_room_types: allRooms
          .filter((room) => !rooms.some((selected) => selected.id === room.id))
          .map((room) => room.source_url),
        fee_pages: fees.length,
        fee_tables: feeTables.length,
        guidance_pages: guidance.length,
        selected_guidance_ids: GUIDANCE_IDS,
        excluded_residences: allResidences
          .filter((page) => !undergraduateResidence(page))
          .map((page) => ({
            source_url: page.source_url,
            reason:
              "Quick facts do not explicitly identify an undergraduate audience; exclusion does not imply ineligibility",
          })),
        excluded_fee_pages: feeSource
          .filter((row) => !fees.some((page) => page.upstream_id === row.id))
          .map((row) => row.link),
        notes: [
          "Shared residences and guidance can also mention graduate students. Graduate-only programs and funding are outside the collection scope.",
          "Only numeric observations and short factual labels are published. Page bodies, HTML and footnote prose are excluded. Rates have different periods, deposits, meal plans and payment schedules; consult the source before applying them.",
          "The general pages API contains empty placeholders and public test pages. This collector uses selected public guidance IDs and the advertised fees parent instead; it does not fetch those unavailable records.",
          "No room availability, application status or student records. Front-desk addresses are not assumed to be residence-building coordinates.",
          "Linked PDFs and photos are not downloaded.",
        ],
      });
    }
  },
);
