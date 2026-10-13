import type { CheerioAPI } from "cheerio";

/** Recognize MSL calendar controls using the caller's strict machine-link candidate validation. */
export function reviewedMslCalendarLinks(
  $: CheerioAPI,
  hostname: string,
  source: URL,
  candidate: (value: string | undefined) => string | null,
): Set<string> {
  const result = new Set<string>();
  if (hostname === "www.msl.ubc.ca" && source.origin === `https://${hostname}` && !source.search && !source.hash) {
    $("a[href]").each((_, node) => {
      const link = $(node);
      const url = candidate(link.attr("href"));
      if (!url) return;
      const path = new URL(url).pathname;
      if (!path.startsWith("/events-calendar/")) return;
      const classes = (link.attr("class") ?? "").split(/\s+/);
      const calendarView = link.attr("data-js") === "tribe-events-view-link";
      const namedView =
        classes.includes("tribe-events-c-view-selector__list-item-link") &&
        /^Display Events in (?:Month|Photo) View$/.test(link.attr("aria-label") ?? "") &&
        /(?:^|\/)(?:month|photo)\/$/.test(path);
      const monthNavigation =
        (classes.includes("tribe-events-c-top-bar__nav-link") ||
          classes.includes("tribe-events-c-nav__prev") ||
          classes.includes("tribe-events-c-nav__next")) &&
        /^(?:Previous|Next) month(?:, [A-Za-z]+)?$/.test(link.attr("aria-label") ?? "");
      const dayNavigation =
        classes.includes("tribe-events-calendar-month__day-date-link") &&
        /^\/events-calendar\/\d{4}-\d{2}-\d{2}\/$/.test(path) &&
        link.closest("time[datetime]").attr("datetime") === path.slice(17, -1);
      const headerView =
        classes.includes("nav-element") &&
        classes.includes("nav-icon") &&
        link.closest(".wrap-nav-elements").length > 0 &&
        /^\/events-calendar\/(?:month|photo)\/$/.test(path);
      const menuView =
        link.closest("#menu-events").length > 0 &&
        link.text().replace(/\s+/g, " ").trim() === "View All Events" &&
        path === "/events-calendar/month";
      if ((calendarView && (namedView || monthNavigation || dayNavigation)) || headerView || menuView) result.add(url);
    });
  }
  return result;
}
