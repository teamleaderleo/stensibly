import type {
  DashboardRepositoryAttachmentRecovery,
  DashboardRepositorySetupObservation,
} from "./project-setup-status.js";

export interface DashboardAttachmentReviewExpectation {
  project: string;
  proposalId: string;
  proposalSemanticFingerprint: string;
  repositoryFullName: string;
  defaultBranch: string;
  sourceRevision: string;
}

export interface DashboardAttachmentReview {
  readonly version: 1;
  readonly project: string;
  readonly proposalId: string;
  readonly proposalSemanticFingerprint: string;
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly sourceRevision: string;
  readonly snapshot: Readonly<Record<string, unknown>> & {
    readonly snapshotSha256: string;
  };
  readonly diff: Readonly<{
    from: string;
    to: string;
    widensAuthority: boolean;
    changes: readonly Readonly<{
      field: string;
      kind: "added" | "removed" | "changed";
      authorityEffect: "widens" | "narrows" | "neutral";
    }>[];
  }> | null;
  readonly requiresAuthorityWidening: boolean;
  readonly exactReplay: boolean;
  readonly authorizesAttachmentAcceptance: false;
  readonly authorizesProviderEffect: false;
  readonly containsSecrets: false;
}

export interface DashboardAcceptedAttachment {
  readonly id: string;
  readonly project: string;
  readonly sourceRevision: string;
  readonly snapshotSha256: string;
}

export function createRepositoryAttachmentDraft(input: {
  project: string;
  proposal: DashboardRepositorySetupObservation;
  recovery: DashboardRepositoryAttachmentRecovery;
}): string;

export function localDraftSourceRevision(source: string): Promise<string>;
export function reviewSource(value: unknown): string;
export function reviewSourceRevision(value: unknown): string;

export function readProjectAttachmentReview(
  payload: unknown,
  expected: DashboardAttachmentReviewExpectation,
): DashboardAttachmentReview;

export function readProjectAttachmentAcceptance(
  payload: unknown,
  review: DashboardAttachmentReview,
): Readonly<{
  attachment: DashboardAcceptedAttachment;
  replayed: boolean;
}>;

export function readAcceptedProjectAttachment(
  payload: unknown,
  review: DashboardAttachmentReview,
): DashboardAcceptedAttachment;
