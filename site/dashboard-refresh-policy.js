export const DASHBOARD_REFRESH_DELAYS_MS = [15000, 45000, 90000, 180000];
export const DASHBOARD_VISIBILITY_WAKE_MS = 1000;

export function dashboardItemsFingerprint(items) {
  if (!Array.isArray(items)) throw new TypeError('Dashboard items must be an array.');
  return [...items]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((item) => [item.id, item.version, item.status, item.updatedAt])
    .map((entry) => JSON.stringify(entry))
    .join('|');
}

export function normalizeDashboardRefreshLevel(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(
    DASHBOARD_REFRESH_DELAYS_MS.length - 1,
    Math.max(0, Math.trunc(parsed)),
  );
}

export function nextDashboardRefreshLevel({
  previousFingerprint,
  nextFingerprint,
  currentLevel,
  interactive = false,
  initial = false,
}) {
  const level = normalizeDashboardRefreshLevel(currentLevel);
  if (interactive || initial || !previousFingerprint || previousFingerprint !== nextFingerprint) {
    return 0;
  }
  return Math.min(level + 1, DASHBOARD_REFRESH_DELAYS_MS.length - 1);
}

export function dashboardRefreshDelay(level) {
  return DASHBOARD_REFRESH_DELAYS_MS[normalizeDashboardRefreshLevel(level)];
}

export function dashboardRefreshMode({ hidden, level, waking = false }) {
  if (hidden) return 'auto paused · hidden';
  if (waking) return 'auto · waking';
  return `auto · ${Math.round(dashboardRefreshDelay(level) / 1000)}s`;
}
