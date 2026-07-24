import type { ActorSession } from './session-context.js';

export interface CreateItemInput {
  project: string;
  kind: string;
  title: string;
  summary?: string;
  nextAction?: string;
  priority?: number | string;
}

export interface CreatedItem {
  id: string;
  project: string;
  title: string;
}

export interface IdempotencyTracker {
  keyFor(value: unknown): string;
  reset(): void;
  current(): string;
}

export function validateCreateItem(input: unknown, actor: ActorSession | null): Record<string, unknown>;
export function readCreatedItem(payload: unknown): CreatedItem;
export function formatValidationIssues(payload: unknown): string;
export function createIdempotencyTracker(generateKey?: () => string): IdempotencyTracker;
export function itemKinds(): string[];
