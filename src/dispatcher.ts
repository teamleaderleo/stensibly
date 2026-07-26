import * as Core from "./dispatcher-core.js";
import type { ExecutionEnvelope } from "./execution-envelope.js";
import {
  assertDispatchEnvelopeIdempotency,
  bindExecutionEnvelope,
  ensureRunExecutionSchema,
  hydrateWorkRun,
  recordDispatchEnvelopeIdempotency,
  requiredExecutionEnvelope,
  tagLatestRunEvent,
} from "./run-execution-store.js";
import { ensureRunSchema } from "./runs.js";
import type { StensiblyStore } from "./store.js";

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
  executionEnvelope: ExecutionEnvelope;
}

export function dispatchNextWork(
  store: StensiblyStore,
  rawInput: DispatchInput,
  now = new Date(),
): Core.DispatchResult | null {
  ensureRunSchema(store);
  ensureRunExecutionSchema(store);
  const envelope = requiredExecutionEnvelope(rawInput.executionEnvelope);
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
    tagLatestRunEvent(store, { run: result.run, type: "run.queued" });
    return {
      ...result,
      run: hydrateWorkRun(store, result.run),
    };
  });
  return transaction();
}
