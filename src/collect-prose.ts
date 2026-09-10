import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { DATA_DIR, ROOT } from "./base.ts";
import { ProseClient } from "./prose/client.ts";
import { collectLiveSource } from "./prose/collect.ts";
import { collectMirroredSource, MIRROR_PROSE_SOURCES } from "./prose/mirrors.ts";
import type { CollectionResult } from "./prose/model.ts";
import { writeProseCategory, writeProseIndex, type ProseCategorySummary } from "./prose/output.ts";
import { LIVE_PROSE_SOURCES } from "./prose/sources.ts";

export const PROSE_SOURCES = [...LIVE_PROSE_SOURCES, ...MIRROR_PROSE_SOURCES.map((definition) => definition.source)];

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      list: { type: "boolean" },
      skip: { type: "string", multiple: true, default: [] },
      refresh: { type: "boolean", default: false },
      "mirror-only": { type: "boolean", default: false },
      "no-fill-missing": { type: "boolean", default: false },
      workers: { type: "string", default: "3" },
      "min-interval": { type: "string", default: "500" },
      timeout: { type: "string", default: "30" },
    },
  });
  if (values.list) {
    for (const source of PROSE_SOURCES)
      console.log(`${source.key.padEnd(24)} ${source.strategy.padEnd(10)} ${source.title}`);
    return 0;
  }
  const unknown = [...positionals, ...values.skip].filter((key) => !PROSE_SOURCES.some((source) => source.key === key));
  if (unknown.length) throw new Error(`Unknown prose subcategories: ${unknown.join(", ")}`);
  const workers = Number(values.workers);
  const minimum = Number(values["min-interval"]);
  const timeout = Number(values.timeout);
  if (
    !Number.isInteger(workers) ||
    workers < 1 ||
    workers > 8 ||
    !Number.isFinite(minimum) ||
    minimum < 0 ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  )
    throw new Error("Use 1–8 source workers, a nonnegative minimum interval, and a positive timeout.");
  const selected = PROSE_SOURCES.filter(
    (source) =>
      (!positionals.length || positionals.includes(source.key)) &&
      !values.skip.includes(source.key) &&
      (!values["mirror-only"] || source.strategy === "mirror"),
  );
  const cacheDir = path.join(ROOT, ".cache/prose");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const client = new ProseClient({
    cacheDir,
    refresh: values.refresh,
    minInterval: minimum,
    timeout: timeout * 1000,
    blockedHosts: PROSE_SOURCES.filter((source) => values.skip.includes(source.key)).map((source) => source.host),
  });
  const summaries = new Map<string, ProseCategorySummary>();
  let next = 0;
  let failures = 0;
  console.log(`Collecting ${selected.length} prose subcategories under ${path.join(DATA_DIR, "prose")}`);
  console.log("Source snapshots are cached for resumption; retrieval timestamps retain their original values.");
  await writeProseIndex(PROSE_SOURCES, summaries);
  const worker = async () => {
    for (;;) {
      const source = selected[next++];
      if (!source) return;
      console.log(`START ${source.key}`);
      let result: CollectionResult;
      try {
        if (source.strategy === "mirror") {
          const definition = MIRROR_PROSE_SOURCES.find((item) => item.source.key === source.key)!;
          result = await collectMirroredSource(definition, client, DATA_DIR, !values["no-fill-missing"]);
        } else {
          result = await collectLiveSource(source, client, console.log);
        }
      } catch (error) {
        result = {
          source: source.key,
          articles: [],
          inventory: [],
          discoveryErrors: [String(error)],
          discoveryNotes: [],
        };
      }
      const summary = await writeProseCategory(source, result);
      summaries.set(source.key, summary);
      if (summary.status === "partial") failures++;
      console.log(
        `DONE ${source.key}: ${summary.articles} articles, ${summary.inventory_urls} inventoried URLs, ${summary.status}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, selected.length) }, worker));
  await writeProseIndex(PROSE_SOURCES, summaries);
  await writeFile(path.join(cacheDir, "last-run-requests.json"), JSON.stringify(client.journal, null, 2), {
    mode: 0o600,
  });
  console.log(
    `Selected collection complete: ${[...summaries.values()].reduce((sum, item) => sum + item.articles, 0)} articles; ${failures} partial subcategories.`,
  );
  return failures ? 1 : 0;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
