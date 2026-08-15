import { sha256, stableJson } from "./canonical-json.js";
import type { RunAuthorityFence } from "./authority-fence.js";
import type {
  EffectiveToolSurfaceSnapshot,
  ToolSurfaceCapabilityRef,
} from "./effective-tool-surface.js";
import {
  parseRunnerAdapterDescriptorV1,
  parseRunnerExternalReferenceV1,
  parseRunnerResumeCommandV1,
  type RunnerAdapterDescriptorV1,
  type RunnerContinuationBindingV1,
  type RunnerExternalReferenceV1,
  type RunnerResumeCommandV1,
} from "./runner-adapter-v1.js";
import {
  requireRunnerCapabilityInspectionForCommandV1,
  type RunnerCapabilityCommandBindingV1,
} from "./runner-capability-binding.js";
import type { RunnerAdapterCommandLookup } from "./runner-adapter-command-contracts.js";
import { admitRunnerAdapterCommandLookup } from "./runner-adapter-command-read.js";

export const RUNNER_RESUME_INSPECTION_V1 = 1 as const;
export const RUNNER_RESUME_INSPECTION_EVALUATOR_VERSION = "0.1.0" as const;

export const runnerResumeInspectionDecisions = ["eligible", "blocked", "unknown"] as const;
export type RunnerResumeInspectionDecisionV1 = typeof runnerResumeInspectionDecisions[number];

export const runnerResumeInspectionCheckStates = ["pass", "block", "unknown"] as const;
export type RunnerResumeInspectionCheckStateV1 = typeof runnerResumeInspectionCheckStates[number];

export const runnerResumeInspectionActions = ["resume", "reconcile", "leave_paused"] as const;
export type RunnerResumeInspectionActionV1 = typeof runnerResumeInspectionActions[number];

export type RunnerResumeCheckpointAvailabilityV1 = "available" | "missing" | "unknown";
export type RunnerResumeCheckpointIntegrityV1 = "verified" | "mismatch" | "unknown";
export type RunnerResumeAuthorizationRefStateV1 = "fresh" | "expired" | "revoked" | "unknown";

export interface RunnerResumeExpectedRuntimeV1 {
  packageId: string;
  packageVersion: string;
  checkpointSchemaVersion: string;
}

/** Neutral metadata projected from an adapter-owned external checkpoint record. */
export interface RunnerResumeCheckpointRecordV1 {
  version: 1;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  profileVersion: string;
  runtimePackageId: string;
  runtimePackageVersion: string;
  checkpointSchemaVersion: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  checkpointGeneration: number;
  externalId: string;
  checkpointDigest: string;
  createdAt: string;
  accessClass: RunnerExternalReferenceV1["accessClass"];
}

export interface RunnerResumeCheckpointSourceV1 {
  availability: RunnerResumeCheckpointAvailabilityV1;
  integrity: RunnerResumeCheckpointIntegrityV1;
  record: RunnerResumeCheckpointRecordV1 | null;
}

export interface RunnerResumeAuthorizationRefV1 {
  ref: string;
  state: RunnerResumeAuthorizationRefStateV1;
  expiresAt: string | null;
}

export interface RunnerResumeInterruptionV1 {
  code: string;
  summary: string;
}

export interface CompileRunnerResumeInspectionInputV1 {
  command: RunnerResumeCommandV1;
  descriptor: RunnerAdapterDescriptorV1 | null;
  expectedRuntime: RunnerResumeExpectedRuntimeV1;
  checkpoint: RunnerResumeCheckpointSourceV1;
  latestCheckpointGeneration: number | null;
  currentContinuation: RunnerContinuationBindingV1 | null;
  checkpointToolSurface: EffectiveToolSurfaceSnapshot | null;
  currentCapabilityBinding: RunnerCapabilityCommandBindingV1 | null;
  currentAuthority: RunAuthorityFence | null;
  grantRefs: readonly RunnerResumeAuthorizationRefV1[] | null;
  requiredApprovalRefs?: readonly string[];
  approvalRefs?: readonly RunnerResumeAuthorizationRefV1[] | null;
  priorCommand: RunnerAdapterCommandLookup | "absent" | null;
  interruption: RunnerResumeInterruptionV1;
  latestEvidenceRefs?: readonly RunnerExternalReferenceV1[];
  observedAt: string;
}

export interface RunnerResumeInspectionCheckV1 {
  code: string;
  state: RunnerResumeInspectionCheckStateV1;
  summary: string;
  expected: string | null;
  observed: string | null;
}

