export interface ProjectAttachmentRepositoryVerificationController {
  sync(): Promise<void>;
  destroy(): void;
}

export interface ProjectAttachmentRepositoryVerificationResult {
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly sourcePath: string;
  readonly commitSha: string;
  readonly sourceContentSha256: string;
  readonly attachmentId: string;
  readonly attachmentSnapshotSha256: string;
}

export function installProjectAttachmentRepositoryVerification(): ProjectAttachmentRepositoryVerificationController | null;

export function readRepositoryVerification(
  payload: unknown,
  expected: {
    project: string;
    repositoryFullName: string;
    defaultBranch: string;
  },
): ProjectAttachmentRepositoryVerificationResult;
