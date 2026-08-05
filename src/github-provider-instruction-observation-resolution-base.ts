import type { GitHubIssueProviderOperation } from "./github-provider-contracts.js";
import {
  buildAcceptedRepositoryInstructionSet,
  type AcceptedRepositoryInstructionSet,
  type RepositoryInstructionSourceInput,
} from "./github-project-context-admission.js";
import { parseGitHubIssueExternalId } from "./github-issue-context.js";
import type {
  GitHubProviderInstructionObservationRequestV1,
} from "./github-provider-instruction-observation-request.js";
import { snapshotBoundedJson } from "./github-repository-observation-admission.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import {
  normalizeRepositoryRemote,
  parseProjectAttachmentSnapshot,
  type ProjectAttachmentSnapshot,
} from "./project-contract.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1 = 1 as const;

export type GitHubProviderInstructionObservationResolutionOutcome =
  | "ready_for_context_acceptance_binding"
  | "request_not_actionable"
  | "attachment_identity_conflict"
  | "project_identity_conflict"
  | "repository_binding_conflict"
  | "attachment_source_conflict"
  | "observation_chronology_conflict";

export type GitHubProviderInstructionObservationResolutionNextAction =
  | "compose_context_acceptance"
  | "none"
  | "reload_current_attachment"
  | "inspect_project_identity"
  | "inspect_repository_binding"
  | "reobserve_repository_instructions";

export interface GitHubProviderInstructionObservationInputV1 {
  observedAt: string;
  observedBy: string;
  sources: RepositoryInstructionSourceInput[];
}

export interface GitHubProviderInstructionObservationResolutionInputV1 {
  schemaVersion: typeof GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1;
  request: GitHubProviderInstructionObservationRequestV1;
  attachment: unknown;
  observation: GitHubProviderInstructionObservationInputV1;
}

export interface GitHubProviderInstructionObservationResolutionV1 {
  version: typeof GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1;
  workspace: string;
  project: string;
  repositoryFullName: string;
  requestId: string | null;
  observationRef: string | null;
  proposalFingerprint: string;
  attachmentId: string;
  attachmentSnapshotSha256: string;
  instructionObservedAt: string | null;
  observedBy: string | null;
  instructionSet: AcceptedRepositoryInstructionSet | null;
  outcome: GitHubProviderInstructionObservationResolutionOutcome;
  nextAction: GitHubProviderInstructionObservationResolutionNextAction;
  resolutionFingerprint: string;
  authorizesProviderRead: false;
  authorizesProviderMutation: false;
  authorizesContextAcceptance: false;
  authorizesPersistence: false;
  authorizesApproval: false;
  authorizesAuthority: false;
}

const inputKeys = ["schemaVersion", "request", "attachment", "observation"] as const;
const requestKeys = [
  "version",
  "workspace",
  "project",
  "repositoryFullName",
  "receiptId",
  "operation",
  "externalId",
  "previousSourceRevision",
  "providerSourceRevision",
  "actorId",
  "attachmentId",
  "attachmentSnapshotSha256",
  "providerObservedAt",
  "proposalFingerprint",
  "outcome",
  "nextAction",
  "requestId",
  "observationRef",
  "requestFingerprint",
  "authorizesProviderRead",
  "authorizesProviderMutation",
  "authorizesContextAcceptance",
  "authorizesApproval",
  "authorizesAuthority",
] as const;
const attachmentKeys = [
  "id",
  "project",
  "snapshot",
  "sourceRevision",
  "acceptedBy",
  "authorityWidening",
  "acceptedAt",
] as const;
const observationKeys = ["observedAt", "observedBy", "sources"] as const;
const requestOutcomes = new Set([
  "ready_for_repository_instruction_observation",
  "proposal_not_actionable",
]);
const requestNextActions = new Set([
  "load_attachment_and_observe_repository_instructions",
  "none",
]);
const receiptProducingOperations = new Set<GitHubIssueProviderOperation>([
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_comment",
  "github_add_issue_labels",
  "github_remove_issue_label",
  "github_add_issue_assignees",
  "github_remove_issue_assignees",
]);
const actionableOperations = new Set<GitHubIssueProviderOperation>([
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_labels",
  "github_remove_issue_label",
  "github_add_issue_assignees",
  "github_remove_issue_assignees",
]);
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/u;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#+-]*$/u;
const slugPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const credentialPattern =
  /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

type DataRecord = Record<string, unknown>;

interface AdmittedAttachment {
  id: string;
  project: string;
  snapshot: ProjectAttachmentSnapshot;
  sourceRevision: string;
}

interface AdmittedObservation {
  observedAt: string;
  observedBy: string;
  instructionSet: AcceptedRepositoryInstructionSet;
}

