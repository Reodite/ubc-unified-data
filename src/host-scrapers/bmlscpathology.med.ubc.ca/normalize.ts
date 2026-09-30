import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { ArticleInput } from "../../prose/model.ts";

const MARQUEE = "#student-stories.testimonials-section > .pura-card";
const COLUMNS = `${MARQUEE} > .pura-right > .pura-col`;
const text = (value: string) => value.replace(/\s+/g, " ").trim();

function requireShape(condition: boolean, context: string): asserts condition {
  if (!condition) throw new Error(`Malformed BMLSc ${context}`);
}

function children($: CheerioAPI, parent: Cheerio<Element>, selector: string, context: string) {
  requireShape(
    parent
      .contents()
      .toArray()
      .every((node) => node.type === "comment" || (node.type === "text" ? !node.data.trim() : $(node).is(selector))),
    context,
  );
  return parent.children().toArray();
}

function fields($: CheerioAPI, parent: Cheerio<Element>, selectors: string[], context: string) {
  const nodes = children($, parent, selectors.join(","), context);
  requireShape(nodes.length === selectors.length && nodes.every((node, i) => $(node).is(selectors[i]!)), context);
  return nodes;
}

function retag(node: Element, tag: string) {
  node.tagName = tag;
}

function curriculum($: CheerioAPI): boolean {
  let changed = false;
  $(".bmlsc-curriculum > .bmlsc-container > header.phead > .summary > div.credit").each((_, node) => {
    const parts = fields($, $(node), [".credit__l", ".credit__n"], "credit summary");
    const unit = $(parts[1]!).children("small");
    requireShape(unit.length === 1, "credit summary unit");
    $(parts[1]!).before(" — ");
    unit.before(" ");
    retag(node, "p");
    changed = true;
  });
  $(".year > header.year__bar").each((_, node) => {
    const heading = $(node);
    const parts = fields($, heading, [".year__n", ".year__cr", ".year__meta"], "year heading");
    for (const part of parts.slice(1)) $(part).before(" — ");
    retag(node, "h2");
    changed = true;
  });
  $(".year__groups > .disc > div.disc__head").each((_, node) => {
    const credits = $(node).children(".disc__cr");
    requireShape(credits.length <= 1, "discipline heading");
    credits.before(" — ");
    retag(node, "h3");
    changed = true;
  });
  $(".year__groups > .disc").each((_, discipline) => {
    let list: Cheerio<Element> | undefined;
    $(discipline)
      .contents()
      .each((_, node) => {
        if (node.type === "text" && !node.data.trim()) return;
        if (node.type !== "tag" || !$(node).is("div.crow, a.crow")) {
          list = undefined;
          return;
        }
        const row = $(node);
        const parts = fields($, row, [".crow__code", ".crow__name", ".crow__cr"], "course row");
        // The PDF glyph denotes the syllabus link, not a separate visual document.
        row.find(".crow__name > .pdf > svg").each((_, icon) => {
          if (!$(icon).find("title,desc,image,foreignObject").length && !text($(icon).text())) $(icon).remove();
        });
        for (const part of parts.slice(1)) $(part).before(" — ");
        if (!list) {
          list = $<Element, string>("<ul>");
          row.before(list);
        }
        const item = $("<li>");
        if (row.is("a")) {
          requireShape(Boolean(row.attr("href")), "course syllabus link");
          item.append(row);
        } else {
          retag(node, "li");
          list.append(row);
          changed = true;
          return;
        }
        list.append(item);
        changed = true;
      });
  });
  return changed;
}

function table($: CheerioAPI, headers: Element[], rows: Element[][], caption?: Element) {
  const result = $("<table>");
  if (caption) result.append($("<caption>").append($(caption).contents().clone()));
  const head = $("<tr>");
  for (const header of headers) {
    const cell = $(header).clone();
    retag(cell[0]!, "th");
    head.append(cell);
  }
  result.append($("<thead>").append(head));
  const body = $("<tbody>");
  for (const row of rows) {
    const tr = $("<tr>");
    for (const node of row) {
      const cell = $(node).clone();
      retag(cell[0]!, "td");
      tr.append(cell);
    }
    body.append(tr);
  }
  return result.append(body);
}

