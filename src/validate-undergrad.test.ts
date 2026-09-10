import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Output } from "./base.ts";
import { publicFacts } from "./public-facts.ts";
import { document } from "./source-documents.ts";
import { validateUndergradData } from "./validate-undergrad.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: { dangling?: boolean; duplicate?: boolean; hash?: string; leak?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubc-data-validation-"));
  roots.push(root);
  const out = new Output("housing", root);
  const source = document({
    sourceId: "housing",
    upstreamId: 1,
    url: "https://vancouver.housing.ubc.ca/example",
    title: "Residence fees",
    html: "<p>Housing fee conditions and payment instructions.</p>",
    campus: "vancouver",
    retrievedAt: "2026-09-10T00:00:00Z",
  });
  const page = publicFacts("housing/fee_pages", source);
  if (options.hash) page.record_sha256 = options.hash;
  if (options.leak) page.content_html = source.content_html;
  await out.table("fee_pages", options.duplicate ? [page, page] : [page]);
  const table = publicFacts("housing/fee_tables", {
    id: "fee:1",
    source_url: source.source_url,
    retrieved_at: source.retrieved_at,
    page_id: options.dangling ? "missing" : page.id,
    residence_ids: [],
    campus: "vancouver",
    source_context_required: true,
    values: [
      { row_label: 'Shared\n"double", room', column_label: "Room fee", amount_text: "$100.00", amount_cents: 10000 },
    ],
  });
  await out.table("fee_tables", [table]);
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({ groups: { housing: { status: "ok", datasets: out.datasets } } }),
  );
  await writeFile(
    path.join(root, "catalog.json"),
    JSON.stringify({
      groups: {
        housing: {
          status: "ok",
          tables: out.datasets
            .filter((dataset) => dataset.path.endsWith(".json"))
            .map((dataset) => ({ json: dataset.path, records: dataset.records })),
        },
      },
    }),
  );
  return root;
}

describe("offline undergraduate data validation", () => {
  it("validates nested CSV, public fact hashes and joins without double-counting", async () => {
    expect(await validateUndergradData(await fixture(), ["housing"])).toMatchObject({
      records: 2,
      fact_records_checked: 2,
      representation: "facts_and_links",
    });
  });

  it("detects file corruption and absent groups", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "housing/fee_pages.json"), "[]");
    await expect(validateUndergradData(root, ["housing"])).rejects.toThrow(/Byte-size/);
    await expect(validateUndergradData(root, ["libraries"])).rejects.toThrow(/missing or not successful/);
  });

  it("detects duplicate ids, broken hashes and dangling fee references", async () => {
    await expect(validateUndergradData(await fixture({ duplicate: true }), ["housing"])).rejects.toThrow(
      /Duplicate id/,
    );
    await expect(validateUndergradData(await fixture({ hash: "bad" }), ["housing"])).rejects.toThrow(/Fact hash/);
    await expect(validateUndergradData(await fixture({ dangling: true }), ["housing"])).rejects.toThrow(
      /Dangling housing/,
    );
  });

  it("rejects copied source bodies even when file counts and sizes match", async () => {
    await expect(validateUndergradData(await fixture({ leak: true }), ["housing"])).rejects.toThrow(
      /Unapproved public field/,
    );
  });
});
