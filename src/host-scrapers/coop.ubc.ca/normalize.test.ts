import { readFileSync } from "node:fs";
import { load, type CheerioAPI } from "cheerio";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../host-crawl/contracts.ts";
import { assertSafeMarkdown, toSafeMarkdown } from "../../prose/markdown.ts";
import { coopScraper } from "./index.ts";

const HOME = "https://coop.ubc.ca/";
const text = (value: string) => value.replace(/\s+/g, " ").trim();

function page(body: string, classes = "", outside = ""): Snapshot {
  return {
    requested_url: HOME,
    url: HOME,
    status: 200,
    headers: { "content-type": "text/html" },
    retrieved_at: "2026-06-03T12:00:00Z",
    body: `<html><head><title>Synthetic structure</title></head><body class="${classes}"><div id="unit-content"><main id="main-content">${body}</main>${outside}</div></body></html>`,
    bytes: 0,
  };
}

function changed(observation: Snapshot, change: ($: CheerioAPI) => void): Snapshot {
  const $ = load(observation.body);
  change($);
  return { ...observation, body: $.html() };
}

function extract(observation: Snapshot) {
  const result = coopScraper.extract(observation);
  if (result.kind !== "document") throw new Error(result.reason);
  const converted = toSafeMarkdown(result.input.html, result.input.url);
  assertSafeMarkdown(converted.markdown);
  const rendered = load(new MarkdownIt().render(converted.markdown));
  return {
    ...converted,
    input: result.input,
    rendered,
    prose: text(rendered.text()),
  };
}

