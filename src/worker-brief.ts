import {
  parseExecutionEnvelope,
  type ExecutionEnvelope,
} from "./execution-envelope.js";
import { sha256, stableJson } from "./canonical-json.js";
import {
  parseProjectAttachmentSnapshot,
  type ProjectAttachmentSnapshot,
} from "./project-contract.js";

export const WORKER_BRIEF_SCHEMA_V1 = "worker-brief/v1" as const;
export const WORKER_BRIEF_COMPILER_VERSION = "0.2.0" as const;

export const NEWLINE_TOKEN = "\\n" as const;

export const workerBriefCapabilityClasses = [
  "frontier",
  "standard",
  "economy",
] as const;

export const workerBriefPresentations = ["explicit", "terse"] as const;

export const workerBriefProviderAvailability = [
  "available",
  "degraded",
  "unavailable",
  "unknown",
] as const;

export const workerBriefSupersessionStates = [
  "current",
  "superseded",
  "conflicted",
  "unknown",
] as const;

export const workerBriefSourceKinds = [
  "project_contract_snapshot",
  "work_item_control",
  "dispatch_lease",
  "situation_projection",
  "context_pack",
  "handoff_record",
  "recipe_contract",
] as const;

export const workerBriefCompletionOutcomes = [
  "success",
  "blocked",
  "waiting",
  "superseded",
  "conflict",
] as const;

export const IMPLEMENT_BOUNDED_ISSUE_RECIPE_ID = "implement_bounded_issue" as const;
export const IMPLEMENT_BOUNDED_ISSUE_RECIPE_REVISION = "1" as const;

export type WorkerBriefCapabilityClass = (typeof workerBriefCapabilityClasses)[number];
export type WorkerBriefPresentation = (typeof workerBriefPresentations)[number];
export type WorkerBriefProviderAvailability =
  (typeof workerBriefProviderAvailability)[number];
export type WorkerBriefSupersessionState =
  (typeof workerBriefSupersessionStates)[number];
export type WorkerBriefSourceKind = (typeof workerBriefSourceKinds)[number];

export interface WorkerBriefClaimSourceV1 {
  kind: WorkerBriefSourceKind;
  coordinates: string;
}

export interface WorkerBriefItemInputV1 {
  id: string;
  title: string;
  summary: string | null;
  nextAction: string | null;
  status: "ready" | "active" | "blocked";
}

export interface WorkerBriefControlInputV1 {
  authorityState: "unclaimed" | "live" | "expiring" | "expired" | "superseded";
  claimGeneration: number | null;
  holderActorId: string | null;
  expiresAt: string | null;
}

export interface WorkerBriefDispatchInputV1 {
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  runnerProfile: string;
  capabilityClass: WorkerBriefCapabilityClass;
}

export interface WorkerBriefSituationInputV1 {
  repositoryBaseline: {
    repository: string;
    baseRevision: string | null;
    candidateRevision: string | null;
    changeIdentity: string | null;
  } | null;
  blockers: readonly string[];
  overlaps: readonly string[];
  providerAvailability: WorkerBriefProviderAvailability;
  supersessionState: WorkerBriefSupersessionState;
  outstandingDecisions: readonly string[];
}

export interface WorkerBriefContextPackInputV1 {
  generatedAt: string;
  characterCount: number;
  sourceReferences: readonly string[];
}

export interface WorkerBriefContextPlanInputV1 {
  canonicalSummary: string;
  expansionRefs: readonly string[];
  maxEvidenceCharacters: number;
  sourceFreshness: "exact_revision_required" | "fresh_read_required" | "advisory";
  contextPack: WorkerBriefContextPackInputV1 | null;
}

export interface WorkerBriefHandoffRecordV1 {
  ref: string;
  fromRunId: string;
  priorBriefDigest: string | null;
  summary: string;
  findings: readonly string[];
  nextAction: string;
  evidenceRefs: readonly string[];
  emittedAt: string;
  replacesClaimGeneration: number;
}

export interface CompileWorkerBriefInputV1 {
  observedAt: string;
  workspaceId: string;
  projectId: string;
  policySnapshot: ProjectAttachmentSnapshot;
  item: WorkerBriefItemInputV1;
  control: WorkerBriefControlInputV1;
  dispatch: WorkerBriefDispatchInputV1;
  objectiveOutcome: string;
  objectiveNonGoals: readonly string[];
  startingPoints: readonly string[];
  situation: WorkerBriefSituationInputV1;
  contextPlan: WorkerBriefContextPlanInputV1;
  executionEnvelope: ExecutionEnvelope;
  recipe: WorkerBriefRecipeV1 | null;
  continuation: WorkerBriefHandoffRecordV1 | null;
  wakeRetryCondition: string | null;
}

export interface WorkerBriefRecipeV1 {
  id: typeof IMPLEMENT_BOUNDED_ISSUE_RECIPE_ID;
  revision: typeof IMPLEMENT_BOUNDED_ISSUE_RECIPE_REVISION;
  applicability: {
    itemStatuses: readonly WorkerBriefItemInputV1["status"][];
    authorityStates: readonly WorkerBriefControlInputV1["authorityState"][];
    scopeClasses: readonly ExecutionEnvelope["scopeClass"][];
  };
  observations: readonly string[];
  checkpoints: readonly string[];
  requiredValidation: readonly string[];
  stopEscalation: readonly string[];
  handoffExpectations: readonly string[];
}

export interface WorkerBriefObjectiveSectionV1 {
  outcome: string;
  outcomeSource: WorkerBriefClaimSourceV1;
  nextAction: string | null;
  nextActionSource: WorkerBriefClaimSourceV1;
  startingPoints: readonly string[];
  nonGoals: readonly string[];
}

export interface WorkerBriefPolicySectionV1 {
  contractSnapshotSha256: string;
  contractContentSha256: string;
  contractSourcePath: string;
  allowedLocalOperations: readonly string[];
  approvalGatedOperations: readonly string[];
  requiredChecks: readonly string[];
  evidenceExpectations: string;
  escalationConditions: string;
  source: WorkerBriefClaimSourceV1;
}

export interface WorkerBriefExecutionBindingV1 {
  envelopeSchemaVersion: number;
  scopeClass: ExecutionEnvelope["scopeClass"];
  expectedToolCalls: number;
  forcedHandoffMinutes: number;
  verificationRequired: boolean;
  continuationStateRequired: boolean;
  requiredOutputs: readonly string[];
  acceptanceChecks: readonly string[];
  source: WorkerBriefClaimSourceV1;
}

export interface WorkerBriefSituationSectionV1 {
  repositoryBaseline: WorkerBriefSituationInputV1["repositoryBaseline"];
  blockers: readonly string[];
  overlaps: readonly string[];
  providerAvailability: WorkerBriefProviderAvailability;
  supersessionState: WorkerBriefSupersessionState;
  outstandingDecisions: readonly string[];
  source: WorkerBriefClaimSourceV1;
}

