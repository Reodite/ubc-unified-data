import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  currentUnavailableHosts,
  HostDispositionLedger,
  inspectUnavailableCandidates,
  type UnavailableCandidate,
} from "./host-crawl/host-dispositions.ts";
import { assertExternalPath } from "./host-crawl/paths.ts";
import { readRegularFile } from "./host-crawl/public-validation.ts";

export async function runHostDispositions(args: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      action: { type: "string" },
      selection: { type: "string" },
      host: { type: "string" },
      reason: { type: "string" },
    },
  });
  if (values.action === "stats") return { unavailable: [...currentUnavailableHosts()].sort() };
  if (values.action === "inspect") {
    if (!values.selection) throw new Error("--selection is required");
    const candidates = JSON.parse(
      (await readRegularFile(assertExternalPath(values.selection))).toString("utf8"),
    ) as UnavailableCandidate[];
    if (!Array.isArray(candidates)) throw new Error("Selection must be a host array");
    const inspected = inspectUnavailableCandidates(candidates);
    return {
      verified: inspected.length,
      kinds: Object.fromEntries(
        [...new Set(inspected.map((item) => item.evidence.kind))].map((kind) => [
          kind,
          inspected.filter((item) => item.evidence.kind === kind).length,
        ]),
      ),
    };
  }
  if (!values.action || !["unavailable", "reopen"].includes(values.action))
    throw new Error("Unknown disposition action");
  const ledger = HostDispositionLedger.open();
  try {
    if (values.action === "unavailable") {
      if (!values.selection) throw new Error("--selection is required");
      const candidates = JSON.parse(
        (await readRegularFile(assertExternalPath(values.selection))).toString("utf8"),
      ) as UnavailableCandidate[];
      if (!Array.isArray(candidates) || !candidates.length || candidates.length > 500)
        throw new Error("Selection must contain a finite nonempty host array");
      const recorded = ledger.appendUnavailable(candidates);
      return { recorded, unavailable: [...currentUnavailableHosts()].sort() };
    }
    if (!values.host || !values.reason) throw new Error("--host and --reason are required");
    ledger.reopen(values.host, values.reason);
    return { reopened: values.host, unavailable: [...currentUnavailableHosts()].sort() };
  } finally {
    ledger.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHostDispositions(process.argv.slice(2))
    .then((value) => console.log(JSON.stringify(value, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
