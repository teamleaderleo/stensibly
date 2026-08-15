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
import {
  admitRunnerAdapterCommandReservationRecord,
  admitRunnerAdapterCommandSettlementRecord,
  type RunnerAdapterCommandLookup,
} from "./runner-adapter-command-contracts.js";

export const RUNNER_RESUME_INSPECTION_V1 = 1 as const;
export const RUNNER_RESUME_INSPECTION_EVALUATOR_VERSION = "0.1.0" as const;

export const runnerResumeInspectionDecisions = [
  "eligible",
  "blocked",
  "unknown",
] as const;
export type RunnerResumeInspectionDecisionV1 =
  typeof runnerResumeInspectionDecisions[number];

export const runnerResumeInspectionCheckStates = [
  "pass",
  "block",
  "unknown",
] as const;
export type RunnerResumeInspectionCheckStateV1 =
  typeof runnerResumeInspectionCheckStates[number];

export const runnerResumeInspectionActions = [
  "resume",
  "reconcile",
  "leave_paused",
] as const;
export type RunnerResumeInspectionActionV1 =
  typeof runnerResumeInspectionActions[number];

export type RunnerResumeCheckpointAvailabilityV1 =
  | "available"
  | "missing"
  | "unknown";
export type RunnerResumeCheckpointIntegrityV1 =
  | "verified"
  | "mismatch"
  | "unknown";
