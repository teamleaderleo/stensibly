import type { ActorSession, PrincipalContext } from './session-context.js';

export interface ItemDetailController {
  reconcile(): void;
  reset(options?: { announce?: string }): void;
  close(): void;
  syncContext(): void;
}

export function createItemDetailController(options: {
  board: HTMLElement;
  getConnection(): { endpoint: string; token: string; connected: boolean };
  getItems(): Array<{ id?: string }>;
  getContext?(): { principal: PrincipalContext | null; actor: ActorSession | null };
  onChanged?(itemId: string): void | Promise<void>;
  reportConnectionIssue?(message: string): void;
}): ItemDetailController;