export interface RunnerResumeInspectionReceiptV1 {
  version: typeof RUNNER_RESUME_INSPECTION_V1;
  evaluatorVersion: typeof RUNNER_RESUME_INSPECTION_EVALUATOR_VERSION;
  observedAt: string;
  decision: RunnerResumeInspectionDecisionV1;
  resumeEligible: boolean;
  authorizesMutation: false;
  authorizesResume: false;
  run: {
    id: string;
    generation: number;
    leaseGeneration: number;
  };
  adapter: {
    id: string;
    version: string;
    profileId: string;
    profileVersion: string;
  };
  continuation: RunnerContinuationBindingV1;
  checkpoint: RunnerExternalReferenceV1 | null;
  interruption: RunnerResumeInterruptionV1;
  checks: readonly RunnerResumeInspectionCheckV1[];
  supportedActions: readonly RunnerResumeInspectionActionV1[];
  latestEvidenceRefs: readonly RunnerExternalReferenceV1[];
  receiptFingerprint: string;
}

export interface RunnerResumeInspectionRenderItemV1 {
  code: string;
  state: RunnerResumeInspectionCheckStateV1;
  text: string;
}

export interface RunnerResumeInspectionRenderSectionV1 {
  id: "checkpoint" | "capabilities" | "authority" | "settlement";
  title: string;
  items: readonly RunnerResumeInspectionRenderItemV1[];
}

export interface RunnerResumeInspectionRenderModelV1 {
  version: 1;
  title: string;
  decision: RunnerResumeInspectionDecisionV1;
  headline: string;
  identity: string;
  interruption: string;
  supportedActions: readonly RunnerResumeInspectionActionV1[];
  sections: readonly RunnerResumeInspectionRenderSectionV1[];
  authorizesMutation: false;
  receiptFingerprint: string;
}

export function compileRunnerResumeInspectionV1(
  rawInput: CompileRunnerResumeInspectionInputV1,
): RunnerResumeInspectionReceiptV1 {
  const command = parseRunnerResumeCommandV1(rawInput.command);
  const observedAt = timestamp(rawInput.observedAt, "Runner resume inspection observation time");
  const observedMs = Date.parse(observedAt);
  const expectedRuntime = normalizeExpectedRuntime(rawInput.expectedRuntime);
  const interruption = Object.freeze({
    code: identifier(rawInput.interruption.code, "Runner interruption code"),
    summary: text(rawInput.interruption.summary, "Runner interruption summary", 500),
  });
  const evidenceRefs = Object.freeze(
    [...(rawInput.latestEvidenceRefs ?? [])].map(parseRunnerExternalReferenceV1),
  );
  if (evidenceRefs.length > 32) {
    throw new RangeError("Runner resume inspection evidence references exceed 32 entries");
  }

  const checks: RunnerResumeInspectionCheckV1[] = [];
  let reconcileRequired = false;

  inspectDescriptor(checks, command, rawInput.descriptor);

  const checkpointRef = command.checkpointRef === null
    ? null
    : parseRunnerExternalReferenceV1(command.checkpointRef);
  inspectCheckpointReference(checks, checkpointRef);

  const checkpoint = normalizeCheckpointSource(rawInput.checkpoint);
  inspectCheckpointSource(checks, checkpointRef, checkpoint, expectedRuntime, command);
  inspectLatestCheckpointGeneration(checks, checkpointRef, rawInput.latestCheckpointGeneration);
  inspectContinuation(checks, command.continuation, rawInput.currentContinuation);

  const currentSurface = inspectCurrentCapabilities(
    checks,
    command,
    rawInput.currentCapabilityBinding,
  );
  inspectCheckpointCapabilityDrift(
    checks,
    rawInput.checkpointToolSurface,
    currentSurface,
  );

  inspectAuthority(checks, command, rawInput.currentAuthority, observedAt, observedMs);
  inspectAuthorizationRefs(
    checks,
    "authority.grants",
    "capability grant",
    command.capabilityGrantRefs,
    rawInput.grantRefs,
    observedMs,
  );
  inspectAuthorizationRefs(
    checks,
    "authority.approvals",
    "approval",
    rawInput.requiredApprovalRefs ?? [],
    rawInput.approvalRefs ?? null,
    observedMs,
  );

  reconcileRequired = inspectPriorCommand(
    checks,
    command,
    checkpointRef,
    rawInput.priorCommand,
  );

  const decision = decisionFor(checks);
  const supportedActions: RunnerResumeInspectionActionV1[] = decision === "eligible"
    ? ["resume", "leave_paused"]
    : reconcileRequired
    ? ["reconcile", "leave_paused"]
    : ["leave_paused"];
  const withoutFingerprint = {
    version: RUNNER_RESUME_INSPECTION_V1,
    evaluatorVersion: RUNNER_RESUME_INSPECTION_EVALUATOR_VERSION,
    observedAt,
    decision,
    resumeEligible: decision === "eligible",
    authorizesMutation: false as const,
    authorizesResume: false as const,
    run: Object.freeze({
      id: command.runId,
      generation: command.runGeneration,
      leaseGeneration: command.leaseGeneration,
    }),
    adapter: Object.freeze({
      id: command.adapterId,
      version: command.adapterVersion,
      profileId: command.profileId,
      profileVersion: command.profileVersion,
    }),
    continuation: Object.freeze({ ...command.continuation }),
    checkpoint: checkpointRef,
    interruption,
    checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
    supportedActions: Object.freeze(supportedActions),
    latestEvidenceRefs: evidenceRefs,
  };
  return deepFreeze({
    ...withoutFingerprint,
    receiptFingerprint: sha256(stableJson(withoutFingerprint)),
  });
}