export function resolveGitHubProviderInstructionObservationV1(
  value: unknown,
): GitHubProviderInstructionObservationResolutionV1 {
  const input = exactRecord(
    value,
    inputKeys,
    "GitHub provider instruction observation resolution input",
  );
  if (input.schemaVersion !== GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1) {
    throw new RangeError(
      "GitHub provider instruction observation resolution schemaVersion must equal 1",
    );
  }
  const request = admitRequest(input.request);
  if (request.outcome !== "ready_for_repository_instruction_observation") {
    return resolution(
      request,
      "request_not_actionable",
      "none",
      null,
      null,
      null,
    );
  }

  const attachment = admitAttachment(input.attachment);
  if (attachment.project !== request.project) {
    return resolution(
      request,
      "project_identity_conflict",
      "inspect_project_identity",
      null,
      null,
      null,
    );
  }
  if (
    attachment.id !== request.attachmentId
    || attachment.snapshot.snapshotSha256
      !== request.attachmentSnapshotSha256
  ) {
    return resolution(
      request,
      "attachment_identity_conflict",
      "reload_current_attachment",
      null,
      null,
      null,
    );
  }
  if (!attachmentDeclaresRepository(
    attachment.snapshot,
    request.repositoryFullName,
  )) {
    return resolution(
      request,
      "repository_binding_conflict",
      "inspect_repository_binding",
      null,
      null,
      null,
    );
  }

  const observation = admitObservation(input.observation, request);
  if (
    request.providerObservedAt !== null
    && Date.parse(observation.observedAt)
      < Date.parse(request.providerObservedAt)
  ) {
    return resolution(
      request,
      "observation_chronology_conflict",
      "reobserve_repository_instructions",
      observation.observedAt,
      observation.observedBy,
      null,
    );
  }
  if (!instructionSetBindsAttachmentSource(
    observation.instructionSet,
    attachment,
  )) {
    return resolution(
      request,
      "attachment_source_conflict",
      "reobserve_repository_instructions",
      observation.observedAt,
      observation.observedBy,
      null,
    );
  }

  return resolution(
    request,
    "ready_for_context_acceptance_binding",
    "compose_context_acceptance",
    observation.observedAt,
    observation.observedBy,
    observation.instructionSet,
  );
}

function resolution(
  request: GitHubProviderInstructionObservationRequestV1,
  outcome: GitHubProviderInstructionObservationResolutionOutcome,
  nextAction: GitHubProviderInstructionObservationResolutionNextAction,
  instructionObservedAt: string | null,
  observedBy: string | null,
  instructionSet: AcceptedRepositoryInstructionSet | null,
): GitHubProviderInstructionObservationResolutionV1 {
  const body = {
    version: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
    workspace: request.workspace,
    project: request.project,
    repositoryFullName: request.repositoryFullName,
    requestId: request.requestId,
    observationRef: request.observationRef,
    proposalFingerprint: request.proposalFingerprint,
    attachmentId: request.attachmentId,
    attachmentSnapshotSha256: request.attachmentSnapshotSha256,
    instructionObservedAt,
    observedBy,
    instructionSet,
    outcome,
    nextAction,
    authorizesProviderRead: false as const,
    authorizesProviderMutation: false as const,
    authorizesContextAcceptance: false as const,
    authorizesPersistence: false as const,
    authorizesApproval: false as const,
    authorizesAuthority: false as const,
  };
  return deepFreeze({
    ...body,
    resolutionFingerprint: fingerprintCanonicalRequest(body),
  });
}

