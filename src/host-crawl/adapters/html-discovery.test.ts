import { describe, expect, it, vi } from "vitest";
import type { HostScraper, Snapshot } from "../contracts.ts";
import { assertPublicViewIdentity, discoverPublicViews, publicViewUrl, verifyHtmlDiscovery } from "./html-discovery.ts";

const hostname = "example.ubc.ca",
  origin = `https://${hostname}`;
const view = {
  path: "/faqs",
  parameter: "audience",
  placeholder: "All",
  values: ["Employer Section", "Student Section"],
};
const scraper: HostScraper = {
  hostname,
  title: "Example",
  scope: "Synthetic",
  adapter: { kind: "html", allowedTypes: [], views: [view], optionalAbsent: ["/jsonapi"] },
  vetHomepage: () => ({ accepted: true, reason: "test" }),
  extract: () => ({ kind: "excluded", reason: "test" }),
};
const form =
  '<form method="get" action="/faqs"><select name="audience"><option value="All">Any</option><option value="Employer Section">Employer</option><option value="Student Section">Student</option></select><input type="submit"></form>';
function snapshot(body = form, url = `${origin}/faqs`): Snapshot {
  return {
    body,
    url,
    requested_url: url,
    status: 200,
    headers: { "content-type": "text/html" },
    bytes: Buffer.byteLength(body),
    retrieved_at: "2026-01-01T00:00:00Z",
  };
}
describe("finite publisher GET views", () => {
  it("generates both advertised selections, not the placeholder or arbitrary form input", () => {
    const urls = discoverPublicViews(scraper, snapshot());
    expect(urls).toEqual([`${origin}/faqs?audience=Employer%20Section`, `${origin}/faqs?audience=Student%20Section`]);
    expect(() => publicViewUrl(hostname, view, "All")).toThrow();
    expect(discoverPublicViews(scraper, snapshot(form, `${origin}/different`))).toEqual([]);
  });
  it.each([
    form.replace('method="get"', 'method="post"'),
    form.replace('action="/faqs"', 'action="https://else.ubc.ca/faqs"'),
    form.replace('action="/faqs"', 'action="/different"'),
    form.replace('action="/faqs"', 'action="/faqs?extra=yes"'),
    form.replace("<select ", "<select multiple "),
    form.replace("<select ", "<select disabled "),
    form.replace("</form>", '<input type="hidden" name="token" value="secret"></form>'),
    form.replace("</select>", '<option value="Unexpected">Extra</option></select>'),
    form.replace('value="Student Section"', 'value="Employer Section"'),
    form.replace('value="Student Section"', 'disabled value="Student Section"'),
    form + form,
    "<p>No form remains.</p>",
  ])("rejects changed form grammar", (body) => {
    expect(() => discoverPublicViews(scraper, snapshot(body))).toThrow();
  });
  it("keeps selected physical identity even when the HTML canonical names the unfiltered page", () => {
    const url = publicViewUrl(hostname, view, view.values[0]!);
    expect(() =>
      assertPublicViewIdentity(scraper, url, snapshot(`<link rel="canonical" href="${origin}/faqs">${form}`, url)),
    ).not.toThrow();
    expect(() => assertPublicViewIdentity(scraper, url, snapshot())).toThrow(/lost/);
    expect(() => assertPublicViewIdentity(scraper, `${url}&audience=Student%20Section`, snapshot())).toThrow(
      /Undeclared/,
    );
    expect(() => assertPublicViewIdentity(scraper, `${url}&page=1`, snapshot())).toThrow(/Undeclared/);
  });
  it.each([200, 401, 403, 500])("does not mistake optional inventory status %s for absence", async (status) => {
    const read = vi.fn(async () => ({ sha256: "a".repeat(64), snapshot: { ...snapshot(), status } }));
    await expect(verifyHtmlDiscovery(scraper, read)).rejects.toThrow(/inventory/);
    expect(read).toHaveBeenCalledWith(`${origin}/jsonapi`);
  });
  it.each([404, 410])(
    "accepts explicit absent inventory status %s without inventing CMS completeness",
    async (status) => {
      await verifyHtmlDiscovery(scraper, async () => ({ sha256: "a".repeat(64), snapshot: { ...snapshot(), status } }));
    },
  );
});
