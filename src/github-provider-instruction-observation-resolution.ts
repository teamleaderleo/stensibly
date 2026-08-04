import type {
  GitHubProviderContextReconciliationProposalV1,
} from "./github-provider-context-reconciliation.js";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
  type GitHubProviderInstructionObservationRequestV1,
} from "./github-provider-instruction-observation-request.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1 as BASE_SCHEMA_VERSION,
  resolveGitHubProviderInstructionObservationV1 as resolveBase,
  type GitHubProviderInstructionObservationInputV1 as BaseObservationInput,
  type GitHubProviderInstructionObservationResolutionInputV1 as BaseResolutionInput,
  type GitHubProviderInstructionObservationResolutionNextAction as BaseNextAction,
  type GitHubProviderInstructionObservationResolutionOutcome as BaseOutcome,
  type GitHubProviderInstructionObservationResolutionV1 as BaseResolution,
} from "./github-provider-instruction-observation-resolution-base.js";

export const GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1 =
  BASE_SCHEMA_VERSION;

export type GitHubProviderInstructionObservationInputV1 = BaseObservationInput;
export type GitHubProviderInstructionObservationResolutionOutcome = BaseOutcome;
export type GitHubProviderInstructionObservationResolutionNextAction =
  BaseNextAction;
export interface GitHubProviderInstructionObservationResolutionInputV1
  extends BaseResolutionInput {
  proposal: GitHubProviderContextReconciliationProposalV1;
}
export interface GitHubProviderInstructionObservationResolutionV1
  extends BaseResolution {
  requestFingerprint: string;
}

interface ChronologyEvidence {
  attachmentAcceptedAt: string;
  providerObservedAt: string;
  instructionObservedAt: string;
}

type DataRecord = Record<PropertyKey, unknown>;

const requestOriginDiagnostic =
  "GitHub provider instruction observation request does not match reconciliation proposal";
const inputKeys = [
  "schemaVersion",
  "proposal",
  "request",
  "attachment",
  "observation",
] as const;

/**
 * Resolves one proposal-backed request from detached evidence. Origin proof is
 * stateless: every call rebuilds the canonical request from the exact supplied
 * proposal and workspace before any attachment or observation is inspected.
 */
export function resolveGitHubProviderInstructionObservationV1(
  value: unknown,
): GitHubProviderInstructionObservationResolutionV1 {
  const input = snapshotResolutionInput(value);
  const proposal = snapshotDataRecord(
    input.proposal,
    "GitHub provider context reconciliation proposal",
  );
  const request = snapshotDataRecord(
    input.request,
    "GitHub provider instruction observation request",
  );
  const canonical = canonicalRequest(proposal, request);

  if (!sameCanonicalRequest(request, canonical)) {
    throw new RangeError(requestOriginDiagnostic);
  }
  if (actionableRequestChronologyIsInvalid(request)) {
    throw new RangeError(
      "GitHub provider instruction observation request chronology is invalid",
    );
  }

  const actionable =
    canonical.outcome === "ready_for_repository_instruction_observation";
  const attachment = actionable
    ? snapshotDataRecord(input.attachment, "Accepted project attachment record")
    : input.attachment;
  const observation = actionable
    ? snapshotDataRecord(
      input.observation,
      "GitHub repository instruction observation",
    )
    : input.observation;

  const base = resolveBase({
    schemaVersion: input.schemaVersion,
    request: canonical,
    attachment,
    observation,
  });
  const requestFingerprint = canonical.requestFingerprint;

  const chronology = actionable
    ? chronologyEvidence(attachment as DataRecord, canonical, observation as DataRecord)
    : null;
  if (
    chronology !== null
    && attachmentChronologyIsInvalid(chronology)
    && (
      base.outcome === "ready_for_context_acceptance_binding"
      || base.outcome === "attachment_source_conflict"
    )
  ) {
    return finalize({
      ...withoutResolutionFingerprint(base),
      requestFingerprint,
      instructionObservedAt: chronology.instructionObservedAt,
      instructionSet: null,
      outcome: "observation_chronology_conflict",
      nextAction: "reobserve_repository_instructions",
    });
  }

  return finalize({
    ...withoutResolutionFingerprint(base),
    requestFingerprint,
  });
}

