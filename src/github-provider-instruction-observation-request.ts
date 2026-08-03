import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1 as BASE_SCHEMA_VERSION,
  compileGitHubProviderInstructionObservationRequestV1 as compileBase,
  type GitHubProviderInstructionObservationRequestInputV1 as BaseInput,
  type GitHubProviderInstructionObservationRequestNextAction as BaseNextAction,
  type GitHubProviderInstructionObservationRequestOutcome as BaseOutcome,
  type GitHubProviderInstructionObservationRequestV1 as BaseRequest,
} from "./github-provider-instruction-observation-request-base.js";

export const GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1 =
  BASE_SCHEMA_VERSION;
export type GitHubProviderInstructionObservationRequestInputV1 = BaseInput;
export type GitHubProviderInstructionObservationRequestNextAction =
  BaseNextAction;
export type GitHubProviderInstructionObservationRequestOutcome = BaseOutcome;
export type GitHubProviderInstructionObservationRequestV1 = BaseRequest;

const maximumRememberedCanonicalRequests = 256;
const canonicalRequests = new Map<string, BaseRequest>();

/**
 * Compiles the reviewed content-minimized request and remembers only that
 * canonical request packet for same-process origin verification. Proposal
 * snapshots and provider prose are never retained by this cache.
 */
export function compileGitHubProviderInstructionObservationRequestV1(
  value: unknown,
): BaseRequest {
  const request = compileBase(value);
  remember(request);
  return request;
}

export function findCanonicalGitHubProviderInstructionObservationRequestV1(
  workspace: unknown,
  proposalFingerprint: unknown,
): BaseRequest | null {
  if (typeof workspace !== "string" || typeof proposalFingerprint !== "string") {
    return null;
  }
  return canonicalRequests.get(cacheKey(workspace, proposalFingerprint)) ?? null;
}

function remember(request: BaseRequest): void {
  const key = cacheKey(request.workspace, request.proposalFingerprint);
  canonicalRequests.delete(key);
  canonicalRequests.set(key, request);
  while (canonicalRequests.size > maximumRememberedCanonicalRequests) {
    const oldest = canonicalRequests.keys().next().value;
    if (typeof oldest !== "string") break;
    canonicalRequests.delete(oldest);
  }
}

function cacheKey(workspace: string, proposalFingerprint: string): string {
  return `${workspace}\u0000${proposalFingerprint}`;
}
