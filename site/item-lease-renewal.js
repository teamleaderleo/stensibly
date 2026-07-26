import { createIdempotencyTracker } from './item-create.js';
import { validateActor } from './session-context.js';

export const LEASE_RENEW_OPERATION = 'renew';

const authorityStates = new Set(['unclaimed', 'live', 'expiring', 'expired', 'superseded']);
const authoritySources = new Set(['claim', 'dispatcher', 'none']);

export function readRenewalAuthority(payload, expectedItemId = '') {
  if (!isRecord(payload) || !isRecord(payload.item)) {
    throw new TypeError('The endpoint returned an incompatible item detail response.');
  }
  const itemId = requiredString(payload.item.id, 'The item detail response is missing an item ID.', 240);
  if (expectedItemId && itemId !== expectedItemId) {
    throw new TypeError('The endpoint returned authority for a different item.');
  }
  if (payload.control === undefined || payload.control === null) {
    return { status: 'absent', authority: null };
  }
  if (!isRecord(payload.control) || !isRecord(payload.control.authority)) {
    return { status: 'malformed', authority: null };
  }

  const authority = payload.control.authority;
  const state = text(authority.state);
  const source = text(authority.source);
  const holderActorId = nullableSafeString(authority.holderActorId, 120);
  const generation = nonNegativeInteger(authority.generation);
  const expiresAt = nullableTimestamp(authority.expiresAt);
  const allowedOperations = operationList(authority.allowedOperations);
  const approvalRequiredOperations = operationList(authority.approvalRequiredOperations);

  if (
    !authorityStates.has(state)
    || !authoritySources.has(source)
    || generation === null
    || allowedOperations === null
    || approvalRequiredOperations === null
    || holderActorId === undefined
    || expiresAt === undefined
  ) {
    return { status: 'malformed', authority: null };
  }

  return {
    status: 'available',
    authority: {
      state,
      holderActorId,
      generation,
      expiresAt,
      source,
      allowedOperations,
      approvalRequiredOperations,
    },
  };
}

export function leaseRenewalAvailability(authorityResult, actor, now = Date.now()) {
  if (!actor || typeof actor !== 'object') {
    return { available: false, message: 'Choose an active session actor before renewing a lease.' };
  }
  if (!authorityResult || authorityResult.status === 'absent') {
    return {
      available: false,
      message: 'Renewal awaits the server-owned authority view. Refresh after the claim-generation contract is available.',
    };
  }
  if (authorityResult.status !== 'available' || !authorityResult.authority) {
    return {
      available: false,
      message: 'The server authority view is incompatible. Refresh after the API and dashboard are on matching versions.',
    };
  }

  const authority = authorityResult.authority;
  if (!['live', 'expiring'].includes(authority.state)) {
    return {
      available: false,
      message: authority.state === 'expired'
        ? 'The server reports this claim as expired. Refresh before taking another action.'
        : 'The server does not report a renewable live claim.',
    };
  }
  if (!authority.holderActorId) {
    return { available: false, message: 'The server authority view has no current holder.' };
  }
  if (authority.holderActorId !== actor.id) {
    return {
      available: false,
      message: `Only the current holder (${authority.holderActorId}) can renew this lease.`,
    };
  }
  if (!authority.allowedOperations.includes(LEASE_RENEW_OPERATION)) {
    return {
      available: false,
      message: 'The server currently withholds lease renewal for this authority generation.',
    };
  }
  if (!authority.expiresAt) {
    return { available: false, message: 'The server authority view has no lease expiry.' };
  }
  const expiresAt = Date.parse(authority.expiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= now) {
    return {
      available: false,
      message: 'The displayed authority has reached its expiry. Refresh to load the current server generation.',
    };
  }

  return {
    available: true,
    message: `Current server authority generation ${authority.generation} ends ${new Date(expiresAt).toLocaleString()}. Renewal starts a fresh duration from server time.`,
  };
}

export function validateLeaseRenewalInput(itemId, leaseSeconds, actor, expectedClaimGeneration) {
  const id = requiredString(itemId, 'Item ID is required.', 240);
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('Choose an active session actor before renewing a lease.');
  }
  const lease = Number(leaseSeconds);
  if (!Number.isInteger(lease) || lease < 30 || lease > 86_400) {
    throw new TypeError('Lease duration must be a whole number from 30 to 86400 seconds.');
  }
  const generation = nonNegativeInteger(expectedClaimGeneration);
  if (generation === null) {
    throw new TypeError('The server-provided expected claim generation is required.');
  }
  return {
    id,
    actor: validateActor(actor),
    leaseSeconds: lease,
    expectedClaimGeneration: generation,
  };
}

export function readRenewedItem(
  payload,
  expectedItemId = '',
  expectedActorId = '',
  expectedPreviousGeneration = -1,
) {
  if (!isRecord(payload) || !isRecord(payload.item)) {
    throw new TypeError('The endpoint returned an incompatible renewed-item response.');
  }
  const item = payload.item;
  const id = requiredString(item.id, 'The renewed item is missing id.', 240);
  const status = requiredString(item.status, 'The renewed item is missing status.', 40);
  const claimedBy = requiredString(item.claimedBy, 'The renewed item is missing its claimant.', 120);
  const claimExpiresAt = requiredString(item.claimExpiresAt, 'The renewed item is missing its lease expiry.', 120);
  const claimGeneration = nonNegativeInteger(item.claimGeneration);
  if (expectedItemId && id !== expectedItemId) throw new TypeError('The endpoint returned a different renewed item.');
  if (status !== 'active') throw new TypeError('The renewed item did not remain active.');
  if (expectedActorId && claimedBy !== expectedActorId) throw new TypeError('The endpoint returned a different claimant.');
  if (Number.isNaN(Date.parse(claimExpiresAt))) throw new TypeError('The renewed item returned an invalid lease expiry.');
  if (claimGeneration === null || claimGeneration <= expectedPreviousGeneration) {
    throw new TypeError('The renewed item did not advance the claim generation.');
  }
  return { id, status, claimedBy, claimExpiresAt, claimGeneration };
}

export function createLeaseRenewalIdempotencyTracker(generateKey) {
  return createIdempotencyTracker(generateKey);
}

function operationList(value) {
  if (!Array.isArray(value) || value.length > 32) return null;
  const operations = [];
  for (const entry of value) {
    const operation = typeof entry === 'string' ? entry.trim() : '';
    if (!operation || operation.length > 80 || /stn\.tok_/i.test(operation)) return null;
    operations.push(operation);
  }
  return [...new Set(operations)];
}

function nullableSafeString(value, maxLength) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const output = value.trim();
  if (!output || output.length > maxLength || /stn\.tok_/i.test(output)) return undefined;
  return output;
}

function nullableTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) return undefined;
  return value.trim();
}

function requiredString(value, message, maxLength) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output) throw new TypeError(message);
  if (/stn\.tok_/i.test(output)) throw new TypeError('Credential-shaped values are not valid renewal fields.');
  if (output.length > maxLength) throw new TypeError(`${message.replace(/\.$/, '')} (maximum ${maxLength} characters).`);
  return output;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
