export interface ProjectAttachmentReviewActionController {
  sync(): Promise<void>;
  destroy(): void;
}

export interface ProjectAttachmentReviewDiffChange {
  readonly field: string;
  readonly kind: "added" | "removed" | "changed";
  readonly authorityEffect: "widens" | "narrows" | "neutral";
}

export interface ProjectAttachmentReviewDiffIdentity {
  readonly from: string;
  readonly to: string;
  readonly widensAuthority: boolean;
  readonly changes: readonly ProjectAttachmentReviewDiffChange[];
}

export function installProjectAttachmentReviewAction(): ProjectAttachmentReviewActionController | null;

export function admitProjectAttachmentReviewSource(value: unknown): string;

export function admitProjectAttachmentReviewDiff(
  value: unknown,
  snapshotSha256: string,
  exactReplay?: boolean,
  requiresAuthorityWidening?: boolean,
): ProjectAttachmentReviewDiffIdentity | null;
