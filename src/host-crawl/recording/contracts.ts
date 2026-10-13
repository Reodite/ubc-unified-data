import type { ProducerContext } from "../contracts.ts";

export interface AcquisitionBudgetGrant {
  id: string;
  authoritySha256: string;
  expectedRequests: number;
  expectedBytes: number;
  additionalRequests: number;
  additionalBytes: number;
  minimumIntervalMs: number;
}

export interface RecordingOptions {
  hostname: string;
  directory: string;
  producer: ProducerContext;
  acquire: boolean;
  seedSha256?: string;
  maxRequests?: number;
  maxBytes?: number;
  maxResponseBytes?: number;
  maxDurationMs?: number;
  minimumMs?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  resumeInterrupted?: boolean;
  recoverTransientFailures?: boolean;
  documentFormats?: readonly "pdf"[];
  documentUrlAllowed?: (url: string) => boolean;
  htmlDocumentsOnly?: boolean;
}
