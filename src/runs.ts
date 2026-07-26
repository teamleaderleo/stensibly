import * as Core from "./runs-core.js";
import { compatibilityExecutionEnvelope } from "./execution-envelope-default.js";
import {
  parseExecutionActual,
  type ExecutionActual,
  type ExecutionEnvelope,
} from "./execution-envelope.js";
import { appendRunEnvelopeReference } from "./run-envelope-events.js";
import type { ActorInput } from "./schemas.js";
import {
  appendExecutionRecord,
  assertEnvelopeIdempotency,
  bindExecutionEnvelope,
  ensureRunExecutionSchema,
  hydrateWorkRun,
  hydrateWorkRuns,
  requiredExecutionEnvelope,
  type RunExecutionRecord,
} from "./run-execution-store.js";
import { ConflictError, type StensiblyStore } from "./store.js";

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

interface ExecutionRecordReplayRow {
  run_id: string;
  run_generation: number;
  lease_generation: number;
  transition: string;
  actual_json: string;
}

interface RunCommandReplayRow {
  run_id: string;
  command: string;
}

const actualRecordingCommands = new Set<Core.WorkRunCommand>([
  "succeed",
  "fail",
  "cancel",
]);

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
    appendRunEnvelopeReference(store, {
      run,
      lifecycleEventType: "run.queued",
    });
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
    appendRunEnvelopeReference(store, {
      run,
      lifecycleEventType: "run.heartbeat",
    });
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
    const normalizedActual = validateExecutionActualReplay(
      store,
      coreInput,
      executionActual,
    );
    const run = Core.transitionWorkRun(store, coreInput, now);
    const eventType = coreInput.command === "retry"
      ? "run.retry_queued"
      : `run.${run.status}`;
    appendRunEnvelopeReference(store, {
      run,
      lifecycleEventType: eventType,
    });
    appendExecutionRecord(store, {
      run,
      transition: coreInput.command,
      actual: normalizedActual,
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
      appendRunEnvelopeReference(store, {
        run,
        lifecycleEventType: "run.abandoned",
        actorId: null,
      });
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

function validateExecutionActualReplay(
  store: StensiblyStore,
  input: Core.TransitionWorkRunInput,
  rawActual: ExecutionActual | undefined,
): ExecutionActual | undefined {
  if (!actualRecordingCommands.has(input.command)) {
    if (rawActual !== undefined) {
      throw new TypeError(
        "Execution actuals may be recorded only for succeed, fail, or cancel transitions",
      );
    }
    return undefined;
  }

  const actual = parseExecutionActual(rawActual);
  if (!input.idempotencyKey) return actual;

  const existing = store.db
    .query<ExecutionRecordReplayRow, [string]>(`
      SELECT run_id, run_generation, lease_generation, transition, actual_json
      FROM run_execution_records
      WHERE idempotency_key = ?1
    `)
    .get(input.idempotencyKey);
  if (existing) {
    const same = existing.run_id === input.id
      && existing.run_generation === input.expectedGeneration + 1
      && existing.lease_generation === input.expectedLeaseGeneration
      && existing.transition === input.command
      && existing.actual_json === JSON.stringify(actual);
    if (!same) {
      throw new ConflictError(
        "Idempotency key was already used for a different execution result",
      );
    }
    return actual;
  }

  const legacy = store.db
    .query<RunCommandReplayRow, [string]>(`
      SELECT run_id, command
      FROM run_commands
      WHERE idempotency_key = ?1
    `)
    .get(input.idempotencyKey);
  if (legacy) {
    throw new ConflictError(
      "Idempotency key belongs to a legacy run command without an execution result",
    );
  }
  return actual;
}
