import { runAuthorityFence } from "./authority-fence.js";
import {
  ensureRunnerAdapterCommandSchema,
  getSqliteRunnerAdapterCommand,
} from "./runner-adapter-command-sqlite.js";
import {
  parseRunnerExternalReferenceV1,
  type RunnerExternalReferenceV1,
} from "./runner-adapter-v1.js";
import { getWorkRun, type WorkRun } from "./runs.js";
import type { StensiblyStore } from "./store.js";

export type ControlRoomResumeEvidenceState = "pass" | "blocked" | "unknown";

export interface ControlRoomResumeEvidenceCheckV1 {
  id: string;
  label: string;
  state: ControlRoomResumeEvidenceState;
  detail: string;
}

export interface ControlRoomResumeInspectionAssemblyV1 {
  version: 1;
  runId: string;
  itemId: string;
  project: string;
  status: WorkRun["status"];
  decision: "blocked" | "unknown";
  checkpoint: RunnerExternalReferenceV1 | null;
  priorCommandId: string | null;
  priorCommandSettled: boolean;
  interruptionObserved: boolean;
  currentAuthorityPresent: boolean;
  continuationRef: string | null;
  checks: readonly ControlRoomResumeEvidenceCheckV1[];
  authorizesMutation: false;
  authorizesResume: false;
}

interface CommandIdentityRow {
  idempotency_key: string;
}

export function assembleControlRoomResumeInspectionV1(
  store: StensiblyStore,
  runId: string,
): ControlRoomResumeInspectionAssemblyV1 {
  const run = getWorkRun(store, runId);
  const item = store.getItem(run.itemId);
  const rawCheckpoint = run.checkpoint ?? null;
  const checkpoint = parseCheckpoint(rawCheckpoint);
  const priorCommand = latestRunnerCommand(store, run.id);
  const terminalObservationType = priorCommand?.settlement?.outcome.terminalObservationType ?? null;
  const interruptionObserved = terminalObservationType === "interrupted";
  const currentAuthorityPresent = runAuthorityFence(run) !== null;
  const checks: ControlRoomResumeEvidenceCheckV1[] = [];

  checks.push(checkpointCheck(rawCheckpoint, checkpoint));
  checks.push({
    id: "interruption-evidence",
    label: "Interruption evidence",
    state: interruptionObserved ? "pass" : "unknown",
    detail: interruptionObserved
      ? "The latest durable adapter command settled with terminal observation type interrupted."
      : priorCommand?.settlement
        ? `The latest durable adapter command settled as ${priorCommand.settlement.outcome.terminalObservationType}; interruption evidence is unresolved.`
        : "No settled adapter command proves an interrupted terminal observation for this run.",
  });
  checks.push({
    id: "continuation",
    label: "Continuation candidate",
    state: run.continuationRef ? "pass" : "unknown",
    detail: run.continuationRef
      ? `Run carries continuation reference ${run.continuationRef}.`
      : "Run has no durable continuation reference yet.",
  });
  checks.push({
    id: "current-authority",
    label: "Current run authority",
    state: currentAuthorityPresent ? "pass" : "unknown",
    detail: currentAuthorityPresent
      ? "Run currently exposes an authority fence for inspection."
      : "No current authority fence is available; a resume command cannot inherit authority from this receipt.",
  });
  checks.push({
    id: "current-capability-binding",
    label: "Current capability admission",
    state: "unknown",
    detail: "Durable history cannot recreate current runtime capability admission. A live admitted binding is required before eligibility can become proven.",
  });
  checks.push({
    id: "authoritative-command",
    label: "Authoritative resume command",
    state: "unknown",
    detail: "Control Room inspection creates no resume command. The RunnerResumeInspectionV1 compiler remains the authority once a complete candidate is assembled server-side.",
  });

  return Object.freeze({
    version: 1,
    runId: run.id,
    itemId: run.itemId,
    project: item.project,
    status: run.status,
    decision: checkpoint === null && rawCheckpoint !== null ? "blocked" : "unknown",
    checkpoint,
    priorCommandId: priorCommand?.command.commandId ?? null,
    priorCommandSettled: priorCommand?.settlement !== null && priorCommand !== null,
    interruptionObserved,
    currentAuthorityPresent,
    continuationRef: run.continuationRef ?? null,
    checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
    authorizesMutation: false,
    authorizesResume: false,
  });
}

function latestRunnerCommand(store: StensiblyStore, runId: string) {
  ensureRunnerAdapterCommandSchema(store);
  const row = store.db.query<CommandIdentityRow, [string]>(`
    SELECT idempotency_key
    FROM runner_adapter_commands
    WHERE run_id = ?1
    ORDER BY reserved_at DESC, command_id DESC
    LIMIT 1
  `).get(runId);
  return row
    ? getSqliteRunnerAdapterCommand(store, { idempotencyKey: row.idempotency_key })
    : null;
}

function parseCheckpoint(value: string | null): RunnerExternalReferenceV1 | null {
  if (!value) return null;
  try {
    return parseRunnerExternalReferenceV1(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function checkpointCheck(
  rawCheckpoint: string | null,
  checkpoint: RunnerExternalReferenceV1 | null,
): ControlRoomResumeEvidenceCheckV1 {
  if (!rawCheckpoint) {
    return {
      id: "checkpoint-reference",
      label: "Checkpoint reference",
      state: "unknown",
      detail: "Run has no durable checkpoint reference yet.",
    };
  }
  if (!checkpoint) {
    return {
      id: "checkpoint-reference",
      label: "Checkpoint reference",
      state: "blocked",
      detail: "Stored checkpoint text is not an admitted RunnerExternalReferenceV1.",
    };
  }
  const identity = checkpoint.externalId ?? checkpoint.digest ?? checkpoint.uri ?? "checkpoint";
  return {
    id: "checkpoint-reference",
    label: "Checkpoint reference",
    state: "pass",
    detail: `Admitted checkpoint ${identity}${checkpoint.digest ? ` (${checkpoint.digest})` : ""}.`,
  };
}