function spotlight(): Snapshot {
  return page(`<div id="block-views-block-program-spotlight-block-1">
    <div class="campus-legend">CAMPUS: <span class="vancouver">Vancouver</span> <span class="okanagan">Okanagan</span></div>
    <div class="view-program-spotlight"><ul>${["vancouver okanagan", "vancouver", "okanagan"]
      .map(
        (campuses, index) =>
          `<li class="card--default"><div class="card__image ${campuses
            .split(" ")
            .map((campus) => `spotlight-${campus}`)
            .join(
              " ",
            )}"><img alt="" src="/image-${index}.jpg"></div><div class="card__footer"><a class="spotlight-title" href="/program/synthetic-${index}">Synthetic Program ${index}</a></div><div class="programs-offered"><span>Bachelors</span> <span>Masters</span></div></li>`,
      )
      .join("")}</ul></div></div>`);
}

function homepage(): Snapshot {
  const caption = `<figcaption><h1>Synthetic homepage</h1><p>Synthetic invitation.</p><a href="/employers/why-ubc-co-op">Learn more</a></figcaption>`;
  const card = (label: string, href: string, description: string) =>
    `<a class="card--default" href="${href}"><div class="card__image"><img src="/${label}.jpg" alt="${label} photo"><div>${label}</div></div><p>${description}</p></a>`;
  return page(
    `${card("Employers", "employers/why-ubc-co-op", "Employers choose suitable programs.")}${card("Students", "students/why-co-op", "Students review eligibility.")}<a class="card--default" href="students/why-co-op"></a>${card("Students", "/students/why-co-op", "Some programs have different terms.")}`,
    "page-node-type-homepage",
    `<div id="featured"><div class="view-homepage-carousel">${[false, true, true, true].map((hidden) => `<div class="views_slideshow_cycle_slide ${hidden ? "views_slideshow_cycle_hidden" : ""}">${caption}</div>`).join("")}</div></div><div class="programs"><h3>Programs</h3><div><div>${["Arts", "Science"].map((name) => `<a href="/program/${name.toLowerCase()}"><div class="unit-button">${name}</div></a>`).join("")}</div><div><a href="/program/forestry"><div class="unit-button">Forestry</div></a></div></div></div><section><div class="view-announcements">${["Mar 13, 2026", "Mar 11, 2026", "Jan 15, 2026"].map((date, index) => `<div><h3><a href="/node/${index}">Synthetic announcement ${index}</a></h3><time>${date}</time><p>Summary ${index}.</p></div>`).join("")}</div></section>`,
  );
}

describe("coop source-derived semantic structure", () => {
  it("omits only decorative duplicate spotlight image links", () => {
    const observation = changed(spotlight(), ($) => {
      $(".card__image img").each((index, node) => {
        $(node).wrap(`<a href="/program/synthetic-${index}"></a>`);
      });
    });
    const result = extract(observation);
    expect(result.links.filter((link) => link.url.includes("/program/"))).toHaveLength(3);
    expect(result.prose).not.toContain("Image");
    const informative = extract(
      changed(observation, ($) => {
        $(".card__image img").first().attr("alt", "A labelled learning facility");
      }),
    );
    expect(informative.prose).toContain("A labelled learning facility");
  });

  it("separates announcement summaries from visually padded continuation links", () => {
    const result = extract(
      page(
        '<div class="view-announcements"><div class="field--name-body"><p>Record work terms<span><a class="pl-4" href="/node/243"><strong>MORE &gt;</strong></a></span></p></div></div>',
        "page-node-type-homepage",
      ),
    );
    expect(result.prose).toContain("Record work terms MORE >");
    expect(result.links).toContainEqual({ text: "MORE >", url: `${HOME}node/243` });
  });
  it("labels campus associations per program without duplicating degree badges by campus", () => {
    const result = extract(spotlight());
    expect(
      result
        .rendered("li")
        .map((_, node) => text(result.rendered(node).text()))
        .get(),
    ).toEqual([
      "Image Synthetic Program 0 CAMPUS: Vancouver, Okanagan Bachelors Masters",
      "Image Synthetic Program 1 CAMPUS: Vancouver Bachelors Masters",
      "Image Synthetic Program 2 CAMPUS: Okanagan Bachelors Masters",
    ]);
    expect(result.prose.match(/Bachelors/g)).toHaveLength(3);
    expect(result.prose.match(/Masters/g)).toHaveLength(3);
    expect(result.links.filter((link) => link.url.includes("/program/"))).toHaveLength(3);
  });

  it.each([
    [
      "missing image",
      ($: CheerioAPI) => {
        $(".card__image").first().remove();
      },
    ],
    [
      "ambiguous image",
      ($: CheerioAPI) => {
        $("li").first().append($(".card__image").first().clone());
      },
    ],
    [
      "missing campus",
      ($: CheerioAPI) => {
        $(".card__image").first().attr("class", "card__image");
      },
    ],
    [
      "unknown campus",
      ($: CheerioAPI) => {
        $(".card__image").first().addClass("spotlight-surrey");
      },
    ],
    [
      "missing title",
      ($: CheerioAPI) => {
        $(".spotlight-title").first().remove();
      },
    ],
    [
      "empty title",
      ($: CheerioAPI) => {
        $(".spotlight-title").first().empty();
      },
    ],
    [
      "missing destination",
      ($: CheerioAPI) => {
        $(".spotlight-title").first().removeAttr("href");
      },
    ],
    [
      "missing degrees",
      ($: CheerioAPI) => {
        $(".programs-offered").first().remove();
      },
    ],
    [
      "empty degrees",
      ($: CheerioAPI) => {
        $(".programs-offered").first().empty();
      },
    ],
    [
      "ambiguous title",
      ($: CheerioAPI) => {
        $("li").first().append($(".spotlight-title").first().clone());
      },
    ],
    [
      "missing cards",
      ($: CheerioAPI) => {
        $(".view-program-spotlight").empty();
      },
    ],
    [
      "missing card class",
      ($: CheerioAPI) => {
        $("li").first().removeClass("card--default");
      },
    ],
    [
      "missing legend",
      ($: CheerioAPI) => {
        $(".campus-legend").remove();
      },
    ],
    [
      "unrecognized legend",
      ($: CheerioAPI) => {
        $(".campus-legend .vancouver").text("Synthetic campus");
      },
    ],
    [
      "ambiguous legend",
      ($: CheerioAPI) => {
        $(".campus-legend").append('<span class="vancouver">Vancouver</span>');
      },
    ],
    [
      "unknown legend entry",
      ($: CheerioAPI) => {
        $(".campus-legend").append('<span class="surrey">Surrey</span>');
      },
    ],
  ] as const)("fails malformed known spotlight shape: %s", (_, mutation) => {
    expect(() => extract(changed(spotlight(), mutation))).toThrow(/spotlight/i);
  });

  it("deduplicates only identical carousel text and link pairs, retaining unique inactive captions", () => {
    const observation = changed(homepage(), ($) => {
      const original = $("figcaption").first();
      const changedLink = original.clone();
      changedLink.find("a").attr("href", "/students/why-co-op");
      const changedText = original.clone();
      changedText.find("p").text("Another invitation.");
      $(".view-homepage-carousel").append(changedLink, changedText);
    });
    const result = extract(observation);
    expect(result.prose.match(/Synthetic invitation\./g)).toHaveLength(2);
    expect(result.prose.match(/Another invitation\./g)).toHaveLength(1);
    expect(result.links).toEqual(
      expect.arrayContaining([
        { text: "Learn more", url: `${HOME}employers/why-ubc-co-op` },
        { text: "Learn more", url: `${HOME}students/why-co-op` },
      ]),
    );
    for (const [index, date] of ["Mar 13, 2026", "Mar 11, 2026", "Jan 15, 2026"].entries()) {
      expect(result.prose).toContain(date);
      expect(result.prose).toContain(`Summary ${index}.`);
      expect(result.links).toContainEqual({
        text: `Synthetic announcement ${index}`,
        url: `${HOME}node/${index}`,
      });
    }
  });

  it("consolidates repeated presentation destinations without losing descriptions or media links", () => {
    const result = extract(homepage());
    expect(result.rendered(`a[href="${HOME}students/why-co-op"]`)).toHaveLength(1);
    expect(result.rendered(`a[href="${HOME}employers/why-ubc-co-op"]`)).toHaveLength(2);
    for (const phrase of [
      "Employers choose suitable programs.",
      "Students review eligibility.",
      "Some programs have different terms.",
    ])
      expect(result.prose).toContain(phrase);
    expect(result.links).toContainEqual({
      text: "Students photo",
      url: `${HOME}Students.jpg`,
    });
    expect(result.prose).not.toContain("https://coop.ubc.ca/students/why-co-op");
  });

  it("turns adjacent program links into ordered semantic list items", () => {
    const result = extract(homepage());
    expect(
      result
        .rendered("ul > li")
        .map((_, node) => text(result.rendered(node).text()))
        .get(),
    ).toEqual(["Arts", "Science", "Forestry"]);
    expect(result.rendered("ul > li a")).toHaveLength(3);
    expect(result.prose).not.toMatch(/ArtsScience|ScienceForestry/);
  });

  it("does not consolidate ordinary prose links or non-homepage card regions", () => {
    const observation = changed(homepage(), ($) => {
      $("body").removeClass("page-node-type-homepage");
    });
    const result = extract(observation);
    expect(result.prose).toContain("Some programs have different terms.");
    expect(result.rendered(`a[href="${HOME}students/why-co-op"]`).length).toBeGreaterThan(1);
  });

  it("merges adjacent attribution strong runs while retaining inactive quotations, roles and organizations", () => {
    const body = `<div class="view-testimonials">${["text-unit-blue-darker", "text-right", ""].map((className, index) => `<div class="views_slideshow_cycle_slide ${index ? "views_slideshow_cycle_hidden" : ""}"><blockquote><p>Source quotation ${index}.</p></blockquote><div><div class="${className}"><strong>Speaker ${index}</strong><strong>, </strong>Source role ${index}</div><div><strong>Organization ${index}</strong></div></div></div>`).join("")}</div>`;
    const result = extract(page(body));
    expect(result.rendered("blockquote")).toHaveLength(3);
    expect(result.prose).not.toContain("**");
    for (const index of [0, 1, 2]) {
      expect(result.prose).toContain(`Speaker ${index}, Source role ${index}`);
      expect(result.prose).toContain(`Organization ${index}`);
      expect(result.prose).toContain(`Source quotation ${index}.`);
      expect(
        result
          .rendered("strong")
          .map((_, node) => result.rendered(node).text())
          .get(),
      ).toContain(`Speaker ${index},`);
    }
  });

  it("does not merge strong elements across attribution prose or outside testimonial blocks", () => {
    const result = extract(
      page(
        '<div class="view-testimonials"><div class="text-right"><strong>Name</strong> and <strong>Role</strong></div></div><div class="text-right"><strong>Outside</strong><strong>,</strong></div>',
      ),
    );
    const $ = load(result.input.html);
    expect($(".view-testimonials strong")).toHaveLength(2);
    expect($("main > .text-right strong")).toHaveLength(2);
  });

  it.each(["Vancouver", "Kelowna", "Okanagan"])(
    "separates address components without correcting the source locality %s",
    (locality) => {
      const result = extract(
        page(
          "<p>Program prose.</p>",
          "",
          `<aside id="sidebar-second"><div class="view-program-views"><div class="node--view-mode-contact"><h3><div class="field--name-field-location-name"></div></h3><p class="address"><span class="locality">${locality}</span><span class="administrative-area">BC</span><span class="postal-code">V1V 1V7</span></p><p>604 822 8007 <a href="mailto:marketing@sciencecoop.ubc.ca">marketing@sciencecoop.ubc.ca</a></p></div></div></aside>`,
        ),
      );
      expect(result.prose).toContain(`${locality} BC V1V 1V7`);
      expect(result.prose).toContain("604 822 8007");
      expect(result.links).toContainEqual({
        text: "marketing@sciencecoop.ubc.ca",
        url: "mailto:marketing@sciencecoop.ubc.ca",
      });
      expect(result.rendered("h3")).toHaveLength(0);
    },
  );

  it("retains existing address punctuation and non-contact source text", () => {
    const address =
      '<p class="address"><span class="locality">Kelowna</span>, <span class="administrative-area">BC</span> <span class="postal-code">V1V 1V7</span></p>';
    const result = extract(
      page(address, "", `<aside id="sidebar-second"><div class="view-program-views">${address}</div></aside>`),
    );
    expect(result.prose.match(/Kelowna, BC V1V 1V7/g)).toHaveLength(2);
  });

  it("separates a leading floated announcement image without rewriting the sentence or link", () => {
    const result = extract(
      page(
        '<article class="node--type-announcements"><div class="field--name-body"><p><img class="align-right" src="/speaker.jpg" alt="Source speaker">As a synthetic student, <a href="https://example.org/">the source speaker</a> earned an award.</p><p>A distinct second paragraph.</p></div></article>',
      ),
    );
    expect(
      result
        .rendered("p")
        .map((_, node) => text(result.rendered(node).text()))
        .get(),
    ).toEqual([
      "Source speaker",
      "As a synthetic student, the source speaker earned an award.",
      "A distinct second paragraph.",
    ]);
    expect(result.links).toContainEqual({
      text: "Source speaker",
      url: `${HOME}speaker.jpg`,
    });
    expect(result.links).toContainEqual({
      text: "the source speaker",
      url: "https://example.org/",
    });
  });

  it("does not relocate a floated image from the middle of a sentence", () => {
    const result = extract(
      page(
        '<article class="node--type-announcements"><div class="field--name-body"><p>Before <img class="align-right" src="/image.jpg" alt="image"> after.</p></div></article>',
      ),
    );
    expect(result.rendered("p")).toHaveLength(1);
    expect(result.prose).toBe("Before image after.");
  });
});

describe("coop posting control residue", () => {
  function posting(): Snapshot {
    const observation = page("");
    observation.body = readFileSync(
      new URL("../../../test/fixtures/host-scrapers/coop.ubc.ca/post-job.html", import.meta.url),
      "utf8",
    );
    return changed(observation, ($) => {
      $(".webform-type-processed-text").first().attr("id", "edit-processed-text");
      $(".webform-element-description")
        .first()
        .attr("id", "edit-attachment-optional---description")
        .html("One file only.<br>64 MB limit.<br>Allowed types: synthetic extensions.");
      $(".field--name-body p").first().text("Use the form below to submit a synthetic job posting.");
    });
  }

  it("removes exactly the uploader description and prose-free organization heading", () => {
    const result = extract(posting());
    expect(result.prose).not.toMatch(/64 MB|Allowed types|One file only|Organization Details/);
    for (const phrase of [
      "Use the form below",
      "Salary guidance",
      "November 1, 2023",
      "Duration guidance",
      "exceptions vary by program",
      "If grant funding restricts eligibility",
      "separate application bundles",
      "Indicate the programs",
    ])
      expect(result.prose).toContain(phrase);
    expect(result.input.warnings).toContain(
      "Interactive posting controls are omitted; consult the source page to complete the form.",
    );
    expect(result.links).toContainEqual({
      text: "synthetic pay rule",
      url: "https://example.org/synthetic-pay-rule",
    });
  });

  it("does not discard new policy prose attached to the uploader description", () => {
    const result = extract(
      changed(posting(), ($) => {
        $("#edit-attachment-optional---description").append(
          "<p>Obtain consent before including personal information.</p>",
        );
      }),
    );
    expect(result.prose).toContain("Obtain consent before including personal information.");
  });

  it("preserves organization headings when their processed block contains prose", () => {
    const result = extract(
      changed(posting(), ($) => {
        $("#edit-processed-text").append("<p>Organization-specific posting qualification.</p>");
        $("#edit-attachment-optional---description").after(
          '<div class="webform-element-description">A separate substantive description.</div>',
        );
      }),
    );
    expect(result.prose).toContain("Organization Details");
    expect(result.prose).toContain("Organization-specific posting qualification.");
    expect(result.prose).toContain("A separate substantive description.");
  });

  it("does not add the posting warning when no source form exists", () => {
    expect(extract(page("<p>Ordinary prose.</p>")).input.warnings).not.toContain(
      "Interactive posting controls are omitted; consult the source page to complete the form.",
    );
  });
});
