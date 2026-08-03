import {
  parseGitHubIssueExternalId,
} from "./github-issue-context.js";
import {
  containsRealisticRetainedCredential,
} from "./github-retained-credential-policy.js";
import {
  compileGitHubProviderInstructionObservationRequestV1 as compileBase,
} from "./github-provider-instruction-observation-request-base.js";

export {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
} from "./github-provider-instruction-observation-request-base.js";
export type {
  GitHubProviderInstructionObservationRequestInputV1,
  GitHubProviderInstructionObservationRequestNextAction,
  GitHubProviderInstructionObservationRequestOutcome,
  GitHubProviderInstructionObservationRequestV1,
} from "./github-provider-instruction-observation-request-base.js";

const maximumGitHubProviderItemNumber = 2_147_483_647;

const retainedProposalIdentityFields = [
  ["project", "GitHub reconciliation project"],
  ["repositoryFullName", "GitHub repository identity"],
  ["receiptId", "GitHub reconciliation receipt ID"],
  ["actorId", "GitHub reconciliation actor ID"],
  ["attachmentId", "GitHub reconciliation attachment ID"],
  ["currentSourceRevision", "GitHub context source revision"],
  ["providerSourceRevision", "GitHub context source revision"],
  ["externalId", "GitHub issue external ID"],
] as const;

type DataRecord = Record<PropertyKey, unknown>;

/**
 * Applies final producer-independent admission before delegating to the
 * reviewed request compiler. The top-level input and proposal are detached
 * exactly once, and the base compiler receives only those detached values.
 */
export function compileGitHubProviderInstructionObservationRequestV1(
  value: unknown,
): ReturnType<typeof compileBase> {
  const input = snapshotDataRecord(
    value,
    "GitHub provider instruction observation request input",
  );
  const proposal = snapshotDataRecord(
    input.proposal,
    "GitHub provider context reconciliation proposal",
  );
  input.proposal = proposal;

  rejectCredentialIdentity(
    input.workspace,
    "GitHub provider instruction observation workspace",
  );
  for (const [field, label] of retainedProposalIdentityFields) {
    rejectCredentialIdentity(proposal[field], label);
  }

  const operation = proposal.operation;
  const outcome = proposal.outcome;
  const currentSourceRevision = proposal.currentSourceRevision;
  const providerSourceRevision = proposal.providerSourceRevision;

  if (
    operation === "github_create_issue"
    && currentSourceRevision !== null
  ) {
    throw new RangeError(
      "GitHub reconciliation proposal semantics are invalid",
    );
  }
  if (
    outcome === "propose_context_acceptance"
    && typeof currentSourceRevision === "string"
    && currentSourceRevision === providerSourceRevision
  ) {
    throw new RangeError(
      "GitHub reconciliation proposal semantics are invalid",
    );
  }

  const externalId = proposal.externalId;
  if (typeof externalId === "string") {
    let parsed: ReturnType<typeof parseGitHubIssueExternalId> | null = null;
    try {
      parsed = parseGitHubIssueExternalId(externalId);
    } catch {
      // The complete base compiler owns syntax and canonical diagnostics.
    }
    if (
      parsed !== null
      && parsed.externalId === externalId
      && parsed.number > maximumGitHubProviderItemNumber
    ) {
      throw new RangeError("GitHub issue external ID is invalid");
    }
  }

  return compileBase(input);
}

function rejectCredentialIdentity(value: unknown, label: string): void {
  if (
    typeof value === "string"
    && containsRealisticRetainedCredential(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
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
