import type { GitHubIssueProviderOperation } from "./github-provider-contracts.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import {
  parseGitHubIssueExternalId,
  type GitHubIssueContext,
} from "./github-issue-context.js";
import type {
  GitHubProviderContextReconciliationProposalV1,
} from "./github-provider-context-reconciliation.js";
import {
  admitAcceptedRepositoryInstructionSet,
  admitGitHubIssueContextAcceptanceSubject,
  admitGitHubIssueContextSnapshot,
  type AcceptedRepositoryInstructionSet,
  type GitHubIssueContextAcceptanceOutcome,
  type GitHubIssueContextAcceptanceSubject,
} from "./github-project-context-admission.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1 = 1 as const;

export type GitHubProviderContextAcceptanceCompositionOutcome =
  | "ready_for_context_acceptance"
  | "requires_repository_instruction_observation"
  | "attachment_generation_conflict"
  | "binding_identity_conflict"
  | "proposal_not_actionable";

export type GitHubProviderContextAcceptanceCompositionNextAction =
  | "accept_context"
  | "observe_repository_instructions"
  | "inspect_attachment_generation"
  | "inspect_binding_identity"
  | "none";

export interface HostedGitHubIssueContextBindingInputV1 {
  version: 1;
  workspace: string;
  recordId: string;
  project: string;
  externalId: string;
  repositoryFullName: string;
  snapshot: GitHubIssueContext;
  instructionSet: AcceptedRepositoryInstructionSet;
  synchronization: {
    status: "synchronized" | "degraded";
    cursor: string | null;
    degradedReasonCode: string | null;
    observationRef: string;
    observedAt: string;
    acceptedBy: string;
    acceptedAt: string;
    outcome: GitHubIssueContextAcceptanceOutcome;
    isCurrent: true;
  };
}

export interface GitHubProviderContextAcceptanceComposerInputV1 {
  schemaVersion: typeof GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1;
  workspace: string;
  proposal: GitHubProviderContextReconciliationProposalV1;
  binding: HostedGitHubIssueContextBindingInputV1 | null;
}

export interface GitHubProviderContextAcceptanceCompositionV1 {
  version: typeof GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1;
  workspace: string;
  project: string;
  repositoryFullName: string;
  receiptId: string;
  externalId: string | null;
  proposalFingerprint: string;
  bindingRecordId: string | null;
  outcome: GitHubProviderContextAcceptanceCompositionOutcome;
  nextAction: GitHubProviderContextAcceptanceCompositionNextAction;
  acceptanceSubject: GitHubIssueContextAcceptanceSubject | null;
  compositionFingerprint: string;
  authorizesProviderMutation: false;
  authorizesContextAcceptance: false;
  authorizesAuthority: false;
}

const inputKeys = ["schemaVersion", "workspace", "proposal", "binding"] as const;
const proposalKeys = [
  "schemaVersion",
  "project",
  "repositoryFullName",
  "receiptId",
  "operation",
  "actorId",
  "attachmentId",
  "attachmentSnapshotSha256",
  "verificationCheckedAt",
  "externalId",
  "currentSourceRevision",
  "providerSourceRevision",
  "outcome",
  "nextAction",
  "providerSnapshot",
  "inputFingerprint",
  "proposalFingerprint",
  "authorizesProviderMutation",
  "authorizesContextAcceptance",
  "authorizesAuthority",
] as const;
const bindingKeys = [
  "version",
  "workspace",
  "recordId",
  "project",
  "externalId",
  "repositoryFullName",
  "snapshot",
  "instructionSet",
  "synchronization",
] as const;
const synchronizationKeys = [
  "status",
  "cursor",
  "degradedReasonCode",
  "observationRef",
  "observedAt",
  "acceptedBy",
  "acceptedAt",
  "outcome",
  "isCurrent",
] as const;
const receiptProducingOperations = new Set<GitHubIssueProviderOperation>([
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_comment",
  "github_add_issue_labels",
  "github_remove_issue_label",
  "github_add_issue_assignees",
  "github_remove_issue_assignees",
]);
const issueContextOperations = new Set<GitHubIssueProviderOperation>([
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_labels",
  "github_remove_issue_label",
  "github_add_issue_assignees",
  "github_remove_issue_assignees",
]);
const proposalOutcomes = new Set([
  "await_provider_result",
  "pending_provider_reconciliation",
  "no_issue_context_effect",
  "already_current",
  "propose_context_acceptance",
  "identity_conflict",
]);
const proposalNextActions = new Set([
  "await_provider_result",
  "reconcile_provider_operation",
  "none",
  "submit_context_acceptance",
  "inspect_issue_identity_conflict",
]);
const bindingOutcomes = new Set<GitHubIssueContextAcceptanceOutcome>([
  "initial",
  "updated",
  "instruction_rebound",
  "synchronization_updated",
]);
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const safeIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/u;
const credentialPattern =
  /(?:^|[._:/-])(?:(?:env|secret):\/\/|bearer(?:[._:/-]|$)|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-|eyJ[A-Za-z0-9_-]{8,}\.)/iu;

