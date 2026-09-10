import { describe, expect, it } from "vitest";
import { policyLifecycle, policyRecord } from "./policies.ts";
import {
  drupalDocument,
  relatedNames,
  resourceCampus,
  unavailableRelationships,
  undergraduateCommonsPage,
} from "./support.ts";

const ROW = {
  id: "uuid",
  nid: 1,
  title: "Official support",
  status: true,
  alias: "/support",
  changed: { value: "2026-01-01T12:30:00+00:00" },
  body: { processed: "<p>Guidance.</p>" },
  related: { uid: "editor", audience: ["students"] },
};

describe("official support records", () => {
  it("handles structured Drupal timestamps and excludes editorial user relationships", () => {
    const page = drupalDocument(ROW, "it", "it.ubc.ca", "node/service", null, "2026-09-10T00:00:00Z");
    expect(page.source_modified_at).toBe("2026-01-01T12:30:00+00:00");
    expect(page.related).toEqual({ audience: ["students"] });
    expect(page.source_url).toBe("https://it.ubc.ca/support");
  });

  it("resolves audience labels and fails on dangling references", () => {
    expect(relatedNames(ROW, "audience", [{ id: "students", name: "Students" }])).toEqual(["Students"]);
    expect(() => relatedNames(ROW, "audience", [])).toThrow(/Unresolved/);
  });

  it("retains the missing sentinel without inventing a label or dropping verified audiences", () => {
    const row = { ...ROW, related: { audience: ["missing", "students"] } };
    expect(relatedNames(row, "audience", [{ id: "students", name: "Students" }])).toEqual(["Students"]);
    expect(unavailableRelationships(row)).toEqual(["audience"]);
    const page = drupalDocument(row, "it", "it.ubc.ca", "node/service", null, "2026-09-10T00:00:00Z");
    expect(page.related).toEqual({ audience: ["missing", "students"] });
    expect(page.unavailable_relationships).toEqual(["audience"]);
    expect(relatedNames({ ...ROW, related: { audience: ["missing"] } }, "audience", [])).toEqual([]);
  });

  it("does not mistake undergraduate titles for graduate-only guidance", () => {
    expect(
      undergraduateCommonsPage({ link: "/undergraduate-guide/", title: { rendered: "Undergraduate research" } }),
    ).toBe(true);
    expect(undergraduateCommonsPage({ link: "/writing/", title: { rendered: "Graduate writing" } })).toBe(false);
    expect(
      undergraduateCommonsPage({ link: "/writing/", title: { rendered: "Undergraduate and graduate writing" } }),
    ).toBe(true);
  });

  it("uses the official campus taxonomy, retaining shared, virtual and unlabelled resources", () => {
    expect(resourceCampus(["Vancouver Campus"])).toBe("vancouver");
    expect(resourceCampus(["Okanagan Campus"])).toBe("okanagan");
    expect(resourceCampus(["Vancouver Campus", "Okanagan Campus"])).toBeNull();
    expect(resourceCampus(["Virtual"])).toBeNull();
    expect(resourceCampus([])).toBeNull();
  });
});

describe("University Counsel policy metadata", () => {
  it("does not infer that an unlabelled policy is in force", () => {
    expect(policyLifecycle("Vacations Policy (Repealed February 1, 2022)")).toBe("repealed");
    expect(policyLifecycle("Retired policy")).toBe("retired");
    expect(policyLifecycle("Student Conduct Policy")).toBe("listed");
  });

  it("retains canonical citations, published dates and the explanatory-notes limitation", () => {
    const record = policyRecord(
      {
        ...ROW,
        field_policy_number: "SC7",
        field_legacy_policy_number: "3",
        field_policy_date: "2020-01-01",
        field_do_not_link_from_search: false,
      },
      "2026-09-10T00:00:00Z",
    );
    expect(record).toMatchObject({
      policy_number: "SC7",
      legacy_policy_number: "3",
      policy_date: "2020-01-01",
      source_url: "https://universitycounsel.ubc.ca/support",
      content_kind: "policy_index",
      lifecycle: "listed",
    });
    expect(record).not.toHaveProperty("notes");
    expect(record).not.toHaveProperty("pdf_url");
  });
});
