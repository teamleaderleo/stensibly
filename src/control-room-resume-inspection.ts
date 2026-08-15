import { runAuthorityFence } from "./authority-fence.js";
import type { EffectiveToolSurfaceSnapshot } from "./effective-tool-surface.js";
import {
  ensureRunnerAdapterCommandSchema,
  getSqliteRunnerAdapterCommand,
} from "./runner-adapter-command-sqlite.js";
import type { RunnerAdapterCommandLookup } from "./runner-adapter-command-contracts.js";
import type { RunnerCapabilityCommandBindingV1 } from "./runner-capability-binding.js";
import {
  parseRunnerExternalReferenceV1,
  type RunnerAdapterDescriptorV1,
  type RunnerExternalReferenceV1,
  type RunnerResumeCommandV1,
} from "./runner-adapter-v1.js";
import {
  compileRunnerResumeInspectionV1,
  renderRunnerResumeInspectionV1,
  type RunnerResumeAuthorizationRefV1,
  type RunnerResumeCheckpointSourceV1,
  type RunnerResumeExpectedRuntimeV1,
  type RunnerResumeInspectionActionV1,
  type RunnerResumeInspectionCheckStateV1,
  type RunnerResumeInspectionDecisionV1,
  type RunnerResumeInspectionReceiptV1,
  type RunnerResumeInterruptionV1,
} from "./runner-resume-inspection.js";
import { getWorkRun, type WorkRun } from "./runs.js";
import type { StensiblyStore } from "./store.js";

export type ControlRoomResumeEvidenceState = "pass" | "blocked" | "unknown";

export interface ControlRoomResumeEvidenceCheckV1 {
  id: string;
  label: string;
  state: ControlRoomResumeEvidenceState;
  detail: string;
}

export interface ControlRoomResumeEvidenceRequestV1 {
  run: Readonly<Pick<
    WorkRun,
    | "id"
    | "itemId"
    | "status"
    | "generation"
    | "leaseGeneration"
    | "leaseOwnerId"
    | "leaseExpiresAt"
    | "continuationRef"
  >>;
  project: string;
  checkpoint: RunnerExternalReferenceV1 | null;
  priorCommand: RunnerAdapterCommandLookup | null;
}

/**
 * Current process-local evidence needed by the authoritative read-only compiler.
 * `inspectionCandidate` is command-shaped input for evaluation only. This surface
 * never reserves, persists, dispatches, or executes it. The checkpoint source
 * describes availability/integrity/runtime metadata for the durable checkpoint
 * named in the request; durable identity fields remain server-owned below.
 */
export interface ControlRoomResumeCurrentEvidenceV1 {
  inspectionCandidate: RunnerResumeCommandV1;
  descriptor: RunnerAdapterDescriptorV1 | null;
  expectedRuntime: RunnerResumeExpectedRuntimeV1;
  checkpoint: RunnerResumeCheckpointSourceV1;
  currentContinuationGeneration: number | null;
  checkpointToolSurface: EffectiveToolSurfaceSnapshot | null;
  currentCapabilityBinding: RunnerCapabilityCommandBindingV1 | null;
  grantRefs: readonly RunnerResumeAuthorizationRefV1[] | null;
  requiredApprovalRefs?: readonly string[];
  approvalRefs?: readonly RunnerResumeAuthorizationRefV1[] | null;
  interruption: RunnerResumeInterruptionV1;
  latestEvidenceRefs?: readonly RunnerExternalReferenceV1[];
  observedAt: string;
}

export type ControlRoomResumeEvidenceSourceV1 = (
  request: ControlRoomResumeEvidenceRequestV1,
) => ControlRoomResumeCurrentEvidenceV1 | null;

export interface ControlRoomResumeEligibilityReasonV1 {
  code: string;
  state: RunnerResumeInspectionCheckStateV1;
  summary: string;
  expected: string | null;
  observed: string | null;
}

export interface ControlRoomResumeEligibilitySectionV1 {
  id: "checkpoint" | "capabilities" | "authority" | "settlement";
  title: string;
  reasons: readonly ControlRoomResumeEligibilityReasonV1[];
}

