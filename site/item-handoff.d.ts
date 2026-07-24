import type { ActorSession } from './session-context.js';

export interface HandoffInput {
  id: string;
  actor: ActorSession;
  action: 'handoff';
  summary: string;
  nextAction: string;
  toActorId?: string;
}

export interface HandedOffItem {
  id: string;
  status: 'ready';
  summary: string;
  nextAction: string;
  version: number;
}

export function validateHandoffInput(
  itemId: unknown,
  summary: unknown,
  nextAction: unknown,
  toActorId: unknown,
  actor: unknown,
): HandoffInput;

export function readHandedOffItem(
  payload: unknown,
  expected?: { id?: string; summary?: string; nextAction?: string },
): HandedOffItem;

export function createHandoffIdempotencyTracker(generateKey?: () => string): {
  keyFor(input: HandoffInput): string;
  reset(): void;
};

export function canHandoffStatus(status: unknown): boolean;
export function handoffEventLabel(type: string): string;
