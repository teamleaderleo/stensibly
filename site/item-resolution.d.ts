import type { ActorSession } from './session-context.js';

export type TrayResolutionOutcome = 'completed' | 'unblocked' | 'failed';

export interface CompleteRequestBody {
  id: string;
  actor: ActorSession;
  action: 'complete';
  expectedClaimGeneration: number;
  summary?: string;
}

export interface UnblockRequestBody {
  id: string;
  actor: ActorSession;
  action: 'unblock';
  expectedClaimGeneration: number;
  nextAction?: string;
}

export interface ConflictShape {
  status: number;
  code: string;
  message: string;
}

export interface TrayItemSnapshot {
  id?: unknown;
  status?: unknown;
  claimGeneration?: unknown;
}

export interface ItemActionResolutionContext {
  endpoint: string;
  token: string;
  itemId: string;
  item: TrayItemSnapshot | null | undefined;
  actor: unknown;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  generateKey?: () => string;
}

export declare function buildCompleteRequestBody(
  itemId: unknown,
  actor: unknown,
  expectedClaimGeneration: unknown,
): CompleteRequestBody;
export declare function buildUnblockRequestBody(
  itemId: unknown,
  actor: unknown,
  expectedClaimGeneration: unknown,
): UnblockRequestBody;
export declare function isBlockedTransitionRefusal(
  conflict: ConflictShape | null | undefined,
): boolean;
export declare function readConflictShape(response: Response): Promise<ConflictShape | null>;
export declare function resolveItemActionOutcome(
  context: ItemActionResolutionContext,
): Promise<TrayResolutionOutcome>;