export function renderRunnerResumeInspectionV1(
  receipt: RunnerResumeInspectionReceiptV1,
): RunnerResumeInspectionRenderModelV1 {
  const sections = Object.freeze([
    section(receipt, "checkpoint", "Checkpoint integrity", ["adapter.", "checkpoint.", "continuation."]),
    section(receipt, "capabilities", "Current capabilities", ["capabilities."]),
    section(receipt, "authority", "Current authority", ["authority."]),
    section(receipt, "settlement", "Prior settlement", ["settlement."]),
  ]);
  const headline = receipt.decision === "eligible"
    ? "Resume inspection is eligible for a later authoritative resume command."
    : receipt.decision === "blocked"
    ? "Resume inspection found a blocking stale, missing, or ambiguous binding."
    : "Resume inspection needs additional source facts before eligibility can be decided.";
  return deepFreeze({
    version: 1 as const,
    title: "Checkpoint Resume Inspection",
    decision: receipt.decision,
    headline,
    identity: `${receipt.run.id} / run ${receipt.run.generation} / lease ${receipt.run.leaseGeneration}`,
    interruption: `${receipt.interruption.code}: ${receipt.interruption.summary}`,
    supportedActions: receipt.supportedActions,
    sections,
    authorizesMutation: false as const,
    receiptFingerprint: receipt.receiptFingerprint,
  });
}

function inspectDescriptor(
  checks: RunnerResumeInspectionCheckV1[],
  command: RunnerResumeCommandV1,
  rawDescriptor: RunnerAdapterDescriptorV1 | null,
): void {
  if (rawDescriptor === null) {
    checks.push(unknown(
      "adapter.current_descriptor",
      "Current adapter descriptor is unavailable.",
      adapterIdentity(command),
    ));
    return;
  }
  const descriptor = parseRunnerAdapterDescriptorV1(rawDescriptor);
  const profile = descriptor.profiles.find((entry) => entry.id === command.profileId);
  const matches = descriptor.adapterId === command.adapterId
    && descriptor.adapterVersion === command.adapterVersion
    && descriptor.supports.resume
    && descriptor.checkpointMode !== "none"
    && profile?.version === command.profileVersion;
  checks.push(matches
    ? pass(
      "adapter.current_descriptor",
      "Current adapter and profile match the resume command.",
      adapterIdentity(command),
    )
    : block(
      "adapter.current_descriptor",
      "Current adapter or profile no longer matches the resume command.",
      adapterIdentity(command),
      `${descriptor.adapterId}@${descriptor.adapterVersion} / ${profile?.id ?? "missing"}@${profile?.version ?? "missing"}`,
    ));
}

function inspectCheckpointReference(
  checks: RunnerResumeInspectionCheckV1[],
  checkpointRef: RunnerExternalReferenceV1 | null,
): void {
  const complete = checkpointRef !== null
    && checkpointRef.kind === "checkpoint"
    && checkpointRef.externalId !== null
    && checkpointRef.digest !== null
    && checkpointRef.generation !== null;
  checks.push(complete
    ? pass(
      "checkpoint.reference",
      "Checkpoint reference carries exact external identity, digest, and generation.",
      checkpointIdentity(checkpointRef),
    )
    : block(
      "checkpoint.reference",
      "Resume requires one complete checkpoint reference.",
      "checkpoint externalId + digest + generation",
      checkpointRef === null ? "missing" : stableJson(checkpointRef),
    ));
}

