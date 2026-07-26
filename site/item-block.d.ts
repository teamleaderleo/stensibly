import type { ActorSession } from './session-context.js';

export interface BlockInput {
  id: string;
  actor: ActorSession;
  action: 'block';
  expectedClaimGeneration: number;
  reason: string;
  nextAction?: string;
}

export interface UnblockInput {
  id: string;
  actor: ActorSession;
  action: 'unblock';
  expectedClaimGeneration: number;
  nextAction?: string;
}

export interface TransitionedItem {
  id: string;
  status: 'blocked' | 'ready';
  summary: string | null;
  nextAction: string | null;
  claimGeneration: number;
  version: number;
}

export interface TransitionIdempotencyTracker {
  keyFor(value: unknown): string;
  reset(): void;
  current(): string;
}

export function validateBlockInput(
  itemId: unknown,
  reason: unknown,
  nextAction: unknown,
  actor: ActorSession | null,
  expectedClaimGeneration: unknown,
): BlockInput;
export function validateUnblockInput(
  itemId: unknown,
  nextAction: unknown,
  actor: ActorSession | null,
  expectedClaimGeneration: unknown,
): UnblockInput;
export function readTransitionItem(
  payload: unknown,
  expected: BlockInput | UnblockInput,
): TransitionedItem;
export function createTransitionIdempotencyTracker(generateKey?: () => string): TransitionIdempotencyTracker;
export function transitionForStatus(status: unknown): 'block' | 'unblock' | null;
