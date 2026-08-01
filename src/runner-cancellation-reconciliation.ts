import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  createResourceSettlementReceipt,
  evaluateResourceGenerationAdvance,
  parseResourceSettlementReceipt,
  type ResourceGenerationAdvanceDecision,
  type ResourceSettlementReceipt,
} from "./resource-settlement.js";
import type { RunnerCancellationSettlementResultV1 } from "./runner-cancellation-settlement.js";
import {
  parseRunnerExternalReferenceV1,
  type RunnerCancellationObservationV1,
  type RunnerExternalReferenceV1,
} from "./runner-adapter-v1.js";

export const RUNNER_CANCELLATION_RECONCILIATION_V1 = 1 as const;

export const runnerCancellationReconciliationKinds = [
  "provider_settled",
  "provider_still_running",
  "provider_unknown",
  "publication_fence",
] as const;

export type RunnerCancellationReconciliationKindV1 =
  typeof runnerCancellationReconciliationKinds[number];

export type RunnerCancellationReconciliationOutcomeV1 =
  | "released_remote_settlement"
  | "released_publication_fence"
  | "still_reconciling";

export interface RunnerCancellationReconciliationEvidenceV1 {
  version: typeof RUNNER_CANCELLATION_RECONCILIATION_V1;
  reconciliationId: string;
  originalResultFingerprint: string;
  kind: RunnerCancellationReconciliationKindV1;
  commandId: string;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  observedAt: string;
  reference: RunnerExternalReferenceV1;
  publicationFenceFingerprint: string | null;
}

export interface RunnerCancellationReconciliationResultV1 {
  version: typeof RUNNER_CANCELLATION_RECONCILIATION_V1;
  reconciliationId: string;
  originalResultFingerprint: string;
  kind: RunnerCancellationReconciliationKindV1;
  outcome: RunnerCancellationReconciliationOutcomeV1;
  commandId: string;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  observedAt: string;
  evidenceReference: RunnerExternalReferenceV1;
  publicationFenceFingerprint: string | null;
  settlement: ResourceSettlementReceipt;
  generationAdvance: ResourceGenerationAdvanceDecision;
  containsPrivateContent: false;
  containsCredentials: false;
  resultFingerprint: string;
}

interface OriginalIdentity {
  workspace: string;
  project: string;
  commandId: string;
  commandFingerprint: string;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  requestedAt: string;
  observedAt: string;
}

const resultPolicyVersion = "runner-cancellation-reconciliation-v1";
const originalPolicyVersion = "runner-cancellation-settlement-v2";
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const realisticCredentialPattern = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

const originalResultKeys = [
  "version",
  "workspace",
  "project",
  "commandId",
  "commandFingerprint",
  "adapterId",
  "adapterVersion",
  "profileId",
  "runId",
  "runGeneration",
  "leaseGeneration",
  "requestedAt",
  "observedAt",
  "outcome",
  "cancellation",
  "settlement",
  "generationAdvance",
  "containsPrivateContent",
  "containsCredentials",
  "resultFingerprint",
] as const;

const cancellationKeys = [
  "version",
  "commandId",
  "adapterId",
  "adapterVersion",
  "profileId",
  "runId",
  "runGeneration",
  "leaseGeneration",
  "observedAt",
  "requestAccepted",
  "deliveryKnown",
  "remoteSettlementKnown",
  "reference",
] as const;

const evidenceKeys = [
  "version",
  "reconciliationId",
  "originalResultFingerprint",
  "kind",
  "commandId",
  "adapterId",
  "adapterVersion",
  "profileId",
  "runId",
  "runGeneration",
  "leaseGeneration",
  "observedAt",
  "reference",
  "publicationFenceFingerprint",
] as const;

const generationAdvanceKeys = [
  "allowed",
  "currentGeneration",
  "requestedGeneration",
  "reason",
  "receiptFingerprint",
] as const;

