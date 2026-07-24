import type { ActorInput } from "./schemas.js";
import {
  ensureContinuationSchema,
  getContinuation,
  type ContinuationProposal,
} from "./continuations.js";
import {
  ConflictError,
  NotFoundError,
  type StensiblyStore,
} from "./store.js";

export interface EditContinuationInput {
  id: string;
  actor: ActorInput;
  expectedGeneration: number;
  instruction: string;
  note?: string;
  idempotencyKey?: string;
}

interface EditRow {
  id: string;
  source_item_id: string;
  status: string;
  generation: number;
}

interface ReplayRow {
  continuation_id: string;
  command: string;
  request_json: string;
  result_json: string;
}

export function editContinuation(
  store: StensiblyStore,
  rawInput: EditContinuationInput,
): ContinuationProposal {
  ensureContinuationSchema(store);
  const input = normalizeInput(rawInput);
  const requestJson = JSON.stringify({
    id: input.id,
    actor: input.actor,
    expectedGeneration: input.expectedGeneration,
    instruction: input.instruction,
    note: input.note ?? null,
  });

  const transaction = store.db.transaction(() => {
    if (input.idempotencyKey) {
      const replay = store.db
        .query<ReplayRow, [string]>(`
          SELECT continuation_id, command, request_json, result_json
          FROM continuation_commands
          WHERE idempotency_key = ?1
        `)
        .get(input.idempotencyKey);
      if (replay) {
        if (
          replay.continuation_id !== input.id
          || replay.command !== "edit"
          || replay.request_json !== requestJson
        ) {
          throw new ConflictError(
            "Idempotency key was already used for a different continuation command",
          );
        }
        return JSON.parse(replay.result_json) as ContinuationProposal;
      }
    }

    getContinuation(store, input.id);
    const current = store.db
      .query<EditRow, [string]>(`
        SELECT id, source_item_id, status, generation
        FROM continuations
        WHERE id = ?1
      `)
      .get(input.id);
    if (!current) throw new NotFoundError(`Continuation ${input.id} does not exist`);
    if (current.generation !== input.expectedGeneration) {
      throw new ConflictError(
        `Continuation generation changed from ${input.expectedGeneration} to ${current.generation}`,
      );
    }
    if (current.status !== "proposed" && current.status !== "deferred") {
      throw new ConflictError(
        `Continuation cannot edit while ${current.status}`,
      );
    }

    const now = new Date().toISOString();
    const nextGeneration = current.generation + 1;
    const result = store.db
      .query(`
        UPDATE continuations
        SET instruction = ?1,
            generation = ?2,
            updated_at = ?3
        WHERE id = ?4 AND generation = ?5 AND status = ?6
      `)
      .run(
        input.instruction,
        nextGeneration,
        now,
        input.id,
        input.expectedGeneration,
        current.status,
      );
    if (result.changes !== 1) {
      throw new ConflictError(
        "Continuation changed while the edit was being applied",
      );
    }

    store.recordEvent({
      itemId: current.source_item_id,
      actor: input.actor,
      type: "continuation.edited",
      payload: {
        continuationId: input.id,
        status: current.status,
        generation: nextGeneration,
        instruction: input.instruction,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    store.db
      .query(`
        UPDATE items
        SET version = version + 1, updated_at = ?1
        WHERE id = ?2
      `)
      .run(now, current.source_item_id);

    const updated = getContinuation(store, input.id);
    if (input.idempotencyKey) {
      store.db
        .query(`
          INSERT INTO continuation_commands (
            idempotency_key, continuation_id, command, request_json, result_json, created_at
          ) VALUES (?1, ?2, 'edit', ?3, ?4, ?5)
        `)
        .run(
          input.idempotencyKey,
          input.id,
          requestJson,
          JSON.stringify(updated),
          now,
        );
    }
    return updated;
  });

  return transaction();
}

function normalizeInput(input: EditContinuationInput) {
  const expectedGeneration = Number(input.expectedGeneration);
  if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
    throw new TypeError("Expected generation must be a positive integer");
  }
  return {
    id: requiredText(input.id, "Continuation ID", 240),
    actor: normalizeActor(input.actor),
    expectedGeneration,
    instruction: requiredText(input.instruction, "Instruction", 10_000),
    note: optionalText(input.note, "Edit note", 10_000),
    idempotencyKey: optionalText(input.idempotencyKey, "Idempotency key", 240),
  };
}

function normalizeActor(actor: ActorInput): ActorInput {
  if (!actor || typeof actor !== "object") throw new TypeError("Actor is required");
  if (!(["human", "agent", "service"] as const).includes(actor.kind)) {
    throw new TypeError("Actor kind must be one of: human, agent, service");
  }
  return {
    id: requiredText(actor.id, "Actor ID", 120),
    name: requiredText(actor.name, "Actor name", 160),
    kind: actor.kind,
  };
}

function optionalText(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, label, maxLength);
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) throw new TypeError(`${label} is required`);
  if (output.length > maxLength) {
    throw new TypeError(`${label} may contain at most ${maxLength} characters`);
  }
  if (/stn\.tok_/i.test(output)) {
    throw new TypeError(`${label} cannot contain credential-shaped text`);
  }
  return output;
}
