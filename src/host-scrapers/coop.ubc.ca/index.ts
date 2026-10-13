import { load, type CheerioAPI } from "cheerio";
import { discoverPublicViews } from "../../host-crawl/adapters/html-discovery.ts";
import type { PublicGetView, Snapshot } from "../../host-crawl/contracts.ts";
import { defineHtmlHost } from "../../host-crawl/scraper.ts";
import { hostUrl, pageExclusion } from "../../host-crawl/urls.ts";
import { extractArticleFromDom } from "../../prose/html.ts";
import { toSafeMarkdown } from "../../prose/markdown.ts";
import { contentRoots, normalizedText as text } from "../../scraping/html.ts";
import { hasUbcBranding } from "../../scraping/ubc.ts";
import { normalizeCoopStructure } from "./normalize.ts";

const HOST = "coop.ubc.ca";
const HOME = `https://${HOST}/`;
const TITLE = "UBC Co-op Programs";
const MAIN = "main#main-content";
const FAQ: PublicGetView = {
  path: "/about-us/faqs",
  parameter: "field_faq_type_value",
  values: ["Employer Section", "Student Section"],
  placeholder: "All",
};

function selectedFaq(url: URL): boolean {
  const entries = [...url.searchParams];
  return (
    url.pathname === FAQ.path &&
    entries.length === 1 &&
    entries[0]![0] === FAQ.parameter &&
    FAQ.values.includes(entries[0]![1])
  );
}

function excludeUrl(value: string): string | null {
  const excluded = pageExclusion(value, HOST);
  if (excluded && excluded !== "Unsupported query or form selection") return excluded;
  const url = new URL(hostUrl(value, HOST));
  const pathname = decodeURIComponent(url.pathname);
  if (
    /\/(?:antibot|admin|user|core|modules|themes|libraries|jsonapi|system|batch|search)(?:\/|$)/i.test(pathname) ||
    /^\/(?:media\/oembed|views\/ajax|node\/\d+\/(?:edit|delete|revisions))(?:\/|$)/i.test(pathname) ||
    /^\/(?:update|install|authorize)\.php(?:\/|$)/i.test(pathname) ||
    /^\/sites\/[^/]+\/(?:files\/(?:css|js|styles)|private)(?:\/|$)/i.test(pathname)
  )
    return "Administration, form action or embedded resource";
  if (url.search && !selectedFaq(url)) return "Unsupported query or form selection";
  if (selectedFaq(url)) return null;
  return excluded;
}

function institutionalHomepage($: CheerioAPI, snapshot: Snapshot): boolean {
  return (
    hasUbcBranding($, snapshot.url, {
      homepage: HOME,
      unit: TITLE,
      footer: `${TITLE}: Vancouver & Okanagan`,
      allowHttpWordmark: true,
    }) && $(MAIN).length === 1
  );
}

function retainPostingInstructions($: CheerioAPI): boolean {
  const forms = $(`${MAIN} form.webform-submission-post-a-job-form`);
  forms.each((_, form) => {
    $(form)
      .find("#edit-attachment-optional---description")
      .each((_, node) => {
        const description = $(node);
        if (
          !description.find("a[href],img,iframe,object,embed").length &&
          /^One file only\.\s*\d+(?:\.\d+)?\s*(?:KB|MB|GB) limit\.\s*Allowed types:\s*[a-z0-9]+(?:\s+[a-z0-9]+)*\.$/i.test(
            text(description.text()),
          )
        )
          description.remove();
      });
    $(form)
      .find("#edit-processed-text.webform-type-processed-text")
      .each((_, node) => {
        const block = $(node);
        if (
          block.children().length === 1 &&
          block.children().is("h4") &&
          !block.children().children().length &&
          text(block.text()) === "Organization Details"
        )
          block.remove();
      });
    // Drupal stores substantive posting guidance both as processed prose and as HTML tooltips beside controls.
    const instructions = $(form).find(
      ".webform-type-processed-text,.webform-element-description,.webform-element-help[data-webform-help]",
    );
    const roots = contentRoots($, instructions);
    const container = $("<div>");
    roots.each((_, node) => {
      const help = $(node).attr("data-webform-help");
      if (help !== undefined) {
        const fragment = load(help, {}, false);
        container.append(
          fragment(".webform-element-help--title,.webform-element-help--content")
            .toArray()
            .map((part) => fragment.html(part))
            .join("\n"),
        );
      } else container.append($(node).clone());
    });
    container.find("form,input,select,textarea,button,label,script,style,noscript,template,.form-actions").remove();
    $(form).replaceWith(container);
  });
  return forms.length > 0;
}

function hasFaqAnswers($: CheerioAPI): boolean {
  const results = $(`${MAIN} .view-faqs > .view-content`).clone();
  results.find("form,nav,[role=navigation],script,style,noscript,template,.view-empty").remove();
  // Filter labels are not answers; require paired source questions and prose.
  return results
    .find(".widget-accordion,.views-row,details")
    .toArray()
    .some((node) => {
      const row = $(node);
      const question = row.find(".accordion__trigger,.views-field-title,.views-field-field-question,summary").first();
      const answer = row
        .find(".accordion__content,.views-field-body,.views-field-field-answer,.field--name-body")
        .first();
      const prose = answer.length ? answer.clone() : row.is("details") ? row.clone() : $([]);
      prose
        .find("h1,h2,h3,h4,h5,h6,summary,a,button,img,iframe,svg,video,audio,object,embed,canvas,source,track")
        .remove();
      return Boolean(text(question.text()) && toSafeMarkdown(prose.html() ?? "", HOME).markdown.trim());
    });
}