function grids($: CheerioAPI): boolean {
  let changed = false;
  $(".gt__grid.gt__grid--main, #gpaTable .gt__grid").each((_, node) => {
    const grid = $(node);
    const grouped = grid.is(".gt__grid--main");
    const context = grouped ? "entrance grid" : "GPA grid";
    const cells = children($, grid, ".gt__cell", context);
    const headers = cells.slice(0, 3);
    requireShape(
      headers.length === 3 &&
        headers.every((cell) => $(cell).is(".gt__cell--head:not(.gt__cell--group)")) &&
        cells.slice(3).every((cell) => !$(cell).is(".gt__cell--head")),
      `${context} headers`,
    );
    const groups: { caption?: Element; rows: Element[][] }[] = grouped ? [] : [{ rows: [] }];
    let pending: Element[] = [];
    for (const cell of cells.slice(3)) {
      if ($(cell).is(".gt__cell--group")) {
        requireShape(grouped && pending.length === 0, `${context} group boundary`);
        groups.push({ caption: cell, rows: [] });
      } else {
        requireShape(groups.length > 0, `${context} missing group`);
        if (!grouped) {
          $(cell).find(".gt__v > small").before(" ");
          const label = $(cell).attr("data-l");
          requireShape(
            label === undefined || text(label) === text($(headers[pending.length]!).text()),
            `${context} column label`,
          );
        }
        pending.push(cell);
        if (pending.length === 3) {
          if (grouped)
            requireShape(
              $(pending[0]!).is(".gt__cell--rowlabel") &&
                pending.slice(1).every((part) => !$(part).is(".gt__cell--rowlabel")),
              `${context} row label`,
            );
          groups.at(-1)!.rows.push(pending);
          pending = [];
        }
      }
    }
    requireShape(
      pending.length === 0 && groups.length > 0 && groups.every((group) => group.rows.length > 0),
      `${context} incomplete row`,
    );
    for (const group of groups) grid.before(table($, headers, group.rows, group.caption));
    grid.remove();
    changed = true;
  });
  return changed;
}

function schedules($: CheerioAPI): boolean {
  let changed = false;
  $("div.sched").each((_, node) => {
    const schedule = $(node);
    const rows = children($, schedule, ".sched__row", "schedule rows");
    requireShape(
      rows.length > 1 &&
        $(rows[0]!).is(".sched__row--head") &&
        rows.slice(1).every((row) => !$(row).is(".sched__row--head")),
      "schedule header",
    );
    const cells = rows.map((row) => {
      const result = children($, $(row), ".sched__cell", "schedule cells");
      requireShape(result.length === 4, "schedule width");
      return result;
    });
    for (const row of cells.slice(1)) {
      for (const [index, node] of row.entries()) {
        const cell = $(node);
        const label = cell.attr("data-term");
        requireShape(label === undefined || text(label) === text($(cells[0]![index]!).text()), "schedule column label");
        if (index === 0) continue;
        const parts = children($, cell, ".term, .tag-pill", "schedule term");
        requireShape(
          (parts.length === 1 || parts.length === 2) &&
            $(parts[0]!).is(".term") &&
            (parts.length === 1 || $(parts[1]!).is(".tag-pill")),
          "schedule term",
        );
        cell.children(".tag-pill").before(" — ");
      }
    }
    schedule.replaceWith(table($, cells[0]!, cells.slice(1)));
    changed = true;
  });
  return changed;
}

function widgets($: CheerioAPI): boolean {
  let changed = false;
  for (const [selector, child] of [
    [`${COLUMNS}.pura-col--text > .pura-track.pura-down`, "figure.pura-qcard"],
    [`${COLUMNS}:not(.pura-col--text) > .pura-track.pura-up`, "span.pura-shot"],
  ]) {
    $(selector!).each((_, track) => {
      const seen = new Set<string>();
      $(track)
        .children(child!)
        .each((_, card) => {
          if (child === "span.pura-shot" && $(card).find("img").length !== 1) return;
          // Exact declared-loop clones retain their first copy, including all attributes.
          const key = $.html(card);
          if (seen.has(key)) {
            $(card).remove();
            changed = true;
          } else seen.add(key);
        });
    });
  }
  $(`${MARQUEE} > button#puraPause.pura-pause`).each((_, node) => {
    $(node).remove();
    changed = true;
  });
  $(".alumni > a.alum").each((_, node) => {
    const card = $(node);
    const parts = fields($, card, [".alum__photo", ".alum__name", ".alum__year", ".alum__role"], "alumni card");
    requireShape(Boolean(card.attr("href")) && Boolean(text($(parts[1]!).text())), "alumni source name");
    const link = $("<a>");
    for (const attribute of ["href", "title", "target", "rel"]) {
      const value = card.attr(attribute);
      if (value !== undefined) link.attr(attribute, value);
      card.removeAttr(attribute);
    }
    const name = $(parts[1]!);
    link.append(name.contents());
    name.append(link);
    retag(parts[1]!, "h3");
    retag(node, "article");
    changed = true;
  });
  $(".bmlsc-experience #panel-voices .qscroll > .qhint").each((_, node) => {
    if (text($(node).text()) === "Drag, scroll or use the arrows — 8 voices") {
      $(node).remove();
      changed = true;
    }
  });
  return changed;
}

/** Give declared CSS widgets semantic structure before the shared safe Markdown renderer. */
export function normalizeArticle(input: ArticleInput): ArticleInput {
  if (!input.html) return input;
  const $ = load(input.html, {}, false);
  const changed = [curriculum($), grids($), schedules($), widgets($)].some(Boolean);
  return changed ? { ...input, html: $.root().html() ?? "" } : input;
}
