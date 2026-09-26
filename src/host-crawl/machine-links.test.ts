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

const blockLog = (user = "AmberSaundry") =>
  `<div id="contentSub"><div class="mw-contributions-user-tools"><a class="mw-contributions-link-block-log" title="Special:Log/block" href="/index.php?title=Special:Log/block&amp;page=User%3A${user}">block log</a></div></div>`;

describe("observed MediaWiki administrative links", () => {
  const source = `${home}Special:Contributions/AmberSaundry`;
  it.each(["AmberSaundry", "RehanRafique.1"])("recognizes the matching block-log tool for account %s", (user) => {
    const page = `${home}Special:Contributions/${user}`;
    const log = `${home}index.php?title=Special:Log/block&page=User%3A${user}`;
    expect(discoverMachineLinks(document(blockLog(user)), host, page)).toEqual(new Set([log]));
  });
  it.each([
    { label: "different user", source, markup: blockLog("AnotherUser") },
    { label: "ordinary page", source: home, markup: blockLog() },
    { label: "changed context", source, markup: blockLog().replace('id="contentSub"', 'id="main"') },
    {
      label: "changed control",
      source,
      markup: blockLog().replace("mw-contributions-link-block-log", "ordinary-link"),
    },
    { label: "changed label", source, markup: blockLog().replace("block log</a>", "read article</a>") },
    { label: "extra query", source, markup: blockLog().replace('AmberSaundry"', 'AmberSaundry&action=edit"') },
    { label: "no ownership title", source, markup: blockLog().replace('title="Special:Log/block"', "") },
    {
      label: "login route",
      source,
      markup: blockLog().replace("Special:Log/block&amp;page", "Special:UserLogin&amp;page"),
    },
  ])("does not exempt $label", ({ source, markup }) => {
    expect(discoverMachineLinks(document(markup), host, source)).toEqual(new Set());
  });
});

const prefixedForm = (prefix: string, dataAction: string | null) =>
  form()
    .replace('method="post"', `method="post"${dataAction === null ? "" : ` data-action="${dataAction}"`}`)
    .replace(`href="${endpoint}"`, `href="${prefix}${endpoint}"`);

describe("observed front-controller refresh identities", () => {
  it.each(
    ["/index%2ephp", "/index%2Ephp"].flatMap((prefix) => ["/contact", "/events"].map((path) => ({ prefix, path }))),
  )("recognizes the exact owned prefix at $prefix$path", ({ prefix, path }) => {
    const source = new URL(`${prefix}${path}`, home).href;
    expect(discoverMachineLinks(document(prefixedForm(prefix, `${prefix}${path}`)), host, source)).toEqual(
      new Set([new URL(`${prefix}${endpoint}`, home).href]),
    );
  });

  it.each([
    { label: "missing data action", source: "/index%2ephp/contact", prefix: "/index%2ephp", data: null },
    { label: "other page", source: "/index%2ephp/contact", prefix: "/index%2ephp", data: "/index%2ephp/events" },
    {
      label: "other data-action spelling",
      source: "/index%2ephp/contact",
      prefix: "/index%2ephp",
      data: "/index%2Ephp/contact",
    },
    {
      label: "other endpoint spelling",
      source: "/index%2ephp/contact",
      prefix: "/index%2Ephp",
      data: "/index%2ephp/contact",
    },
    { label: "clean source", source: "/contact", prefix: "/index%2ephp", data: "/contact" },
    {
      label: "literal front controller",
      source: "/index.php/contact",
      prefix: "/index.php",
      data: "/index.php/contact",
    },
    {
      label: "nested prefix",
      source: "/index%2ephp/index%2ephp/contact",
      prefix: "/index%2ephp/index%2ephp",
      data: "/index%2ephp/index%2ephp/contact",
    },
    {
      label: "double encoding",
      source: "/index%252ephp/contact",
      prefix: "/index%252ephp",
      data: "/index%252ephp/contact",
    },
    {
      label: "nested source with single endpoint",
      source: "/index%2ephp/index%2Ephp/contact",
      prefix: "/index%2ephp",
      data: "/index%2ephp/index%2Ephp/contact",
    },
    {
      label: "nested literal controller",
      source: "/index%2ephp/index.php/contact",
      prefix: "/index%2ephp",
      data: "/index%2ephp/index.php/contact",
    },
    {
      label: "source query",
      source: "/index%2ephp/contact?page_id=7",
      prefix: "/index%2ephp",
      data: "/index%2ephp/contact",
    },
    {
      label: "source fragment",
      source: "/index%2ephp/contact#form",
      prefix: "/index%2ephp",
      data: "/index%2ephp/contact",
    },
    {
      label: "empty data-action query",
      source: "/index%2ephp/contact",
      prefix: "/index%2ephp",
      data: "/index%2ephp/contact?",
    },
    {
      label: "data-action dot segment",
      source: "/index%2ephp/contact",
      prefix: "/index%2ephp",
      data: "/index%2ephp/nested/../contact",
    },
    {
      label: "foreign data action",
      source: "/index%2ephp/contact",
      prefix: "/index%2ephp",
      data: "https://other.ubc.ca/index%2ephp/contact",
    },
  ])("does not infer prefix ownership from $label", ({ source, prefix, data }) => {
    expect(discoverMachineLinks(document(prefixedForm(prefix, data)), host, new URL(source, home).href)).toEqual(
      new Set(),
    );
  });

  it.each(["form_id", "captcha_sid", "captcha_token", "captcha_response"])(
    "still requires the prefixed form's %s control",
    (name) => {
      const body = prefixedForm("/index%2ephp", "/index%2ephp/contact").replace(
        new RegExp(`<input[^>]*name="${name}"[^>]*>`),
        "",
      );
      expect(discoverMachineLinks(document(body), host, `${home}index%2ephp/contact`)).toEqual(new Set());
    },
  );
});