export const coopScraper = defineHtmlHost({
  hostname: HOST,
  title: TITLE,
  scope:
    "Public Co-op program information, employer and student guidance, FAQs, announcements, testimonials and posting instructions.",
  adapter: {
    kind: "html",
    allowedTypes: [],
    views: [FAQ],
    optionalAbsent: ["/jsonapi"],
    sitemaps: [
      {
        path: "/sitemap.xml",
        rootOnlyLocation: "https://master-7rqtwti-d5a7pezenil4q.ca-1.platformsh.site//",
      },
    ],
  },
  excludeUrl,
  officialHomepage: ($, snapshot) => hostUrl(snapshot.url, HOST) === HOME && institutionalHomepage($, snapshot),
  extractPage($, snapshot) {
    const requested = new URL(hostUrl(snapshot.requested_url, HOST));
    const resolved = new URL(hostUrl(snapshot.url, HOST));
    if (
      selectedFaq(requested) &&
      requested.searchParams.get(FAQ.parameter) !== resolved.searchParams.get(FAQ.parameter)
    )
      throw new Error("Selected FAQ observation loses its requested view");
    if ($(MAIN).length !== 1) throw new Error(`No unique recognized prose container at ${snapshot.url}`);
    const canonical = $("link[rel=canonical]").attr("href");
    if (canonical) {
      const url = hostUrl(canonical, HOST, snapshot.url);
      if (excludeUrl(url)) throw new Error("Canonical URL is outside the public page policy");
    }
    const selected = selectedFaq(resolved);
    if (selected && !hasFaqAnswers($)) throw new Error("Selected FAQ view contains no actual answers");
    // Canonical tags commonly point filtered views back to their unselected page.
    if (selected) $("link[rel=canonical]").remove();
    if (resolved.pathname === FAQ.path) {
      const destinations = discoverPublicViews(coopScraper, snapshot);
      const select = $("select").filter((_, node) => $(node).attr("name") === FAQ.parameter);
      const choices = $("<ul>");
      for (const url of destinations) {
        const value = new URL(url).searchParams.get(FAQ.parameter);
        const label = text(
          select
            .find("option")
            .filter((_, node) => $(node).attr("value") === value)
            .text(),
        );
        if (!label) throw new Error("FAQ audience option lacks source label text");
        choices.append($("<li>").append($("<a>").attr("href", url).text(label)));
      }
      select.closest("form").replaceWith(choices);
    }

    // Toggle buttons wrap block headings; their control emphasis must not become orphan Markdown markers.
    $(`${MAIN} .widget-accordion .accordion__trigger > button`).each((_, node) => {
      const button = $(node);
      const outside = button.clone();
      outside.children().remove();
      if (button.children().length === 1 && button.children().is("h1,h2,h3,h4,h5,h6") && !text(outside.text()))
        button.replaceWith(button.contents());
    });
    const omittedPostingControls = retainPostingInstructions($);
    normalizeCoopStructure($);
    // Program contact templates place line breaks around website URLs and immediately after mailto:.
    $("#unit-content #sidebar-second .view-program-views .node--view-mode-contact a[href]").each((_, node) => {
      const href = $(node).attr("href")!.trim();
      $(node).attr(
        "href",
        href.replace(/^mailto:[ \t\r\n]+([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})$/i, "mailto:$1"),
      );
    });
    $("#unit-content #sidebar-second .view-program-views h3 > .field--name-field-location-name").each((_, node) => {
      $(node).replaceWith($(node).contents());
    });
    const selectors = [
      MAIN,
      "#unit-content #sidebar-second .view-program-views",
      "#unit-content #sidebar-second .view-testimonials",
    ];
    if ($("body.page-node-type-homepage").length) {
      // The homepage's mismatched closing tags place programs and announcements outside main after HTML parsing.
      selectors.push(
        "#featured .view-homepage-carousel figcaption",
        "#unit-content > .programs",
        "#unit-content > section:has(.view-announcements)",
      );
    }
    $(selectors.join(","))
      .find(
        "form,input,select,textarea,.form-actions,.views-slideshow-controls-top,.views-slideshow-controls-bottom,svg[role=presentation]",
      )
      .remove();
    const input = extractArticleFromDom($, snapshot, {
      key: HOST,
      title: TITLE,
      host: HOST,
      campus: null,
      strategy: "drupal",
      selectors: [selectors.join(",")],
      strictSelectors: true,
      scope: excludeUrl,
    });
    if (omittedPostingControls)
      input.warnings = [
        ...(input.warnings ?? []),
        "Interactive posting controls are omitted; consult the source page to complete the form.",
      ];
    if (selected) {
      input.url = resolved.href;
      delete input.upstreamId;
    }
    return { kind: "document", input };
  },
});
