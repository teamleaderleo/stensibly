import { claimRunnerWork as claimRunnerWorkCore } from "./runner-queue-core.js";
import type { ClaimRunnerWorkInput } from "./runner-contracts.js";
import {
  ensureRunExecutionSchema,
  hydrateWorkRun,
  tagLatestRunEvent,
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
    tagLatestRunEvent(store, { run, type: "run.starting" });
    return hydrateWorkRun(store, run);
  });
  return transaction();
}
