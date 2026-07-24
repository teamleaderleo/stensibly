import type { ActorSession } from './session-context.js';

export type LeaseState = 'none' | 'healthy' | 'expiring' | 'expired' | 'invalid';

export interface LeaseClassification {
  state: LeaseState;
  claimant: string | null;
  expiresAt: string | null;
  secondsRemaining: number | null;
}

export const DEFAULT_EXPIRING_WITHIN_MS: number;

export function classifyLease(
  item: unknown,
  now?: number,
  expiringWithinMs?: number,
): LeaseClassification;

export function describeLease(
  item: unknown,
  actor?: ActorSession | null,
  now?: number,
  expiringWithinMs?: number,
): string;

export function actionEmptyState(
  action: 'claim' | 'transition' | 'complete' | string,
  status: string,
  canWrite: boolean,
  hasActor: boolean,
): string | null;