export type RunnerResumeAuthorizationRefStateV1 =
  | "fresh"
  | "expired"
  | "revoked"
  | "unknown";

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
  const observedAt = canonicalTimestamp(rawInput.observedAt, "Runner resume inspection observation time");
  const observedMilliseconds = Date.parse(observedAt);
  const expectedRuntime = normalizeExpectedRuntime(rawInput.expectedRuntime);
  const interruption = Object.freeze({
    code: boundedIdentifier(rawInput.interruption.code, "Runner interruption code"),
    summary: boundedText(rawInput.interruption.summary, "Runner interruption summary", 500),
  });
  const evidenceRefs = Object.freeze(
    [...(rawInput.latestEvidenceRefs ?? [])].map(parseRunnerExternalReferenceV1),
  );
  if (evidenceRefs.length > 32) {
    throw new RangeError("Runner resume inspection evidence references exceed 32 entries");
  }

  const checks: RunnerResumeInspectionCheckV1[] = [];
  let reconcileRequired = false;

  const descriptor = rawInput.descriptor === null
    ? null
    : parseRunnerAdapterDescriptorV1(rawInput.descriptor);
  if (descriptor === null) {
    checks.push(unknownCheck(
      "adapter.current_descriptor",
      "Current adapter descriptor is unavailable.",
      `${command.adapterId}@${command.adapterVersion} / ${command.profileId}@${command.profileVersion}`,
    ));
  } else {
    const profile = descriptor.profiles.find((entry) => entry.id === command.profileId);
    const matches = descriptor.adapterId === command.adapterId
      && descriptor.adapterVersion === command.adapterVersion
      && descriptor.supports.resume
      && descriptor.checkpointMode !== "none"
      && profile?.version === command.profileVersion;
    checks.push(matches
      ? passCheck(
        "adapter.current_descriptor",
        "Current adapter and profile match the resume command.",
        `${command.adapterId}@${command.adapterVersion} / ${command.profileId}@${command.profileVersion}`,
      )
      : blockCheck(
        "adapter.current_descriptor",
        "Current adapter or profile no longer matches the resume command.",
        `${command.adapterId}@${command.adapterVersion} / ${command.profileId}@${command.profileVersion}`,
        `${descriptor.adapterId}@${descriptor.adapterVersion} / ${profile?.id ?? "missing"}@${profile?.version ?? "missing"}`,
      ));
  }

  const checkpointRef = command.checkpointRef === null
    ? null
    : parseRunnerExternalReferenceV1(command.checkpointRef);
  if (
    checkpointRef === null
    || checkpointRef.kind !== "checkpoint"
    || checkpointRef.externalId === null
    || checkpointRef.digest === null
    || checkpointRef.generation === null
  ) {
    checks.push(blockCheck(
      "checkpoint.reference",
      "Resume requires one complete checkpoint reference.",
      "checkpoint externalId + digest + generation",
      checkpointRef === null ? "missing" : stableJson(checkpointRef),
    ));
  } else {
    checks.push(passCheck(
      "checkpoint.reference",
      "Checkpoint reference carries exact external identity, digest, and generation.",
      `${checkpointRef.externalId} / ${checkpointRef.digest} / generation ${checkpointRef.generation}`,
    ));
  }

  const checkpointSource = normalizeCheckpointSource(rawInput.checkpoint);
  if (checkpointSource.availability === "unknown") {
    checks.push(unknownCheck(
      "checkpoint.external_record",
      "External checkpoint availability is unknown.",
      checkpointRef?.externalId ?? "checkpoint external record",
    ));
  } else if (checkpointSource.availability === "missing") {
    checks.push(blockCheck(
      "checkpoint.external_record",
      "External checkpoint record is missing.",
      checkpointRef?.externalId ?? "checkpoint external record",
      "missing",
    ));
  } else if (checkpointSource.record === null) {
    throw new RangeError("Available runner checkpoint source requires a record");
  } else {
    checks.push(passCheck(
      "checkpoint.external_record",
      "External checkpoint record is available.",
      checkpointSource.record.externalId,
    ));
  }

  if (checkpointSource.integrity === "unknown") {
    checks.push(unknownCheck(
      "checkpoint.integrity",
      "Checkpoint integrity has not been verified.",
      checkpointRef?.digest ?? "checkpoint digest",
    ));
  } else if (checkpointSource.integrity === "mismatch") {
    checks.push(blockCheck(
      "checkpoint.integrity",
      "Checkpoint integrity verification failed.",
      checkpointRef?.digest ?? "checkpoint digest",
      "mismatch",
    ));
  } else {
    checks.push(passCheck(
      "checkpoint.integrity",
      "Checkpoint integrity is verified.",
      checkpointRef?.digest ?? null,
    ));
  }

  if (checkpointSource.record !== null) {
    const record = checkpointSource.record;
    const referenceMatches = checkpointRef !== null
      && checkpointRef.externalId === record.externalId
      && checkpointRef.digest === record.checkpointDigest
      && checkpointRef.generation === record.checkpointGeneration
      && checkpointRef.createdAt === record.createdAt
      && checkpointRef.accessClass === record.accessClass;
    checks.push(referenceMatches
      ? passCheck(
        "checkpoint.reference_binding",
        "External checkpoint metadata matches the durable reference.",
        `${record.externalId} / ${record.checkpointDigest} / generation ${record.checkpointGeneration}`,
      )
      : blockCheck(
        "checkpoint.reference_binding",
        "External checkpoint metadata changed from the durable reference.",
        checkpointRef === null
          ? "complete checkpoint reference"
          : `${checkpointRef.externalId} / ${checkpointRef.digest} / generation ${checkpointRef.generation}`,
        `${record.externalId} / ${record.checkpointDigest} / generation ${record.checkpointGeneration}`,
      ));

    const lineageMatches = record.adapterId === command.adapterId
      && record.adapterVersion === command.adapterVersion
      && record.profileId === command.profileId
      && record.profileVersion === command.profileVersion
      && record.runId === command.runId
      && record.runGeneration === command.runGeneration
      && record.leaseGeneration === command.leaseGeneration;
    checks.push(lineageMatches
      ? passCheck(
        "checkpoint.lineage",
        "Checkpoint adapter, profile, run, and lease lineage match the resume command.",
        `${command.runId} / run ${command.runGeneration} / lease ${command.leaseGeneration}`,
      )
      : blockCheck(
        "checkpoint.lineage",
        "Checkpoint lineage is stale or belongs to another command lineage.",
        `${command.adapterId}@${command.adapterVersion} / ${command.profileId}@${command.profileVersion} / ${command.runId} / run ${command.runGeneration} / lease ${command.leaseGeneration}`,
        `${record.adapterId}@${record.adapterVersion} / ${record.profileId}@${record.profileVersion} / ${record.runId} / run ${record.runGeneration} / lease ${record.leaseGeneration}`,
      ));

    const runtimeMatches = record.runtimePackageId === expectedRuntime.packageId
      && record.runtimePackageVersion === expectedRuntime.packageVersion
      && record.checkpointSchemaVersion === expectedRuntime.checkpointSchemaVersion;
    checks.push(runtimeMatches
      ? passCheck(
        "checkpoint.runtime_schema",
        "Checkpoint package and schema versions match the current runtime expectation.",
        `${expectedRuntime.packageId}@${expectedRuntime.packageVersion} / schema ${expectedRuntime.checkpointSchemaVersion}`,
      )
      : blockCheck(
        "checkpoint.runtime_schema",
        "Checkpoint package or schema version is incompatible with the current runtime expectation.",
        `${expectedRuntime.packageId}@${expectedRuntime.packageVersion} / schema ${expectedRuntime.checkpointSchemaVersion}`,
        `${record.runtimePackageId}@${record.runtimePackageVersion} / schema ${record.checkpointSchemaVersion}`,
      ));
  }

  if (rawInput.latestCheckpointGeneration === null) {
    checks.push(unknownCheck(
      "checkpoint.latest_generation",
      "Latest checkpoint generation is unknown.",
      checkpointRef?.generation === null || checkpointRef?.generation === undefined
        ? "checkpoint generation"
        : String(checkpointRef.generation),
    ));
  } else {
    const latestGeneration = positiveInteger(
      rawInput.latestCheckpointGeneration,
      "Latest checkpoint generation",
    );
    const matches = checkpointRef?.generation === latestGeneration;
    checks.push(matches
      ? passCheck(
        "checkpoint.latest_generation",
        "Checkpoint is the latest known generation for this lineage.",
        String(latestGeneration),
      )
      : blockCheck(
        "checkpoint.latest_generation",
        latestGeneration > (checkpointRef?.generation ?? 0)
          ? "A newer checkpoint supersedes the requested resume checkpoint."
          : "Latest checkpoint generation conflicts with the requested resume checkpoint.",
        checkpointRef?.generation === null || checkpointRef?.generation === undefined
          ? "checkpoint generation"
          : String(checkpointRef.generation),
        String(latestGeneration),
      ));
  }

  if (rawInput.currentContinuation === null) {
    checks.push(unknownCheck(
      "continuation.current_generation",
      "Current continuation generation is unknown.",
      `${command.continuation.id} / generation ${command.continuation.generation}`,
    ));
  } else {
    const currentContinuation = normalizeContinuation(rawInput.currentContinuation);
    const matches = currentContinuation.id === command.continuation.id
      && currentContinuation.generation === command.continuation.generation;
    checks.push(matches
      ? passCheck(
        "continuation.current_generation",
        "Continuation identity and generation remain current.",
        `${currentContinuation.id} / generation ${currentContinuation.generation}`,
      )
      : blockCheck(
        "continuation.current_generation",
        "Continuation identity or generation has been superseded.",
        `${command.continuation.id} / generation ${command.continuation.generation}`,
        `${currentContinuation.id} / generation ${currentContinuation.generation}`,
      ));
  }

  let currentSurface: EffectiveToolSurfaceSnapshot | null = null;
  if (rawInput.currentCapabilityBinding === null) {
    checks.push(unknownCheck(
      "capabilities.current_binding",
      "Current resume capability inspection binding is unavailable.",
      command.commandId,
    ));
  } else {
    try {
      currentSurface = requireRunnerCapabilityInspectionForCommandV1(
        rawInput.currentCapabilityBinding,
        command,
      );
      checks.push(passCheck(
        "capabilities.current_binding",
        "Current capability inspection is bound to the exact resume command.",
        rawInput.currentCapabilityBinding.commandFingerprint,
      ));
    } catch (error) {
      checks.push(blockCheck(
        "capabilities.current_binding",
        "Current capability inspection no longer binds the exact resume command.",
        command.commandId,
        errorMessage(error),
      ));
    }
  }

  if (currentSurface !== null) {
    if (currentSurface.missingRequiredCapabilities.length > 0) {
      checks.push(blockCheck(
        "capabilities.current_required",
        "Current resume inspection is missing required command capabilities.",
        capabilityList(command.requiredCapabilities),
        capabilityList(currentSurface.missingRequiredCapabilities),
      ));
    } else {
      checks.push(passCheck(
        "capabilities.current_required",
        "Current resume inspection exposes every required command capability.",
        capabilityList(command.requiredCapabilities),
      ));
    }
  } else {
    checks.push(unknownCheck(
      "capabilities.current_required",
      "Current required-capability availability is unknown.",
      capabilityList(command.requiredCapabilities),
    ));
  }

  if (rawInput.checkpointToolSurface === null || currentSurface === null) {
    checks.push(unknownCheck(
      "capabilities.checkpoint_drift",
      "Checkpoint-to-current capability drift cannot be established.",
      "checkpoint required capabilities remain executable",
    ));
  } else {
    const checkpointSurface = rawInput.checkpointToolSurface;
    const currentExecutable = executableCapabilityKeys(currentSurface);
    const lost = checkpointSurface.requiredCapabilities.filter(
      (entry) => !currentExecutable.has(capabilityKey(entry)),
    );
    checks.push(lost.length === 0
      ? passCheck(
        "capabilities.checkpoint_drift",
        "Every capability required at checkpoint time remains executable; additive capabilities are tolerated.",
        capabilityList(checkpointSurface.requiredCapabilities),
      )
      : blockCheck(
        "capabilities.checkpoint_drift",
        "A capability required at checkpoint time is no longer executable.",
        capabilityList(checkpointSurface.requiredCapabilities),
        capabilityList(lost),
      ));
  }

  if (rawInput.currentAuthority === null) {
    checks.push(unknownCheck(
      "authority.current_fence",
      "Current run authority is unavailable.",
      authorityIdentity(command.authority),
    ));
  } else {
    const authority = normalizeAuthority(rawInput.currentAuthority);
    const matches = authority.resource === command.authority.resource
      && authority.holderId === command.authority.holderId
      && authority.generation === command.authority.generation
      && authority.expiresAt === command.authority.expiresAt
      && authority.generation === command.leaseGeneration;
    checks.push(matches
      ? passCheck(
        "authority.current_fence",
        "Current authority exactly matches the resume command fence.",
        authorityIdentity(command.authority),
      )
      : blockCheck(
        "authority.current_fence",
        "Current authority differs from the resume command fence.",
        authorityIdentity(command.authority),
        authorityIdentity(authority),
      ));
  }

  const authorityExpiresAt = Date.parse(command.authority.expiresAt);
  checks.push(authorityExpiresAt > observedMilliseconds
    ? passCheck(
      "authority.expiry",
      "Resume command authority is fresh at the inspection observation time.",
      `expires after ${observedAt}`,
      command.authority.expiresAt,
    )
    : blockCheck(
      "authority.expiry",
      "Resume command authority is expired at the inspection observation time.",
      `expires after ${observedAt}`,
      command.authority.expiresAt,
    ));

  inspectAuthorizationRefs(
    checks,
    "authority.grants",
    "capability grant",
    command.capabilityGrantRefs,
    rawInput.grantRefs,
    observedMilliseconds,
  );
  inspectAuthorizationRefs(
    checks,
    "authority.approvals",
    "approval",
    rawInput.requiredApprovalRefs ?? [],
    rawInput.approvalRefs ?? null,
    observedMilliseconds,
  );

  if (rawInput.priorCommand === null) {
    checks.push(unknownCheck(
      "settlement.prior_execution",
      "Prior command settlement state is unknown.",
      "settled interrupted/paused episode",
    ));
  } else if (rawInput.priorCommand === "absent") {
    checks.push(unknownCheck(
      "settlement.prior_execution",
      "No durable prior command record was supplied for this resume lineage.",
      "settled interrupted/paused episode",
    ));
  } else {
    const priorCommand = admitRunnerAdapterCommandReservationRecord(rawInput.priorCommand.command);
    const priorIdentityMatches = priorCommand.runId === command.runId
      && priorCommand.runGeneration === command.runGeneration
      && priorCommand.leaseGeneration === command.leaseGeneration
      && priorCommand.adapterId === command.adapterId
      && priorCommand.profileId === command.profileId;
    if (!priorIdentityMatches) {
      checks.push(blockCheck(
        "settlement.prior_execution",
        "Prior durable command belongs to another run or adapter lineage.",
        `${command.runId} / run ${command.runGeneration} / lease ${command.leaseGeneration} / ${command.adapterId} / ${command.profileId}`,
        `${priorCommand.runId} / run ${priorCommand.runGeneration} / lease ${priorCommand.leaseGeneration} / ${priorCommand.adapterId} / ${priorCommand.profileId}`,
      ));
    } else if (rawInput.priorCommand.settlement === null) {
      reconcileRequired = true;
      checks.push(blockCheck(
        "settlement.prior_execution",
        "Prior execution has a durable reservation without settlement; reconcile before resume.",
        "settled interrupted/paused episode",
        `unsettled ${priorCommand.commandId}`,
      ));
    } else {
      const settlement = admitRunnerAdapterCommandSettlementRecord(
        rawInput.priorCommand.settlement,
      );
      const terminal = settlement.outcome.terminalObservationType;
      const terminalAllowsResume = terminal === "interrupted" || terminal === "paused";
      const checkpointMatches = checkpointRef?.externalId !== null
        && checkpointRef?.externalId !== undefined
        && settlement.outcome.latestCheckpointExternalId === checkpointRef.externalId;
      checks.push(terminalAllowsResume && checkpointMatches
        ? passCheck(
          "settlement.prior_execution",
          "Prior execution settled as an interrupted/paused episode bound to this checkpoint.",
          `${checkpointRef.externalId} / interrupted or paused`,
          `${settlement.outcome.latestCheckpointExternalId} / ${terminal}`,
        )
        : blockCheck(
          "settlement.prior_execution",
          "Prior settlement does not establish this checkpoint as a resumable interrupted episode.",
          checkpointRef?.externalId ?? "checkpoint external ID",
          `${settlement.outcome.latestCheckpointExternalId ?? "no checkpoint"} / ${terminal}`,
        ));
    }
  }

  const decision = inspectionDecision(checks);
  const supportedActions: RunnerResumeInspectionActionV1[] = decision === "eligible"
    ? ["resume", "leave_paused"]
    : reconcileRequired
    ? ["reconcile", "leave_paused"]
    : ["leave_paused"];
  const checkpoint = checkpointRef === null ? null : checkpointRef;
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
    checkpoint,
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
  const sections: RunnerResumeInspectionRenderSectionV1[] = [
    renderSection(
      receipt,
      "checkpoint",
      "Checkpoint integrity",
      ["adapter.", "checkpoint.", "continuation."],
    ),
    renderSection(
      receipt,
      "capabilities",
      "Current capabilities",
      ["capabilities."],
    ),
    renderSection(
      receipt,
      "authority",
      "Current authority",
      ["authority."],
    ),
    renderSection(
      receipt,
      "settlement",
      "Prior settlement",
      ["settlement."],
    ),
  ];
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