export interface WorkerBriefContextPlanSectionV1 {
  canonicalSummary: string;
  expansionRefs: readonly string[];
  maxEvidenceCharacters: number;
  sourceFreshness: WorkerBriefContextPlanInputV1["sourceFreshness"];
  contextPackRef: {
    digest: string;
    generatedAt: string;
    characterCount: number;
  } | null;
  source: WorkerBriefClaimSourceV1;
}

export interface WorkerBriefCompletionContractV1 {
  outcomes: readonly (typeof workerBriefCompletionOutcomes)[number][];
  requiredReceipts: readonly string[];
  handoffFields: readonly string[];
  wakeRetryCondition: string | null;
  source: WorkerBriefClaimSourceV1;
}

export interface WorkerBriefContinuationSectionV1 {
  ref: string;
  fromRunId: string;
  priorBriefDigest: string | null;
  summary: string;
  findings: readonly string[];
  evidenceRefs: readonly string[];
  emittedAt: string;
  replacesClaimGeneration: number;
  source: WorkerBriefClaimSourceV1;
}

export interface WorkerBriefV1 {
  version: typeof WORKER_BRIEF_SCHEMA_V1;
  compilerVersion: typeof WORKER_BRIEF_COMPILER_VERSION;
  observedAt: string;
  semanticDigest: string;
  grantsAuthority: false;
  identity: {
    workspaceId: string;
    projectId: string;
    itemId: string;
    itemTitle: string;
    claimGeneration: number | null;
    dispatch: {
      runId: string;
      runGeneration: number;
      leaseGeneration: number;
      runnerProfile: string;
      capabilityClass: WorkerBriefCapabilityClass;
    };
    continuation: {
      ref: string;
      fromRunId: string;
    } | null;
  };
  objective: WorkerBriefObjectiveSectionV1;
  policy: WorkerBriefPolicySectionV1;
  execution: WorkerBriefExecutionBindingV1;
  situation: WorkerBriefSituationSectionV1;
  contextPlan: WorkerBriefContextPlanSectionV1;
  recipe: WorkerBriefRecipeV1 | null;
  completionContract: WorkerBriefCompletionContractV1;
  continuation: WorkerBriefContinuationSectionV1 | null;
}

export interface WorkerBriefFreshnessFactsV1 {
  expectedSemanticDigest: string;
  runId: string;
  itemId: string;
  claimGeneration: number | null;
  runGeneration: number;
  leaseGeneration: number;
  contractSnapshotSha256: string;
  itemNextAction: string | null;
}

export interface WorkerBriefPresentationSectionV1 {
  id:
    | "identity"
    | "objective"
    | "situation"
    | "policy"
    | "execution"
    | "context"
    | "recipe"
    | "completion";
  title: string;
  lines: readonly string[];
}

export interface WorkerBriefPresentationModelV1 {
  version: 1;
  presentation: WorkerBriefPresentation;
  title: string;
  semanticDigest: string;
  grantsAuthority: false;
  invariant: {
    itemId: string;
    outcome: string;
    nextAction: string | null;
    allowedLocalOperations: readonly string[];
    approvalGatedOperations: readonly string[];
    requiredChecks: readonly string[];
    requiredReceipts: readonly string[];
    handoffFields: readonly string[];
    nonGoals: readonly string[];
    requiredValidation: readonly string[];
    stopEscalation: readonly string[];
    escalationConditions: string;
    evidenceExpectations: string;
  };
  sections: readonly WorkerBriefPresentationSectionV1[];
  invariantFingerprint: string;
}

const MAX_IDENTIFIER_LENGTH = 120;
const MAX_REF_LENGTH = 240;
const MAX_RUN_ID_LENGTH = 180;
const MAX_TITLE_LENGTH = 240;
const MAX_TEXT_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 800;
const MAX_POLICY_PROSE_LENGTH = 1_500;
const MAX_ESCALATION_PROSE_LENGTH = 1_000;
const MAX_RENDER_LINE_LENGTH = 1_000;
const MAX_NON_GOALS = 8;
const MAX_STARTING_POINTS = 12;
const MAX_EXPANSION_REFS = 24;
const MAX_BLOCKERS = 12;
const MAX_OVERLAPS = 12;
const MAX_OUTSTANDING_DECISIONS = 8;
const MAX_FINDINGS = 10;
const MAX_HANDOFF_EVIDENCE_REFS = 16;
const MIN_EVIDENCE_CHARACTERS = 500;
const MAX_EVIDENCE_CHARACTERS = 50_000;

const CREDENTIAL_PATTERN = /(?:stn\.tok_|sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9._-]+/i;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const NEWLINE_RUN_PATTERN = /\r\n|[\r\n]/gu;
const REVISION_PATTERN = /^[a-f0-9]{7,40}$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CHANGE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/u;

