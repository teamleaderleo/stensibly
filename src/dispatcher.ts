import * as Core from "./dispatcher-core.js";
import { compatibilityExecutionEnvelope } from "./execution-envelope-default.js";
import {
  executionEnvelopeJson,
  type ExecutionEnvelope,
} from "./execution-envelope.js";
import { appendRunEnvelopeReference } from "./run-envelope-events.js";
import {
  bindExecutionEnvelope,
  ensureRunExecutionSchema,
  hydrateWorkRun,
  recordDispatchEnvelopeIdempotency,
  requiredExecutionEnvelope,
} from "./run-execution-store.js";
import { ensureRunSchema } from "./runs.js";
import { ConflictError, type StensiblyStore } from "./store.js";

export {
  ensureDispatchSchema,
  surveyDispatch,
} from "./dispatcher-core.js";
export type {
  DispatchCandidate,
  DispatchResult,
  DispatchSurvey,
  SurveyDispatchInput,
} from "./dispatcher-core.js";

export interface DispatchInput extends Core.DispatchNextWorkInput {
  executionEnvelope?: ExecutionEnvelope;
}

interface EnvelopeRow {
  envelope_json: string;
}

interface ExistingKeyRow {
  exists_flag: number;
}

export function dispatchNextWork(
  store: StensiblyStore,
  rawInput: DispatchInput,
  now = new Date(),
): Core.DispatchResult | null {
  ensureRunSchema(store);
  Core.ensureDispatchSchema(store);
  ensureRunExecutionSchema(store);
  const envelope = requiredExecutionEnvelope(
    rawInput.executionEnvelope
      ?? compatibilityExecutionEnvelope(
        rawInput.itemId
          ? `Dispatch work item ${rawInput.itemId} with runner profile ${rawInput.runnerProfile}`
          : `Dispatch the next eligible item with runner profile ${rawInput.runnerProfile}`,
      ),
  );
  const { executionEnvelope: _executionEnvelope, ...coreInput } = rawInput;
  const transaction = store.db.transaction(() => {
    assertDispatchEnvelopeIdempotency(
      store,
      rawInput.idempotencyKey,
      envelope,
    );
    const result = Core.dispatchNextWork(store, coreInput, now);
    recordDispatchEnvelopeIdempotency(
      store,
      rawInput.idempotencyKey,
      envelope,
      now.toISOString(),
    );
    if (!result) return null;
    bindExecutionEnvelope(
      store,
      result.run.id,
      envelope,
      undefined,
      result.run.createdAt,
    );
    appendRunEnvelopeReference(store, {
      run: result.run,
      lifecycleEventType: "run.queued",
    });
    return {
      ...result,
      run: hydrateWorkRun(store, result.run),
    };
  });
  return transaction();
}

function assertDispatchEnvelopeIdempotency(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  envelope: ExecutionEnvelope,
): void {
  if (!idempotencyKey) return;
  const existing = store.db
    .query<EnvelopeRow, [string]>(`
      SELECT envelope_json
      FROM dispatch_execution_envelopes
      WHERE idempotency_key = ?1
    `)
    .get(idempotencyKey);
  if (existing) {
    if (existing.envelope_json !== executionEnvelopeJson(envelope)) {
      throw new ConflictError(
        "Idempotency key was already used with a different dispatch execution envelope",
      );
    }
    return;
  }
  const legacy = store.db
    .query<ExistingKeyRow, [string]>(`
      SELECT 1 AS exists_flag
      FROM dispatch_commands
      WHERE idempotency_key = ?1
      LIMIT 1
    `)
    .get(idempotencyKey);
  if (legacy) {
    throw new ConflictError(
      "Idempotency key belongs to a legacy dispatch without an execution envelope",
    );
  }
}
