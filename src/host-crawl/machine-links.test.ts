import { describe, expect, it } from "vitest";
import { discoverMachineLinks } from "./machine-links.ts";

const host = "fixture.ubc.ca";
const home = `https://${host}/`;
const document = (body: string, head = "") => `<html><head>${head}</head><body>${body}</body></html>`;
const feed = (href: string) => `<link rel="alternate" type="application/atom+xml" href="${href}">`;
const id = "contact_form";
const endpoint = `/image-captcha-refresh/${id}`;
const form = () =>
  `<form id="contact" method="post"><input type="hidden" name="form_id" value="${id}"><fieldset class="captcha captcha-type-challenge--image"><input type="hidden" name="captcha_sid"><input type="hidden" name="captcha_token"><input type="text" name="captcha_response"><a class="reload-captcha" href="${endpoint}">Reload</a></fieldset></form>`;

const discover = (body: string, head = "") => discoverMachineLinks(document(body, head), host, home);

describe("raw machine-link identity evidence", () => {
  it("uses a declared safe HTML base without changing the exact resolved identity", () => {
    expect(discover("", `<base href="/archive/">${feed("updates.atom")}`)).toEqual(
      new Set([`${home}archive/updates.atom`]),
    );
  });

  it("normalizes HTML relation and MIME casing and deduplicates repeated declarations", () => {
    expect(
      discover(
        "",
        `${feed("/history.atom")}${feed("/history.atom").replaceAll("alternate", "ALTERNATE enclosure").replace("application/atom+xml", "APPLICATION/ATOM+XML")}`,
      ),
    ).toEqual(new Set([`${home}history.atom`]));
  });

  it("preserves the existing legacy HTTP candidate rule without creating aliases", () => {
    expect(discover("", feed(`http://${host}/history.atom`))).toEqual(new Set([`${home}history.atom`]));
  });

  it.each([
    "/history.atom?",
    "/history.atom#",
    "/nested/../history.atom",
    "/nested/%2E%2e/history.atom",
    "/nested%2f..%2fhistory.atom",
    "/%00history.atom",
    "/%C2%85history.atom",
    "/%5chistory.atom",
    "/%zz/history.atom",
    "/%252ehistory.atom",
    "/history\t.atom",
    "//fixture.ubc.ca//history.atom",
    "https://other.ubc.ca/history.atom",
    "https://reader@fixture.ubc.ca/history.atom",
    "https://fixture.ubc.ca:8443/history.atom",
    "javascript:history.atom",
  ])("does not prove an unsafe or ambiguous endpoint: %s", (href) => {
    expect(discover("", feed(href))).toEqual(new Set());
  });

  it.each(['<base href="https://other.ubc.ca/">', '<base href="/a/"><base href="/b/">'])(
    "keeps unsupported base declarations strict: %s",
    (base) => {
      expect(() => discover("", `${base}${feed("history.atom")}`)).toThrow();
    },
  );

  it("accepts explicitly matching form associations without reading token values", () => {
    const associated = form()
      .replaceAll("<input", '<input form="contact"')
      .replace("<fieldset", '<fieldset form="contact"');
    expect(discover(associated)).toEqual(new Set([new URL(endpoint, home).href]));
  });

  it.each([
    (value: string) => `${value.replaceAll("<input", '<input form="contact"')}<form id="contact"></form>`,
    (value: string) => value.replace('id="contact"', 'id=""').replaceAll("<input", '<input form=""'),
    (value: string) =>
      value.replace('<input type="hidden" name="form_id"', '<input form="other" type="hidden" name="form_id"'),
    (value: string) =>
      value.replace(
        '<input type="hidden" name="captcha_token"',
        '<input form="other" type="hidden" name="captcha_token"',
      ),
    (value: string) => value.replace("<fieldset", '<fieldset form="other"'),
    (value: string) =>
      value.replace(
        '<input type="hidden" name="captcha_sid">',
        '<input type="hidden" name="captcha_sid"><input type="hidden" name="captcha_sid">',
      ),
    (value: string) =>
      value.replace('<input type="text" name="captcha_response">', '<input type="hidden" name="captcha_response">'),
    (value: string) =>
      value.replace(
        '<input type="hidden" name="captcha_token">',
        '<fieldset><input type="hidden" name="captcha_token"></fieldset>',
      ),
  ])("does not borrow ambiguous or differently owned challenge controls", (mutate) => {
    expect(discover(mutate(form()))).toEqual(new Set());
  });
});
