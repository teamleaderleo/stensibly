import type { ExecutionEnvelope } from "./execution-envelope.js";
import type { Item } from "./store.js";
import type { WorkRun } from "./runs.js";
import type { ActorInput } from "./schemas.js";

export interface DispatchWorkInputV1 {
  project: string;
  itemId: string;
  expectedClaimGeneration: number;
  actor: ActorInput;
  runnerType: string;
  runnerProfile: string;
  runnerProfileVersion: string | null;
  executionEnvelope: ExecutionEnvelope;
  leaseSeconds: number;
  maxAttempts: number;
  retryBackoffSeconds: number;
  idempotencyKey: string;
}

export interface DispatchWorkResultV1 {
  status: "dispatched";
  replay: boolean;
  expectedClaimGeneration: number;
  claimedGeneration: number;
  item: Item;
  run: WorkRun;
}

export interface ExactDispatchLedgerV1 {
  dispatchWork(input: DispatchWorkInputV1): Promise<DispatchWorkResultV1>;
}

export function exactDispatchLedgerV1(value: unknown): ExactDispatchLedgerV1 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ExactDispatchLedgerV1>;
  return typeof candidate.dispatchWork === "function"
    ? candidate as ExactDispatchLedgerV1
    : null;
}
