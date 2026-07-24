import type { ActorSession } from './session-context.js';

export declare const PROGRESS_EVENT_TYPE: 'item.progress';

export interface ProgressInput {
  id: string;
  actor: ActorSession;
  type: 'item.progress';
  payload: { summary: string; nextAction?: string };
}

export interface ProgressEvent {
  id: string;
  itemId: string;
  actorId: string;
  type: 'item.progress';
  createdAt: string;
}

export interface ProgressIdempotencyTracker {
  keyFor(value: unknown): string;
  reset(): void;
  current(): string;
}

export function validateProgressInput(
  itemId: unknown,
  summary: unknown,
  nextAction: unknown,
  actor: ActorSession | null,
): ProgressInput;
export function readProgressEvent(
  payload: unknown,
  expected?: { itemId?: string; actorId?: string; summary?: string; nextAction?: string },
): ProgressEvent;
export function createProgressIdempotencyTracker(generateKey?: () => string): ProgressIdempotencyTracker;
