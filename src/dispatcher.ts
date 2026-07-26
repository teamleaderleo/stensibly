import { randomUUID } from "node:crypto";
import * as Core from "./dispatcher-core.js";
import { compatibilityExecutionEnvelope } from "./execution-envelope-default.js";
import {
  executionEnvelopeJson,
  type ExecutionEnvelope,
} from "./execution-envelope.js";
import {
  appendPromiseWakeupConsumptionEvent,
  consumePromiseWakeupsForDispatch,
  ensurePromiseWakeupConsumptionSchema,
  readPromiseWakeupDispatchReplay,
  recordPromiseWakeupDispatchReplay,
  type PromiseWakeupDispatchSource,
} from "./promise-wakeup-consumptions.js";
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
  DispatchSurvey,
  SurveyDispatchInput,
} from "./dispatcher-core.js";

export interface DispatchInput extends Core.DispatchNextWorkInput {
  executionEnvelope?: ExecutionEnvelope;
}

export interface DispatchResult extends Core.DispatchResult {
  dispatchCommandId: string | null;
  consumedPromiseWakeupIds: string[];
  promiseWakeupSource: PromiseWakeupDispatchSource;
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
): DispatchResult | null {
  ensureRunSchema(store);
  Core.ensureDispatchSchema(store);
  ensureRunExecutionSchema(store);
  ensurePromiseWakeupConsumptionSchema(store);
  const { executionEnvelope: _executionEnvelope, ...coreInput } = rawInput;
  const transaction = store.db.transaction(() => {
    const hadDispatchReplay = hasDispatchReplay(store, rawInput.idempotencyKey);
    if (isLegacyDispatchReplay(store, rawInput.idempotencyKey)) {
      if (rawInput.executionEnvelope !== undefined) {
        throw new ConflictError(
          "Historical dispatch cannot be retrofitted with an execution envelope",
        );
      }
      const replay = Core.dispatchNextWork(store, coreInput, now);
      if (!replay) return null;
      return {
        ...replay,
        ...promiseWakeupFields(store, replay, rawInput, now, hadDispatchReplay),
        run: hydrateWorkRun(store, replay.run),
      };
    }

    const envelope = requiredExecutionEnvelope(
      rawInput.executionEnvelope
        ?? compatibilityExecutionEnvelope(
          rawInput.itemId
            ? `Dispatch work item ${rawInput.itemId} with runner profile ${rawInput.runnerProfile}`
            : `Dispatch the next eligible item with runner profile ${rawInput.runnerProfile}`,
        ),
    );
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
    const wakeupFields = promiseWakeupFields(
      store,
      result,
      rawInput,
      now,
      hadDispatchReplay,
    );
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
      ...wakeupFields,
      run: hydrateWorkRun(store, result.run),
    };
  });
  return transaction();
}

function promiseWakeupFields(
  store: StensiblyStore,
  result: Core.DispatchResult,
  input: DispatchInput,
  now: Date,
  hadDispatchReplay: boolean,
): Pick<DispatchResult, "dispatchCommandId" | "consumedPromiseWakeupIds" | "promiseWakeupSource"> {
  if (hadDispatchReplay) {
    const replay = readPromiseWakeupDispatchReplay(store, input.idempotencyKey);
    if (!replay) {
      return {
        dispatchCommandId: null,
        consumedPromiseWakeupIds: [],
        promiseWakeupSource: "legacy_unavailable",
      };
    }
    if (replay.runId !== result.run.id) {
      throw new ConflictError("Stored promise wakeup replay belongs to a different run");
    }
    return {
      dispatchCommandId: replay.dispatchCommandId,
      consumedPromiseWakeupIds: replay.consumedPromiseWakeupIds,
      promiseWakeupSource: "local",
    };
  }

  const dispatchCommandId = `dispatch_${randomUUID()}`;
  const consumed = consumePromiseWakeupsForDispatch(store, {
    itemId: result.item.id,
    projectId: result.item.project,
    dispatchCommandId,
    runId: result.run.id,
    consumedAt: now.toISOString(),
  });
  const consumedPromiseWakeupIds = consumed.map((entry) => entry.wakeupId);
  appendPromiseWakeupConsumptionEvent(store, {
    itemId: result.item.id,
    actorId: input.actor.id,
    dispatchCommandId,
    runId: result.run.id,
    consumedPromiseWakeupIds,
    createdAt: now.toISOString(),
  });
  recordPromiseWakeupDispatchReplay(store, {
    idempotencyKey: input.idempotencyKey,
    dispatchCommandId,
    runId: result.run.id,
    consumedPromiseWakeupIds,
    createdAt: now.toISOString(),
  });
  return {
    dispatchCommandId,
    consumedPromiseWakeupIds,
    promiseWakeupSource: "local",
  };
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
  if (existing && existing.envelope_json !== executionEnvelopeJson(envelope)) {
    throw new ConflictError(
      "Idempotency key was already used with a different dispatch execution envelope",
    );
  }
}

function hasDispatchReplay(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
): boolean {
  if (!idempotencyKey) return false;
  return store.db
    .query<ExistingKeyRow, [string]>(`
      SELECT 1 AS exists_flag
      FROM dispatch_commands
      WHERE idempotency_key = ?1
      LIMIT 1
    `)
    .get(idempotencyKey) !== null;
}

function isLegacyDispatchReplay(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
): boolean {
  if (!idempotencyKey) return false;
  const envelope = store.db
    .query<ExistingKeyRow, [string]>(`
      SELECT 1 AS exists_flag
      FROM dispatch_execution_envelopes
      WHERE idempotency_key = ?1
      LIMIT 1
    `)
    .get(idempotencyKey);
  if (envelope) return false;
  return hasDispatchReplay(store, idempotencyKey);
}
