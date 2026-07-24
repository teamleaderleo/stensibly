import type { ActorSession, PrincipalContext } from './session-context.js';

export interface SessionContextController {
  refresh(): Promise<void>;
  reset(): void;
  getActor(): ActorSession | null;
  getPrincipal(): PrincipalContext | null;
}

export function createSessionContextController(options: {
  getConnection(): { endpoint: string; token: string; connected: boolean };
  reportConnectionIssue(message: string): void;
  onChange?(): void;
}): SessionContextController;
