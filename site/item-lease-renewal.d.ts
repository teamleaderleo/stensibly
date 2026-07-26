import type { ActorSession } from './session-context.js';

export const LEASE_RENEW_OPERATION: 'renew';

export interface LeaseRenewalAuthority {
  state: 'unclaimed' | 'live' | 'expiring' | 'expired' | 'superseded';
  holderActorId: string | null;
  generation: number;
  expiresAt: string | null;
  source: 'claim' | 'dispatcher' | 'none';
  allowedOperations: string[];
  approvalRequiredOperations: string[];
}

export interface LeaseRenewalAuthorityResult {
  status: 'available' | 'absent' | 'malformed';
  authority: LeaseRenewalAuthority | null;
}

export interface LeaseRenewalAvailability {
  available: boolean;
  message: string;
}

export interface LeaseRenewalInput {
  id: string;
  actor: ActorSession;
  leaseSeconds: number;
  expectedClaimGeneration: number;
}

export interface RenewedItem {
  id: string;
  status: 'active';
  claimedBy: string;
  claimExpiresAt: string;
  claimGeneration: number;
}

export interface LeaseRenewalIdempotencyTracker {
  keyFor(value: unknown): string;
  reset(): void;
  current(): string;
}

export function readRenewalAuthority(payload: unknown, expectedItemId?: string): LeaseRenewalAuthorityResult;
export function leaseRenewalAvailability(
  authorityResult: LeaseRenewalAuthorityResult | null,
  actor: ActorSession | null,
  now?: number,
): LeaseRenewalAvailability;
export function validateLeaseRenewalInput(
  itemId: unknown,
  leaseSeconds: unknown,
  actor: ActorSession | null,
  expectedClaimGeneration: unknown,
): LeaseRenewalInput;
export function readRenewedItem(
  payload: unknown,
  expectedItemId?: string,
  expectedActorId?: string,
  expectedPreviousGeneration?: number,
): RenewedItem;
export function createLeaseRenewalIdempotencyTracker(
  generateKey?: () => string,
): LeaseRenewalIdempotencyTracker;
