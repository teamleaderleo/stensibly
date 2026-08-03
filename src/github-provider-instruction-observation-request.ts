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

/**
 * Applies final producer-independent admission before delegating to the
 * reviewed request compiler. The preflight reads only own data descriptors and
 * never touches nested provider snapshots.
 */
export function compileGitHubProviderInstructionObservationRequestV1(
  value: unknown,
): ReturnType<typeof compileBase> {
  const workspace = dataProperty(value, "workspace");
  rejectCredentialIdentity(
    workspace,
    "GitHub provider instruction observation workspace",
  );

  const proposal = dataProperty(value, "proposal");
  for (const [field, label] of retainedProposalIdentityFields) {
    rejectCredentialIdentity(dataProperty(proposal, field), label);
  }

  const operation = dataProperty(proposal, "operation");
  const outcome = dataProperty(proposal, "outcome");
  const currentSourceRevision = dataProperty(
    proposal,
    "currentSourceRevision",
  );
  const providerSourceRevision = dataProperty(
    proposal,
    "providerSourceRevision",
  );

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

  const externalId = dataProperty(proposal, "externalId");
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

  return compileBase(value);
}

function rejectCredentialIdentity(value: unknown, label: string): void {
  if (
    typeof value === "string"
    && containsRealisticRetainedCredential(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
}

function dataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
