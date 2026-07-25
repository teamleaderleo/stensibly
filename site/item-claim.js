import './actor-activity-controller.js';
import './board-filter-controller.js';
import './project-brief-controller.js';
import './item-progress-controller.js';
import './item-block-controller.js';
import './item-complete-controller.js';
import './item-handoff-controller.js';
import './item-handoff-history-controller.js';
import { createIdempotencyTracker } from './item-create.js';
import { validateActor } from './session-context.js';

export function validateClaimInput(itemId, leaseSeconds, actor) {
  const id = requiredString(itemId, 'Item ID is required.', 240);
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('Choose an active session actor before claiming work.');
  }
  const lease = Number(leaseSeconds);
  if (!Number.isInteger(lease) || lease < 30 || lease > 86_400) {
    throw new TypeError('Lease duration must be a whole number from 30 to 86400 seconds.');
  }
  return {
    id,
    actor: validateActor(actor),
    leaseSeconds: lease,
  };
}

export function readClaimedItem(payload, expectedItemId = '', expectedActorId = '') {
  if (!isRecord(payload) || !isRecord(payload.item)) {
    throw new TypeError('The endpoint returned an incompatible claimed-item response.');
  }
  const item = payload.item;
  const id = requiredString(item.id, 'The claimed item is missing id.', 240);
  if (expectedItemId && id !== expectedItemId) {
    throw new TypeError('The endpoint returned a different claimed item.');
  }
  const status = requiredString(item.status, 'The claimed item is missing status.', 40);
  const claimedBy = requiredString(item.claimedBy, 'The claimed item is missing its claimant.', 120);
  const claimExpiresAt = requiredString(item.claimExpiresAt, 'The claimed item is missing its lease expiry.', 120);
  if (status !== 'active') throw new TypeError('The claimed item did not become active.');
  if (expectedActorId && claimedBy !== expectedActorId) {
    throw new TypeError('The endpoint returned a different claimant.');
  }
  if (Number.isNaN(Date.parse(claimExpiresAt))) {
    throw new TypeError('The claimed item returned an invalid lease expiry.');
  }
  return { id, status, claimedBy, claimExpiresAt };
}

export function createClaimIdempotencyTracker(generateKey) {
  return createIdempotencyTracker(generateKey);
}

export function describeClaim(item, actor, now = Date.now()) {
  if (!item || typeof item !== 'object') return 'Claim state unavailable.';
  const claimant = typeof item.claimedBy === 'string' ? item.claimedBy.trim() : '';
  const expiry = typeof item.claimExpiresAt === 'string' ? item.claimExpiresAt.trim() : '';
  if (!claimant) return 'This item has no current claimant.';
  const owner = actor?.id === claimant ? 'the active actor' : claimant;
  if (!expiry) return `Held by ${owner} without a reported lease expiry.`;
  const parsed = Date.parse(expiry);
  if (Number.isNaN(parsed)) return `Held by ${owner}; the lease expiry is invalid.`;
  if (parsed <= now) return `The reported lease for ${owner} has expired. The server will decide whether takeover is allowed.`;
  return `Held by ${owner} until ${new Date(parsed).toLocaleString()}.`;
}

export function leaseRenewalAvailability(item, actor, now = Date.now()) {
  if (!actor || typeof actor !== 'object') {
    return { available: false, message: 'Choose an active session actor before renewing a lease.' };
  }
  if (!item || typeof item !== 'object') {
    return { available: false, message: 'Lease renewal state is unavailable.' };
  }
  const status = typeof item.status === 'string' ? item.status.trim() : '';
  const claimant = typeof item.claimedBy === 'string' ? item.claimedBy.trim() : '';
  const expiry = typeof item.claimExpiresAt === 'string' ? item.claimExpiresAt.trim() : '';
  if (status !== 'active' || !claimant) {
    return { available: false, message: 'Only an active claimed item has a renewable lease.' };
  }
  if (claimant !== actor.id) {
    return { available: false, message: `Only the current holder (${claimant}) can renew this lease.` };
  }
  if (!expiry) {
    return { available: false, message: 'The current lease has no reported expiry and cannot be renewed from the dashboard.' };
  }
  const parsed = Date.parse(expiry);
  if (Number.isNaN(parsed)) {
    return { available: false, message: 'The current lease expiry is invalid and cannot be renewed from the dashboard.' };
  }
  if (parsed <= now) {
    return { available: false, message: 'The reported lease has expired. Refresh to let the server reconcile the claim before taking another action.' };
  }
  return {
    available: true,
    message: `Current lease ends ${new Date(parsed).toLocaleString()}. Renewal starts a fresh duration from server time.`,
  };
}

function requiredString(value, message, maxLength) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output) throw new TypeError(message);
  if (/stn\.tok_/i.test(output)) throw new TypeError('Credential-shaped values are not valid claim fields.');
  if (output.length > maxLength) throw new TypeError(`${message.replace(/\.$/, '')} (maximum ${maxLength} characters).`);
  return output;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => void import('./item-lease-state-controller.js'));
}
