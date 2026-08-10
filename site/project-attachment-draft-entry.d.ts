export interface ProjectAttachmentDraftController {
  sync(): void;
  destroy(): void;
}

export function installProjectAttachmentDraftAction(): ProjectAttachmentDraftController | null;
export function createProjectAttachmentDraft(setup: unknown): string;
export function localDraftSourceRevision(source: string): Promise<string>;