export function composeGitHubProviderContextAcceptanceV1(
  value: unknown,
): GitHubProviderContextAcceptanceCompositionV1 {
  const input = exactRecord(
    value,
    inputKeys,
    "GitHub provider context acceptance composer input",
  );
  if (input.schemaVersion !== GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1) {
    throw new RangeError(
      "GitHub provider context acceptance composer schemaVersion must equal 1",
    );
  }
  const workspace = exactSlug(input.workspace, "GitHub context acceptance workspace");
  const proposal = admitProposal(input.proposal);
  if (proposal.outcome !== "propose_context_acceptance") {
    return composition(
      workspace,
      proposal,
      null,
      "proposal_not_actionable",
      "none",
      null,
    );
  }
  if (input.binding === null) {
    return composition(
      workspace,
      proposal,
      null,
      "requires_repository_instruction_observation",
      "observe_repository_instructions",
      null,
    );
  }
  const binding = admitBinding(input.binding);
  if (
    proposal.currentSourceRevision === null
    || binding.workspace !== workspace
    || proposal.externalId !== binding.externalId
    || proposal.project !== binding.project
    || proposal.repositoryFullName !== binding.repositoryFullName
    || binding.snapshot.sourceRevision !== proposal.currentSourceRevision
  ) {
    return composition(
      workspace,
      proposal,
      binding.recordId,
      "binding_identity_conflict",
      "inspect_binding_identity",
      null,
    );
  }
  if (
    proposal.attachmentId !== binding.instructionSet.projectAttachmentId
    || proposal.attachmentSnapshotSha256
      !== binding.instructionSet.projectAttachmentSnapshotSha256
  ) {
    return composition(
      workspace,
      proposal,
      binding.recordId,
      "attachment_generation_conflict",
      "inspect_attachment_generation",
      null,
    );
  }
  const acceptanceSubject = admitGitHubIssueContextAcceptanceSubject({
    snapshot: proposal.providerSnapshot!,
    instructionSet: binding.instructionSet,
    syncStatus: "synchronized",
    syncCursor: null,
    degradedReasonCode: null,
    observationRef: deterministicObservationRef(
      workspace,
      proposal.proposalFingerprint,
    ),
    observedAt: proposal.verificationCheckedAt!,
    acceptedBy: proposal.actorId,
  });
  return composition(
    workspace,
    proposal,
    binding.recordId,
    "ready_for_context_acceptance",
    "accept_context",
    acceptanceSubject,
  );
}

function composition(
  workspace: string,
  proposal: GitHubProviderContextReconciliationProposalV1,
  bindingRecordId: string | null,
  outcome: GitHubProviderContextAcceptanceCompositionOutcome,
  nextAction: GitHubProviderContextAcceptanceCompositionNextAction,
  acceptanceSubject: GitHubIssueContextAcceptanceSubject | null,
): GitHubProviderContextAcceptanceCompositionV1 {
  const body = {
    version: GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
    workspace,
    project: proposal.project,
    repositoryFullName: proposal.repositoryFullName,
    receiptId: proposal.receiptId,
    externalId: proposal.externalId,
    proposalFingerprint: proposal.proposalFingerprint,
    bindingRecordId,
    outcome,
    nextAction,
    acceptanceSubject,
    authorizesProviderMutation: false as const,
    authorizesContextAcceptance: false as const,
    authorizesAuthority: false as const,
  };
  return deepFreeze({
    ...body,
    compositionFingerprint: fingerprintCanonicalRequest(body),
  });
}