function admitRequest(
  value: unknown,
): GitHubProviderInstructionObservationRequestV1 {
  const request = exactRecord(
    value,
    requestKeys,
    "GitHub provider instruction observation request",
  );
  if (request.version !== 1) {
    throw new RangeError(
      "GitHub provider instruction observation request version is invalid",
    );
  }
  const workspace = exactSlug(
    request.workspace,
    "GitHub provider instruction observation workspace",
  );
  const project = exactSlug(
    request.project,
    "GitHub provider instruction observation project",
  );
  const repositoryFullName = canonicalRepository(request.repositoryFullName);
  const receiptId = exactIdentifier(
    request.receiptId,
    "GitHub provider instruction observation receipt ID",
    240,
  );
  const operation = exactOperation(request.operation);
  const externalId = request.externalId === null
    ? null
    : canonicalExternalId(request.externalId);
  if (
    externalId !== null
    && parseGitHubIssueExternalId(externalId).repositoryFullName
      !== repositoryFullName
  ) {
    throw new RangeError(
      "GitHub provider instruction observation issue identity does not match repository",
    );
  }
  const previousSourceRevision = nullableRevision(
    request.previousSourceRevision,
    "GitHub provider instruction observation previous revision",
  );
  const providerSourceRevision = nullableRevision(
    request.providerSourceRevision,
    "GitHub provider instruction observation provider revision",
  );
  const actorId = exactIdentifier(
    request.actorId,
    "GitHub provider instruction observation actor ID",
    240,
  );
  const attachmentId = exactIdentifier(
    request.attachmentId,
    "GitHub provider instruction observation attachment ID",
    240,
  );
  const attachmentSnapshotSha256 = exactHash(
    request.attachmentSnapshotSha256,
    "GitHub provider instruction observation attachment fingerprint",
  );
  const providerObservedAt = request.providerObservedAt === null
    ? null
    : exactTimestamp(
      request.providerObservedAt,
      "GitHub provider instruction observation provider time",
    );
  const proposalFingerprint = exactHash(
    request.proposalFingerprint,
    "GitHub provider instruction observation proposal fingerprint",
  );
  if (!requestOutcomes.has(String(request.outcome))) {
    throw new RangeError(
      "GitHub provider instruction observation request outcome is invalid",
    );
  }
  if (!requestNextActions.has(String(request.nextAction))) {
    throw new RangeError(
      "GitHub provider instruction observation request next action is invalid",
    );
  }
  const requestId = request.requestId === null
    ? null
    : exactIdentifier(
      request.requestId,
      "GitHub provider instruction observation request ID",
      240,
    );
  const observationRef = request.observationRef === null
    ? null
    : exactIdentifier(
      request.observationRef,
      "GitHub provider instruction observation reference",
      240,
    );
  const requestFingerprint = exactHash(
    request.requestFingerprint,
    "GitHub provider instruction observation request fingerprint",
  );
  if (
    request.authorizesProviderRead !== false
    || request.authorizesProviderMutation !== false
    || request.authorizesContextAcceptance !== false
    || request.authorizesApproval !== false
    || request.authorizesAuthority !== false
  ) {
    throw new RangeError(
      "GitHub provider instruction observation request cannot grant authority",
    );
  }

  const body = {
    version: 1 as const,
    workspace,
    project,
    repositoryFullName,
    receiptId,
    operation,
    externalId,
    previousSourceRevision,
    providerSourceRevision,
    actorId,
    attachmentId,
    attachmentSnapshotSha256,
    providerObservedAt,
    proposalFingerprint,
    outcome: request.outcome as GitHubProviderInstructionObservationRequestV1["outcome"],
    nextAction: request.nextAction as GitHubProviderInstructionObservationRequestV1["nextAction"],
    requestId,
    observationRef,
    authorizesProviderRead: false as const,
    authorizesProviderMutation: false as const,
    authorizesContextAcceptance: false as const,
    authorizesApproval: false as const,
    authorizesAuthority: false as const,
  };
  if (fingerprintCanonicalRequest(body) !== requestFingerprint) {
    throw new RangeError(
      "GitHub provider instruction observation request fingerprint is invalid",
    );
  }
  assertRequestSemantics(body);
  return deepFreeze({ ...body, requestFingerprint });
}

function assertRequestSemantics(
  request: Omit<
    GitHubProviderInstructionObservationRequestV1,
    "requestFingerprint"
  >,
): void {
  if (request.outcome === "proposal_not_actionable") {
    if (
      request.nextAction !== "none"
      || request.requestId !== null
      || request.observationRef !== null
    ) {
      throw new RangeError(
        "GitHub provider instruction observation request semantics are invalid",
      );
    }
    return;
  }
  if (
    !actionableOperations.has(request.operation)
    || request.nextAction
      !== "load_attachment_and_observe_repository_instructions"
    || request.externalId === null
    || request.providerSourceRevision === null
    || request.providerObservedAt === null
    || request.requestId === null
    || request.observationRef === null
  ) {
    throw new RangeError(
      "GitHub provider instruction observation request semantics are invalid",
    );
  }
  const identity = fingerprintCanonicalRequest({
    version: 1,
    workspace: request.workspace,
    project: request.project,
    repositoryFullName: request.repositoryFullName,
    receiptId: request.receiptId,
    externalId: request.externalId,
    proposalFingerprint: request.proposalFingerprint,
    attachmentId: request.attachmentId,
    attachmentSnapshotSha256: request.attachmentSnapshotSha256,
  });
  const suffix = identity.slice("sha256:".length);
  if (
    request.requestId !== `github_instruction_observation_${suffix}`
    || request.observationRef
      !== `github:provider-instruction-observation:${suffix}`
  ) {
    throw new RangeError(
      "GitHub provider instruction observation request identity is invalid",
    );
  }
}

