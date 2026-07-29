export interface ProviderCapacityScope {
  repository: string;
  subjectLogin: string;
}

export type ProviderCapacityState = "available" | "unavailable" | "unknown";
export type ProviderCapacityReason =
  | "quota_exhausted"
  | "provider_reported_unavailable"
  | "not_observed"
  | "observation_stale"
  | "refill_window_elapsed"
  | null;

export interface ProviderCapacitySource {
  pullRequestNumber: number;
  commentId: string;
}

export interface ProviderCapacity {
  provider: "coderabbit";
  repository: string;
  subjectLogin: string;
  subjectBasis: "pull_request_author_proxy";
  state: ProviderCapacityState;
  reason: ProviderCapacityReason;
  remaining: number | null;
  limit: number | null;
  observedAt: string | null;
  receivedAt: string | null;
  staleAt: string | null;
  refillAt: string | null;
  nextAvailableAt: string | null;
  source: ProviderCapacitySource | null;
}

export interface ProviderCapacityDescription {
  statusLabel: ProviderCapacityState;
  quota: string;
  evidenceAge: string;
  timing: string;
  scope: string;
  sourceLabel: string;
  sourceHref: string | null;
}

export function validateProviderCapacityScope(value: unknown): ProviderCapacityScope;
export function readProviderCapacity(
  payload: unknown,
  expectedScope: ProviderCapacityScope,
): ProviderCapacity;
export function describeProviderCapacity(
  capacity: ProviderCapacity,
  now?: number,
): ProviderCapacityDescription;
