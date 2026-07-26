import { claimRunnerWork as claimRunnerWorkCore } from "./runner-queue-core.js";
import type { ClaimRunnerWorkInput } from "./runner-contracts.js";
import { appendRunEnvelopeReference } from "./run-envelope-events.js";
import {
  ensureRunExecutionSchema,
  hydrateWorkRun,
} from "./run-execution-store.js";
import { ensureRunSchema, type WorkRun } from "./runs.js";
import type { StensiblyStore } from "./store.js";

export function claimRunnerWork(
  store: StensiblyStore,
  input: ClaimRunnerWorkInput,
  now = new Date(),
): WorkRun | null {
  ensureRunSchema(store);
  ensureRunExecutionSchema(store);
  const transaction = store.db.transaction(() => {
    const run = claimRunnerWorkCore(store, input, now);
    if (!run) return null;
    appendRunEnvelopeReference(store, {
      run,
      lifecycleEventType: "run.starting",
    });
    return hydrateWorkRun(store, run);
  });
  return transaction();
}