function inspectCheckpointSource(
  checks: RunnerResumeInspectionCheckV1[],
  checkpointRef: RunnerExternalReferenceV1 | null,
  checkpoint: RunnerResumeCheckpointSourceV1,
  expectedRuntime: RunnerResumeExpectedRuntimeV1,
  command: RunnerResumeCommandV1,
): void {
  if (checkpoint.availability === "unknown") {
    checks.push(unknown(
      "checkpoint.external_record",
      "External checkpoint availability is unknown.",
      checkpointRef?.externalId ?? "checkpoint external record",
    ));
  } else if (checkpoint.availability === "missing") {
    checks.push(block(
      "checkpoint.external_record",
      "External checkpoint record is missing.",
      checkpointRef?.externalId ?? "checkpoint external record",
      "missing",
    ));
  } else {
    checks.push(pass(
      "checkpoint.external_record",
      "External checkpoint record is available.",
      checkpoint.record?.externalId ?? "checkpoint external record",
    ));
  }

  if (checkpoint.integrity === "unknown") {
    checks.push(unknown(
      "checkpoint.integrity",
      "Checkpoint integrity has not been verified.",
      checkpointRef?.digest ?? "checkpoint digest",
    ));
  } else if (checkpoint.integrity === "mismatch") {
    checks.push(block(
      "checkpoint.integrity",
      "Checkpoint integrity verification failed.",
      checkpointRef?.digest ?? "checkpoint digest",
      "mismatch",
    ));
  } else {
    checks.push(pass(
      "checkpoint.integrity",
      "Checkpoint integrity is verified.",
      checkpointRef?.digest ?? null,
    ));
  }

  if (checkpoint.record === null) return;
  const record = checkpoint.record;
  const referenceMatches = checkpointRef !== null
    && checkpointRef.externalId === record.externalId
    && checkpointRef.digest === record.checkpointDigest
    && checkpointRef.generation === record.checkpointGeneration
    && checkpointRef.createdAt === record.createdAt
    && checkpointRef.accessClass === record.accessClass;
  checks.push(referenceMatches
    ? pass(
      "checkpoint.reference_binding",
      "External checkpoint metadata matches the durable reference.",
      checkpointRecordIdentity(record),
    )
    : block(
      "checkpoint.reference_binding",
      "External checkpoint metadata changed from the durable reference.",
      checkpointRef === null ? "complete checkpoint reference" : checkpointIdentity(checkpointRef),
      checkpointRecordIdentity(record),
    ));

  const lineageMatches = record.adapterId === command.adapterId
    && record.adapterVersion === command.adapterVersion
    && record.profileId === command.profileId
    && record.profileVersion === command.profileVersion
    && record.runId === command.runId
    && record.runGeneration === command.runGeneration
    && record.leaseGeneration === command.leaseGeneration;
  checks.push(lineageMatches
    ? pass(
      "checkpoint.lineage",
      "Checkpoint adapter, profile, run, and lease lineage match the resume command.",
      runLineage(command),
    )
    : block(
      "checkpoint.lineage",
      "Checkpoint lineage is stale or belongs to another command lineage.",
      `${adapterIdentity(command)} / ${runLineage(command)}`,
      `${record.adapterId}@${record.adapterVersion} / ${record.profileId}@${record.profileVersion} / ${record.runId} / run ${record.runGeneration} / lease ${record.leaseGeneration}`,
    ));

  const runtimeMatches = record.runtimePackageId === expectedRuntime.packageId
    && record.runtimePackageVersion === expectedRuntime.packageVersion
    && record.checkpointSchemaVersion === expectedRuntime.checkpointSchemaVersion;
  checks.push(runtimeMatches
    ? pass(
      "checkpoint.runtime_schema",
      "Checkpoint package and schema versions match the current runtime expectation.",
      runtimeIdentity(expectedRuntime),
    )
    : block(
      "checkpoint.runtime_schema",
      "Checkpoint package or schema version is incompatible with the current runtime expectation.",
      runtimeIdentity(expectedRuntime),
      `${record.runtimePackageId}@${record.runtimePackageVersion} / schema ${record.checkpointSchemaVersion}`,
    ));
}

function inspectLatestCheckpointGeneration(
  checks: RunnerResumeInspectionCheckV1[],
  checkpointRef: RunnerExternalReferenceV1 | null,
  rawLatestGeneration: number | null,
): void {
  if (rawLatestGeneration === null) {
    checks.push(unknown(
      "checkpoint.latest_generation",
      "Latest checkpoint generation is unknown.",
      checkpointRef?.generation === null || checkpointRef?.generation === undefined
        ? "checkpoint generation"
        : String(checkpointRef.generation),
    ));
    return;
  }
  const latest = positiveInteger(rawLatestGeneration, "Latest checkpoint generation");
  checks.push(checkpointRef?.generation === latest
    ? pass(
      "checkpoint.latest_generation",
      "Checkpoint is the latest known generation for this lineage.",
      String(latest),
    )
    : block(
      "checkpoint.latest_generation",
      latest > (checkpointRef?.generation ?? 0)
        ? "A newer checkpoint supersedes the requested resume checkpoint."
        : "Latest checkpoint generation conflicts with the requested resume checkpoint.",
      checkpointRef?.generation === null || checkpointRef?.generation === undefined
        ? "checkpoint generation"
        : String(checkpointRef.generation),
      String(latest),
    ));
}

