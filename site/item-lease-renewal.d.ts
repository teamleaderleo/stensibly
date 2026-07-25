import type { ActorSession } from './session-context.js';

export interface LeaseRenewalPrincipal {
  capabilities: { write: boolean };
}

export interface LeaseRenewalConnection {
  endpoint: string;
  token: string;
  connected: boolean;
}

export interface LeaseRenewalController {
  section(item: Record<string, unknown>): HTMLElement;
  reset(): void;
  syncContext(): void;
  isInFlight(): boolean;
}

export function createLeaseRenewalController(options: {
  getConnection(): LeaseRenewalConnection;
  getContext(): { principal: LeaseRenewalPrincipal | null; actor: ActorSession | null };
  onChanged?(itemId: string): Promise<void>;
  reportConnectionIssue?(message: string): void;
  setBusy?(busy: boolean, label?: string): void;
  announce?(message: string): void;
}): LeaseRenewalController;
