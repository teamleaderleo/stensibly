export const MAX_ACTIVITY_ITEMS: number;
export const MAX_ACTIVITY_CONCURRENCY: number;
export const MAX_EVENTS_PER_ITEM: number;
export const MAX_ACTIVITY_EVENTS: number;

export interface ActivityCandidate {
  id: string;
  project: string;
  title: string;
  status: string;
}

export interface ActivityDetail {
  item: {
    id: string;
    project: string;
    title: string;
    status: string;
    claimedBy: string | null;
    updatedAt: string;
  };
  events: Array<{
    id: string;
    itemId: string;
    actorId: string | null;
    type: string;
    createdAt: string;
  }>;
}

export function normalizeActivityCandidates(values: unknown, limit?: number): ActivityCandidate[];
export function readActorActivityDetail(payload: unknown, expectedCandidate: unknown): ActivityDetail;
export function aggregateActorActivity(details: unknown[], generatedAt?: string): unknown;
export function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R> | R,
): Promise<R[]>;