export interface ControlRoomResumeEligibilityExplanationV1 {
  version: 1;
  evaluatorVersion: string;
  observedAt: string;
  decision: RunnerResumeInspectionDecisionV1;
  resumeEligible: boolean;
  headline: string;
  receiptFingerprint: string;
  run: RunnerResumeInspectionReceiptV1["run"];
  adapter: RunnerResumeInspectionReceiptV1["adapter"];
  continuation: RunnerResumeInspectionReceiptV1["continuation"];
  checkpoint: {
    externalId: string | null;
    digest: string | null;
    generation: number | null;
    createdAt: string;
    accessClass: RunnerExternalReferenceV1["accessClass"];
  } | null;
  currentCapability: {
    commandFingerprint: string;
    requiredFingerprint: string;
    snapshotFingerprint: string;
    surfaceFingerprint: string;
  } | null;
  priorCommand: {
    commandId: string;
    commandFingerprint: string;
    settled: boolean;
    outcomeFingerprint: string | null;
  } | null;
  supportedActions: readonly RunnerResumeInspectionActionV1[];
  sections: readonly ControlRoomResumeEligibilitySectionV1[];
  authorizesMutation: false;
  authorizesResume: false;
}

export interface ControlRoomResumeInspectionAssemblyV1 {
  version: 1;
  runId: string;
  itemId: string;
  project: string;
  status: WorkRun["status"];
  decision: RunnerResumeInspectionDecisionV1;
  checkpoint: RunnerExternalReferenceV1 | null;
  priorCommandId: string | null;
  priorCommandSettled: boolean;
  interruptionObserved: boolean;
  currentAuthorityPresent: boolean;
  continuationRef: string | null;
  checks: readonly ControlRoomResumeEvidenceCheckV1[];
  eligibility: ControlRoomResumeEligibilityExplanationV1 | null;
  authorizesMutation: false;
  authorizesResume: false;
}

interface CommandIdentityRow {
  idempotency_key: string;
}

export function assembleControlRoomResumeInspectionV1(
  store: StensiblyStore,
  runId: string,
  currentEvidenceSource?: ControlRoomResumeEvidenceSourceV1 | null,
): ControlRoomResumeInspectionAssemblyV1 {
  const run = getWorkRun(store, runId);
  const item = store.getItem(run.itemId);
  const rawCheckpoint = run.checkpoint ?? null;
  const checkpoint = parseCheckpoint(rawCheckpoint);
  const priorCommand = latestRunnerCommand(store, run.id);
  const terminalObservationType = priorCommand?.settlement?.outcome.terminalObservationType ?? null;
  const interruptionObserved = terminalObservationType === "interrupted";
  const currentAuthority = runAuthorityFence(run);
  const currentAuthorityPresent = currentAuthority !== null;
  const durableCheckpointReady = checkpoint?.kind === "checkpoint";
  const currentEvidence = durableCheckpointReady
    ? currentEvidenceSource?.(Object.freeze({
      run: Object.freeze({
        id: run.id,
        itemId: run.itemId,
        status: run.status,
        generation: run.generation,
        leaseGeneration: run.leaseGeneration,
        leaseOwnerId: run.leaseOwnerId,
        leaseExpiresAt: run.leaseExpiresAt,
        continuationRef: run.continuationRef,
      }),
      project: item.project,
      checkpoint,
      priorCommand,
    })) ?? null
    : null;

  let eligibility: ControlRoomResumeEligibilityExplanationV1 | null = null;
  let authoritativeEvidenceRejected = false;
  if (currentEvidence !== null && checkpoint !== null) {
    try {
      const receipt = compileRunnerResumeInspectionV1({
        command: currentEvidence.inspectionCandidate,
        descriptor: currentEvidence.descriptor,
        expectedRuntime: currentEvidence.expectedRuntime,
        checkpoint: bindDurableCheckpointSource(
          currentEvidence.checkpoint,
          checkpoint,
          run,
        ),
        latestCheckpointGeneration: checkpoint.generation,
        currentContinuation: run.continuationRef !== null
          && currentEvidence.currentContinuationGeneration !== null
          ? {
            id: run.continuationRef,
            generation: currentEvidence.currentContinuationGeneration,
          }
          : null,
        checkpointToolSurface: currentEvidence.checkpointToolSurface,
        currentCapabilityBinding: currentEvidence.currentCapabilityBinding,
        currentAuthority,
        grantRefs: currentEvidence.grantRefs,
        requiredApprovalRefs: currentEvidence.requiredApprovalRefs ?? [],
        approvalRefs: currentEvidence.approvalRefs ?? null,
        priorCommand: priorCommand ?? "absent",
        interruption: currentEvidence.interruption,
        latestEvidenceRefs: currentEvidence.latestEvidenceRefs ?? [],
        observedAt: currentEvidence.observedAt,
      });
      eligibility = projectEligibility(receipt, currentEvidence, priorCommand);
    } catch {
      authoritativeEvidenceRejected = true;
    }
  }

  const checks = sourceChecks({
    rawCheckpoint,
    checkpoint,
    priorCommand,
    interruptionObserved,
    run,
    currentAuthorityPresent,
    currentEvidence,
    eligibility,
    authoritativeEvidenceRejected,
  });

  return Object.freeze({
    version: 1,
    runId: run.id,
    itemId: run.itemId,
    project: item.project,
    status: run.status,
    decision: eligibility?.decision
      ?? (rawCheckpoint !== null && !durableCheckpointReady ? "blocked" : "unknown"),
    checkpoint,
    priorCommandId: priorCommand?.command.commandId ?? null,
    priorCommandSettled: priorCommand?.settlement !== null && priorCommand !== null,
    interruptionObserved,
    currentAuthorityPresent,
    continuationRef: run.continuationRef ?? null,
    checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
    eligibility,
    authorizesMutation: false,
    authorizesResume: false,
  });
}

