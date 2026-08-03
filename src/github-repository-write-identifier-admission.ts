import {
  admitGitHubRepositoryWriteReceipt,
} from "./github-repository-write-receipt-admission.js";

const fixedSha = "a".repeat(40);
const fixedDigest = `sha256:${"b".repeat(64)}`;

/**
 * Reuse the durable repository-write receipt identifier contract for standalone
 * lookup keys without maintaining a second grammar or credential policy.
 */
export function admitGitHubRepositoryWriteIdentifier(value: unknown): string {
  return admitGitHubRepositoryWriteReceipt({
    version: 1,
    id: "ghrw_identifier_admission",
    project: "identifier-admission",
    repositoryFullName: "stensibly/identifier-admission",
    targetRef: "identifier-admission",
    path: "identifier-admission.txt",
    operation: "create_file",
    expectedParentSha: fixedSha,
    requestSha256: fixedDigest,
    payloadSha256: fixedDigest,
    actorId: "identifier_admission_actor",
    clientId: "identifier_admission_client",
    idempotencyKey: value,
    state: "reserved",
    dispatchCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    verified: null,
    error: null,
  }).idempotencyKey;
}
