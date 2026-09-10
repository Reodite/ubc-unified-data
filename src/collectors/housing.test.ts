import { describe, expect, it } from "vitest";
import { document } from "../source-documents.ts";
import { housingFeeTables, housingPage, housingSitemap, housingUrlKey, undergraduateResidence } from "./housing.ts";

const URL = "https://vancouver.housing.ubc.ca/residences/totem-park/";
const AT = "2026-09-10T00:00:00Z";
const HTML = `<html><head><link rel="canonical" href="${URL}"></head><body><h1>Totem Park</h1><nav>Global navigation</nav><div class="entry-content"><div id="quickfacts"><p>Winter session (September to April)</p><p>Mainly first-year undergraduate students</p><p>2,088 beds in 9 houses</p><a href="/applications/fees-payments/totem-park/">Fees</a></div><div id="address">Totem Park Front Desk, 2525 West Mall</div><a href="/rooms/shared-room/">Shared room</a></div><footer>Footer navigation</footer></body></html>`;

describe("undergraduate housing selection", () => {
  it("reads sitemap provenance and rejects foreign or duplicate URLs", () => {
    const xml = `<urlset><url><loc>${URL}</loc><lastmod>2025-04-25T18:07:48-07:00</lastmod></url></urlset>`;
    expect(housingSitemap(xml, "residences")).toEqual([{ url: URL, lastmod: "2025-04-25T18:07:48-07:00" }]);
    expect(() => housingSitemap(xml.replace("vancouver.housing.ubc.ca", "example.org"), "residences")).toThrow(
      /Unexpected/,
    );
    expect(() => housingSitemap("<html>Blocked</html>", "residences")).toThrow(/sitemap/);
  });

  it("uses explicit undergraduate facts and separates front desks from residence locations", () => {
    const page = housingPage(HTML, { url: URL, lastmod: null }, "residence", AT);
    expect(undergraduateResidence(page)).toBe(true);
    expect(page).toMatchObject({
      beds: 2088,
      front_desk_text: "Totem Park Front Desk, 2525 West Mall",
      room_urls: ["https://vancouver.housing.ubc.ca/rooms/shared-room/"],
      fee_urls: ["https://vancouver.housing.ubc.ca/applications/fees-payments/totem-park/"],
    });
    expect(page.content_text).not.toMatch(/Global navigation|Footer navigation/);
    expect(undergraduateResidence({ ...page, quick_facts_text: "Mainly graduate students" })).toBe(false);
    expect(undergraduateResidence({ ...page, quick_facts_text: "Student Family Residence" })).toBe(false);
  });

  it("matches the published Totem Park fee link without a trailing slash", () => {
    expect(housingUrlKey("https://vancouver.housing.ubc.ca/applications/fees-payments/totem-park")).toBe(
      housingUrlKey("https://vancouver.housing.ubc.ca/applications/fees-payments/totem-park/#fees"),
    );
  });

  it("fails on missing content rather than preserving a challenge page as housing data", () => {
    expect(() => housingPage("<h1>Verify you are human</h1>", { url: URL, lastmod: null }, "residence", AT)).toThrow(
      /Missing/,
    );
  });
});

describe("housing fee facts", () => {
  it("preserves numeric observations and short period labels without copying prose or HTML", () => {
    const page = document({
      sourceId: "housing_page",
      upstreamId: 1075,
      url: "https://vancouver.housing.ubc.ca/applications/fees-payments/totem-park/",
      title: "Totem Park Fees",
      campus: "vancouver",
      retrievedAt: AT,
      html: `<h2>2026/27 Fees</h2><p>Explanatory prose must not be published.</p><table><tr><th>Room</th><th>Room fee</th><th>Meal plan</th><th>Total</th></tr><tr><td colspan="4">Winter Session Contract—September 5, 2026 to April 28, 2027</td></tr><tr><td>Shared</td><td>$6,376</td><td>$7,712.32</td><td>$14,088.32</td></tr></table><h2>Payment schedule</h2><p>More excluded prose.</p><table><tr><th>Payment</th><th>Nano Suite</th></tr><tr><td>Due on acceptance</td><td>$1,100</td></tr><tr><td>Due monthly</td><td>$959.66/person**</td></tr></table>`,
    });
    const tables = housingFeeTables(page, ["housing_residence:totem-park"]);
    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ section_labels: ["2026/27 Fees"], source_context_required: true });
    expect(tables[0]?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row_label: "Shared",
          column_label: "Total",
          amount_cents: 1408832,
          period_label: "Winter Session Contract—September 5, 2026 to April 28, 2027",
        }),
      ]),
    );
    expect(tables[1]?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row_label: "Due monthly",
          column_label: "Nano Suite",
          amount_cents: 95966,
          amount_basis: "per_person",
          footnote_markers: ["**"],
        }),
      ]),
    );
    expect(JSON.stringify(tables)).not.toMatch(/excluded prose|Explanatory prose|<table|<p>/);
    expect(tables[0]).not.toHaveProperty("table_html");
    expect(tables[0]).not.toHaveProperty("preceding_text");
    expect(tables[1]).not.toHaveProperty("annual_amount");
  });
});
