import type { CheerioAPI } from "cheerio";

const MAIN = "main#main-content";
const CONTACTS = "#unit-content #sidebar-second .view-program-views";
const text = (value: string) => value.replace(/\s+/g, " ").trim();

function labelSpotlightCampuses($: CheerioAPI): void {
  $(`${MAIN} .view-program-spotlight`).each((_, view) => {
    const legend = $(view).closest("#block-views-block-program-spotlight-block-1").find(".campus-legend");
    const labels = ["vancouver", "okanagan"] as const;
    const prefix = legend.clone();
    prefix.children().remove();
    if (
      legend.length !== 1 ||
      legend.children().length !== labels.length ||
      text(prefix.text()) !== "CAMPUS:" ||
      labels.some(
        (campus) =>
          legend.find(`span.${campus}`).length !== 1 ||
          text(legend.find(`span.${campus}`).text()) !== (campus === "vancouver" ? "Vancouver" : "Okanagan"),
      )
    )
      throw new Error("Unrecognized spotlight campus legend");
    const cards = $(view).find("li");
    if (!cards.length) throw new Error("Missing spotlight program cards");
    cards.each((_, node) => {
      const card = $(node);
      const image = card.find(".card__image");
      const title = card.find("a.spotlight-title");
      const degrees = card.find(".programs-offered");
      const classes = (image.attr("class") ?? "").split(/\s+/).filter((value) => value.startsWith("spotlight-"));
      const campuses = labels.filter((campus) => classes.includes(`spotlight-${campus}`));
      if (
        !card.is(".card--default") ||
        image.length !== 1 ||
        title.length !== 1 ||
        !text(title.text()) ||
        !title.attr("href")?.trim() ||
        degrees.length !== 1 ||
        !text(degrees.text()) ||
        !campuses.length ||
        classes.some((value) => !labels.some((campus) => value === `spotlight-${campus}`))
      )
        throw new Error("Unrecognized spotlight program-campus shape");
      image.find("a[href]").each((_, linkNode) => {
        const link = $(linkNode);
        const picture = link.children("img");
        if (
          picture.length !== 1 ||
          link.children().length !== 1 ||
          text(link.text()) ||
          picture.attr("alt") !== "" ||
          text(picture.attr("title") ?? "") ||
          text(picture.attr("aria-label") ?? "") ||
          text(link.attr("title") ?? "") ||
          text(link.attr("aria-label") ?? "")
        )
          return;
        try {
          if (
            new URL(link.attr("href")!, "https://coop.ubc.ca/").href ===
            new URL(title.attr("href")!, "https://coop.ubc.ca/").href
          )
            link.remove();
        } catch {
          /* Invalid links remain subject to shared sanitization. */
        }
      });
      // Campus indicators describe the program, not a campus-by-degree cross-product.
      degrees.before(
        $("<p>").text(
          `${text(prefix.text())} ${campuses.map((campus) => text(legend.find(`span.${campus}`).text())).join(", ")}`,
        ),
      );
    });
  });
}

function normalizeHomepage($: CheerioAPI): void {
  if (!$("body.page-node-type-homepage").length) return;
  const captions = new Set<string>();
  $("#featured .view-homepage-carousel figcaption").each((_, node) => {
    const caption = $(node);
    const signature = JSON.stringify([
      text(caption.text()),
      caption
        .find("a")
        .toArray()
        .map((link) => [$(link).attr("href"), text($(link).text()), $(link).attr("title")]),
      caption
        .find("img")
        .toArray()
        .map((image) => [$(image).attr("src"), $(image).attr("alt"), $(image).attr("title")]),
    ]);
    if (captions.has(signature)) caption.remove();
    else captions.add(signature);
  });

  $(".view-announcements .field--name-body p > span").each((_, node) => {
    const span = $(node);
    const previous = node.previousSibling;
    if (
      span.children().length === 1 &&
      span.children("a.pl-4[href]").length === 1 &&
      text(span.text()) === "MORE >" &&
      previous &&
      (previous.type !== "text" || /\S$/.test(previous.data))
    )
      span.before(" ");
  });

  const destinations = new Set<string>();
  const cards = $(`${MAIN} a.card--default[href]`);
  cards.each((_, node) => {
    const card = $(node);
    const href = card.attr("href")!;
    let url: URL;
    try {
      url = new URL(href, "https://coop.ubc.ca/");
    } catch {
      return;
    }
    const expected = new Map([
      ["https://coop.ubc.ca/employers/why-ubc-co-op", "Employers"],
      ["https://coop.ubc.ca/students/why-co-op", "Students"],
    ]).get(url.href);
    const image = card.children(".card__image");
    if (!expected || image.length !== 1 || text(image.text()) !== expected) return;
    const content = $("<div>");
    // Hoist image links out of the destination link so sanitization cannot create nested anchors.
    image.find("img").each((_, imageNode) => {
      content.append($("<p>").append(imageNode));
    });
    if (!destinations.has(url.href))
      content.append($("<p>").append($("<a>").attr("href", href).text(text(image.text()))));
    destinations.add(url.href);
    image.replaceWith(content);
    card.replaceWith($("<div>").append(card.contents()));
  });
  cards
    .filter((_, node) => !text($(node).text()) && !$(node).children().length)
    .each((_, node) => {
      try {
        if (destinations.has(new URL($(node).attr("href")!, "https://coop.ubc.ca/").href)) $(node).remove();
      } catch {
        /* Invalid destinations remain subject to shared link sanitization. */
      }
    });

  $("#unit-content .programs div:has(> a[href])").each((_, node) => {
    const row = $(node);
    const links = row.children("a[href]");
    const remainder = row.clone();
    remainder.children("a[href]").remove();
    if (text(remainder.text()) || remainder.children().length || !links.length) return;
    const list = $("<ul>");
    links.each((_, link) => {
      list.append($("<li>").append(link));
    });
    row.replaceWith(list);
  });
}

/** Retain source relationships that depend on this host's presentation markup. */
export function normalizeCoopStructure($: CheerioAPI): void {
  labelSpotlightCampuses($);
  normalizeHomepage($);
  $(".view-testimonials blockquote + div > div > strong").each((_, node) => {
    let next = node.nextSibling;
    while (next?.type === "tag" && next.name === "strong") {
      const following = next.nextSibling;
      $(node).append($(next).contents());
      $(next).remove();
      next = following;
    }
  });
  $(`${CONTACTS} .address > .administrative-area,${CONTACTS} .address > .postal-code`).each((_, node) => {
    const previous = node.previousSibling;
    if (previous?.type === "tag" && $(previous).is(".locality,.administrative-area")) $(node).before(" ");
  });
  $(`${MAIN} .node--type-announcements .field--name-body > p:first-child > img.align-right`).each((_, node) => {
    const paragraph = $(node).parent();
    const first = paragraph
      .contents()
      .toArray()
      .find((part) => part.type !== "text" || Boolean(text(part.data)));
    if (first === node && text(paragraph.text())) paragraph.before($("<p>").append(node));
  });
}