function admitProposal(
  value: unknown,
): GitHubProviderContextReconciliationProposalV1 {
  const proposal = exactRecord(
    value,
    proposalKeys,
    "GitHub provider context reconciliation proposal",
  );
  if (proposal.schemaVersion !== 1) {
    throw new RangeError("GitHub provider context reconciliation proposal version is invalid");
  }
  const project = exactSlug(proposal.project, "GitHub reconciliation project");
  const repositoryFullName = canonicalRepository(proposal.repositoryFullName);
  const receiptId = safeIdentity(proposal.receiptId, "GitHub reconciliation receipt ID", 240);
  const operation = exactOperation(proposal.operation);
  const actorId = safeIdentity(proposal.actorId, "GitHub reconciliation actor ID", 240);
  const attachmentId = safeIdentity(
    proposal.attachmentId,
    "GitHub reconciliation attachment ID",
    240,
  );
  const attachmentSnapshotSha256 = exactHash(proposal.attachmentSnapshotSha256);
  const verificationCheckedAt = nullableTimestamp(proposal.verificationCheckedAt);
  const externalId = nullableExternalId(proposal.externalId);
  const currentSourceRevision = nullableSourceRevision(proposal.currentSourceRevision);
  const providerSourceRevision = nullableSourceRevision(proposal.providerSourceRevision);
  if (!proposalOutcomes.has(String(proposal.outcome))) {
    throw new RangeError("GitHub reconciliation proposal outcome is invalid");
  }
  if (!proposalNextActions.has(String(proposal.nextAction))) {
    throw new RangeError("GitHub reconciliation proposal next action is invalid");
  }
  const providerSnapshot = proposal.providerSnapshot === null
    ? null
    : admitGitHubIssueContextSnapshot(proposal.providerSnapshot);
  const inputFingerprint = exactHash(proposal.inputFingerprint);
  const proposalFingerprint = exactHash(proposal.proposalFingerprint);
  if (
    proposal.authorizesProviderMutation !== false
    || proposal.authorizesContextAcceptance !== false
    || proposal.authorizesAuthority !== false
  ) {
    throw new RangeError("GitHub reconciliation proposal cannot grant authority");
  }
  const admitted = {
    schemaVersion: 1 as const,
    project,
    repositoryFullName,
    receiptId,
    operation,
    actorId,
    attachmentId,
    attachmentSnapshotSha256,
    verificationCheckedAt,
    externalId,
    currentSourceRevision,
    providerSourceRevision,
    outcome: proposal.outcome as GitHubProviderContextReconciliationProposalV1["outcome"],
    nextAction: proposal.nextAction as GitHubProviderContextReconciliationProposalV1["nextAction"],
    providerSnapshot,
    inputFingerprint,
    proposalFingerprint,
    authorizesProviderMutation: false as const,
    authorizesContextAcceptance: false as const,
    authorizesAuthority: false as const,
  };
  if (fingerprintCanonicalRequest(withoutProposalFingerprint(admitted)) !== proposalFingerprint) {
    throw new RangeError("GitHub reconciliation proposal fingerprint is invalid");
  }
  assertProposalSemanticCoherence(admitted);
  return deepFreeze(admitted);
}

