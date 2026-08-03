import type {
  GitHubProviderContextReconciliationProposalV1,
} from "./github-provider-context-reconciliation.js";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
  findCanonicalGitHubProviderInstructionObservationRequestV1,
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
  proposal?: GitHubProviderContextReconciliationProposalV1;
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

type DataRecord = Record<string, unknown>;

const requestOriginDiagnostic =
  "GitHub provider instruction observation request does not match reconciliation proposal";

/**
 * Adds canonical producer-origin verification, request-evidence retention, and
 * local chronology guards to the reviewed resolver implementation.
 */
export function resolveGitHubProviderInstructionObservationV1(
  value: unknown,
): GitHubProviderInstructionObservationResolutionV1 {
  const input = resolutionInputRecord(value);
  const request = input === null ? null : dataRecord(input.request);

  if (input !== null && request !== null) {
    requireCanonicalRequestOrigin(input, request);
    if (actionableRequestChronologyIsInvalid(request)) {
      throw new RangeError(
        "GitHub provider instruction observation request chronology is invalid",
      );
    }
  }

  const base = resolveBase(input === null
    ? value
    : {
      schemaVersion: input.schemaVersion,
      request: input.request,
      attachment: input.attachment,
      observation: input.observation,
    });
  const requestFingerprint = request?.requestFingerprint;
  if (typeof requestFingerprint !== "string") {
    throw new RangeError(
      "GitHub provider instruction observation request fingerprint is invalid",
    );
  }

  const chronology = chronologyEvidence(input, request);
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

function requireCanonicalRequestOrigin(
  input: DataRecord,
  request: DataRecord,
): void {
  const workspace = request.workspace;
  const proposalFingerprint = request.proposalFingerprint;
  const requestFingerprint = request.requestFingerprint;
  if (
    typeof workspace !== "string"
    || typeof proposalFingerprint !== "string"
    || typeof requestFingerprint !== "string"
  ) {
    return;
  }

  let canonical: GitHubProviderInstructionObservationRequestV1 | null;
  if (Object.prototype.hasOwnProperty.call(input, "proposal")) {
    try {
      canonical = compileGitHubProviderInstructionObservationRequestV1({
        schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
        workspace,
        proposal: input.proposal as GitHubProviderContextReconciliationProposalV1,
      });
    } catch {
      throw new RangeError(requestOriginDiagnostic);
    }
  } else {
    canonical = findCanonicalGitHubProviderInstructionObservationRequestV1(
      workspace,
      proposalFingerprint,
    );
  }

  if (
    canonical === null
    || canonical.proposalFingerprint !== proposalFingerprint
    || canonical.requestFingerprint !== requestFingerprint
  ) {
    throw new RangeError(requestOriginDiagnostic);
  }
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
  input: DataRecord | null,
  request: DataRecord | null,
): ChronologyEvidence | null {
  if (input === null || request === null) return null;
  const attachment = dataRecord(input.attachment);
  const observation = dataRecord(input.observation);
  if (attachment === null || observation === null) return null;
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

function resolutionInputRecord(value: unknown): DataRecord | null {
  const input = dataRecord(value);
  if (input === null) return null;
  const keys = Object.keys(input);
  const required = ["schemaVersion", "request", "attachment", "observation"];
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
    || keys.some((key) => !required.includes(key) && key !== "proposal")
    || keys.length < required.length
    || keys.length > required.length + 1
  ) {
    return null;
  }
  return input;
}

function dataRecord(value: unknown): DataRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return null;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return null;
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