function latestRunnerCommand(
  store: StensiblyStore,
  runId: string,
): RunnerAdapterCommandLookup | null {
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

function bindDurableCheckpointSource(
  source: RunnerResumeCheckpointSourceV1,
  durable: RunnerExternalReferenceV1,
  run: WorkRun,
): RunnerResumeCheckpointSourceV1 {
  if (source.availability !== "available" || source.record === null) return source;
  if (
    durable.kind !== "checkpoint"
    || durable.externalId === null
    || durable.digest === null
    || durable.generation === null
  ) {
    return Object.freeze({
      availability: "missing" as const,
      integrity: "unknown" as const,
      record: null,
    });
  }
  return Object.freeze({
    availability: "available" as const,
    integrity: source.integrity,
    record: Object.freeze({
      ...source.record,
      adapterId: durable.adapterId,
      runId: run.id,
      runGeneration: run.generation,
      leaseGeneration: run.leaseGeneration,
      checkpointGeneration: durable.generation,
      externalId: durable.externalId,
      checkpointDigest: durable.digest,
      createdAt: durable.createdAt,
      accessClass: durable.accessClass,
    }),
  });
}

function projectEligibility(
  receipt: RunnerResumeInspectionReceiptV1,
  evidence: ControlRoomResumeCurrentEvidenceV1,
  priorCommand: RunnerAdapterCommandLookup | null,
): ControlRoomResumeEligibilityExplanationV1 {
  const rendered = renderRunnerResumeInspectionV1(receipt);
  const byCode = new Map(receipt.checks.map((check) => [check.code, check]));
  const sections = rendered.sections.map((section) => Object.freeze({
    id: section.id,
    title: section.title,
    reasons: Object.freeze(section.items.map((item) => {
      const check = byCode.get(item.code);
      if (!check) throw new RangeError(`Resume inspection render item ${item.code} has no source check`);
      return Object.freeze({
        code: check.code,
        state: check.state,
        summary: check.summary,
        expected: check.expected,
        observed: check.observed,
      });
    })),
  }));
  const checkpoint = receipt.checkpoint === null
    ? null
    : Object.freeze({
      externalId: receipt.checkpoint.externalId,
      digest: receipt.checkpoint.digest,
      generation: receipt.checkpoint.generation,
      createdAt: receipt.checkpoint.createdAt,
      accessClass: receipt.checkpoint.accessClass,
    });
  const binding = evidence.currentCapabilityBinding;
  const currentCapability = binding === null
    ? null
    : Object.freeze({
      commandFingerprint: binding.commandFingerprint,
      requiredFingerprint: binding.inspection.requiredFingerprint,
      snapshotFingerprint: binding.inspection.snapshotFingerprint,
      surfaceFingerprint: binding.inspection.snapshot.surfaceFingerprint,
    });
  const prior = priorCommand === null
    ? null
    : Object.freeze({
      commandId: priorCommand.command.commandId,
      commandFingerprint: priorCommand.command.commandFingerprint,
      settled: priorCommand.settlement !== null,
      outcomeFingerprint: priorCommand.settlement?.outcomeSha256 ?? null,
    });
  return deepFreeze({
    version: 1 as const,
    evaluatorVersion: receipt.evaluatorVersion,
    observedAt: receipt.observedAt,
    decision: receipt.decision,
    resumeEligible: receipt.resumeEligible,
    headline: rendered.headline,
    receiptFingerprint: receipt.receiptFingerprint,
    run: { ...receipt.run },
    adapter: { ...receipt.adapter },
    continuation: { ...receipt.continuation },
    checkpoint,
    currentCapability,
    priorCommand: prior,
    supportedActions: [...receipt.supportedActions],
    sections,
    authorizesMutation: false as const,
    authorizesResume: false as const,
  });
}

function sourceChecks(input: {
  rawCheckpoint: string | null;
  checkpoint: RunnerExternalReferenceV1 | null;
  priorCommand: RunnerAdapterCommandLookup | null;
  interruptionObserved: boolean;
  run: WorkRun;
  currentAuthorityPresent: boolean;
  currentEvidence: ControlRoomResumeCurrentEvidenceV1 | null;
  eligibility: ControlRoomResumeEligibilityExplanationV1 | null;
  authoritativeEvidenceRejected: boolean;
}): ControlRoomResumeEvidenceCheckV1[] {
  const checks: ControlRoomResumeEvidenceCheckV1[] = [];
  checks.push(checkpointCheck(input.rawCheckpoint, input.checkpoint));
  checks.push({
    id: "interruption-evidence",
    label: "Interruption evidence",
    state: input.interruptionObserved ? "pass" : "unknown",
    detail: input.interruptionObserved
      ? "The latest durable adapter command settled with terminal observation type interrupted."
      : input.priorCommand?.settlement
        ? `The latest durable adapter command settled as ${input.priorCommand.settlement.outcome.terminalObservationType}; interruption evidence is unresolved.`
        : "No settled adapter command proves an interrupted terminal observation for this run.",
  });
  checks.push({
    id: "continuation",
    label: "Continuation candidate",
    state: input.run.continuationRef ? "pass" : "unknown",
    detail: input.run.continuationRef
      ? `Run carries continuation reference ${input.run.continuationRef}.`
      : "Run has no durable continuation reference yet.",
  });
  checks.push({
    id: "current-authority",
    label: "Current run authority",
    state: input.currentAuthorityPresent ? "pass" : "unknown",
    detail: input.currentAuthorityPresent
      ? "Run currently exposes an authority fence for inspection."
      : "No current authority fence is available; a resume command cannot inherit authority from this receipt.",
  });
  checks.push({
    id: "current-capability-binding",
    label: "Current capability admission",
    state: input.currentEvidence?.currentCapabilityBinding ? "pass" : "unknown",
    detail: input.currentEvidence?.currentCapabilityBinding
      ? `Current admitted capability evidence is bound by ${input.currentEvidence.currentCapabilityBinding.commandFingerprint}.`
      : "Current runtime capability admission is unavailable, so authoritative eligibility remains unknown unless another blocking fact applies.",
  });
  checks.push({
    id: "authoritative-inspection",
    label: "Authoritative eligibility inspection",
    state: input.eligibility ? "pass" : "unknown",
    detail: input.eligibility
      ? `RunnerResumeInspectionV1 compiled receipt ${input.eligibility.receiptFingerprint}.`
      : input.authoritativeEvidenceRejected
        ? "Current evidence was rejected by the authoritative read-only inspection compiler; no eligibility was inferred."
        : "No current authoritative inspection evidence is attached to this Control Room request.",
  });
  checks.push({
    id: "authoritative-command",
    label: "Authoritative resume command",
    state: "unknown",
    detail: "Control Room creates and executes no resume command. Authority-bearing resume command reservation, recheck, dispatch, and settlement remain outside this read-only receipt.",
  });
  return checks;
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
  if (!checkpoint || checkpoint.kind !== "checkpoint") {
    return {
      id: "checkpoint-reference",
      label: "Checkpoint reference",
      state: "blocked",
      detail: "Stored checkpoint text is not an admitted checkpoint RunnerExternalReferenceV1.",
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
