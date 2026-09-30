import { describe, expect, it } from "vitest";
import { discoverMachineLinks } from "./machine-links.ts";

const hostname = "www.msl.ubc.ca";
const origin = `https://${hostname}/`;
const source = `${origin}events-calendar/category/msl-seminars/`;
const detect = (html: string, host = hostname, page = source) => discoverMachineLinks(html, host, page);
const topBar = (href: string, title = "Previous month") =>
  `<li class="tribe-events-c-top-bar__nav-list-item"><a class="tribe-events-c-top-bar__nav-link tribe-events-c-top-bar__nav-link--prev" href="${href}" data-js="tribe-events-view-link" aria-label="${title}" rel="prev">Earlier</a></li>`;

describe("reviewed Michael Smith Laboratories calendar navigation", () => {
  it("excludes only witnessed calendar view, month paging, day and site-header controls", () => {
    const html = `<div class="wrap-nav-elements"><a class="nav-element nav-icon calendar-icon" href="/events-calendar/month/"></a><a class="nav-element nav-icon show-all" href="/events-calendar/photo/"></a><ul id="menu-events"><li><a href="/events-calendar/month">View All Events</a></li></ul></div><ul><li><a class="tribe-events-c-view-selector__list-item-link" data-js="tribe-events-view-link" aria-label="Display Events in Photo View" href="/events-calendar/category/msl-seminars/photo/">Photo</a></li>${topBar("/events-calendar/category/msl-seminars/2026-08/")}</ul><time datetime="2026-09-16"><a class="tribe-events-calendar-month__day-date-link" data-js="tribe-events-view-link" href="/events-calendar/2026-09-16/">16</a></time><a href="/event/seminar/">Read seminar</a><a href="/events-calendar/category/msl-seminars/">View category</a>`;
    expect(detect(html)).toEqual(
      new Set([
        `${origin}events-calendar/month/`,
        `${origin}events-calendar/photo/`,
        `${origin}events-calendar/month`,
        `${origin}events-calendar/category/msl-seminars/photo/`,
        `${origin}events-calendar/category/msl-seminars/2026-08/`,
        `${origin}events-calendar/2026-09-16/`,
      ]),
    );
  });

  it("does not exclude similar public links without source-owned calendar controls", () => {
    const html = `<a href="/events-calendar/2026-09-16/">Public guide to the 16th</a>${topBar("/events-calendar/category/msl-seminars/2026-08/", "Read earlier seminars").replace('data-js="tribe-events-view-link"', "")}<a class="tribe-events-c-view-selector__list-item-link" data-js="tribe-events-view-link" aria-label="Display Events in Photo View" href="/event/photo-essay/">Photo essay</a><div><a class="nav-element nav-icon" href="/events-calendar/month/">Named article</a></div>`;
    expect(detect(html)).toEqual(new Set());
    expect(
      detect(
        topBar("/events-calendar/category/msl-seminars/2026-08/"),
        "other.ubc.ca",
        "https://other.ubc.ca/events-calendar/",
      ),
    ).toEqual(new Set());
    expect(detect(topBar("/events-calendar/category/msl-seminars/2026-08/"), hostname, `${origin}research/`)).toEqual(
      new Set([`${origin}events-calendar/category/msl-seminars/2026-08/`]),
    );
  });

  it("does not follow unsafe, query-bearing or off-host calendar selectors", () => {
    for (const href of [
      "/events-calendar/month/?page=2",
      "/events-calendar/month/#today",
      "https://other.ubc.ca/events-calendar/month/",
      "/events-calendar/../private/",
    ])
      expect(
        detect(`<div class="wrap-nav-elements"><a class="nav-element nav-icon" href="${href}"></a></div>`),
      ).toEqual(new Set());
  });
});
