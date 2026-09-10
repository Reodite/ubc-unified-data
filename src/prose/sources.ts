import type { ProseSource } from "./model.ts";

const ASSET =
  /\.(?:pdf|docx?|xlsx?|pptx?|zip|gz|png|jpe?g|gif|webp|svg|ico|mp[34]|mov|avi|ics|xml|json|csv|txt|woff2?|ttf)$/i;

export function commonExclusion(value: string, title = ""): string | null {
  const url = new URL(value);
  let route = url.pathname.toLowerCase();
  try {
    route = decodeURIComponent(route);
  } catch {}
  if (ASSET.test(route) || /^\/file\/[^/]+\/download(?:\/|$)/.test(route))
    return "Linked attachment rather than an HTML prose article; retained as a source link.";
  if (
    /^\/(?:wp-json|wp-admin|wp-login\.php|admin|user|login|login_required|signin|logout|search|feed|tag|category|author)(?:\/|$)/.test(
      route,
    )
  )
    return "Authentication, administration, search or taxonomy route rather than an article.";
  if (/\/(?:profile|profiles|people|alumni-profile|alumni-profiles|event|events)(?:\/|$)/.test(route))
    return "Individual profile or event record; these are not prose article collections.";
  if (
    /(?:^|\/)(?:employers?|faculty-staff(?:-resources)?|faculty-and-staff|faculty-resources|staff-resources|for-faculty|instructors?)(?:\/|$)/.test(
      route,
    )
  )
    return "Faculty, staff, instructor or employer-only section.";
  if (
    /(?:^|\/)(?:graduate|grad|doctoral|postdoctoral|phd|masters|faculty-graduate)(?:[/_-]|$)/.test(route) ||
    /\b(?:graduate students?|graduate programs?|doctoral|postdoctoral|dissertations?|master['’]?s programs?)\b/i.test(
      title,
    )
  ) {
    if (!/\bundergraduate|bachelor|\bbsc\b|\bbcom\b/i.test(`${route} ${title}`))
      return "Graduate-only topic outside the undergraduate/shared-service scope.";
  }
  if (
    (/(?:^|[/_-])(?:okanagan|ubco)(?:[/_-]|$)/.test(route) || /\bokanagan\b/i.test(title)) &&
    !/vancouver/i.test(`${route} ${title}`)
  )
    return "Okanagan-specific content outside this Vancouver corpus.";
  return null;
}

function wholeStudentSite(value: string, title?: string): string | null {
  return commonExclusion(value, title);
}

export const LIVE_PROSE_SOURCES: ProseSource[] = [
  {
    key: "workday",
    title: "Workday student tutorials",
    host: "workday.students.ubc.ca",
    campus: null,
    strategy: "wordpress",
    wordpressTypes: ["pages", "posts"],
    scope: wholeStudentSite,
    roots: ["https://workday.students.ubc.ca/"],
    sitemaps: ["https://workday.students.ubc.ca/wp-sitemap.xml"],
  },
  {
    key: "student-housing",
    title: "Vancouver student housing articles and guidance",
    host: "vancouver.housing.ubc.ca",
    campus: "vancouver",
    strategy: "wordpress",
    wordpressTypes: ["pages", "posts"],
    scope: (url, title) =>
      commonExclusion(url, title) ??
      (/\/(?:green-college|st-johns-college)(?:\/|$)/i.test(new URL(url).pathname)
        ? "College residence whose published quick facts do not identify undergraduate residents."
        : null),
    roots: ["https://vancouver.housing.ubc.ca/"],
    sitemaps: ["https://vancouver.housing.ubc.ca/wp-sitemap.xml"],
  },
  {
    key: "learning-technology",
    title: "Learning Technology Hub student guides",
    host: "lthub.ubc.ca",
    campus: null,
    strategy: "wordpress",
    wordpressTypes: ["pages", "posts"],
    scope: (url, title) =>
      commonExclusion(url, title) ??
      (/\/guides\/[^/]*student-guide(?:\/|$)/.test(new URL(url).pathname)
        ? null
        : "Outside the dedicated student-guide collection; instructor and general platform pages stay separate."),
    sitemaps: ["https://lthub.ubc.ca/wp-sitemap.xml"],
  },
  {
    key: "learning-commons",
    title: "Learning Commons articles and study guidance",
    host: "learningcommons.ubc.ca",
    campus: "vancouver",
    strategy: "wordpress",
    wordpressTypes: ["pages", "posts"],
    scope: wholeStudentSite,
    roots: ["https://learningcommons.ubc.ca/"],
    sitemaps: ["https://learningcommons.ubc.ca/wp-sitemap.xml"],
  },
  {
    key: "academic-integrity",
    title: "Academic integrity student and shared guidance",
    host: "academicintegrity.ubc.ca",
    campus: null,
    strategy: "wordpress",
    wordpressTypes: ["pages", "posts"],
    scope: (url, title) =>
      commonExclusion(url, title) ??
      (/\/(?:faculty(?:-start|-forum|-updated)?|templates|academic-integrity-working-group)(?:\/|$)|syllabus/.test(
        new URL(url).pathname,
      )
        ? "Faculty administration, instructor templates or syllabus-authoring material."
        : null),
    roots: ["https://academicintegrity.ubc.ca/student-start/"],
    sitemaps: ["https://academicintegrity.ubc.ca/wp-sitemap.xml"],
  },
  {
    key: "arts-advising",
    title: "Arts undergraduate programs, advising and student support",
    host: "www.arts.ubc.ca",
    campus: "vancouver",
    strategy: "wordpress",
    wordpressTypes: ["pages", "posts", "news", "arts-program"],
    scope: (url, title) =>
      commonExclusion(url, title) ??
      (/\/(?:academic-advisors|academic-postings|recruit-students|artsmeetings[^/]*|arts-comms-yearbook|arts-communications-promotional-request|request-communications-support)(?:\/|$)/.test(
        new URL(url).pathname,
      )
        ? "Faculty/staff directory, recruitment or internal communications workflow."
        : /(?:^|\/)(?:news|event|program|degree|alumni-profile|interest)-(?:tag|topic|type|category|program)(?:\/|$)|-survey-(?:it|its|could)|\/(?:graduating-year|alumni-profile-category)(?:\/|$)/.test(
              new URL(url).pathname,
            )
          ? "Taxonomy archive or feedback-action page rather than a prose article."
          : null),
    roots: ["https://www.arts.ubc.ca/student-support/academic-support/academic-advising/"],
    selectors: [".entry-content", "article", "main"],
  },
  {
    key: "sauder-undergraduate",
    title: "myBCom undergraduate handbook and articles",
    host: "mybcom.sauder.ubc.ca",
    campus: "vancouver",
    strategy: "sitemap",
    scope: wholeStudentSite,
    roots: ["https://mybcom.sauder.ubc.ca/"],
    sitemaps: ["https://mybcom.sauder.ubc.ca/sitemap.xml"],
    selectors: [".main-content .panel-content", ".main-content"],
  },
  {
    key: "science-advising",
    title: "Science undergraduate guidance and advising",
    host: "science.ubc.ca",
    campus: "vancouver",
    strategy: "drupal",
    drupalTypes: [
      "ubc_page",
      "ubc_landing_page",
      "student_resource",
      "program_specialization",
      "blog",
      "ubc_announcement",
    ],
    scope: (url, title) =>
      commonExclusion(url, title) ??
      (/^\/(?:faculty|staff|giving|employment)(?:\/|$)|^\/equity\/(?:faculty|staff)(?:\/|$)/.test(new URL(url).pathname)
        ? "Faculty/staff-only operations or donor fundraising rather than student/shared prose."
        : null),
    roots: ["https://science.ubc.ca/students"],
    sitemaps: ["https://science.ubc.ca/sitemap.xml"],
    selectors: ["#unit-content > main"],
  },
  {
    key: "science-coop",
    title: "Science Co-op undergraduate guidance",
    host: "sciencecoop.ubc.ca",
    campus: "vancouver",
    strategy: "drupal",
    drupalTypes: ["ubc_page", "ubc_landing_page", "ubc_blog", "ubc_announcement"],
    scope: (url, title) =>
      commonExclusion(url, title) ??
      (/^\/prospective\/(?:apply\/(?:gradcpsc|gradstats|prodigy)|res)(?:\/|$)/.test(new URL(url).pathname)
        ? "The public prospective-program directory identifies this track as graduate-only."
        : null),
    roots: ["https://sciencecoop.ubc.ca/students", "https://sciencecoop.ubc.ca/prospective"],
    sitemaps: ["https://sciencecoop.ubc.ca/sitemap.xml"],
    selectors: ["#unit-content > main"],
  },
  {
    key: "go-global",
    title: "Go Global student programs and guidance",
    host: "goglobal.ubc.ca",
    campus: null,
    strategy: "drupal",
    drupalTypes: ["exchange", "faq", "summer_abroad", "ubc_page", "ubc_landing_page", "ubc_announcement"],
    scope: (url, title) =>
      commonExclusion(url, title) ??
      (/\/(?:faculty-staff-resources|supervisors?)(?:\/|$)/.test(new URL(url).pathname)
        ? "Faculty, staff or supervisor-only administration."
        : null),
    roots: ["https://goglobal.ubc.ca/go-global/programs-ubc-students/exchange"],
    sitemaps: ["https://goglobal.ubc.ca/sitemap.xml"],
    selectors: ["#unit-content > main"],
  },
  {
    key: "library",
    title: "Library Ask Us questions and answers",
    host: "answers.library.ubc.ca",
    campus: null,
    strategy: "sitemap",
    scope: (url, title) =>
      commonExclusion(url, title) ??
      (/^\/askus\/faq\/\d+\/?$/.test(new URL(url).pathname)
        ? null
        : "Outside the public Ask Us FAQ article collection."),
    sitemaps: ["https://answers.library.ubc.ca/sitemap.xml"],
    selectors: [".s-la-faq-answer"],
  },
];
