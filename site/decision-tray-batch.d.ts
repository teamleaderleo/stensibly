export type BatchOutcome = 'completed' | 'unblocked' | 'failed';

export interface BatchResult {
  id: string;
  outcome: BatchOutcome;
}

export interface BatchSummary {
  attempted: number;
  completed: number;
  unblocked: number;
  failed: number;
  staleCount: number;
  resolved: number;
  allResolved: boolean;
  summaryLine: string;
}

export declare const BATCH_OUTCOMES: readonly BatchOutcome[];

export declare function collectRenderedBlockedIds(visibleItems: unknown): string[];

export declare function reconcileBatchTargets(
  renderedIds: unknown,
  isStillVisibleBlockedItem: (id: string) => boolean,
): { targets: string[]; stale: string[] };

export declare function summarizeBatchResults(
  results: unknown,
  options?: { staleCount?: number },
): BatchSummary;
