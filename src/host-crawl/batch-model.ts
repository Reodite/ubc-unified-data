import type { CompletedHost, ProducerContext } from "./contracts.ts";
import type { AcquisitionBudgetGrant } from "./recording.ts";

export interface HostBatchConfig {
  repositoryRoot: string;
  producerRoot: string;
  producer: ProducerContext;
  baseline: string;
  main: string;
  bootstrapFiles: Record<string, string>;
  recoverTransientFailures?: boolean;
  acquisitionBudgetGrants?: Record<string, AcquisitionBudgetGrant>;
  requireSavedRouting?: boolean;
  historicalReady?: Record<
    string,
    { readySha256: string; producerRoot: string; producer: ProducerContext; pdfCacheDirectory?: string }
  >;
}

interface ReadyHostBase {
  hostname: string;
  recording_seal: string;
  seed_sha256: string;
  pdf_profile_sha256: string | null;
  completed: CompletedHost;
}

export interface ReadyHostV1 extends ReadyHostBase {
  version: 1;
}

export interface ReadyHostV2 extends ReadyHostBase {
  version: 2;
  markdown_profile_sha256: string | null;
}

export type ReadyHost = ReadyHostV1 | ReadyHostV2;