function inspectContinuation(
  checks: RunnerResumeInspectionCheckV1[],
  expected: RunnerContinuationBindingV1,
  current: RunnerContinuationBindingV1 | null,
): void {
  if (current === null) {
    checks.push(unknown(
      "continuation.current_generation",
      "Current continuation generation is unknown.",
      continuationIdentity(expected),
    ));
    return;
  }
  const normalized = {
    id: identifier(current.id, "Runner continuation ID"),
    generation: positiveInteger(current.generation, "Runner continuation generation"),
  };
  checks.push(normalized.id === expected.id && normalized.generation === expected.generation
    ? pass(
      "continuation.current_generation",
      "Continuation identity and generation remain current.",
      continuationIdentity(expected),
    )
    : block(
      "continuation.current_generation",
      "Continuation identity or generation has been superseded.",
      continuationIdentity(expected),
      continuationIdentity(normalized),
    ));
}

function inspectCurrentCapabilities(
  checks: RunnerResumeInspectionCheckV1[],
  command: RunnerResumeCommandV1,
  binding: RunnerCapabilityCommandBindingV1 | null,
): EffectiveToolSurfaceSnapshot | null {
  if (binding === null) {
    checks.push(unknown(
      "capabilities.current_binding",
      "Current resume capability inspection binding is unavailable.",
      command.commandId,
    ));
    checks.push(unknown(
      "capabilities.current_required",
      "Current required-capability availability is unknown.",
      capabilityList(command.requiredCapabilities),
    ));
    return null;
  }

  let surface: EffectiveToolSurfaceSnapshot;
  try {
    surface = requireRunnerCapabilityInspectionForCommandV1(binding, command);
  } catch (error) {
    checks.push(block(
      "capabilities.current_binding",
      "Current capability inspection no longer binds the exact resume command.",
      command.commandId,
      errorText(error),
    ));
    checks.push(unknown(
      "capabilities.current_required",
      "Current required-capability availability cannot be trusted from a stale binding.",
      capabilityList(command.requiredCapabilities),
    ));
    return null;
  }

  checks.push(pass(
    "capabilities.current_binding",
    "Current capability inspection is bound to the exact resume command.",
    binding.commandFingerprint,
  ));
  checks.push(surface.missingRequiredCapabilities.length === 0
    ? pass(
      "capabilities.current_required",
      "Current resume inspection exposes every required command capability.",
      capabilityList(command.requiredCapabilities),
    )
    : block(
      "capabilities.current_required",
      "Current resume inspection is missing required command capabilities.",
      capabilityList(command.requiredCapabilities),
      capabilityList(surface.missingRequiredCapabilities),
    ));
  return surface;
}

function inspectCheckpointCapabilityDrift(
  checks: RunnerResumeInspectionCheckV1[],
  checkpointSurface: EffectiveToolSurfaceSnapshot | null,
  currentSurface: EffectiveToolSurfaceSnapshot | null,
): void {
  if (checkpointSurface === null || currentSurface === null) {
    checks.push(unknown(
      "capabilities.checkpoint_drift",
      "Checkpoint-to-current capability drift cannot be established.",
      "checkpoint required capabilities remain executable",
    ));
    return;
  }
  const currentExecutable = executableCapabilityKeys(currentSurface);
  const lost = checkpointSurface.requiredCapabilities.filter(
    (entry) => !currentExecutable.has(capabilityKey(entry)),
  );
  checks.push(lost.length === 0
    ? pass(
      "capabilities.checkpoint_drift",
      "Every capability required at checkpoint time remains executable; additive capabilities are tolerated.",
      capabilityList(checkpointSurface.requiredCapabilities),
    )
    : block(
      "capabilities.checkpoint_drift",
      "A capability required at checkpoint time is no longer executable.",
      capabilityList(checkpointSurface.requiredCapabilities),
      capabilityList(lost),
    ));
}

