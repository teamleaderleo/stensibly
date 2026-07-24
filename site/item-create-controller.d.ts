import type { CreatedItem } from './item-create.js';
import type { ActorSession, PrincipalContext } from './session-context.js';

export interface ItemCreateController {
  sync(): void;
  reset(options?: { announce?: string }): void;
}

export function createItemCreateController(options: {
  getConnection(): { endpoint: string; token: string; connected: boolean };
  getContext(): { principal: PrincipalContext | null; actor: ActorSession | null };
  getSelectedProject(): string;
  onCreated(item: CreatedItem): Promise<void> | void;
  reportConnectionIssue(message: string): void;
}): ItemCreateController;
