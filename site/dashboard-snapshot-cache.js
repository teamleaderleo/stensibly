export const DASHBOARD_SNAPSHOT_STORAGE_KEY = 'stensiblyDashboardSnapshotV1';
export const DASHBOARD_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_ITEMS = 240;
const MAX_SERIALIZED_BYTES = 512 * 1024;
const validStatuses = new Set(['ready', 'active', 'blocked', 'done']);
const unsafeTextPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export function readDashboardSnapshot(storage, {
  endpoint,
  now = Date.now(),
  maximumAgeMs = DASHBOARD_SNAPSHOT_MAX_AGE_MS,
} = {}) {
  try {
    if (!storage || !validOrigin(endpoint) || !Number.isFinite(now) || now < 0) return null;
    const raw = storage.getItem(DASHBOARD_SNAPSHOT_STORAGE_KEY);
    if (!raw || byteLength(raw) > MAX_SERIALIZED_BYTES) return null;
    const parsed = JSON.parse(raw);
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || parsed.endpoint !== new URL(endpoint).origin
      || typeof parsed.savedAt !== 'string'
      || !Array.isArray(parsed.items)
      || parsed.items.length > MAX_ITEMS
    ) return null;
    const savedAtMs = Date.parse(parsed.savedAt);
    if (!Number.isFinite(savedAtMs) || savedAtMs > now + 60_000 || now - savedAtMs > maximumAgeMs) return null;
    const items = parsed.items.map(readCachedItem);
    if (items.some((item) => item === null)) return null;
    return Object.freeze({
      version: 1,
      endpoint: parsed.endpoint,
      savedAt: new Date(savedAtMs).toISOString(),
      items: Object.freeze(items),
    });
  } catch {
    return null;
  }
}

export function persistDashboardSnapshot(storage, { endpoint, items, savedAt = new Date().toISOString() } = {}) {
  try {
    if (!storage || !validOrigin(endpoint) || !Array.isArray(items) || items.length > MAX_ITEMS) return false;
    const savedAtMs = Date.parse(savedAt);
    if (!Number.isFinite(savedAtMs)) return false;
    const cachedItems = items.map(readCachedItem);
    if (cachedItems.some((item) => item === null)) return false;
    const serialized = JSON.stringify({
      version: 1,
      endpoint: new URL(endpoint).origin,
      savedAt: new Date(savedAtMs).toISOString(),
      items: cachedItems,
    });
    if (byteLength(serialized) > MAX_SERIALIZED_BYTES) return false;
    storage.setItem(DASHBOARD_SNAPSHOT_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearDashboardSnapshot(storage) {
  try {
    storage?.removeItem(DASHBOARD_SNAPSHOT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function readCachedItem(value) {
  if (!isRecord(value)) return null;
  const item = {
    id: boundedText(value.id, 200),
    project: boundedText(value.project, 80),
    kind: boundedText(value.kind, 40),
    title: boundedText(value.title, 240),
    summary: nullableText(value.summary, 10_000),
    nextAction: nullableText(value.nextAction, 2_000),
    status: boundedText(value.status, 16),
    priority: boundedInteger(value.priority, 0, 100),
    claimedBy: nullableText(value.claimedBy, 120),
    claimExpiresAt: nullableTimestamp(value.claimExpiresAt),
    claimGeneration: boundedInteger(value.claimGeneration, 0, Number.MAX_SAFE_INTEGER),
    version: boundedInteger(value.version, 0, Number.MAX_SAFE_INTEGER),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
  if (
    Object.values(item).some((entry) => entry === undefined)
    || !validStatuses.has(item.status)
  ) return null;
  return Object.freeze(item);
}

function boundedText(value, maximum) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maximum
    || unsafeTextPattern.test(normalized)
    || /stn\.tok_/i.test(normalized)
  ) return undefined;
  return normalized;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  return boundedText(value, maximum);
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(Date.parse(value)).toISOString();
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  return timestamp(value);
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function validOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
