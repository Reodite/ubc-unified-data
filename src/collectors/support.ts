import type { Http, Output } from "../base.ts";
import { InvalidValueError, register, utcnow, wants } from "../base.ts";
import { FACT_COLUMNS, publishFacts } from "../public-facts.ts";
import {
  document,
  drupalRecords,
  object,
  plainText,
  string,
  wordpressDocument,
  wordpressPages,
  type Row,
  type SourceDocument,
} from "../source-documents.ts";

const IT = "it.ubc.ca";
const WELLBEING = "wellbeing.ubc.ca";
const COMMONS = "learningcommons.ubc.ca";

function richText(value: unknown): string {
  return string(object(value).processed) || string(object(value).value);
}

export function drupalDocument(
  row: Row,
  sourceId: string,
  host: string,
  resource: string,
  campus: string | null,
  at: string,
  fields: Record<string, string> = {},
): SourceDocument {
  if (row.status !== true) throw new InvalidValueError(`Non-public Drupal node from ${host}: ${row.id}`);
  const alias = string(row.alias) || `/node/${row.nid}`;
  const url = new URL(alias, `https://${host}`).href;
  if (new URL(url).hostname !== host) throw new InvalidValueError(`Unexpected Drupal source host: ${url}`);
  const fragments = [richText(row.body)];
  for (const [name, label] of Object.entries(fields)) {
    const html = richText(row[name]);
    if (html) fragments.push(`<h2>${label}</h2>\n${html}`);
  }
  return {
    ...document({
      sourceId,
      upstreamId: String(row.id),
      url,
      apiUrl: `https://${host}/jsonapi/${resource}/${row.id}`,
      campus,
      title: string(row.title),
      html: fragments.join("\n"),
      modified: string(row.changed) || string(object(row.changed).value) || null,
      retrievedAt: at,
    }),
    upstream_id: row.id,
    unavailable_relationships: unavailableRelationships(row),
    related: Object.fromEntries(
      Object.entries(object(row.related)).filter(([key]) => !["uid", "revision_uid", "node_type"].includes(key)),
    ),
  };
}

export function unavailableRelationships(row: Row): string[] {
  return Object.entries(object(row.related))
    .filter(([, value]) => value === "missing" || (Array.isArray(value) && value.includes("missing")))
    .map(([key]) => key);
}

export function relatedNames(row: Row, key: string, terms: Row[]): string[] {
  const value = object(row.related)[key];
  const ids = (Array.isArray(value) ? value : value ? [value] : []).filter((id) => id !== "missing");
  const names = new Map(terms.map((term) => [term.id, string(term.name)]));
  return ids.map((id) => {
    const name = names.get(id);
    if (!name) throw new InvalidValueError(`Unresolved ${key} taxonomy reference: ${id}`);
    return name;
  });
}

export function resourceCampus(labels: string[]): string | null {
  const campuses = new Set(
    labels
      .map((label) => label.toLowerCase().replace(/ campus$/, ""))
      .filter((label) => label === "vancouver" || label === "okanagan"),
  );
  return campuses.size === 1 ? [...campuses][0]! : null;
}

export function undergraduateCommonsPage(row: Row): boolean {
  const label = `${row.link} ${object(row.title).rendered}`;
  return /\bundergraduates?\b/i.test(label) || !/\b(?:graduate|dissertation)s?\b/i.test(label);
}

const SERVICE_FIELDS = {
  field_service_advisory: "Service advisory",
  field_service_features_benefits: "Features and benefits",
  field_service_requirements_eligi: "Requirements and eligibility",
  field_service_price: "Pricing",
  field_service_learn_more: "Getting started and further information",
  field_service_get_help: "Get help",
};