function inspectAuthority(
  checks: RunnerResumeInspectionCheckV1[],
  command: RunnerResumeCommandV1,
  rawCurrent: RunAuthorityFence | null,
  observedAt: string,
  observedMs: number,
): void {
  if (rawCurrent === null) {
    checks.push(unknown(
      "authority.current_fence",
      "Current run authority is unavailable.",
      authorityIdentity(command.authority),
    ));
  } else {
    const current = normalizeAuthority(rawCurrent);
    const matches = current.resource === command.authority.resource
      && current.holderId === command.authority.holderId
      && current.generation === command.authority.generation
      && current.expiresAt === command.authority.expiresAt
      && current.generation === command.leaseGeneration;
    checks.push(matches
      ? pass(
        "authority.current_fence",
        "Current authority exactly matches the resume command fence.",
        authorityIdentity(command.authority),
      )
      : block(
        "authority.current_fence",
        "Current authority differs from the resume command fence.",
        authorityIdentity(command.authority),
        authorityIdentity(current),
      ));
  }

  checks.push(Date.parse(command.authority.expiresAt) > observedMs
    ? pass(
      "authority.expiry",
      "Resume command authority is fresh at the inspection observation time.",
      `expires after ${observedAt}`,
      command.authority.expiresAt,
    )
    : block(
      "authority.expiry",
      "Resume command authority is expired at the inspection observation time.",
      `expires after ${observedAt}`,
      command.authority.expiresAt,
    ));
}

function inspectAuthorizationRefs(
  checks: RunnerResumeInspectionCheckV1[],
  code: string,
  label: string,
  rawRequired: readonly string[],
  rawFacts: readonly RunnerResumeAuthorizationRefV1[] | null,
  observedMs: number,
): void {
  const required = uniqueIdentifiers(rawRequired, `Runner resume required ${label}`);
  if (required.length === 0) {
    checks.push(pass(code, `Resume command requires no ${label} references.`, "none"));
    return;
  }
  if (rawFacts === null) {
    checks.push(unknown(code, `Current ${label} freshness is unknown.`, required.join(", ")));
    return;
  }
  const facts = rawFacts.map((fact) => normalizeAuthorizationRef(fact, label));
  const byRef = new Map(facts.map((fact) => [fact.ref, fact]));
  const missing: string[] = [];
  const stale: string[] = [];
  const uncertain: string[] = [];
  for (const ref of required) {
    const fact = byRef.get(ref);
    if (!fact) {
      missing.push(ref);
    } else if (fact.state === "unknown") {
      uncertain.push(ref);
    } else if (
      fact.state !== "fresh"
      || (fact.expiresAt !== null && Date.parse(fact.expiresAt) <= observedMs)
    ) {
      stale.push(ref);
    }
  }
  if (missing.length > 0 || stale.length > 0) {
    checks.push(block(
      code,
      `A required ${label} is missing, expired, or revoked.`,
      required.join(", "),
      [...missing.map((ref) => `${ref}:missing`), ...stale.map((ref) => `${ref}:stale`)].join(", "),
    ));
  } else if (uncertain.length > 0) {
    checks.push(unknown(
      code,
      `A required ${label} has unknown freshness.`,
      required.join(", "),
      uncertain.join(", "),
    ));
  } else {
    checks.push(pass(
      code,
      `Every required ${label} is fresh at the inspection observation time.`,
      required.join(", "),
    ));
  }
}

function inspectPriorCommand(
  checks: RunnerResumeInspectionCheckV1[],
  command: RunnerResumeCommandV1,
  checkpointRef: RunnerExternalReferenceV1 | null,
  rawPrior: RunnerAdapterCommandLookup | "absent" | null,
): boolean {
  if (rawPrior === null) {
    checks.push(unknown(
      "settlement.prior_execution",
      "Prior command settlement state is unknown.",
      "settled interrupted/paused episode",
    ));
    return false;
  }
  if (rawPrior === "absent") {
    checks.push(unknown(
      "settlement.prior_execution",
      "No durable prior command record was supplied for this resume lineage.",
      "settled interrupted/paused episode",
    ));
    return false;
  }

  let prior: RunnerAdapterCommandLookup;
  try {
    prior = admitRunnerAdapterCommandLookup(rawPrior);
  } catch (error) {
    checks.push(block(
      "settlement.prior_execution",
      "Prior durable command record is internally inconsistent.",
      "coherent reservation and settlement identity",
      errorText(error),
    ));
    return false;
  }
  const reservation = prior.command;
  const lineageMatches = reservation.runId === command.runId
    && reservation.runGeneration === command.runGeneration
    && reservation.leaseGeneration === command.leaseGeneration
    && reservation.adapterId === command.adapterId
    && reservation.profileId === command.profileId;
  if (!lineageMatches) {
    checks.push(block(
      "settlement.prior_execution",
      "Prior durable command belongs to another run or adapter lineage.",
      `${runLineage(command)} / ${command.adapterId} / ${command.profileId}`,
      `${reservation.runId} / run ${reservation.runGeneration} / lease ${reservation.leaseGeneration} / ${reservation.adapterId} / ${reservation.profileId}`,
    ));
    return false;
  }
  if (prior.settlement === null) {
    checks.push(block(
      "settlement.prior_execution",
      "Prior execution has a durable reservation without settlement; reconcile before resume.",
      "settled interrupted/paused episode",
      `unsettled ${reservation.commandId}`,
    ));
    return true;
  }

  const terminal = prior.settlement.outcome.terminalObservationType;
  const terminalAllowsResume = terminal === "interrupted" || terminal === "paused";
  const checkpointMatches = checkpointRef?.externalId !== null
    && checkpointRef?.externalId !== undefined
    && prior.settlement.outcome.latestCheckpointExternalId === checkpointRef.externalId;
  checks.push(terminalAllowsResume && checkpointMatches
    ? pass(
      "settlement.prior_execution",
      "Prior execution settled as an interrupted/paused episode bound to this checkpoint.",
      `${checkpointRef.externalId} / interrupted or paused`,
      `${prior.settlement.outcome.latestCheckpointExternalId} / ${terminal}`,
    )
    : block(
      "settlement.prior_execution",
      "Prior settlement does not establish this checkpoint as a resumable interrupted episode.",
      checkpointRef?.externalId ?? "checkpoint external ID",
      `${prior.settlement.outcome.latestCheckpointExternalId ?? "no checkpoint"} / ${terminal}`,
    ));
  return false;
}