export function compileWorkerBriefV1(
  rawInput: CompileWorkerBriefInputV1,
): WorkerBriefV1 {
  const input = exactRecord(rawInput, compileInputKeys, "Worker brief compile input");
  const observedAt = timestamp(input.observedAt, "Worker brief observation time");
  const workspaceId = identifier(input.workspaceId, "Worker brief workspace");
  const projectId = slug(input.projectId, "Worker brief project");
  const policySnapshot = parseProjectAttachmentSnapshot(input.policySnapshot);
  const item = admitItem(input.item);
  const control = admitControl(input.control);
  const dispatch = admitDispatch(input.dispatch);

  const continuation = input.continuation === null
    ? null
    : admitHandoffRecordAfterChecks(input, control);

  const outcomeText = safeText(input.objectiveOutcome, "Objective outcome", MAX_TEXT_LENGTH);
  const nonGoals = safeTextList(input.objectiveNonGoals, "Objective non-goal", MAX_NON_GOALS, MAX_TEXT_LENGTH);
  const startingPoints = refList(input.startingPoints, "Starting point", MAX_STARTING_POINTS);
  const situation = admitSituation(input.situation);
  const contextPlan = admitContextPlan(input.contextPlan);
  const envelope = parseExecutionEnvelope(input.executionEnvelope);
  const recipe = input.recipe === null ? null : admitRecipe(input.recipe);

  if (
    recipe !== null
    && !recipe.applicability.itemStatuses.includes(item.status)
  ) {
    throw new RangeError("The selected recipe does not apply to the current item status");
  }
  if (
    recipe !== null
    && !recipe.applicability.authorityStates.includes(control.authorityState)
  ) {
    throw new RangeError("The selected recipe does not apply to the current authority state");
  }
  if (
    recipe !== null
    && !recipe.applicability.scopeClasses.includes(envelope.scopeClass)
  ) {
    throw new RangeError("The selected recipe does not apply to the execution scope class");
  }
  if (recipe !== null) {
    assertCanonicalRecipeBody(recipe, policySnapshot);
  }

  const policySource: WorkerBriefClaimSourceV1 = Object.freeze({
    kind: "project_contract_snapshot",
    coordinates: `${policySnapshot.source.path}@${policySnapshot.source.contentSha256}`,
  });
  const dispatchSource: WorkerBriefClaimSourceV1 = Object.freeze({
    kind: "dispatch_lease",
    coordinates: `run:${dispatch.runId}@gen${dispatch.runGeneration}/lease${dispatch.leaseGeneration}`,
  });
  const controlSource: WorkerBriefClaimSourceV1 = Object.freeze({
    kind: "work_item_control",
    coordinates: control.claimGeneration === null
      ? `item:${item.id}@unclaimed`
      : `item:${item.id}@claim-generation-${control.claimGeneration}`,
  });
  const situationSource: WorkerBriefClaimSourceV1 = Object.freeze({
    kind: "situation_projection",
    coordinates: `projection:item:${item.id}@${observedAt}`,
  });
  const contextSource: WorkerBriefClaimSourceV1 = Object.freeze(
    contextPlan.contextPackRef === null
      ? { kind: "situation_projection", coordinates: `projection:context:${item.id}@${observedAt}` }
      : { kind: "context_pack", coordinates: `context-pack@${contextPlan.contextPackRef.digest}` },
  );
  const nextActionSource: WorkerBriefClaimSourceV1 = Object.freeze(
    continuation === null
      ? controlSource
      : {
        kind: "handoff_record" as const,
        coordinates: `handoff:${continuation.ref}`,
      },
  );

  const withoutDigest = deepFreeze({
    version: WORKER_BRIEF_SCHEMA_V1,
    compilerVersion: WORKER_BRIEF_COMPILER_VERSION,
    observedAt,
    grantsAuthority: false as const,
    identity: Object.freeze({
      workspaceId,
      projectId,
      itemId: item.id,
      itemTitle: item.title,
      claimGeneration: control.claimGeneration,
      dispatch: Object.freeze({ ...dispatch }),
      continuation: continuation === null
        ? null
        : Object.freeze({ ref: continuation.ref, fromRunId: continuation.fromRunId }),
    }),
    objective: Object.freeze({
      outcome: outcomeText,
      outcomeSource: dispatchSource,
      nextAction: continuation !== null ? continuation.nextAction : item.nextAction,
      nextActionSource,
      startingPoints,
      nonGoals,
    }),
    policy: Object.freeze({
      contractSnapshotSha256: policySnapshot.snapshotSha256,
      contractContentSha256: policySnapshot.source.contentSha256,
      contractSourcePath: policySnapshot.source.path,
      allowedLocalOperations: [...policySnapshot.contract.autonomousActions],
      approvalGatedOperations: [...policySnapshot.contract.approvalRequired],
      requiredChecks: [...policySnapshot.contract.checks],
      evidenceExpectations: clipProse(policySnapshot.context.evidenceAndHandoff, MAX_POLICY_PROSE_LENGTH),
      escalationConditions: clipProse(policySnapshot.context.escalation, MAX_ESCALATION_PROSE_LENGTH),
      source: policySource,
    }),
    execution: Object.freeze({
      envelopeSchemaVersion: envelope.schemaVersion,
      scopeClass: envelope.scopeClass,
      expectedToolCalls: envelope.budget.expectedToolCalls,
      forcedHandoffMinutes: envelope.boundaries.forcedHandoffMinutes,
      verificationRequired: envelope.completion.verificationRequired,
      continuationStateRequired: envelope.completion.continuationStateRequired,
      requiredOutputs: [...envelope.completion.requiredOutputs],
      acceptanceChecks: [...envelope.completion.acceptanceChecks],
      source: dispatchSource,
    }),
    situation: Object.freeze({ ...situation, source: situationSource }),
    contextPlan: Object.freeze({ ...contextPlan, source: contextSource }),
    recipe,
    completionContract: Object.freeze({
      outcomes: [...workerBriefCompletionOutcomes],
      requiredReceipts: [...envelope.completion.requiredOutputs],
      handoffFields: recipe !== null && recipe.handoffExpectations.length > 0
        ? [...recipe.handoffExpectations]
        : ["summary", "nextAction", "evidenceRefs", "outcome"],
      wakeRetryCondition: input.wakeRetryCondition === null
        ? null
        : safeText(input.wakeRetryCondition, "Wake retry condition", MAX_TEXT_LENGTH),
      source: dispatchSource,
    }),
    continuation: continuation === null
      ? null
      : Object.freeze({
        ref: continuation.ref,
        fromRunId: continuation.fromRunId,
        priorBriefDigest: continuation.priorBriefDigest,
        summary: continuation.summary,
        findings: continuation.findings,
        evidenceRefs: continuation.evidenceRefs,
        emittedAt: continuation.emittedAt,
        replacesClaimGeneration: continuation.replacesClaimGeneration,
        source: nextActionSource,
      }),
  });

  return deepFreeze({
    ...withoutDigest,
    semanticDigest: sha256(stableJson(withoutDigest)),
  }) as WorkerBriefV1;
}

export function workerBriefJson(brief: WorkerBriefV1): string {
  const admitted = admitCompiledBrief(brief);
  return stableJson(admitted);
}

export function assertWorkerBriefCurrentV1(
  brief: WorkerBriefV1,
  current: WorkerBriefFreshnessFactsV1,
): void {
  const parsed = admitCompiledBrief(brief);
  const facts = exactRecord(current, freshnessKeys, "Worker brief freshness facts");
  hashValue(parsed.semanticDigest, "Worker brief semantic digest");
  if (typeof facts.runId !== "string" || !facts.runId) {
    throw new TypeError("Current run id must be text");
  }
  if (typeof facts.itemId !== "string" || !facts.itemId) {
    throw new TypeError("Current item id must be text");
  }
  const expectedDigest = hashValue(facts.expectedSemanticDigest, "Current expected semantic digest");
  const mismatches: string[] = [];
  if (parsed.identity.dispatch.runId !== facts.runId) {
    mismatches.push(`run id ${parsed.identity.dispatch.runId} != ${facts.runId}`);
  }
  if (parsed.identity.itemId !== facts.itemId) {
    mismatches.push(`item id ${parsed.identity.itemId} != ${facts.itemId}`);
  }
  if (parsed.semanticDigest !== expectedDigest) {
    mismatches.push(`semantic digest ${parsed.semanticDigest} != ${expectedDigest}`);
  }
  if (parsed.identity.claimGeneration !== nullablePositiveInteger(facts.claimGeneration)) {
    mismatches.push(`claim generation ${String(parsed.identity.claimGeneration)} != ${String(facts.claimGeneration)}`);
  }
  if (parsed.identity.dispatch.runGeneration !== positiveInteger(facts.runGeneration, "Current run generation")) {
    mismatches.push(`run generation ${parsed.identity.dispatch.runGeneration} != ${facts.runGeneration}`);
  }
  if (parsed.identity.dispatch.leaseGeneration !== positiveInteger(facts.leaseGeneration, "Current lease generation")) {
    mismatches.push(`lease generation ${parsed.identity.dispatch.leaseGeneration} != ${facts.leaseGeneration}`);
  }
  const currentSnapshot = hashValue(facts.contractSnapshotSha256, "Current contract snapshot");
  if (parsed.policy.contractSnapshotSha256 !== currentSnapshot) {
    mismatches.push(`contract snapshot ${parsed.policy.contractSnapshotSha256} != ${currentSnapshot}`);
  }
  const currentNextAction = facts.itemNextAction === null || facts.itemNextAction === undefined
    ? null
    : safeText(facts.itemNextAction, "Current next action", MAX_TEXT_LENGTH);
  if (parsed.objective.nextAction !== currentNextAction) {
    mismatches.push(
      `next action ${JSON.stringify(parsed.objective.nextAction)} != ${JSON.stringify(currentNextAction)}`,
    );
  }
  if (mismatches.length > 0) {
    throw new RangeError(
      `Worker brief ${parsed.semanticDigest} is stale and fails closed: ${mismatches.join("; ")}`,
    );
  }
}

