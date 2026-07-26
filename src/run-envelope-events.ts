import { createHash, randomUUID } from "node:crypto";
import { EXECUTION_ENVELOPE_SCHEMA_VERSION } from "./execution-envelope.js";
import type { WorkRun } from "./runs-core.js";
import type { StensiblyStore } from "./store.js";

export function appendRunEnvelopeReference(
  store: StensiblyStore,
  input: {
    run: WorkRun;
    lifecycleEventType: string;
    actorId?: string | null;
  },
): void {
  const lifecycleEventType = requiredText(
    input.lifecycleEventType,
    "Lifecycle event type",
    160,
  );
  const idempotencyKey = envelopeReferenceKey(input.run, lifecycleEventType);
  store.db
    .query(`
      INSERT OR IGNORE INTO events (
        id, item_id, actor_id, type, payload_json, idempotency_key, created_at
      ) VALUES (?1, ?2, ?3, 'run.envelope_reference', ?4, ?5, ?6)
    `)
    .run(
      `evt_${randomUUID()}`,
      input.run.itemId,
      input.actorId === undefined ? input.run.actorId : input.actorId,
      JSON.stringify({
        runId: input.run.id,
        generation: input.run.generation,
        leaseGeneration: input.run.leaseGeneration,
        envelopeSchemaVersion: EXECUTION_ENVELOPE_SCHEMA_VERSION,
        lifecycleEventType,
        lifecycleEventCreatedAt: input.run.updatedAt,
      }),
      idempotencyKey,
      input.run.updatedAt,
    );
}

function envelopeReferenceKey(run: WorkRun, lifecycleEventType: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      itemId: run.itemId,
      runId: run.id,
      generation: run.generation,
      leaseGeneration: run.leaseGeneration,
      lifecycleEventType,
      lifecycleEventCreatedAt: run.updatedAt,
    }))
    .digest("hex");
  return `run-envelope-ref:${digest}`;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) throw new TypeError(`${label} is required`);
  if (output.length > maximum) {
    throw new TypeError(`${label} may contain at most ${maximum} characters`);
  }
  return output;
}
