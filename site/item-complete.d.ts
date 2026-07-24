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
  nextAction: null;
  version: number;
}

export interface CompletionIdempotencyTracker {
  keyFor(value: unknown): string;
  reset(): void;
  current(): string;
}

export function validateCompleteInput(
  itemId: unknown,
  summary: unknown,
  actor: ActorSession | null,
): CompleteInput;
export function readCompletedItem(
  payload: unknown,
  expected: CompleteInput & { previousSummary?: string | null },
): CompletedItem;
export function createCompletionIdempotencyTracker(generateKey?: () => string): CompletionIdempotencyTracker;
export function canCompleteStatus(status: unknown): boolean;