export function workerBriefIsCurrentV1(
  brief: WorkerBriefV1,
  current: WorkerBriefFreshnessFactsV1,
): boolean {
  try {
    assertWorkerBriefCurrentV1(brief, current);
    return true;
  } catch {
    return false;
  }
}

export function presentWorkerBriefV1(
  rawBrief: WorkerBriefV1,
  presentation: WorkerBriefPresentation,
): WorkerBriefPresentationModelV1 {
  const brief = admitCompiledBrief(rawBrief);
  if (!workerBriefPresentations.includes(presentation)) {
    throw new RangeError("Worker brief presentation is invalid");
  }

  const identity = brief.identity;
  const core = {
    semanticDigest: brief.semanticDigest,
    grantsAuthority: false as const,
    invariant: Object.freeze({
      itemId: identity.itemId,
      outcome: brief.objective.outcome,
      nextAction: brief.objective.nextAction,
      allowedLocalOperations: brief.policy.allowedLocalOperations,
      approvalGatedOperations: brief.policy.approvalGatedOperations,
      requiredChecks: brief.policy.requiredChecks,
      requiredReceipts: brief.completionContract.requiredReceipts,
      handoffFields: brief.completionContract.handoffFields,
      nonGoals: brief.objective.nonGoals,
      requiredValidation: brief.recipe === null ? [] : brief.recipe.requiredValidation,
      stopEscalation: brief.recipe === null ? [] : brief.recipe.stopEscalation,
      escalationConditions: brief.policy.escalationConditions,
      evidenceExpectations: brief.policy.evidenceExpectations,
    }),
  };

  const sections: WorkerBriefPresentationSectionV1[] = [];
  sections.push(Object.freeze({
    id: "identity" as const,
    title: "Identity",
    lines: Object.freeze(presentation === "explicit"
      ? [
        `workspace ${identity.workspaceId} · project ${identity.projectId}`,
        `item ${identity.itemId}: ${identity.itemTitle}`,
        `run ${identity.dispatch.runId} @ generation ${identity.dispatch.runGeneration} / lease ${identity.dispatch.leaseGeneration}`,
        `runner profile ${identity.dispatch.runnerProfile} (${identity.dispatch.capabilityClass})`,
        `claim generation ${String(identity.claimGeneration)}`,
        `brief ${brief.semanticDigest}`,
        identity.continuation === null
          ? "continuation none"
          : `continuation ${identity.continuation.ref} from run ${identity.continuation.fromRunId}`,
      ]
      : [
        `item ${identity.itemId} · run ${identity.dispatch.runId} g${identity.dispatch.runGeneration}/l${identity.dispatch.leaseGeneration}`,
        `brief ${brief.semanticDigest}`,
      ]),
  }));
  sections.push(Object.freeze({
    id: "objective" as const,
    title: "Objective",
    lines: Object.freeze([
      `outcome: ${brief.objective.outcome}`,
      `next action: ${brief.objective.nextAction ?? "none recorded"}`,
      ...(presentation === "explicit"
        ? [
          `outcome source: ${claimCoordinate(brief.objective.outcomeSource)}`,
          `next action source: ${claimCoordinate(brief.objective.nextActionSource)}`,
          ...brief.objective.startingPoints.map((ref) => `start from: ${ref}`),
          ...brief.objective.nonGoals.map((goal) => `non-goal: ${goal}`),
        ]
        : brief.objective.nonGoals.map((goal) => `non-goal: ${goal}`)),
    ]),
  }));
  sections.push(Object.freeze({
    id: "situation" as const,
    title: "Current situation",
    lines: Object.freeze([
      `provider availability: ${brief.situation.providerAvailability}`,
      `supersession: ${brief.situation.supersessionState}`,
      ...(presentation === "explicit"
        ? [
          baselineLine(brief.situation.repositoryBaseline),
          ...brief.situation.blockers.map((blocker) => `blocker: ${blocker}`),
          ...brief.situation.overlaps.map((overlap) => `overlap: ${overlap}`),
          ...brief.situation.outstandingDecisions.map((decision) => `open decision: ${decision}`),
          `source: ${claimCoordinate(brief.situation.source)}`,
        ]
        : brief.situation.blockers.slice(0, 3).map((blocker) => `blocker: ${blocker}`)),
    ]),
  }));
  sections.push(Object.freeze({
    id: "policy" as const,
    title: "Operating policy",
    lines: Object.freeze([
      `allowed local operations: ${listOrNone(brief.policy.allowedLocalOperations)}`,
      `approval gated operations: ${listOrNone(brief.policy.approvalGatedOperations)}`,
      ...brief.policy.requiredChecks.map((check) => `required check: ${check}`),
      `evidence expectations: ${brief.policy.evidenceExpectations}`,
      `escalation conditions: ${brief.policy.escalationConditions}`,
      ...(presentation === "explicit"
        ? [
          `contract snapshot: ${brief.policy.contractSnapshotSha256}`,
          `contract source: ${brief.policy.contractSourcePath}@${brief.policy.contractContentSha256}`,
        ]
        : []),
    ]),
  }));
  sections.push(Object.freeze({
    id: "execution" as const,
    title: "Execution binding",
    lines: Object.freeze([
      `scope class ${brief.execution.scopeClass} · envelope schema v${brief.execution.envelopeSchemaVersion}`,
      `forced handoff after ${brief.execution.forcedHandoffMinutes} minutes`,
      ...(presentation === "explicit"
        ? [
          ...brief.execution.acceptanceChecks.map((check) => `acceptance check: ${check}`),
          `verification required: ${brief.execution.verificationRequired}`,
        ]
        : []),
    ]),
  }));
  sections.push(Object.freeze({
    id: "context" as const,
    title: "Context plan",
    lines: Object.freeze([
      brief.contextPlan.canonicalSummary,
      `expand at most ${String(brief.contextPlan.maxEvidenceCharacters)} characters (${brief.contextPlan.sourceFreshness})`,
      ...(presentation === "explicit"
        ? brief.contextPlan.expansionRefs.map((ref) => `eligible reference: ${ref}`)
        : brief.contextPlan.expansionRefs.slice(0, 5).map((ref) => `reference: ${ref}`)),
    ]),
  }));
  if (brief.recipe !== null) {
    sections.push(Object.freeze({
      id: "recipe" as const,
      title: `Recipe ${brief.recipe.id}`,
      lines: Object.freeze(presentation === "explicit"
        ? [
          ...brief.recipe.observations.map((entry) => `observe: ${entry}`),
          ...brief.recipe.checkpoints.map((entry, index) => `checkpoint ${index + 1}: ${entry}`),
          ...brief.recipe.requiredValidation.map((entry) => `validate: ${entry}`),
          ...brief.recipe.stopEscalation.map((entry) => `stop or escalate: ${entry}`),
        ]
        : [
          ...brief.recipe.requiredValidation.map((entry) => `validate: ${entry}`),
          ...brief.recipe.stopEscalation.map((entry) => `stop or escalate: ${entry}`),
        ]),
    }));
  }
  sections.push(Object.freeze({
    id: "completion" as const,
    title: "Completion contract",
    lines: Object.freeze([
      `outcomes: ${brief.completionContract.outcomes.join(", ")}`,
      ...brief.completionContract.requiredReceipts.map((receipt) => `receipt required: ${receipt}`),
      `handoff fields: ${brief.completionContract.handoffFields.join(", ")}`,
      ...(brief.completionContract.wakeRetryCondition === null
        ? []
        : [`wake/retry condition: ${brief.completionContract.wakeRetryCondition}`]),
      ...(presentation === "explicit"
        ? [`authority: this brief grants zero authority; live authority stays with the referenced dispatch lease.`]
        : []),
    ]),
  }));

  const clippedSections = sections.map((section) => ({
    id: section.id,
    title: section.title,
    lines: Object.freeze([...section.lines].map(renderLine)),
  }));

  return deepFreeze({
    version: 1 as const,
    presentation,
    title: presentation === "explicit"
      ? "Worker brief (explicit)"
      : "Worker brief (terse)",
    ...core,
    sections: Object.freeze(clippedSections),
    invariantFingerprint: sha256(stableJson(core)),
  }) as WorkerBriefPresentationModelV1;
}

