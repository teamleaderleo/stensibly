export interface DashboardConnectionFailure {
  kind: string;
  message: string;
}

export function isPlausibleToken(value: unknown): boolean;
export function normalizeEndpoint(value: unknown): string;
export function describeHttpFailure(status: number, payload: unknown): DashboardConnectionFailure;
export function readItems(payload: unknown): unknown[];