function admitAttachment(value: unknown): AdmittedAttachment {
  const attachment = exactRecord(
    value,
    attachmentKeys,
    "Accepted project attachment record",
  );
  const id = exactIdentifier(
    attachment.id,
    "Accepted project attachment ID",
    240,
  );
  const project = exactSlug(
    attachment.project,
    "Accepted project attachment project",
  );
  const snapshot = parseProjectAttachmentSnapshot(snapshotBoundedJson(
    attachment.snapshot,
    "Accepted project attachment snapshot",
  ));
  const sourceRevision = exactRevision(
    attachment.sourceRevision,
    "Accepted project attachment source revision",
    240,
  );
  exactSafeText(
    attachment.acceptedBy,
    "Accepted project attachment accepting actor",
    240,
  );
  if (typeof attachment.authorityWidening !== "boolean") {
    throw new RangeError(
      "Accepted project attachment authority flag is invalid",
    );
  }
  exactTimestamp(
    attachment.acceptedAt,
    "Accepted project attachment acceptance time",
  );
  if (snapshot.contract.project !== project) {
    throw new RangeError(
      "Accepted project attachment project does not match its snapshot",
    );
  }
  return deepFreeze({ id, project, snapshot, sourceRevision });
}

function admitObservation(
  value: unknown,
  request: GitHubProviderInstructionObservationRequestV1,
): AdmittedObservation {
  const observation = exactRecord(
    value,
    observationKeys,
    "GitHub repository instruction observation",
  );
  const observedAt = exactTimestamp(
    observation.observedAt,
    "GitHub repository instruction observation time",
  );
  const observedBy = exactIdentifier(
    observation.observedBy,
    "GitHub repository instruction observing actor",
    240,
  );
  const instructionSet = buildAcceptedRepositoryInstructionSet({
    projectAttachmentId: request.attachmentId,
    projectAttachmentSnapshotSha256: request.attachmentSnapshotSha256,
    sources: observation.sources,
  });
  for (const source of instructionSet.sources) {
    if (
      credentialPattern.test(source.path)
      || credentialPattern.test(source.revision)
    ) {
      throw new RangeError(
        "GitHub repository instruction observation contains credential-shaped identity",
      );
    }
  }
  return deepFreeze({ observedAt, observedBy, instructionSet });
}

function instructionSetBindsAttachmentSource(
  instructionSet: AcceptedRepositoryInstructionSet,
  attachment: AdmittedAttachment,
): boolean {
  const source = instructionSet.sources.find((entry) =>
    entry.path === attachment.snapshot.source.path
  );
  return source !== undefined
    && source.revision === attachment.sourceRevision
    && source.contentSha256 === attachment.snapshot.source.contentSha256;
}

function attachmentDeclaresRepository(
  snapshot: ProjectAttachmentSnapshot,
  repositoryFullName: string,
): boolean {
  return snapshot.contract.repositories.some((declared) => {
    const normalized = normalizeRepositoryRemote(declared);
    if (normalized === null) return false;
    try {
      return normalizeGitHubRepository(normalized) === repositoryFullName;
    } catch {
      return false;
    }
  });
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
  label: string,
): DataRecord {
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
  const output = Object.create(null) as DataRecord;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactOperation(value: unknown): GitHubIssueProviderOperation {
  if (
    typeof value !== "string"
    || !receiptProducingOperations.has(value as GitHubIssueProviderOperation)
  ) {
    throw new RangeError(
      "GitHub provider instruction observation operation is invalid",
    );
  }
  return value as GitHubIssueProviderOperation;
}

function exactSlug(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !slugPattern.test(value)
    || credentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function canonicalRepository(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError(
      "GitHub provider instruction observation repository is invalid",
    );
  }
  const repository = normalizeGitHubRepository(value);
  if (repository !== value) {
    throw new RangeError(
      "GitHub provider instruction observation repository must be canonical lowercase",
    );
  }
  if (credentialPattern.test(repository)) {
    throw new RangeError(
      "GitHub provider instruction observation repository is invalid",
    );
  }
  return repository;
}

function canonicalExternalId(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError(
      "GitHub provider instruction observation issue identity is invalid",
    );
  }
  const externalId = parseGitHubIssueExternalId(value).externalId;
  if (externalId !== value) {
    throw new RangeError(
      "GitHub provider instruction observation issue identity must be canonical",
    );
  }
  return externalId;
}

function exactIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length === 0
    || value.length > maximum
    || !identifierPattern.test(value)
    || credentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactRevision(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length === 0
    || value.length > maximum
    || !revisionPattern.test(value)
    || credentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function nullableRevision(value: unknown, label: string): string | null {
  return value === null ? null : exactRevision(value, label, 512);
}

function exactSafeText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length === 0
    || value.length > maximum
    || unsafeTextPattern.test(value)
    || credentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !timestampPattern.test(value)
    || new Date(value).toISOString() !== value
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
