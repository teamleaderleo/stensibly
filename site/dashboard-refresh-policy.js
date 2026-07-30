export const DASHBOARD_REFRESH_DELAYS_MS = [15000, 45000, 90000, 180000];
export const DASHBOARD_VISIBILITY_WAKE_MS = 1000;

const REFRESH_STATE_KEY = 'stensiblyRefreshState';
const LEGACY_REFRESH_KEYS = ['stensiblyRefreshLevel', 'stensiblyItemsFingerprint'];
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const SECOND_OFFSET = 7809847782465536322n;
const SECOND_PRIME = 14029467366897019727n;

function hashEntries(entries) {
  let first = FNV_OFFSET;
  let second = SECOND_OFFSET;
  for (const entry of entries) {
    for (let index = 0; index < entry.length; index += 1) {
      const code = BigInt(entry.charCodeAt(index));
      first = BigInt.asUintN(64, (first ^ code) * FNV_PRIME);
      second = BigInt.asUintN(64, (second ^ (code + 1n)) * SECOND_PRIME);
    }
    first = BigInt.asUintN(64, (first ^ 31n) * FNV_PRIME);
    second = BigInt.asUintN(64, (second ^ 257n) * SECOND_PRIME);
  }
  return first.toString(16).padStart(16, '0')
    + second.toString(16).padStart(16, '0');
}

export function dashboardItemsFingerprint(items) {
  if (!Array.isArray(items)) throw new TypeError('Dashboard items must be an array.');
  const entries = items
    .map((item) => JSON.stringify([item.id, item.version, item.status, item.updatedAt]))
    .sort();
  return `v1:${items.length}:${hashEntries(entries)}`;
}

export function normalizeDashboardRefreshLevel(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return 0;
  return Math.min(DASHBOARD_REFRESH_DELAYS_MS.length - 1, Math.max(0, parsed));
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

export function readDashboardRefreshState(storage) {
  try {
    const raw = storage?.getItem(REFRESH_STATE_KEY);
    if (!raw) return { level: 0, fingerprint: '' };
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== 'fingerprint,level,version'
      || parsed.version !== 1
      || typeof parsed.fingerprint !== 'string'
      || !/^v1:\d{1,10}:[0-9a-f]{32}$/.test(parsed.fingerprint)
    ) {
      return { level: 0, fingerprint: '' };
    }
    return {
      level: normalizeDashboardRefreshLevel(parsed.level),
      fingerprint: parsed.fingerprint,
    };
  } catch {
    return { level: 0, fingerprint: '' };
  }
}

export function persistDashboardRefreshState(storage, state) {
  try {
    if (!storage) return false;
    storage.setItem(REFRESH_STATE_KEY, JSON.stringify({
      version: 1,
      level: normalizeDashboardRefreshLevel(state.level),
      fingerprint: state.fingerprint,
    }));
    for (const key of LEGACY_REFRESH_KEYS) storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function clearDashboardRefreshState(storage) {
  let cleared = true;
  for (const key of [REFRESH_STATE_KEY, ...LEGACY_REFRESH_KEYS]) {
    try {
      storage?.removeItem(key);
    } catch {
      cleared = false;
    }
  }
  return cleared;
}

export function acceptDashboardRefreshResult({
  storage,
  previousFingerprint,
  currentLevel,
  nextItems,
  interactive = false,
  initial = false,
}) {
  const fingerprint = dashboardItemsFingerprint(nextItems);
  const level = nextDashboardRefreshLevel({
    previousFingerprint,
    nextFingerprint: fingerprint,
    currentLevel,
    interactive,
    initial,
  });
  const state = { items: nextItems, level, fingerprint };
  return { ...state, persisted: persistDashboardRefreshState(storage, state) };
}

export function dashboardRefreshDelay(level) {
  return DASHBOARD_REFRESH_DELAYS_MS[normalizeDashboardRefreshLevel(level)];
}

export function dashboardRefreshMode({ hidden, level, waking = false }) {
  if (hidden) return 'auto paused · hidden';
  if (waking) return 'auto · waking';
  return `auto · ${Math.round(dashboardRefreshDelay(level) / 1000)}s`;
}