export function renderWorkerBriefPresentationV1(
  model: WorkerBriefPresentationModelV1,
): string {
  const parsed = exactRecord(model, presentationKeys, "Worker brief presentation model");
  if (parsed.version !== 1) throw new TypeError("Worker brief presentation version is unsupported");
  if (!workerBriefPresentations.includes(parsed.presentation as WorkerBriefPresentation)) {
    throw new TypeError("Worker brief presentation is invalid");
  }
  hashValue(parsed.semanticDigest, "Worker brief semantic digest");
  hashValue(parsed.invariantFingerprint, "Worker brief invariant fingerprint");
  const sections = dataList(parsed.sections, "Presentation sections", 12).map(
    (entry, index) => admitPresentationSection(entry, index),
  );
  const lines = [safeText(parsed.title, "Presentation title", 120), `semantic digest ${parsed.semanticDigest}`, ""];
  for (const section of sections) {
    lines.push(`## ${section.title}`);
    for (const line of section.lines) lines.push(line);
    lines.push("");
  }
  lines.push("grantsAuthority: false");
  return lines.join("\n").replace(/\n{3,}$/u, "\n");
}

function admitPresentationSection(
  value: unknown,
  index: number,
): WorkerBriefPresentationSectionV1 {
  const record = exactRecord(value, presentationSectionKeys, `Presentation section ${index + 1}`);
  return {
    id: closedValue<WorkerBriefPresentationSectionV1["id"]>(
      record.id,
      new Set(presentationSectionIds),
      "Section id",
    ),
    title: safeText(record.title, "Section title", 120),
    lines: Object.freeze(safeTextList(record.lines, "Section line", 60, MAX_RENDER_LINE_LENGTH)),
  };
}

function renderLine(text: string): string {
  const singleLine = text.replace(NEWLINE_RUN_PATTERN, NEWLINE_TOKEN);
  if (singleLine.length <= MAX_RENDER_LINE_LENGTH) return singleLine;
  return `${singleLine.slice(0, MAX_RENDER_LINE_LENGTH - 1)}…`;
}

const CANONICAL_IMPLEMENT_BOUNDED_ISSUE_APPLICABILITY = {
  itemStatuses: ["ready"] as const,
  authorityStates: ["unclaimed"] as const,
  scopeClasses: ["atomic", "segmented"] as const,
} as const;

const CANONICAL_IMPLEMENT_BOUNDED_ISSUE_OBSERVATIONS = Object.freeze([
  "Read every exact evidence reference in the context plan before editing.",
  "Confirm the repository baseline matches the brief before creating work.",
  "Re-read current project instructions from the imported contract snapshot.",
]);

const CANONICAL_IMPLEMENT_BOUNDED_ISSUE_CHECKPOINTS = Object.freeze([
  "State the bounded change and its fence before the first edit.",
  "Implement with tests as evidence, then inspect the exact diff.",
  "Record typed progress and evidence against the durable item.",
]);

const CANONICAL_IMPLEMENT_BOUNDED_ISSUE_STOP_ESCALATION = Object.freeze([
  "Stop when a necessary operation is approval-gated by the contract.",
  "Stop when the situation projection reports supersession or conflict.",
  "Stop when required validation cannot run or fails for unrelated reasons.",
]);

const CANONICAL_IMPLEMENT_BOUNDED_ISSUE_HANDOFF_EXPECTATIONS = Object.freeze([
  "summary",
  "nextAction",
  "evidenceRefs",
  "outcome",
  "residualRisks",
]);

function stringListsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function implementBoundedIssueRecipeV1(
  rawSnapshot: ProjectAttachmentSnapshot,
): WorkerBriefRecipeV1 {
  const snapshot = parseProjectAttachmentSnapshot(rawSnapshot);
  const checks = [...snapshot.contract.checks];
  return deepFreeze({
    id: IMPLEMENT_BOUNDED_ISSUE_RECIPE_ID,
    revision: IMPLEMENT_BOUNDED_ISSUE_RECIPE_REVISION,
    applicability: CANONICAL_IMPLEMENT_BOUNDED_ISSUE_APPLICABILITY,
    observations: CANONICAL_IMPLEMENT_BOUNDED_ISSUE_OBSERVATIONS,
    checkpoints: CANONICAL_IMPLEMENT_BOUNDED_ISSUE_CHECKPOINTS,
    requiredValidation: Object.freeze(checks),
    stopEscalation: CANONICAL_IMPLEMENT_BOUNDED_ISSUE_STOP_ESCALATION,
    handoffExpectations: CANONICAL_IMPLEMENT_BOUNDED_ISSUE_HANDOFF_EXPECTATIONS,
  }) as WorkerBriefRecipeV1;
}

