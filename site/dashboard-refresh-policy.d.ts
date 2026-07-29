export const DASHBOARD_REFRESH_DELAYS_MS: number[];
export const DASHBOARD_VISIBILITY_WAKE_MS: number;

export interface DashboardRefreshItem {
  id: string;
  version: number;
  status: string;
  updatedAt: string;
}

export function dashboardItemsFingerprint(items: DashboardRefreshItem[]): string;
export function normalizeDashboardRefreshLevel(value: unknown): number;
export function nextDashboardRefreshLevel(input: {
  previousFingerprint: string;
  nextFingerprint: string;
  currentLevel: unknown;
  interactive?: boolean;
  initial?: boolean;
}): number;
export function dashboardRefreshDelay(level: unknown): number;
export function dashboardRefreshMode(input: {
  hidden: boolean;
  level: unknown;
  waking?: boolean;
}): string;
