export const DASHBOARD_REFRESH_DELAYS_MS: number[];
export const DASHBOARD_VISIBILITY_WAKE_MS: number;

export interface DashboardRefreshItem {
  id: string;
  version: number;
  status: string;
  updatedAt: string;
}

export interface DashboardRefreshStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DashboardRefreshState<T extends DashboardRefreshItem = DashboardRefreshItem> {
  items: T[];
  level: number;
  fingerprint: string;
}

export function dashboardItemsFingerprint<T extends DashboardRefreshItem>(items: T[]): string;
export function normalizeDashboardRefreshLevel(value: unknown): number;
export function nextDashboardRefreshLevel(input: {
  previousFingerprint: string;
  nextFingerprint: string;
  currentLevel: unknown;
  interactive?: boolean;
  initial?: boolean;
}): number;
export function readDashboardRefreshState(
  storage: DashboardRefreshStorage | null | undefined,
): Pick<DashboardRefreshState, "level" | "fingerprint">;
export function persistDashboardRefreshState(
  storage: DashboardRefreshStorage | null | undefined,
  state: Pick<DashboardRefreshState, "level" | "fingerprint">,
): boolean;
export function clearDashboardRefreshState(
  storage: DashboardRefreshStorage | null | undefined,
): boolean;
export function acceptDashboardRefreshResult<T extends DashboardRefreshItem>(input: {
  storage: DashboardRefreshStorage | null | undefined;
  previousFingerprint: string;
  currentLevel: unknown;
  nextItems: T[];
  interactive?: boolean;
  initial?: boolean;
}): DashboardRefreshState<T> & { persisted: boolean };
export function dashboardRefreshDelay(level: unknown): number;
export function dashboardRefreshMode(input: {
  hidden: boolean;
  level: unknown;
  waking?: boolean;
}): string;
