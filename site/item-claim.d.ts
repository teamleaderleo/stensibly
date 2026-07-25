import type { ActorSession } from './session-context.js';

export interface ClaimInput {
  id: string;
  actor: ActorSession;
  leaseSeconds: number;
}

export interface ClaimedItem {
  id: string;
  status: 'active';
  claimedBy: string;
  claimExpiresAt: string;
}

export interface ClaimIdempotencyTracker {
  keyFor(value: unknown): string;
  reset(): void;
  current(): string;
}

export interface LeaseRenewalAvailability {
  available: boolean;
  message: string;
}

export function validateClaimInput(itemId: unknown, leaseSeconds: unknown, actor: ActorSession | null): ClaimInput;
export function readClaimedItem(payload: unknown, expectedItemId?: string, expectedActorId?: string): ClaimedItem;
export function createClaimIdempotencyTracker(generateKey?: () => string): ClaimIdempotencyTracker;
export function describeClaim(item: unknown, actor: ActorSession | null, now?: number): string;
export function leaseRenewalAvailability(
  item: unknown,
  actor: ActorSession | null,
  now?: number,
): LeaseRenewalAvailability;