function renderSection(
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

function inspectAuthorizationRefs(
  checks: RunnerResumeInspectionCheckV1[],
  code: string,
  label: string,
  requiredRefs: readonly string[],
  facts: readonly RunnerResumeAuthorizationRefV1[] | null,
  observedMilliseconds: number,
): void {
  const required = uniqueIdentifiers(requiredRefs, `Runner resume required ${label}`);
  if (required.length === 0) {
    checks.push(passCheck(code, `Resume command requires no ${label} references.`, "none"));
    return;
  }
  if (facts === null) {
    checks.push(unknownCheck(
      code,
      `Current ${label} freshness is unknown.`,
      required.join(", "),
    ));
    return;
  }
  const normalized = facts.map((fact) => normalizeAuthorizationRef(fact, label));
  const byRef = new Map(normalized.map((fact) => [fact.ref, fact]));
  const missing: string[] = [];
  const stale: string[] = [];
  const unknown: string[] = [];
  for (const ref of required) {
    const fact = byRef.get(ref);
    if (!fact) {
      missing.push(ref);
      continue;
    }
    if (fact.state === "unknown") {
      unknown.push(ref);
      continue;
    }
    if (
      fact.state !== "fresh"
      || (fact.expiresAt !== null && Date.parse(fact.expiresAt) <= observedMilliseconds)
    ) {
      stale.push(ref);
    }
  }
  if (stale.length > 0 || missing.length > 0) {
    checks.push(blockCheck(
      code,
      `A required ${label} is missing, expired, or revoked.`,
      required.join(", "),
      [...missing.map((ref) => `${ref}:missing`), ...stale.map((ref) => `${ref}:stale`)].join(", "),
    ));
  } else if (unknown.length > 0) {
    checks.push(unknownCheck(
      code,
      `A required ${label} has unknown freshness.`,
      required.join(", "),
      unknown.join(", "),
    ));
  } else {
    checks.push(passCheck(
      code,
      `Every required ${label} is fresh at the inspection observation time.`,
      required.join(", "),
    ));
  }
}

function inspectionDecision(
  checks: readonly RunnerResumeInspectionCheckV1[],
): RunnerResumeInspectionDecisionV1 {
  if (checks.some((check) => check.state === "block")) return "blocked";
  if (checks.some((check) => check.state === "unknown")) return "unknown";
  return "eligible";
}

function normalizeExpectedRuntime(
  input: RunnerResumeExpectedRuntimeV1,
): RunnerResumeExpectedRuntimeV1 {
  return Object.freeze({
    packageId: boundedIdentifier(input.packageId, "Runner runtime package ID"),
    packageVersion: boundedText(input.packageVersion, "Runner runtime package version", 160),
    checkpointSchemaVersion: boundedText(
      input.checkpointSchemaVersion,
      "Runner checkpoint schema version",
      160,
    ),
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
  const accessClass = input.accessClass;
  if (accessClass !== "private" && accessClass !== "project" && accessClass !== "workspace") {
    throw new RangeError("Runner checkpoint access class is invalid");
  }
  return Object.freeze({
    version: 1,
    adapterId: boundedIdentifier(input.adapterId, "Runner checkpoint adapter ID"),
    adapterVersion: boundedText(input.adapterVersion, "Runner checkpoint adapter version", 160),
    profileId: boundedIdentifier(input.profileId, "Runner checkpoint profile ID"),
    profileVersion: boundedText(input.profileVersion, "Runner checkpoint profile version", 160),
    runtimePackageId: boundedIdentifier(input.runtimePackageId, "Runner checkpoint runtime package ID"),
    runtimePackageVersion: boundedText(
      input.runtimePackageVersion,
      "Runner checkpoint runtime package version",
      160,
    ),
    checkpointSchemaVersion: boundedText(
      input.checkpointSchemaVersion,
      "Runner checkpoint schema version",
      160,
    ),
    runId: boundedIdentifier(input.runId, "Runner checkpoint run ID"),
    runGeneration: positiveInteger(input.runGeneration, "Runner checkpoint run generation"),
    leaseGeneration: positiveInteger(input.leaseGeneration, "Runner checkpoint lease generation"),
    checkpointGeneration: positiveInteger(
      input.checkpointGeneration,
      "Runner checkpoint generation",
    ),
    externalId: boundedIdentifier(input.externalId, "Runner checkpoint external ID"),
    checkpointDigest: fingerprint(input.checkpointDigest, "Runner checkpoint digest"),
    createdAt: canonicalTimestamp(input.createdAt, "Runner checkpoint creation time"),
    accessClass,
  });
}

function normalizeContinuation(
  input: RunnerContinuationBindingV1,
): RunnerContinuationBindingV1 {
  return Object.freeze({
    id: boundedIdentifier(input.id, "Runner continuation ID"),
    generation: positiveInteger(input.generation, "Runner continuation generation"),
  });
}

function normalizeAuthority(input: RunAuthorityFence): RunAuthorityFence {
  return Object.freeze({
    resource: runResource(input.resource),
    holderId: boundedIdentifier(input.holderId, "Runner authority holder ID"),
    generation: positiveInteger(input.generation, "Runner authority generation"),
    expiresAt: canonicalTimestamp(input.expiresAt, "Runner authority expiry"),
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
    ref: boundedIdentifier(input.ref, `Runner ${label} reference`),
    state: input.state,
    expiresAt: input.expiresAt === null
      ? null
      : canonicalTimestamp(input.expiresAt, `Runner ${label} expiry`),
  });
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
    : [...entries]
      .map((entry) => `${entry.class}:${entry.id}`)
      .sort()
      .join(", ");
}

function capabilityKey(entry: ToolSurfaceCapabilityRef | { class: string; id: string }): string {
  return `${entry.class}\u0000${entry.id}`;
}

function authorityIdentity(authority: RunAuthorityFence): string {
  return `${authority.resource} / ${authority.holderId} / generation ${authority.generation} / expires ${authority.expiresAt}`;
}

function passCheck(
  code: string,
  summary: string,
  expected: string | null,
): RunnerResumeInspectionCheckV1 {
  return { code, state: "pass", summary, expected, observed: expected };
}

function blockCheck(
  code: string,
  summary: string,
  expected: string | null,
  observed: string | null,
): RunnerResumeInspectionCheckV1 {
  return { code, state: "block", summary, expected, observed };
}

function unknownCheck(
  code: string,
  summary: string,
  expected: string | null,
  observed: string | null = null,
): RunnerResumeInspectionCheckV1 {
  return { code, state: "unknown", summary, expected, observed };
}

function uniqueIdentifiers(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => boundedIdentifier(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new RangeError(`${label} contains duplicates`);
  }
  return normalized;
}

function runResource(value: unknown): `run:${string}` {
  const normalized = boundedText(value, "Runner authority resource", 200);
  if (!normalized.startsWith("run:") || normalized.length <= 4) {
    throw new RangeError("Runner authority resource is invalid");
  }
  return normalized as `run:${string}`;
}

function fingerprint(value: unknown, label: string): string {
  const normalized = boundedText(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const normalized = boundedText(value, label, 40);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function boundedIdentifier(value: unknown, label: string): string {
  const normalized = boundedText(value, label, 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum} characters`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function errorMessage(error: unknown): string {
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