function canonicalRequest(
  proposal: DataRecord,
  request: DataRecord,
): GitHubProviderInstructionObservationRequestV1 {
  const workspace = request.workspace;
  if (typeof workspace !== "string") {
    throw new RangeError(requestOriginDiagnostic);
  }
  try {
    return compileGitHubProviderInstructionObservationRequestV1({
      schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
      workspace,
      proposal,
    });
  } catch {
    throw new RangeError(requestOriginDiagnostic);
  }
}

function sameCanonicalRequest(
  candidate: DataRecord,
  canonical: GitHubProviderInstructionObservationRequestV1,
): boolean {
  const candidateKeys = Reflect.ownKeys(candidate);
  const canonicalKeys = Reflect.ownKeys(canonical);
  if (
    candidateKeys.length !== canonicalKeys.length
    || candidateKeys.some((key) => typeof key !== "string")
  ) {
    return false;
  }
  for (const key of canonicalKeys) {
    if (
      typeof key !== "string"
      || !Object.prototype.hasOwnProperty.call(candidate, key)
      || candidate[key] !== canonical[key as keyof typeof canonical]
    ) {
      return false;
    }
  }
  return true;
}

function actionableRequestChronologyIsInvalid(request: DataRecord): boolean {
  if (request.outcome !== "ready_for_repository_instruction_observation") {
    return false;
  }
  const operation = request.operation;
  const previous = request.previousSourceRevision;
  const provider = request.providerSourceRevision;
  if (
    typeof operation !== "string"
    || !(previous === null || typeof previous === "string")
    || !(provider === null || typeof provider === "string")
  ) {
    return false;
  }
  return (
    operation === "github_create_issue" && previous !== null
  ) || (
    previous !== null && previous === provider
  );
}

function chronologyEvidence(
  attachment: DataRecord,
  request: GitHubProviderInstructionObservationRequestV1,
  observation: DataRecord,
): ChronologyEvidence | null {
  const attachmentAcceptedAt = attachment.acceptedAt;
  const providerObservedAt = request.providerObservedAt;
  const instructionObservedAt = observation.observedAt;
  if (
    typeof attachmentAcceptedAt !== "string"
    || typeof providerObservedAt !== "string"
    || typeof instructionObservedAt !== "string"
  ) {
    return null;
  }
  return {
    attachmentAcceptedAt,
    providerObservedAt,
    instructionObservedAt,
  };
}

function attachmentChronologyIsInvalid(value: ChronologyEvidence): boolean {
  const accepted = Date.parse(value.attachmentAcceptedAt);
  const provider = Date.parse(value.providerObservedAt);
  const observed = Date.parse(value.instructionObservedAt);
  if (![accepted, provider, observed].every(Number.isFinite)) return false;
  return accepted > provider || observed < accepted || observed < provider;
}

function withoutResolutionFingerprint(
  value: BaseResolution,
): Omit<BaseResolution, "resolutionFingerprint"> {
  const { resolutionFingerprint: _resolutionFingerprint, ...body } = value;
  return body;
}

function finalize(
  body: Omit<
    GitHubProviderInstructionObservationResolutionV1,
    "resolutionFingerprint"
  >,
): GitHubProviderInstructionObservationResolutionV1 {
  return deepFreeze({
    ...body,
    resolutionFingerprint: fingerprintCanonicalRequest(body),
  });
}

function snapshotResolutionInput(value: unknown): DataRecord {
  const input = snapshotDataRecord(
    value,
    "GitHub provider instruction observation resolution input",
  );
  if (!Object.prototype.hasOwnProperty.call(input, "proposal")) {
    throw new RangeError(requestOriginDiagnostic);
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== inputKeys.length
    || keys.some((key) =>
      typeof key !== "string"
      || !(inputKeys as readonly string[]).includes(key)
    )
  ) {
    throw new TypeError(
      "GitHub provider instruction observation resolution input fields are invalid",
    );
  }
  return input;
}

function snapshotDataRecord(value: unknown, label: string): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Reflect.get(descriptors, key) as
      | PropertyDescriptor
      | undefined;
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
