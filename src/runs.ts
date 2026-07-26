import * as Core from "./runs-core.js";
import { compatibilityExecutionEnvelope } from "./execution-envelope-default.js";
import type { ActorInput } from "./schemas.js";
import type { StensiblyStore } from "./store.js";
import type { ExecutionActual, ExecutionEnvelope } from "./execution-envelope.js";
import {
  appendExecutionRecord,
  assertEnvelopeIdempotency,
  bindExecutionEnvelope,
  ensureRunExecutionSchema,
  hydrateWorkRun,
  hydrateWorkRuns,
  requiredExecutionEnvelope,
  tagLatestRunEvent,
  type RunExecutionRecord,
} from "./run-execution-store.js";

export { runCommands, runStatuses } from "./runs-core.js";
export type {
  HeartbeatWorkRunInput,
  ListWorkRunsInput,
  ReconcileRunsResult,
  RunUsage,
  WorkRunCommand,
  WorkRunStatus,
} from "./runs-core.js";

export type WorkRun = Core.WorkRun & {
  executionEnvelope?: ExecutionEnvelope | null;
  executionRecords?: RunExecutionRecord[];
};

export interface CreateWorkRunInput
  extends Omit<Core.CreateWorkRunInput, "actor"> {
  actor: ActorInput;
  executionEnvelope?: ExecutionEnvelope;
}

export interface TransitionWorkRunInput extends Core.TransitionWorkRunInput {
  executionActual?: ExecutionActual;
}

export function ensureRunSchema(store: StensiblyStore): void {
  Core.ensureRunSchema(store);
  ensureRunExecutionSchema(store);
}

export function createWorkRun(
  store: StensiblyStore,
  rawInput: CreateWorkRunInput,
  now = new Date(),
): WorkRun {
  ensureRunSchema(store);
  const envelope = requiredExecutionEnvelope(
    rawInput.executionEnvelope
      ?? compatibilityExecutionEnvelope(
        `Execute work item ${rawInput.itemId} with runner profile ${rawInput.runnerProfile}`,
      ),
  );
  const { executionEnvelope: _executionEnvelope, ...coreInput } = rawInput;
  const transaction = store.db.transaction(() => {
    assertEnvelopeIdempotency(
      store,
      rawInput.idempotencyKey,
      envelope,
      "run creation",
    );
    const run = Core.createWorkRun(store, coreInput, now);
    bindExecutionEnvelope(
      store,
      run.id,
      envelope,
      rawInput.idempotencyKey,
      run.createdAt,
    );
    tagLatestRunEvent(store, { run, type: "run.queued" });
    return hydrateWorkRun(store, run);
  });
  return transaction();
}

export function getWorkRun(
  store: StensiblyStore,
  id: string,
  now = new Date(),
): WorkRun {
  ensureRunSchema(store);
  return hydrateWorkRun(store, Core.getWorkRun(store, id, now));
}

export function listWorkRuns(
  store: StensiblyStore,
  input: Core.ListWorkRunsInput = {},
  now = new Date(),
): WorkRun[] {
  ensureRunSchema(store);
  return hydrateWorkRuns(store, Core.listWorkRuns(store, input, now));
}

export function listRetryEligibleRuns(
  store: StensiblyStore,
  now = new Date(),
): WorkRun[] {
  ensureRunSchema(store);
  return hydrateWorkRuns(store, Core.listRetryEligibleRuns(store, now));
}

export function heartbeatWorkRun(
  store: StensiblyStore,
  input: Core.HeartbeatWorkRunInput,
  now = new Date(),
): WorkRun {
  ensureRunSchema(store);
  const transaction = store.db.transaction(() => {
    const run = Core.heartbeatWorkRun(store, input, now);
    tagLatestRunEvent(store, { run, type: "run.heartbeat" });
    return hydrateWorkRun(store, run);
  });
  return transaction();
}

export function transitionWorkRun(
  store: StensiblyStore,
  rawInput: TransitionWorkRunInput,
  now = new Date(),
): WorkRun {
  ensureRunSchema(store);
  const { executionActual, ...coreInput } = rawInput;
  const transaction = store.db.transaction(() => {
    const run = Core.transitionWorkRun(store, coreInput, now);
    const eventType = coreInput.command === "retry"
      ? "run.retry_queued"
      : `run.${run.status}`;
    tagLatestRunEvent(store, { run, type: eventType });
    appendExecutionRecord(store, {
      run,
      transition: coreInput.command,
      actual: executionActual,
      idempotencyKey: coreInput.idempotencyKey,
      createdAt: run.updatedAt,
    });
    return hydrateWorkRun(store, run);
  });
  return transaction();
}

export function reconcileStaleRuns(
  store: StensiblyStore,
  now = new Date(),
): Core.ReconcileRunsResult {
  ensureRunSchema(store);
  const transaction = store.db.transaction(() => {
    const result = Core.reconcileStaleRuns(store, now);
    const abandoned = result.abandoned.map((run) => {
      tagLatestRunEvent(store, { run, type: "run.abandoned" });
      appendExecutionRecord(store, {
        run,
        transition: "abandon",
        actual: { estimateErrorReasons: ["lease_expired"] },
        createdAt: run.updatedAt,
      });
      return hydrateWorkRun(store, run);
    });
    return { abandoned };
  });
  return transaction();
}