export const Support = register(
  class {
    name = "support";
    folder = "student-support";
    title = "IT services, wellbeing resources and academic learning support";
    description =
      "Student-facing IT and undergraduate/shared Wellbeing service metadata and taxonomy labels, plus a Learning Commons source-link index. Page prose and HTML are not published; staff-only and graduate-only resources are excluded.";
    sources = [
      `https://${IT}/jsonapi/node/service`,
      `https://${WELLBEING}/jsonapi/node/resources`,
      `https://${COMMONS}/wp-json/wp/v2/pages`,
    ];

    async collect(http: Http, out: Output): Promise<void> {
      const at = utcnow();
      const it = await drupalRecords(http, IT, "node/service");
      const itAudiences = await drupalRecords(http, IT, "taxonomy_term/audience");
      const itCategories = await drupalRecords(http, IT, "taxonomy_term/parent_service_category");
      const wellbeing = await drupalRecords(http, WELLBEING, "node/resources");
      const campuses = await drupalRecords(http, WELLBEING, "taxonomy_term/campus_category");
      const audiences = await drupalRecords(http, WELLBEING, "taxonomy_term/audience_category");
      const categories = await drupalRecords(http, WELLBEING, "taxonomy_term/resource_category");
      const populations = await drupalRecords(http, WELLBEING, "taxonomy_term/student_population");
      const commons = wants("vancouver") ? await wordpressPages(http, COMMONS) : [];
      if (!it.length || !wellbeing.length)
        throw new InvalidValueError("IT or Wellbeing returned an empty resource collection");
      const services = it
        .filter((row) => relatedNames(row, "audience", itAudiences).includes("Students"))
        .map((row) => ({
          ...drupalDocument(row, "it", IT, "node/service", null, at, SERVICE_FIELDS),
          audiences: relatedNames(row, "audience", itAudiences),
          categories: relatedNames(row, "service_category", itCategories),
          eligibility_text: plainText(richText(row.field_service_requirements_eligi)) || null,
          pricing_text: plainText(richText(row.field_service_price)) || null,
        }));
      const resources = wellbeing
        .map((row) => {
          const labels = relatedNames(row, "resource_campus", campuses);
          return {
            ...drupalDocument(row, "wellbeing", WELLBEING, "node/resources", resourceCampus(labels), at, {
              field_resource_support_content: "Supporting resources",
            }),
            campus_labels: labels,
            audiences: relatedNames(row, "resource_audience_category", audiences),
            student_populations: relatedNames(row, "resource_student_pop", populations),
            categories: relatedNames(row, "resource_category", categories),
          };
        })
        .filter(
          (row) =>
            wants(row.campus) &&
            row.audiences.includes("Students") &&
            (row.student_populations.length === 0 || row.student_populations.includes("Undergraduate Students")),
        );
      const pages = commons
        .filter(undergraduateCommonsPage)
        .map((row) => wordpressDocument(row, "learning_commons", COMMONS, "vancouver", at));
      for (const [stem, rows, source, grain] of [
        [
          "it_services",
          services,
          this.sources[0]!,
          "one UBC IT service whose official audience taxonomy includes Students",
        ],
        [
          "wellbeing_resources",
          resources,
          this.sources[1]!,
          "one student-facing UBC Wellbeing resource for undergraduates or an unspecified student population",
        ],
        ["learning_commons_pages", pages, this.sources[2]!, "one published Vancouver Learning Commons guidance page"],
      ] as const) {
        out.describe(stem, {
          grain,
          columns: {
            ...FACT_COLUMNS,
            audiences:
              "Resolved official audience taxonomy labels; do not assume every service is available to every student",
            related:
              "Original Drupal relationship UUIDs; the literal missing sentinel denotes an unavailable target and is not a foreign key",
            unavailable_relationships:
              "Relationship names containing UBC's missing sentinel; no labels are inferred for those targets",
            source_url:
              "Official service/guidance page for details; pricing, eligibility prose and page bodies are not republished",
          },
          joins:
            stem === "it_services"
              ? [
                  "related.audience[] -> student-support/it_audiences.id",
                  "related.service_category -> student-support/it_categories.id",
                ]
              : stem === "wellbeing_resources"
                ? [
                    "related.resource_campus[] -> student-support/wellbeing_campuses.id",
                    "related.resource_audience_category[] -> student-support/wellbeing_audiences.id",
                    "related.resource_category[] -> student-support/wellbeing_categories.id",
                    "related.resource_student_pop[] -> student-support/wellbeing_populations.id",
                  ]
                : [],
        });
        await publishFacts(out, `student-support/${stem}`, rows, source);
      }
      for (const [stem, rows, host, resource] of [
        ["it_audiences", itAudiences, IT, "audience"],
        ["it_categories", itCategories, IT, "parent_service_category"],
        ["wellbeing_campuses", campuses, WELLBEING, "campus_category"],
        ["wellbeing_audiences", audiences, WELLBEING, "audience_category"],
        ["wellbeing_categories", categories, WELLBEING, "resource_category"],
        ["wellbeing_populations", populations, WELLBEING, "student_population"],
      ] as const) {
        out.describe(stem, {
          grain: "one official Drupal taxonomy term",
          columns: { id: "Upstream UUID referenced by a resource's related fields", name: "Official label" },
        });
        const endpoint = `https://${host}/jsonapi/taxonomy_term/${resource}`;
        await publishFacts(
          out,
          `student-support/${stem}`,
          rows.map((row) => ({
            ...row,
            source_url: string(row.alias)
              ? new URL(string(row.alias), `https://${host}`).href
              : `${endpoint}/${row.id}`,
            api_url: `${endpoint}/${row.id}`,
            retrieved_at: at,
          })),
          endpoint,
        );
      }
      await out.json(
        "_unavailable.json",
        wellbeing
          .filter((row) => unavailableRelationships(row).length > 0)
          .map((row) => ({
            source_url: `https://${WELLBEING}${row.alias}`,
            upstream_id: row.id,
            title: row.title,
            relationships: unavailableRelationships(row),
            retained: resources.some((resource) => resource.id === `wellbeing:${row.id}`),
            reason:
              "UBC returns a literal missing relationship target. Only available taxonomy labels are used; records with no verified student/undergraduate audience are excluded.",
          })),
        { source: this.sources[1] },
      );
      await out.json("_sources.json", [
        {
          source: this.sources[0],
          authority: "UBC Information Technology",
          representation: "facts_and_links",
          retrieved_at: at,
          records: services.length,
          upstream_records: it.length,
          excluded_by_audience: it.length - services.length,
          robots_url: `https://${IT}/robots.txt`,
          campus: null,
        },
        {
          source: this.sources[1],
          authority: "UBC Wellbeing",
          representation: "facts_and_links",
          retrieved_at: at,
          records: resources.length,
          upstream_records: wellbeing.length,
          excluded_by_scope: wellbeing.length - resources.length,
          robots_url: `https://${WELLBEING}/robots.txt`,
          scope: "undergraduate",
          notes:
            "Requires Students in the audience taxonomy; excludes graduate-only populations and other campuses. Missing targets are recorded in _unavailable.json, not fetched or inferred. Multi-campus/virtual resources remain. Historical resources are not assumed current.",
        },
        {
          source: this.sources[2],
          authority: "UBC Learning Commons",
          representation: "facts_and_links",
          retrieved_at: at,
          records: pages.length,
          robots_url: `https://${COMMONS}/robots.txt`,
          campus: "vancouver",
          skipped: wants("vancouver") ? null : "Source is Vancouver-only",
        },
      ]);
    }
  },
);