function assertCanonicalRecipeBody(
  recipe: WorkerBriefRecipeV1,
  policySnapshot: ProjectAttachmentSnapshot,
): void {
  const applicability = recipe.applicability;
  if (!stringListsEqual(applicability.itemStatuses, CANONICAL_IMPLEMENT_BOUNDED_ISSUE_APPLICABILITY.itemStatuses)
    || !stringListsEqual(applicability.authorityStates, CANONICAL_IMPLEMENT_BOUNDED_ISSUE_APPLICABILITY.authorityStates)
    || !stringListsEqual(applicability.scopeClasses, CANONICAL_IMPLEMENT_BOUNDED_ISSUE_APPLICABILITY.scopeClasses)) {
    throw new RangeError(
      `Recipe ${recipe.id}@${recipe.revision} applicability diverges from the admitted canonical recipe`,
    );
  }
  const requiredValidation = [...policySnapshot.contract.checks];
  type RecipeBodyField =
    | "observations"
    | "checkpoints"
    | "requiredValidation"
    | "stopEscalation"
    | "handoffExpectations";
  const boundBodies: readonly (readonly [RecipeBodyField, readonly string[]])[] = [
    ["observations", CANONICAL_IMPLEMENT_BOUNDED_ISSUE_OBSERVATIONS],
    ["checkpoints", CANONICAL_IMPLEMENT_BOUNDED_ISSUE_CHECKPOINTS],
    ["requiredValidation", requiredValidation],
    ["stopEscalation", CANONICAL_IMPLEMENT_BOUNDED_ISSUE_STOP_ESCALATION],
    ["handoffExpectations", CANONICAL_IMPLEMENT_BOUNDED_ISSUE_HANDOFF_EXPECTATIONS],
  ];
  for (const [field, expected] of boundBodies) {
    if (!stringListsEqual(recipe[field], expected)) {
      throw new RangeError(
        `Recipe ${recipe.id}@${recipe.revision} ${field} diverges from the admitted canonical recipe`,
      );
    }
  }
}

export function selectImplementBoundedIssueRecipeV1(
  item: WorkerBriefItemInputV1,
  control: WorkerBriefControlInputV1,
  scopeClass: ExecutionEnvelope["scopeClass"],
): boolean {
  const admittedItem = admitItem(item);
  const admittedControl = admitControl(control);
  const recipe = implementBoundedIssueRecipeV1Template();
  return recipe.applicability.itemStatuses.includes(admittedItem.status)
    && recipe.applicability.authorityStates.includes(admittedControl.authorityState)
    && recipe.applicability.scopeClasses.includes(scopeClass);
}

function implementBoundedIssueRecipeV1Template(): Pick<
  WorkerBriefRecipeV1,
  "applicability"
> {
  return { applicability: CANONICAL_IMPLEMENT_BOUNDED_ISSUE_APPLICABILITY };
}

const compileInputKeys = [
  "observedAt",
  "workspaceId",
  "projectId",
  "policySnapshot",
  "item",
  "control",
  "dispatch",
  "objectiveOutcome",
  "objectiveNonGoals",
  "startingPoints",
  "situation",
  "contextPlan",
  "executionEnvelope",
  "recipe",
  "continuation",
  "wakeRetryCondition",
] as const;

const freshnessKeys = [
  "expectedSemanticDigest",
  "runId",
  "itemId",
  "claimGeneration",
  "runGeneration",
  "leaseGeneration",
  "contractSnapshotSha256",
  "itemNextAction",
] as const;

const presentationKeys = [
  "version",
  "presentation",
  "title",
  "semanticDigest",
  "grantsAuthority",
  "invariant",
  "sections",
  "invariantFingerprint",
] as const;

const presentationSectionIds = [
  "identity",
  "objective",
  "situation",
  "policy",
  "execution",
  "context",
  "recipe",
  "completion",
] as const;

const presentationSectionKeys = ["id", "title", "lines"] as const;

const itemKeys = ["id", "title", "summary", "nextAction", "status"] as const;
const controlKeys = [
  "authorityState",
  "claimGeneration",
  "holderActorId",
  "expiresAt",
] as const;
const dispatchKeys = [
  "runId",
  "runGeneration",
  "leaseGeneration",
  "runnerProfile",
  "capabilityClass",
] as const;
const situationKeys = [
  "repositoryBaseline",
  "blockers",
  "overlaps",
  "providerAvailability",
  "supersessionState",
  "outstandingDecisions",
] as const;
const baselineKeys = [
  "repository",
  "baseRevision",
  "candidateRevision",
  "changeIdentity",
] as const;
const contextPlanKeys = [
  "canonicalSummary",
  "expansionRefs",
  "maxEvidenceCharacters",
  "sourceFreshness",
  "contextPack",
] as const;
const contextPackKeys = [
  "generatedAt",
  "characterCount",
  "sourceReferences",
] as const;
const handoffKeys = [
  "ref",
  "fromRunId",
  "priorBriefDigest",
  "summary",
  "findings",
  "nextAction",
  "evidenceRefs",
  "emittedAt",
  "replacesClaimGeneration",
] as const;
const recipeKeys = [
  "id",
  "revision",
  "applicability",
  "observations",
  "checkpoints",
  "requiredValidation",
  "stopEscalation",
  "handoffExpectations",
] as const;
const applicabilityKeys = [
  "itemStatuses",
  "authorityStates",
  "scopeClasses",
] as const;

function admitItem(value: unknown): WorkerBriefItemInputV1 {
  const record = exactRecord(value, itemKeys, "Work item input");
  const status = closedValue<WorkerBriefItemInputV1["status"]>(
    record.status,
    new Set(["ready", "active", "blocked"]),
    "Item status",
  );
  return {
    id: slug(record.id, "Item id"),
    title: safeText(record.title, "Item title", MAX_TITLE_LENGTH),
    summary: record.summary === null
      ? null
      : safeText(record.summary, "Item summary", MAX_SUMMARY_LENGTH),
    nextAction: record.nextAction === null
      ? null
      : safeText(record.nextAction, "Item next action", MAX_TEXT_LENGTH),
    status,
  };
}

function admitControl(value: unknown): WorkerBriefControlInputV1 {
  const record = exactRecord(value, controlKeys, "Work item control input");
  const authorityState = closedValue<WorkerBriefControlInputV1["authorityState"]>(
    record.authorityState,
    new Set(["unclaimed", "live", "expiring", "expired", "superseded"]),
    "Authority state",
  );
  return {
    authorityState,
    claimGeneration: record.claimGeneration === null
      ? null
      : positiveInteger(record.claimGeneration, "Claim generation"),
    holderActorId: record.holderActorId === null
      ? null
      : identifier(record.holderActorId, "Holder actor"),
    expiresAt: record.expiresAt === null
      ? null
      : timestamp(record.expiresAt, "Claim expiry"),
  };
}

