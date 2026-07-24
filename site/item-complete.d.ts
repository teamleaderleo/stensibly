import type { ActorSession } from './session-context.js';

export interface CompleteInput {
  id: string;
  actor: ActorSession;
  action: 'complete';
  summary?: string;
}

export interface CompletedItem {
  id: string;
  status: 'done';
  summary: string | null;
  version: number;
}

export interface IdempotencyTracker<T> {
  keyFor(input: T): string;
  reset(): void;
}

export function validateCompleteInput(
  itemId: unknown,
  summary: unknown,
  actor: unknown,
): CompleteInput;

export function readCompletedItem(
  payload: unknown,
  expected?: { id?: string; summary?: string | null },
): CompletedItem;

export function createCompleteIdempotencyTracker(
  generateKey?: () => string,
): IdempotencyTracker<CompleteInput>;

export function canCompleteStatus(status: unknown): boolean;