function assertProposalSemanticCoherence(
  proposal: GitHubProviderContextReconciliationProposalV1,
): void {
  const invalid = (): never => {
    throw new RangeError("GitHub reconciliation proposal semantics are invalid");
  };
  const snapshot = proposal.providerSnapshot;
  const requiresIssueOperation =
    proposal.outcome === "already_current"
    || proposal.outcome === "identity_conflict";
  if (requiresIssueOperation && !issueContextOperations.has(proposal.operation)) {
    invalid();
  }

  switch (proposal.outcome) {
    case "await_provider_result":
      if (
        proposal.nextAction !== "await_provider_result"
        || snapshot !== null
        || proposal.externalId !== null
        || proposal.providerSourceRevision !== null
        || proposal.verificationCheckedAt !== null
      ) invalid();
      return;
    case "pending_provider_reconciliation":
      if (
        proposal.nextAction !== "reconcile_provider_operation"
        || snapshot !== null
        || proposal.externalId !== null
        || proposal.providerSourceRevision !== null
      ) invalid();
      return;
    case "no_issue_context_effect":
      if (
        proposal.nextAction !== "none"
        || snapshot !== null
        || proposal.externalId !== null
        || proposal.providerSourceRevision !== null
      ) invalid();
      return;
    case "already_current":
      if (
        proposal.nextAction !== "none"
        || snapshot !== null
        || proposal.externalId === null
        || proposal.providerSourceRevision === null
        || proposal.currentSourceRevision !== proposal.providerSourceRevision
        || proposal.verificationCheckedAt === null
      ) invalid();
      return;
    case "propose_context_acceptance":
      if (
        proposal.nextAction !== "submit_context_acceptance"
        || !issueContextOperations.has(proposal.operation)
        || snapshot === null
        || proposal.externalId !== snapshot.reference.externalId
        || proposal.repositoryFullName !== snapshot.reference.repositoryFullName
        || proposal.providerSourceRevision !== snapshot.sourceRevision
        || proposal.verificationCheckedAt === null
      ) invalid();
      return;
    case "identity_conflict":
      if (
        proposal.nextAction !== "inspect_issue_identity_conflict"
        || snapshot !== null
        || proposal.externalId === null
        || proposal.providerSourceRevision === null
        || proposal.currentSourceRevision === null
        || proposal.verificationCheckedAt === null
      ) invalid();
      return;
  }
}

function admitBinding(value: unknown): HostedGitHubIssueContextBindingInputV1 {
  const binding = exactRecord(
    value,
    bindingKeys,
    "Hosted GitHub issue context binding",
  );
  if (binding.version !== 1) {
    throw new RangeError("Hosted GitHub issue context binding version is invalid");
  }
  const synchronization = exactRecord(
    binding.synchronization,
    synchronizationKeys,
    "Hosted GitHub issue context synchronization",
  );
  if (
    synchronization.status !== "synchronized"
    && synchronization.status !== "degraded"
  ) {
    throw new RangeError("Hosted GitHub issue context synchronization status is invalid");
  }
  const snapshot = admitGitHubIssueContextSnapshot(binding.snapshot);
  const instructionSet = admitAcceptedRepositoryInstructionSet(binding.instructionSet);
  const project = exactSlug(binding.project, "Hosted GitHub issue context project");
  const externalId = exactExternalId(binding.externalId);
  const repositoryFullName = canonicalRepository(binding.repositoryFullName);
  if (
    snapshot.reference.externalId !== externalId
    || snapshot.reference.repositoryFullName !== repositoryFullName
  ) {
    throw new RangeError("Hosted GitHub issue context binding identity is inconsistent");
  }
  const syncSubject = admitGitHubIssueContextAcceptanceSubject({
    snapshot,
    instructionSet,
    syncStatus: synchronization.status,
    syncCursor: nullableSafeIdentity(synchronization.cursor, "Hosted GitHub sync cursor", 512),
    degradedReasonCode: nullableSafeIdentity(
      synchronization.degradedReasonCode,
      "Hosted GitHub degraded reason",
      160,
    ),
    observationRef: safeIdentity(
      synchronization.observationRef,
      "Hosted GitHub observation reference",
      240,
    ),
    observedAt: exactTimestamp(synchronization.observedAt),
    acceptedBy: safeIdentity(
      synchronization.acceptedBy,
      "Hosted GitHub accepting actor",
      240,
    ),
  });
  const acceptedAt = exactTimestamp(synchronization.acceptedAt);
  const workspace = exactSlug(binding.workspace, "Hosted GitHub workspace");
  const recordId = safeIdentity(
    binding.recordId,
    "Hosted GitHub context record ID",
    240,
  );
  if (
    synchronization.isCurrent !== true
    || !bindingOutcomes.has(
      synchronization.outcome as GitHubIssueContextAcceptanceOutcome,
    )
    || Date.parse(syncSubject.observedAt) > Date.parse(acceptedAt) + 5 * 60_000
    || recordId !== deterministicRecordId(
      workspace,
      project,
      syncSubject.observationRef,
    )
  ) {
    throw new RangeError("Hosted GitHub issue context binding metadata is invalid");
  }
  return deepFreeze({
    version: 1,
    workspace,
    recordId,
    project,
    externalId,
    repositoryFullName,
    snapshot,
    instructionSet,
    synchronization: {
      status: synchronization.status,
      cursor: syncSubject.syncCursor,
      degradedReasonCode: syncSubject.degradedReasonCode,
      observationRef: syncSubject.observationRef,
      observedAt: syncSubject.observedAt,
      acceptedBy: syncSubject.acceptedBy,
      acceptedAt,
      outcome: synchronization.outcome as GitHubIssueContextAcceptanceOutcome,
      isCurrent: true,
    },
  });
}

