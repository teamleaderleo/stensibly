export const DEFAULT_EXPIRING_WITHIN_MS = 15 * 60 * 1000;

export function classifyLease(item, now = Date.now(), expiringWithinMs = DEFAULT_EXPIRING_WITHIN_MS) {
  if (!Number.isFinite(now)) throw new TypeError('Lease classification time must be valid.');
  if (!Number.isFinite(expiringWithinMs) || expiringWithinMs < 0) {
    throw new TypeError('Lease expiry window must be non-negative.');
  }
  if (!item || typeof item !== 'object') {
    return lease('invalid', null, null, null);
  }
  const status = text(item.status);
  const claimant = text(item.claimedBy);
  const expiresAt = text(item.claimExpiresAt);
  const hasAnyClaim = Boolean(claimant || expiresAt);

  if (status !== 'active') {
    return hasAnyClaim
      ? lease('invalid', claimant || null, expiresAt || null, null)
      : lease('none', null, null, null);
  }
  if (!claimant || !expiresAt) {
    return lease('invalid', claimant || null, expiresAt || null, null);
  }
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) {
    return lease('invalid', claimant, expiresAt, null);
  }
  const secondsRemaining = Math.floor((expiryMs - now) / 1000);
  if (expiryMs <= now) return lease('expired', claimant, expiresAt, secondsRemaining);
  if (expiryMs <= now + expiringWithinMs) {
    return lease('expiring', claimant, expiresAt, secondsRemaining);
  }
  return lease('healthy', claimant, expiresAt, secondsRemaining);
}

export function describeLease(item, actor, now = Date.now(), expiringWithinMs = DEFAULT_EXPIRING_WITHIN_MS) {
  const result = classifyLease(item, now, expiringWithinMs);
  if (result.state === 'none') return 'No active lease.';
  if (result.state === 'invalid') {
    if (text(item?.status) === 'active') {
      return 'This active item has incomplete or invalid lease fields. Refresh to inspect the latest server state.';
    }
    return 'This non-active item still reports claim data. Refresh to inspect the latest server state.';
  }
  const owner = actor?.id === result.claimant ? 'the active session actor' : result.claimant;
  const absolute = formatAbsolute(result.expiresAt);
  if (result.state === 'expired') {
    return `The displayed lease for ${owner} expired at ${absolute} (${formatDistance(result.secondsRemaining)} ago). The server decides recovery or takeover.`;
  }
  const remaining = formatDistance(result.secondsRemaining);
  if (result.state === 'expiring') {
    return `Lease held by ${owner} expires soon at ${absolute} (${remaining} remaining).`;
  }
  return `Lease held by ${owner} until ${absolute} (${remaining} remaining).`;
}

export function actionEmptyState(action, status, canWrite, hasActor) {
  if (!canWrite) return 'This token is read-only. Connect with a write-capable token to use this action.';
  if (!hasActor) return 'Choose an active session actor to use this action.';

  if (action === 'claim') {
    if (status === 'blocked') return 'Claim is unavailable while this item is blocked. Unblock it before claiming.';
    if (status === 'done') return 'This item is already done and cannot be claimed.';
    if (status === 'archived') return 'This item is archived and cannot be claimed.';
  }
  if (action === 'transition') {
    if (status === 'blocked') return null;
    if (status === 'ready' || status === 'active') return null;
    if (status === 'done') return 'Block and unblock are unavailable because this item is done.';
    if (status === 'archived') return 'Block and unblock are unavailable because this item is archived.';
  }
  if (action === 'complete') {
    if (status === 'done') return 'This item is already complete.';
    if (status === 'archived') return 'Archived work cannot be completed.';
  }
  return null;
}

function lease(state, claimant, expiresAt, secondsRemaining) {
  return { state, claimant, expiresAt, secondsRemaining };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatAbsolute(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? 'an invalid server time' : date.toLocaleString();
}

function formatDistance(seconds) {
  const total = Math.max(0, Math.abs(Number(seconds) || 0));
  if (total < 60) return 'less than a minute';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
