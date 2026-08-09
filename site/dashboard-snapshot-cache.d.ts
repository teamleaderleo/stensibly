export interface DashboardSnapshotItem {
  id: string;
  project: string;
  kind: string;
  title: string;
  summary: string | null;
  nextAction: string | null;
  status: "ready" | "active" | "blocked" | "done";
  priority: number;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  claimGeneration: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardSnapshot {
  version: 1;
  endpoint: string;
  savedAt: string;
  items: readonly DashboardSnapshotItem[];
}

export const DASHBOARD_SNAPSHOT_STORAGE_KEY: string;
export const DASHBOARD_SNAPSHOT_MAX_AGE_MS: number;
export function readDashboardSnapshot(
  storage: Pick<Storage, "getItem"> | null,
  options?: { endpoint?: string; now?: number; maximumAgeMs?: number },
): DashboardSnapshot | null;
export function persistDashboardSnapshot(
  storage: Pick<Storage, "setItem"> | null,
  input?: { endpoint?: string; items?: unknown[]; savedAt?: string },
): boolean;
export function clearDashboardSnapshot(storage: Pick<Storage, "removeItem"> | null): boolean;