function normalizeExpectedRuntime(
  input: RunnerResumeExpectedRuntimeV1,
): RunnerResumeExpectedRuntimeV1 {
  return Object.freeze({
    packageId: identifier(input.packageId, "Runner runtime package ID"),
    packageVersion: text(input.packageVersion, "Runner runtime package version", 160),
    checkpointSchemaVersion: text(input.checkpointSchemaVersion, "Runner checkpoint schema version", 160),
  });
}

function normalizeCheckpointSource(
  input: RunnerResumeCheckpointSourceV1,
): RunnerResumeCheckpointSourceV1 {
  if (!["available", "missing", "unknown"].includes(input.availability)) {
    throw new RangeError("Runner checkpoint availability is invalid");
  }
  if (!["verified", "mismatch", "unknown"].includes(input.integrity)) {
    throw new RangeError("Runner checkpoint integrity state is invalid");
  }
  if (input.availability !== "available" && input.record !== null) {
    throw new RangeError("Unavailable runner checkpoint source cannot carry a record");
  }
  if (input.availability !== "available" && input.integrity !== "unknown") {
    throw new RangeError("Unavailable runner checkpoint source must have unknown integrity");
  }
  if (input.availability === "available" && input.record === null) {
    throw new RangeError("Available runner checkpoint source requires a record");
  }
  return Object.freeze({
    availability: input.availability,
    integrity: input.integrity,
    record: input.record === null ? null : normalizeCheckpointRecord(input.record),
  });
}

function normalizeCheckpointRecord(
  input: RunnerResumeCheckpointRecordV1,
): RunnerResumeCheckpointRecordV1 {
  if (input.version !== 1) throw new RangeError("Runner checkpoint record version is invalid");
  if (!["private", "project", "workspace"].includes(input.accessClass)) {
    throw new RangeError("Runner checkpoint access class is invalid");
  }
  return Object.freeze({
    version: 1,
    adapterId: identifier(input.adapterId, "Runner checkpoint adapter ID"),
    adapterVersion: text(input.adapterVersion, "Runner checkpoint adapter version", 160),
    profileId: identifier(input.profileId, "Runner checkpoint profile ID"),
    profileVersion: text(input.profileVersion, "Runner checkpoint profile version", 160),
    runtimePackageId: identifier(input.runtimePackageId, "Runner checkpoint runtime package ID"),
    runtimePackageVersion: text(input.runtimePackageVersion, "Runner checkpoint runtime package version", 160),
    checkpointSchemaVersion: text(input.checkpointSchemaVersion, "Runner checkpoint schema version", 160),
    runId: identifier(input.runId, "Runner checkpoint run ID"),
    runGeneration: positiveInteger(input.runGeneration, "Runner checkpoint run generation"),
    leaseGeneration: positiveInteger(input.leaseGeneration, "Runner checkpoint lease generation"),
    checkpointGeneration: positiveInteger(input.checkpointGeneration, "Runner checkpoint generation"),
    externalId: identifier(input.externalId, "Runner checkpoint external ID"),
    checkpointDigest: fingerprint(input.checkpointDigest, "Runner checkpoint digest"),
    createdAt: timestamp(input.createdAt, "Runner checkpoint creation time"),
    accessClass: input.accessClass,
  });
}

function normalizeAuthority(input: RunAuthorityFence): RunAuthorityFence {
  const resource = text(input.resource, "Runner authority resource", 200);
  if (!resource.startsWith("run:") || resource.length <= 4) {
    throw new RangeError("Runner authority resource is invalid");
  }
  return Object.freeze({
    resource: resource as `run:${string}`,
    holderId: identifier(input.holderId, "Runner authority holder ID"),
    generation: positiveInteger(input.generation, "Runner authority generation"),
    expiresAt: timestamp(input.expiresAt, "Runner authority expiry"),
  });
}