function admitDispatch(value: unknown): WorkerBriefDispatchInputV1 {
  const record = exactRecord(value, dispatchKeys, "Dispatch input");
  return {
    runId: runId(record.runId),
    runGeneration: positiveInteger(record.runGeneration, "Run generation"),
    leaseGeneration: positiveInteger(record.leaseGeneration, "Lease generation"),
    runnerProfile: slug(record.runnerProfile, "Runner profile"),
    capabilityClass: closedValue<WorkerBriefCapabilityClass>(
      record.capabilityClass,
      new Set(workerBriefCapabilityClasses),
      "Capability class",
    ),
  };
}

function admitSituation(value: unknown): Omit<WorkerBriefSituationSectionV1, "source"> {
  const record = exactRecord(value, situationKeys, "Situation input");
  let repositoryBaseline: WorkerBriefSituationInputV1["repositoryBaseline"] = null;
  if (record.repositoryBaseline !== null) {
    const baseline = exactRecord(record.repositoryBaseline, baselineKeys, "Repository baseline");
    const baseRevision = baseline.baseRevision === null
      ? null
      : revision(baseline.baseRevision, "Base revision");
    const candidateRevision = baseline.candidateRevision === null
      ? null
      : revision(baseline.candidateRevision, "Candidate revision");
    const changeIdentity = baseline.changeIdentity === null
      ? null
      : safePattern(
        baseline.changeIdentity,
        CHANGE_IDENTITY_PATTERN,
        "Durable change identity",
        MAX_REF_LENGTH,
      );
    repositoryBaseline = {
      repository: repositoryIdentifier(baseline.repository),
      baseRevision,
      candidateRevision,
      changeIdentity,
    };
  }
  return {
    repositoryBaseline,
    blockers: safeTextList(record.blockers, "Blocker", MAX_BLOCKERS, MAX_TEXT_LENGTH),
    overlaps: safeTextList(record.overlaps, "Overlap", MAX_OVERLAPS, MAX_TEXT_LENGTH),
    providerAvailability: closedValue<WorkerBriefProviderAvailability>(
      record.providerAvailability,
      new Set(workerBriefProviderAvailability),
      "Provider availability",
    ),
    supersessionState: closedValue<WorkerBriefSupersessionState>(
      record.supersessionState,
      new Set(workerBriefSupersessionStates),
      "Supersession state",
    ),
    outstandingDecisions: safeTextList(
      record.outstandingDecisions,
      "Outstanding decision",
      MAX_OUTSTANDING_DECISIONS,
      MAX_TEXT_LENGTH,
    ),
  };
}

function admitContextPlan(value: unknown): Omit<WorkerBriefContextPlanSectionV1, "source"> {
  const record = exactRecord(value, contextPlanKeys, "Context plan input");
  let contextPackRef: WorkerBriefContextPlanSectionV1["contextPackRef"] = null;
  if (record.contextPack !== null) {
    const pack = exactRecord(record.contextPack, contextPackKeys, "Context pack input");
    const generatedAt = timestamp(pack.generatedAt, "Context pack time");
    const characterCount = boundedInteger(
      pack.characterCount,
      "Context pack character count",
      1,
      MAX_EVIDENCE_CHARACTERS * 4,
    );
    const sourceReferences = refList(pack.sourceReferences, "Context pack reference", 64);
    contextPackRef = {
      digest: sha256(stableJson({ generatedAt, characterCount, sourceReferences })),
      generatedAt,
      characterCount,
    };
  }
  return {
    canonicalSummary: safeText(record.canonicalSummary, "Canonical summary", MAX_SUMMARY_LENGTH),
    expansionRefs: refList(record.expansionRefs, "Expansion reference", MAX_EXPANSION_REFS),
    maxEvidenceCharacters: boundedInteger(
      record.maxEvidenceCharacters,
      "Maximum evidence characters",
      MIN_EVIDENCE_CHARACTERS,
      MAX_EVIDENCE_CHARACTERS,
    ),
    sourceFreshness: closedValue<WorkerBriefContextPlanInputV1["sourceFreshness"]>(
      record.sourceFreshness,
      new Set(["exact_revision_required", "fresh_read_required", "advisory"]),
      "Source freshness",
    ),
    contextPackRef,
  };
}

function admitHandoffRecordAfterChecks(
  rawInput: Record<string, unknown>,
  control: WorkerBriefControlInputV1,
): WorkerBriefHandoffRecordV1 {
  if (control.claimGeneration === null) {
    throw new RangeError(
      "A continuation handoff requires the current claim generation",
    );
  }
  const record = exactRecord(rawInput.continuation, handoffKeys, "Handoff record input");
  const replaces = positiveInteger(record.replacesClaimGeneration, "Replaced claim generation");
  if (replaces >= control.claimGeneration) {
    throw new RangeError(
      "A continuation handoff must close a strictly earlier claim generation",
    );
  }
  return {
    ref: identifier(record.ref, "Handoff reference"),
    fromRunId: runId(record.fromRunId),
    priorBriefDigest: record.priorBriefDigest === null
      ? null
      : hashValue(record.priorBriefDigest, "Prior brief digest"),
    summary: safeText(record.summary, "Handoff summary", 2_000),
    findings: safeTextList(record.findings, "Handoff finding", MAX_FINDINGS, MAX_TEXT_LENGTH),
    nextAction: safeText(record.nextAction, "Handoff next action", MAX_TEXT_LENGTH),
    evidenceRefs: refList(record.evidenceRefs, "Handoff evidence reference", MAX_HANDOFF_EVIDENCE_REFS),
    emittedAt: timestamp(record.emittedAt, "Handoff emission time"),
    replacesClaimGeneration: replaces,
  };
}

function admitRecipe(value: unknown): WorkerBriefRecipeV1 {
  const record = exactRecord(value, recipeKeys, "Recipe input");
  if (record.id !== IMPLEMENT_BOUNDED_ISSUE_RECIPE_ID) {
    throw new RangeError(`Unsupported worker brief recipe ${String(record.id)}`);
  }
  if (record.revision !== IMPLEMENT_BOUNDED_ISSUE_RECIPE_REVISION) {
    throw new RangeError("Unsupported worker brief recipe revision");
  }
  const applicability = exactRecord(record.applicability, applicabilityKeys, "Recipe applicability");
  return deepFreeze({
    id: IMPLEMENT_BOUNDED_ISSUE_RECIPE_ID,
    revision: IMPLEMENT_BOUNDED_ISSUE_RECIPE_REVISION,
    applicability: Object.freeze({
      itemStatuses: Object.freeze(closedList(applicability.itemStatuses, new Set(["ready", "active", "blocked"]), "Recipe item status")),
      authorityStates: Object.freeze(closedList(applicability.authorityStates, new Set(["unclaimed", "live", "expiring", "expired", "superseded"]), "Recipe authority state")),
      scopeClasses: Object.freeze(closedList(applicability.scopeClasses, new Set(["atomic", "segmented", "exploratory", "long-running", "portfolio", "review"]), "Recipe scope class")),
    }),
    observations: Object.freeze(safeTextList(record.observations, "Recipe observation", 12, MAX_TEXT_LENGTH)),
    checkpoints: Object.freeze(safeTextList(record.checkpoints, "Recipe checkpoint", 12, MAX_TEXT_LENGTH)),
    requiredValidation: Object.freeze(safeTextList(record.requiredValidation, "Recipe validation step", 50, 500)),
    stopEscalation: Object.freeze(safeTextList(record.stopEscalation, "Recipe stop condition", 12, MAX_TEXT_LENGTH)),
    handoffExpectations: Object.freeze(safeTextList(record.handoffExpectations, "Recipe handoff expectation", 12, 120)),
  }) as WorkerBriefRecipeV1;
}

