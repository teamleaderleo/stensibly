import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import type {
  ProjectRepositorySetupObservationRecord,
} from "./project-repository-setup-observation.js";
import {
  compareProjectAttachments,
  compileProjectContract,
  type ProjectAttachmentDiff,
  type ProjectAttachmentSnapshot,
} from "./project-contract.js";

export const PROJECT_ATTACHMENT_REVIEW_VERSION = 1 as const;

export interface PrepareProjectAttachmentReviewInput {
  project: string;
  proposal: ProjectRepositorySetupObservationRecord;
  source: string;
  sourceRevision: string;
  currentAttachment: ProjectAttachmentRecord | null;
}

export interface ProjectAttachmentReview {
  readonly version: typeof PROJECT_ATTACHMENT_REVIEW_VERSION;
  readonly project: string;
  readonly proposalId: string;
  readonly proposalSemanticFingerprint: string;
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly sourceRevision: string;
  readonly snapshot: ProjectAttachmentSnapshot;
  readonly diff: ProjectAttachmentDiff | null;
  readonly requiresAuthorityWidening: boolean;
  readonly exactReplay: boolean;
  readonly authorizesAttachmentAcceptance: false;
  readonly authorizesProviderEffect: false;
  readonly containsSecrets: false;
}

export function prepareProjectAttachmentReview(
  input: PrepareProjectAttachmentReviewInput,
): ProjectAttachmentReview {
  const project = exactProject(input.project);
  const proposal = input.proposal;
  if (
    proposal.project !== project
    || proposal.authorizesProviderEffect !== false
    || proposal.containsSecrets !== false
  ) {
    throw new RangeError("Repository setup proposal does not match the selected project");
  }
  const sourceRevision = exactSourceRevision(input.sourceRevision);
  if (typeof input.source !== "string" || input.source.length < 1) {
    throw new RangeError("STENSIBLY.md source is required");
  }

  const snapshot = compileProjectContract(input.source);
  if (snapshot.contract.project !== project) {
    throw new RangeError("STENSIBLY.md project does not match the selected project");
  }
  if (!snapshot.contract.repositories.includes(proposal.repositoryFullName)) {
    throw new RangeError("STENSIBLY.md does not include the saved repository proposal");
  }

  const current = input.currentAttachment;
  if (current && current.project !== project) {
    throw new RangeError("Current project attachment does not match the selected project");
  }
  const exactReplay = current?.snapshot.snapshotSha256 === snapshot.snapshotSha256
    && current.sourceRevision === sourceRevision;
  const diff = current && !exactReplay
    ? compareProjectAttachments(current.snapshot, snapshot)
    : null;
  const requiresAuthorityWidening = current === null
    ? true
    : diff?.widensAuthority === true;

  return deepFreeze({
    version: PROJECT_ATTACHMENT_REVIEW_VERSION,
    project,
    proposalId: proposal.id,
    proposalSemanticFingerprint: proposal.semanticFingerprint,
    repositoryFullName: proposal.repositoryFullName,
    defaultBranch: proposal.defaultBranch,
    sourceRevision,
    snapshot,
    diff,
    requiresAuthorityWidening,
    exactReplay,
    authorizesAttachmentAcceptance: false,
    authorizesProviderEffect: false,
    containsSecrets: false,
  });
}

function exactProject(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError("Project must be an exact lowercase slug up to 80 characters");
  }
  return value;
}

function exactSourceRevision(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 240
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError("STENSIBLY.md source revision is invalid");
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