function normalizeAuthorizationRef(
  input: RunnerResumeAuthorizationRefV1,
  label: string,
): RunnerResumeAuthorizationRefV1 {
  if (!["fresh", "expired", "revoked", "unknown"].includes(input.state)) {
    throw new RangeError(`Runner ${label} state is invalid`);
  }
  return Object.freeze({
    ref: identifier(input.ref, `Runner ${label} reference`),
    state: input.state,
    expiresAt: input.expiresAt === null
      ? null
      : timestamp(input.expiresAt, `Runner ${label} expiry`),
  });
}

function section(
  receipt: RunnerResumeInspectionReceiptV1,
  id: RunnerResumeInspectionRenderSectionV1["id"],
  title: string,
  prefixes: readonly string[],
): RunnerResumeInspectionRenderSectionV1 {
  return Object.freeze({
    id,
    title,
    items: Object.freeze(receipt.checks
      .filter((check) => prefixes.some((prefix) => check.code.startsWith(prefix)))
      .map((check) => Object.freeze({
        code: check.code,
        state: check.state,
        text: check.summary,
      }))),
  });
}

function decisionFor(
  checks: readonly RunnerResumeInspectionCheckV1[],
): RunnerResumeInspectionDecisionV1 {
  if (checks.some((check) => check.state === "block")) return "blocked";
  if (checks.some((check) => check.state === "unknown")) return "unknown";
  return "eligible";
}

function executableCapabilityKeys(snapshot: EffectiveToolSurfaceSnapshot): Set<string> {
  const keys = new Set<string>();
  for (const classSnapshot of Object.values(snapshot.classes)) {
    for (const capability of classSnapshot.executableCapabilities) {
      keys.add(`${classSnapshot.class}\u0000${capability.id}`);
    }
  }
  return keys;
}

function capabilityList(entries: readonly { class: string; id: string }[]): string {
  return entries.length === 0
    ? "none"
    : [...entries].map((entry) => `${entry.class}:${entry.id}`).sort().join(", ");
}

function capabilityKey(entry: ToolSurfaceCapabilityRef | { class: string; id: string }): string {
  return `${entry.class}\u0000${entry.id}`;
}

function adapterIdentity(command: RunnerResumeCommandV1): string {
  return `${command.adapterId}@${command.adapterVersion} / ${command.profileId}@${command.profileVersion}`;
}

function checkpointIdentity(reference: RunnerExternalReferenceV1): string {
  return `${reference.externalId ?? "missing"} / ${reference.digest ?? "missing"} / generation ${reference.generation ?? "missing"}`;
}

function checkpointRecordIdentity(record: RunnerResumeCheckpointRecordV1): string {
  return `${record.externalId} / ${record.checkpointDigest} / generation ${record.checkpointGeneration}`;
}

function continuationIdentity(value: RunnerContinuationBindingV1): string {
  return `${value.id} / generation ${value.generation}`;
}

function runLineage(command: RunnerResumeCommandV1): string {
  return `${command.runId} / run ${command.runGeneration} / lease ${command.leaseGeneration}`;
}

function runtimeIdentity(value: RunnerResumeExpectedRuntimeV1): string {
  return `${value.packageId}@${value.packageVersion} / schema ${value.checkpointSchemaVersion}`;
}

function authorityIdentity(authority: RunAuthorityFence): string {
  return `${authority.resource} / ${authority.holderId} / generation ${authority.generation} / expires ${authority.expiresAt}`;
}

function pass(
  code: string,
  summary: string,
  expected: string | null,
  observed: string | null = expected,
): RunnerResumeInspectionCheckV1 {
  return { code, state: "pass", summary, expected, observed };
}

function block(
  code: string,
  summary: string,
  expected: string | null,
  observed: string | null,
): RunnerResumeInspectionCheckV1 {
  return { code, state: "block", summary, expected, observed };
}

function unknown(
  code: string,
  summary: string,
  expected: string | null,
  observed: string | null = null,
): RunnerResumeInspectionCheckV1 {
  return { code, state: "unknown", summary, expected, observed };
}

function uniqueIdentifiers(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => identifier(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new RangeError(`${label} contains duplicates`);
  }
  return normalized;
}

function identifier(value: unknown, label: string): string {
  const normalized = text(value, label, 240);
  if (!/^[A-Za-z0-9@][A-Za-z0-9._:/#@-]*$/u.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function fingerprint(value: unknown, label: string): string {
  const normalized = text(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function timestamp(value: unknown, label: string): string {
  const normalized = text(value, label, 40);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum} characters`);
  }
  return normalized;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