function withoutProposalFingerprint(
  proposal: GitHubProviderContextReconciliationProposalV1,
): Omit<GitHubProviderContextReconciliationProposalV1, "proposalFingerprint"> {
  const { proposalFingerprint: _proposalFingerprint, ...body } = proposal;
  return body;
}

function deterministicObservationRef(
  workspace: string,
  proposalFingerprint: string,
): string {
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace,
    proposalFingerprint,
  });
  return `github:provider-reconciliation:${digest.slice("sha256:".length)}`;
}

function deterministicRecordId(
  workspace: string,
  project: string,
  observationRef: string,
): string {
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace,
    project,
    observationRef,
  });
  return `github_context_${digest.slice("sha256:".length)}`;
}

function exactOperation(value: unknown): GitHubIssueProviderOperation {
  if (
    typeof value !== "string"
    || !receiptProducingOperations.has(value as GitHubIssueProviderOperation)
  ) {
    throw new RangeError("GitHub reconciliation proposal operation is invalid");
  }
  return value as GitHubIssueProviderOperation;
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) =>
      typeof key !== "string" || !(keys as readonly string[]).includes(key)
    )
  ) {
    throw new TypeError(`${label} fields are invalid`);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactSlug(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}

function canonicalRepository(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError("GitHub repository identity is invalid");
  }
  const repository = normalizeGitHubRepository(value);
  if (repository !== value) {
    throw new RangeError("GitHub repository identity must be canonical lowercase");
  }
  return repository;
}

function exactExternalId(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError("GitHub issue external ID is invalid");
  }
  const externalId = parseGitHubIssueExternalId(value).externalId;
  if (externalId !== value) {
    throw new RangeError("GitHub issue external ID must be canonical");
  }
  return externalId;
}

function nullableExternalId(value: unknown): string | null {
  return value === null ? null : exactExternalId(value);
}

function exactHash(value: unknown): string {
  if (typeof value !== "string" || !hashPattern.test(value)) {
    throw new RangeError("GitHub context acceptance fingerprint is invalid");
  }
  return value;
}

function exactTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !timestampPattern.test(value)
    || new Date(value).toISOString() !== value
  ) throw new RangeError("GitHub context acceptance timestamp is invalid");
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : exactTimestamp(value);
}

function nullableSourceRevision(value: unknown): string | null {
  return value === null
    ? null
    : safeIdentity(value, "GitHub context source revision", 512);
}

function safeIdentity(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length === 0
    || value.length > maximum
    || !safeIdentityPattern.test(value)
    || credentialPattern.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}

function nullableSafeIdentity(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  return value === null ? null : safeIdentity(value, label, maximum);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