export function parseWorkerBriefV1(rawJson: unknown): WorkerBriefV1 {
  if (typeof rawJson !== "string") throw new TypeError("Worker brief JSON must be text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch {
    throw new TypeError("Worker brief JSON is not valid JSON");
  }
  return admitCompiledBrief(parsed);
}

function admitCompiledBrief(value: unknown): WorkerBriefV1 {
  if (!isPlainObject(value)) throw new TypeError("Worker brief must be an object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Worker brief contains a symbol field");
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`Worker brief field ${key} must be an enumerable data property`);
    }
  }
  if (descriptors.version?.value !== WORKER_BRIEF_SCHEMA_V1) {
    throw new TypeError("Worker brief version is unsupported");
  }
  requirePlainDataTree(value, "Worker brief", new WeakSet());
  const declaredDigest = hashValue(descriptors.semanticDigest?.value, "Worker brief semantic digest");
  const withoutDigest = { ...value } as Record<string, unknown>;
  delete withoutDigest.semanticDigest;
  const recomputed = sha256(stableJson(withoutDigest));
  if (recomputed !== declaredDigest) {
    throw new TypeError(
      "Worker brief semantic digest does not match its content; failing closed",
    );
  }
  return value as unknown as WorkerBriefV1;
}

function requirePlainDataTree(
  value: unknown,
  path: string,
  pathStack: WeakSet<object>,
): void {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite number`);
    }
    return;
  }
  if (!isPlainObject(value) && !Array.isArray(value)) {
    throw new TypeError(`${path} must be plain data`);
  }
  const objectValue = value as object;
  if (pathStack.has(objectValue)) throw new TypeError(`${path} contains a cycle`);
  pathStack.add(objectValue);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (Array.isArray(value) && !/^\d+$/u.test(key)) {
      throw new TypeError(`${path} array contains unknown field ${key}`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path} field ${key} must be an enumerable data property`);
    }
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) throw new TypeError(`${path} entry ${index} is missing`);
      requirePlainDataTree(descriptor.value, `${path}[${index}]`, pathStack);
    }
  } else {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      requirePlainDataTree(descriptor.value, `${path}.${key}`, pathStack);
    }
  }
  pathStack.delete(objectValue);
}

function claimCoordinate(source: WorkerBriefClaimSourceV1): string {
  return `${source.kind}:${source.coordinates}`;
}

function baselineLine(
  baseline: WorkerBriefSituationSectionV1["repositoryBaseline"],
): string {
  if (baseline === null) return "repository baseline: none recorded";
  return `repository baseline: ${baseline.repository} base ${baseline.baseRevision ?? "unknown"} candidate ${baseline.candidateRevision ?? "none"}`;
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "none declared" : values.join(", ");
}

function exactRecord<T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string,
): Record<T[number], unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null) as Record<T[number], unknown>;
  for (const key of Object.keys(descriptors)) {
    if (!(keys as readonly string[]).includes(key)) {
      throw new TypeError(`${label} contains unknown field ${key}`);
    }
  }
  for (const key of keys as readonly string[]) {
    const descriptor = descriptors[key];
    if (!descriptor) throw new TypeError(`${label} is missing field ${key}`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} field ${key} must be an enumerable data property`);
    }
    output[key as T[number]] = descriptor.value;
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function dataList(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an array`);
  }
  if (value.length > maximum) {
    throw new TypeError(`${label} may contain at most ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) throw new TypeError(`${label} must be dense`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} entry ${index} must be an enumerable data property`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const flattened = value.replace(NEWLINE_RUN_PATTERN, NEWLINE_TOKEN);
  const normalized = flattened.trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  if (normalized.length > maximum) {
    throw new TypeError(`${label} may contain at most ${maximum} characters`);
  }
  if (UNSAFE_TEXT_PATTERN.test(normalized)) {
    throw new TypeError(`${label} contains unsafe control characters`);
  }
  if (CREDENTIAL_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must not contain credential-shaped text`);
  }
  return normalized;
}

function safeTextList(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  return dataList(value, label, maximumEntries).map((entry, index) =>
    safeText(entry, `${label} entry ${index + 1}`, maximumLength)
  );
}

function refList(value: unknown, label: string, maximumEntries: number): string[] {
  return dataList(value, label, maximumEntries).map((entry, index) =>
    ref(entry, `${label} ${index + 1}`)
  );
}

function closedList<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T[] {
  return dataList(value, label, 32).map((entry) => closedValue<T>(entry, allowed, label));
}

function closedValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`${label} is unsupported`);
  }
  return value as T;
}

function identifier(value: unknown, label: string): string {
  const normalized = safeText(value, label, MAX_IDENTIFIER_LENGTH);
  if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function slug(value: unknown, label: string): string {
  const normalized = safeText(value, label, 80);
  if (!/^[a-z0-9][a-z0-9-_]*$/u.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase slug`);
  }
  return normalized;
}

function ref(value: unknown, label: string): string {
  const normalized = safeText(value, label, MAX_REF_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@ -]*$/u.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function runId(value: unknown, label = "Run id"): string {
  const normalized = safeText(value, label, MAX_RUN_ID_LENGTH);
  return normalized;
}

function repositoryIdentifier(value: unknown): string {
  const normalized = safeText(value, "Repository identifier", 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(normalized)) {
    throw new TypeError("Repository identifier must be owner/repository");
  }
  return normalized;
}

function revision(value: unknown, label: string): string {
  const normalized = safeText(value, label, 40);
  if (!REVISION_PATTERN.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function hashValue(value: unknown, label: string): string {
  const normalized = safeText(value, label, 71);
  if (!HASH_PATTERN.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function safePattern(
  value: unknown,
  pattern: RegExp,
  label: string,
  maximum: number,
): string {
  const normalized = safeText(value, label, maximum);
  if (!pattern.test(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function timestamp(value: unknown, label: string): string {
  const normalized = safeText(value, label, 40);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null) return null;
  return positiveInteger(value, "Claim generation");
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function clipProse(value: string, maximum: number): string {
  const flattened = value.replace(NEWLINE_RUN_PATTERN, NEWLINE_TOKEN);
  if (flattened.length <= maximum) return flattened;
  return `${safeText(flattened.slice(0, maximum), "Clipped policy prose", maximum)}…`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return value;
}