export function reconcileRunnerCancellationSettlementV1(
  originalInput: unknown,
  evidenceInput: unknown,
): RunnerCancellationReconciliationResultV1 {
  const original = parseOriginalResult(originalInput);
  const evidence = parseEvidence(evidenceInput, original);

  const releasedByProvider = evidence.kind === "provider_settled";
  const releasedByFence = evidence.kind === "publication_fence";
  const released = releasedByProvider || releasedByFence;
  const outcome: RunnerCancellationReconciliationOutcomeV1 = releasedByProvider
    ? "released_remote_settlement"
    : releasedByFence
      ? "released_publication_fence"
      : "still_reconciling";

  const settlement = createResourceSettlementReceipt({
    workspace: original.workspace,
    project: original.project,
    resourceId: `run:${original.runId}`,
    resourceKind: "runner_adapter",
    generation: original.runGeneration,
    operationRef: evidence.reconciliationId,
    policyVersion: resultPolicyVersion,
    failureMode: "continue_through_error",
    admissionState: "closed",
    disposition: released ? "retired" : "reconciliation_hold",
    openedAt: original.requestedAt,
    closingStartedAt: original.requestedAt,
    terminalAt: evidence.observedAt,
    observedAt: evidence.observedAt,
    owners: [{
      id: `${original.adapterId}:${original.profileId}`,
      kind: "worker",
      generation: original.runGeneration,
      attempted: true,
      state: releasedByFence
        ? "publication_fenced"
        : releasedByProvider
          ? "settled_failure"
          : "reconciliation_required",
      attemptedAt: original.requestedAt,
      settledAt: evidence.observedAt,
      failureClass: releasedByProvider ? "cancelled" : "unknown_outcome",
      reconciliationRequired: !released,
      canPublishLate: !releasedByProvider,
      outputFingerprint: evidence.reference.digest,
      publicationFenceFingerprint: releasedByFence
        ? evidence.publicationFenceFingerprint
        : null,
    }],
  });

  const generationAdvance = evaluateResourceGenerationAdvance(
    settlement,
    original.runGeneration + 1,
  );
  if (generationAdvance.allowed !== released) {
    throw new Error(
      "Runner cancellation reconciliation produced inconsistent generation authority",
    );
  }

  const withoutFingerprint = {
    version: RUNNER_CANCELLATION_RECONCILIATION_V1,
    reconciliationId: evidence.reconciliationId,
    originalResultFingerprint: original.resultFingerprint,
    kind: evidence.kind,
    outcome,
    commandId: original.commandId,
    adapterId: original.adapterId,
    adapterVersion: original.adapterVersion,
    profileId: original.profileId,
    runId: original.runId,
    runGeneration: original.runGeneration,
    leaseGeneration: original.leaseGeneration,
    observedAt: evidence.observedAt,
    evidenceReference: evidence.reference,
    publicationFenceFingerprint: evidence.publicationFenceFingerprint,
    settlement,
    generationAdvance,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };

  return deepFreeze({
    ...withoutFingerprint,
    resultFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

function parseOriginalResult(
  value: unknown,
): RunnerCancellationSettlementResultV1 {
  const safe = copyJsonData(value, "Runner cancellation settlement result");
  const input = exactRecord(
    safe,
    "Runner cancellation settlement result",
    originalResultKeys,
  );
  if (input.version !== 1) {
    throw new RangeError("Runner cancellation settlement result version is unsupported");
  }
  if (input.containsPrivateContent !== false || input.containsCredentials !== false) {
    throw new RangeError(
      "Runner cancellation settlement result must exclude private content and credentials",
    );
  }

  const identity: OriginalIdentity = {
    workspace: boundedSlug(input.workspace, "Runner cancellation workspace", 80),
    project: boundedSlug(input.project, "Runner cancellation project", 80),
    commandId: boundedIdentifier(input.commandId, "Runner cancellation command ID", 160),
    commandFingerprint: digest(
      input.commandFingerprint,
      "Runner cancellation command fingerprint",
    ),
    adapterId: boundedIdentifier(input.adapterId, "Runner cancellation adapter ID", 80),
    adapterVersion: boundedText(
      input.adapterVersion,
      "Runner cancellation adapter version",
      160,
    ),
    profileId: boundedIdentifier(input.profileId, "Runner cancellation profile ID", 79),
    runId: boundedIdentifier(input.runId, "Runner cancellation run ID", 156),
    runGeneration: positiveInteger(
      input.runGeneration,
      "Runner cancellation run generation",
    ),
    leaseGeneration: positiveInteger(
      input.leaseGeneration,
      "Runner cancellation lease generation",
    ),
    requestedAt: canonicalTimestamp(
      input.requestedAt,
      "Runner cancellation request time",
    ),
    observedAt: canonicalTimestamp(
      input.observedAt,
      "Runner cancellation settlement observation time",
    ),
  };
  if (identity.observedAt < identity.requestedAt) {
    throw new RangeError(
      "Runner cancellation settlement observation predates its request",
    );
  }

  const outcome = closedValue(
    input.outcome,
    ["cancellation_observed", "adapter_failure"] as const,
    "Runner cancellation settlement outcome",
  );
  const cancellation = outcome === "cancellation_observed"
    ? parseOriginalCancellation(input.cancellation, identity)
    : null;
  if (outcome === "adapter_failure" && input.cancellation !== null) {
    throw new RangeError(
      "Runner cancellation adapter failure cannot retain cancellation evidence",
    );
  }

  const settlement = parseResourceSettlementReceipt(input.settlement);
  validateOriginalSettlement(settlement, identity, cancellation);

  const expectedAdvance = evaluateResourceGenerationAdvance(
    settlement,
    identity.runGeneration + 1,
  );
  const generationAdvance = parseGenerationAdvance(input.generationAdvance);
  if (!sameGenerationAdvance(generationAdvance, expectedAdvance)) {
    throw new RangeError(
      "Runner cancellation generation-advance decision does not match settlement",
    );
  }

  const resultFingerprint = digest(
    input.resultFingerprint,
    "Runner cancellation settlement result fingerprint",
  );
  const withoutFingerprint = {
    version: 1 as const,
    ...identity,
    outcome,
    cancellation,
    settlement,
    generationAdvance,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
  if (fingerprintCanonicalRequest(withoutFingerprint) !== resultFingerprint) {
    throw new RangeError(
      "Runner cancellation settlement result fingerprint does not match content",
    );
  }
  return deepFreeze({ ...withoutFingerprint, resultFingerprint });
}

function parseOriginalCancellation(
  value: unknown,
  identity: OriginalIdentity,
): RunnerCancellationObservationV1 {
  const input = exactRecord(
    value,
    "Runner cancellation observation",
    cancellationKeys,
  );
  if (input.version !== 1) {
    throw new RangeError("Runner cancellation observation version is unsupported");
  }
  const reference = input.reference === null
    ? null
    : parseRunnerExternalReferenceV1(input.reference);
  const observation: RunnerCancellationObservationV1 = {
    version: 1,
    commandId: boundedIdentifier(
      input.commandId,
      "Runner cancellation observation command ID",
      160,
    ),
    adapterId: boundedIdentifier(
      input.adapterId,
      "Runner cancellation observation adapter ID",
      80,
    ),
    adapterVersion: boundedText(
      input.adapterVersion,
      "Runner cancellation observation adapter version",
      160,
    ),
    profileId: boundedIdentifier(
      input.profileId,
      "Runner cancellation observation profile ID",
      79,
    ),
    runId: boundedIdentifier(
      input.runId,
      "Runner cancellation observation run ID",
      156,
    ),
    runGeneration: positiveInteger(
      input.runGeneration,
      "Runner cancellation observation run generation",
    ),
    leaseGeneration: positiveInteger(
      input.leaseGeneration,
      "Runner cancellation observation lease generation",
    ),
    observedAt: canonicalTimestamp(
      input.observedAt,
      "Runner cancellation observation time",
    ),
    requestAccepted: booleanValue(
      input.requestAccepted,
      "Runner cancellation request-accepted flag",
    ),
    deliveryKnown: booleanValue(
      input.deliveryKnown,
      "Runner cancellation delivery-known flag",
    ),
    remoteSettlementKnown: false,
    reference,
  };
  if (input.remoteSettlementKnown !== false) {
    throw new RangeError(
      "Runner cancellation observation cannot claim remote settlement in v1",
    );
  }
  if (observation.deliveryKnown && !observation.requestAccepted) {
    throw new RangeError(
      "Runner cancellation delivery cannot be known when its request was rejected",
    );
  }
  if (
    observation.commandId !== identity.commandId
    || observation.adapterId !== identity.adapterId
    || observation.adapterVersion !== identity.adapterVersion
    || observation.profileId !== identity.profileId
    || observation.runId !== identity.runId
    || observation.runGeneration !== identity.runGeneration
    || observation.leaseGeneration !== identity.leaseGeneration
  ) {
    throw new RangeError(
      "Runner cancellation observation does not match settlement result",
    );
  }
  if (
    observation.observedAt < identity.requestedAt
    || observation.observedAt > identity.observedAt
  ) {
    throw new RangeError(
      "Runner cancellation observation chronology does not match settlement result",
    );
  }
  if (reference !== null) {
    if (reference.adapterId !== identity.adapterId) {
      throw new RangeError(
        "Runner cancellation observation reference does not match adapter",
      );
    }
    if (
      reference.generation !== null
      && reference.generation !== identity.runGeneration
    ) {
      throw new RangeError(
        "Runner cancellation observation reference does not match run generation",
      );
    }
    if (reference.createdAt > observation.observedAt) {
      throw new RangeError(
        "Runner cancellation observation reference postdates its observation",
      );
    }
  }
  return deepFreeze(observation);
}

function validateOriginalSettlement(
  settlement: ResourceSettlementReceipt,
  identity: OriginalIdentity,
  cancellation: RunnerCancellationObservationV1 | null,
): void {
  if (
    settlement.workspace !== identity.workspace
    || settlement.project !== identity.project
    || settlement.resourceId !== `run:${identity.runId}`
    || settlement.resourceKind !== "runner_adapter"
    || settlement.generation !== identity.runGeneration
    || settlement.operationRef !== identity.commandFingerprint
    || settlement.policyVersion !== originalPolicyVersion
    || settlement.failureMode !== "continue_through_error"
    || settlement.admissionState !== "closed"
    || settlement.disposition !== "reconciliation_hold"
    || settlement.openedAt !== identity.requestedAt
    || settlement.closingStartedAt !== identity.requestedAt
    || settlement.terminalAt !== identity.observedAt
    || settlement.observedAt !== identity.observedAt
    || settlement.phase !== "settled_failure"
  ) {
    throw new RangeError(
      "Runner cancellation settlement receipt does not match result identity",
    );
  }
  if (settlement.owners.length !== 1) {
    throw new RangeError(
      "Runner cancellation settlement must contain one adapter owner",
    );
  }
  const owner = settlement.owners[0]!;
  const expectedOutput = cancellation?.reference?.digest ?? null;
  if (
    owner.id !== `${identity.adapterId}:${identity.profileId}`
    || owner.kind !== "worker"
    || owner.generation !== identity.runGeneration
    || owner.attempted !== true
    || owner.attemptedAt !== identity.requestedAt
    || owner.settledAt !== identity.observedAt
    || owner.state !== "reconciliation_required"
    || owner.failureClass !== "unknown_outcome"
    || owner.reconciliationRequired !== true
    || owner.canPublishLate !== true
    || owner.outputFingerprint !== expectedOutput
    || owner.publicationFenceFingerprint !== null
  ) {
    throw new RangeError(
      "Runner cancellation settlement owner does not require exact reconciliation",
    );
  }
}

function parseEvidence(
  value: unknown,
  original: RunnerCancellationSettlementResultV1,
): RunnerCancellationReconciliationEvidenceV1 {
  const safe = copyJsonData(value, "Runner cancellation reconciliation evidence");
  const input = exactRecord(
    safe,
    "Runner cancellation reconciliation evidence",
    evidenceKeys,
  );
  if (input.version !== RUNNER_CANCELLATION_RECONCILIATION_V1) {
    throw new RangeError(
      `Runner cancellation reconciliation evidence version must be ${RUNNER_CANCELLATION_RECONCILIATION_V1}`,
    );
  }
  const kind = closedValue(
    input.kind,
    runnerCancellationReconciliationKinds,
    "Runner cancellation reconciliation kind",
  );
  const reference = parseRunnerExternalReferenceV1(input.reference);
  const evidence: RunnerCancellationReconciliationEvidenceV1 = {
    version: RUNNER_CANCELLATION_RECONCILIATION_V1,
    reconciliationId: boundedIdentifier(
      input.reconciliationId,
      "Runner cancellation reconciliation ID",
      160,
    ),
    originalResultFingerprint: digest(
      input.originalResultFingerprint,
      "Runner cancellation original result fingerprint",
    ),
    kind,
    commandId: boundedIdentifier(input.commandId, "Runner cancellation command ID", 160),
    adapterId: boundedIdentifier(input.adapterId, "Runner cancellation adapter ID", 80),
    adapterVersion: boundedText(
      input.adapterVersion,
      "Runner cancellation adapter version",
      160,
    ),
    profileId: boundedIdentifier(input.profileId, "Runner cancellation profile ID", 79),
    runId: boundedIdentifier(input.runId, "Runner cancellation run ID", 156),
    runGeneration: positiveInteger(
      input.runGeneration,
      "Runner cancellation run generation",
    ),
    leaseGeneration: positiveInteger(
      input.leaseGeneration,
      "Runner cancellation lease generation",
    ),
    observedAt: canonicalTimestamp(
      input.observedAt,
      "Runner cancellation reconciliation observation time",
    ),
    reference,
    publicationFenceFingerprint: input.publicationFenceFingerprint === null
      ? null
      : digest(
        input.publicationFenceFingerprint,
        "Runner cancellation publication fence fingerprint",
      ),
  };

  if (
    evidence.originalResultFingerprint !== original.resultFingerprint
    || evidence.commandId !== original.commandId
    || evidence.adapterId !== original.adapterId
    || evidence.adapterVersion !== original.adapterVersion
    || evidence.profileId !== original.profileId
    || evidence.runId !== original.runId
    || evidence.runGeneration !== original.runGeneration
    || evidence.leaseGeneration !== original.leaseGeneration
  ) {
    throw new RangeError(
      "Runner cancellation reconciliation evidence does not match original result",
    );
  }
  if (evidence.observedAt < original.observedAt) {
    throw new RangeError(
      "Runner cancellation reconciliation observation predates original settlement",
    );
  }
  const referenceDigest = reference.digest;
  if (
    reference.kind !== "provider_receipt"
    || reference.adapterId !== original.adapterId
    || referenceDigest === null
    || reference.generation !== original.runGeneration
    || reference.uri !== null
    || reference.accessClass !== "project"
    || reference.createdAt < original.observedAt
    || reference.createdAt > evidence.observedAt
  ) {
    throw new RangeError(
      "Runner cancellation reconciliation reference is not attributable to the run",
    );
  }
  const expectedExternalId = evidenceExternalId(
    kind,
    original.runId,
    original.runGeneration,
  );
  if (reference.externalId !== expectedExternalId) {
    throw new RangeError(
      "Runner cancellation reconciliation reference does not match evidence kind",
    );
  }
  if (kind === "publication_fence") {
    if (
      evidence.publicationFenceFingerprint === null
      || evidence.publicationFenceFingerprint !== referenceDigest
    ) {
      throw new RangeError(
        "Runner cancellation publication fence is not bound to its receipt",
      );
    }
  } else if (evidence.publicationFenceFingerprint !== null) {
    throw new RangeError(
      "Runner cancellation provider evidence cannot contain a publication fence",
    );
  }
  return deepFreeze(evidence);
}

function evidenceExternalId(
  kind: RunnerCancellationReconciliationKindV1,
  runId: string,
  generation: number,
): string {
  const prefix = kind === "provider_settled"
    ? "remote-settlement"
    : kind === "provider_still_running"
      ? "runtime-still-running"
      : kind === "provider_unknown"
        ? "runtime-unknown"
        : "publication-fence";
  return `${prefix}:${runId}:g${generation}`;
}

function parseGenerationAdvance(value: unknown): ResourceGenerationAdvanceDecision {
  const input = exactRecord(
    value,
    "Runner cancellation generation-advance decision",
    generationAdvanceKeys,
  );
  return deepFreeze({
    allowed: booleanValue(input.allowed, "Generation-advance allowed flag"),
    currentGeneration: positiveInteger(
      input.currentGeneration,
      "Generation-advance current generation",
    ),
    requestedGeneration: positiveInteger(
      input.requestedGeneration,
      "Generation-advance requested generation",
    ),
    reason: closedValue(
      input.reason,
      [
        "next_generation_allowed",
        "generation_must_increase_by_one",
        "settlement_not_terminal",
        "reconciliation_still_required",
      ] as const,
      "Generation-advance reason",
    ),
    receiptFingerprint: digest(
      input.receiptFingerprint,
      "Generation-advance receipt fingerprint",
    ),
  });
}

function sameGenerationAdvance(
  left: ResourceGenerationAdvanceDecision,
  right: ResourceGenerationAdvanceDecision,
): boolean {
  return left.allowed === right.allowed
    && left.currentGeneration === right.currentGeneration
    && left.requestedGeneration === right.requestedGeneration
    && left.reason === right.reason
    && left.receiptFingerprint === right.receiptFingerprint;
}

function copyJsonData(
  value: unknown,
  label: string,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): unknown {
  budget.nodes += 1;
  if (depth > 16 || budget.nodes > 10_000) {
    throw new RangeError(`${label} exceeds the bounded JSON data limit`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1_024) {
      throw new RangeError(`${label} contains an invalid array`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    const expected = new Set<string>([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    if (
      keys.some((key) => typeof key !== "string" || !expected.has(key))
      || keys.length !== expected.size
    ) {
      throw new RangeError(`${label} contains a sparse or decorated array`);
    }
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.enumerable !== true
        || !("value" in descriptor)
        || descriptor.get !== undefined
        || descriptor.set !== undefined
      ) {
        throw new RangeError(`${label} contains a non-data array entry`);
      }
      return copyJsonData(descriptor.value, label, depth + 1, budget);
    });
  }
  if (!value || typeof value !== "object") {
    throw new RangeError(`${label} contains a non-JSON value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} contains a non-plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || keys.some((key) => typeof key !== "string")) {
    throw new RangeError(`${label} contains invalid object fields`);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) {
      throw new RangeError(`${label} must contain only enumerable data properties`);
    }
    output[key] = copyJsonData(descriptor.value, label, depth + 1, budget);
  }
  return output;
}

function exactRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a plain data object`);
  }
  const keys = Object.keys(value);
  const allowed = new Set(allowedKeys);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new RangeError(`${label} has unknown field ${key}`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new RangeError(`${label} is missing field ${key}`);
    }
  }
  return value as Record<string, unknown>;
}

function boundedIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || !identifierPattern.test(value)
    || unsafeTextPattern.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedSlug(value: unknown, label: string, maximum: number): string {
  const parsed = boundedIdentifier(value, label, maximum);
  if (parsed !== parsed.toLowerCase() || !/^[a-z0-9][a-z0-9_-]*$/u.test(parsed)) {
    throw new RangeError(`${label} must be a bounded lowercase slug`);
  }
  return parsed;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maximum
    || value !== value.trim()
    || unsafeTextPattern.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new RangeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new RangeError(`${label} must be boolean`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new RangeError(`${label} must be a SHA-256 identifier`);
  }
  return value;
}

function closedValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
