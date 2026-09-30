import type { Http, Output } from "../base.ts";
import { InvalidValueError, register, utcnow } from "../base.ts";
import { FACT_COLUMNS, publishFacts } from "../public-facts.ts";
import { drupalRecords, string, type Row } from "../source-documents.ts";
import { drupalDocument } from "./support.ts";

export const POLICY_HOST = "universitycounsel.ubc.ca";
export const POLICY_SOURCE = `https://${POLICY_HOST}/jsonapi/node/policy`;

export const UNDERGRADUATE_POLICY_CODES = new Set([
  "FM1",
  "LR4",
  "LR7",
  "LR8",
  "LR10",
  "SC1",
  "SC2",
  "SC5",
  "SC6",
  "SC7",
  "SC9",
  "SC12",
  "SC13",
  "SC14",
  "SC16",
  "SC17",
  "SC18",
]);

export function policyLifecycle(title: string): string {
  if (/\brepealed\b/i.test(title)) return "repealed";
  if (/\bretired\b/i.test(title)) return "retired";
  return "listed";
}

export function policyRecord(row: Row, at: string): Row {
  const page = drupalDocument(row, "university_counsel", POLICY_HOST, "node/policy", null, at);
  return {
    ...page,
    policy_number: row.field_policy_number ?? null,
    legacy_policy_number: row.field_legacy_policy_number ?? null,
    long_title: row.field_policy_long_title ?? null,
    policy_date: row.field_policy_date ?? null,
    procedures_date: row.field_procedures_date ?? null,
    guidelines_date: row.field_guidelines_date ?? null,
    rules_date: row.field_rules_date ?? null,
    lifecycle: policyLifecycle(string(row.title)),
    linked_from_search: row.field_do_not_link_from_search === false,
    content_kind: "policy_index",
  };
}

export const Policies = register(
  class {
    name = "policies";
    folder = "policies";
    title = "Undergraduate-relevant university policy index";
    description =
      "Identifiers, dates and canonical links for undergraduate-relevant policies. Shared policies may also apply to other groups. No policy PDFs or explanatory-note prose are published.";
    sources = [POLICY_SOURCE, `https://${POLICY_HOST}/policies`];

    async collect(http: Http, out: Output): Promise<void> {
      const at = utcnow();
      const rows = await drupalRecords(http, POLICY_HOST, "node/policy");
      if (!rows.length) throw new InvalidValueError("University Counsel returned no policies");
      const policies = rows
        .filter((row) => UNDERGRADUATE_POLICY_CODES.has(string(row.field_policy_number)))
        .map((row) => policyRecord(row, at));
      if (!policies.length) throw new InvalidValueError("No undergraduate-relevant policy codes found");
      out.describe("index", {
        grain:
          "one undergraduate-relevant University Counsel policy record; this is a selected subset, not the full policy index",
        columns: {
          ...FACT_COLUMNS,
          policy_number: "Current UBC policy code (e.g. SC7); preserve as a string",
          legacy_policy_number: "Previous numeric policy code, when published",
          lifecycle: "repealed/retired only when the title says so; listed does not certify that a policy is in force",
          policy_date: "Published policy date; distinct from the web page modification timestamp",
          content_kind: "policy_index: identifiers and dates only, not explanatory notes or binding policy text",
          linked_from_search: "Whether UBC's record permits linking from its search results",
        },
        joins: ["related.related_policies[] -> policies/index.upstream_id"],
      });
      await publishFacts(out, "policies/index", policies, POLICY_SOURCE);
      await out.json(
        "_source.json",
        {
          source: POLICY_SOURCE,
          authority: "University of British Columbia, Office of the University Counsel",
          representation: "facts_and_links",
          campus: null,
          retrieved_at: at,
          records: policies.length,
          upstream_records: rows.length,
          scope: "undergraduate",
          selected_policy_codes: [...UNDERGRADUATE_POLICY_CODES],
          excluded_by_scope: rows.length - policies.length,
          robots_url: `https://${POLICY_HOST}/robots.txt`,
          notes: [
            "Institution-wide metadata applies to both campuses; no campus filter is applied.",
            "UBC requests linking to the canonical explanatory-notes page for the current documents. Policy PDFs and their direct download URLs are not collected.",
            "Neither policy text nor explanatory-note prose is published. Consult the canonical source page for the current documents.",
            "Historical entries remain distinguishable by lifecycle. listed is not a determination of legal status.",
          ],
        },
        { source: POLICY_SOURCE },
      );
    }
  },
);
