export interface ProjectAttachmentReviewActionController {
  sync(): Promise<void>;
  destroy(): void;
}

export function installProjectAttachmentReviewAction(): ProjectAttachmentReviewActionController | null;

export function admitProjectAttachmentReviewSource(value: unknown): string;
