import { createIdempotencyTracker } from './item-create.js';
import { validateActor } from './session-context.js';

export function validateBlockInput(itemId, reason, nextAction, actor) {
  return {
    id: requiredString(itemId, 'Item ID is required.', 240),
    actor: requireActor(actor),
    action: 'block',
    reason: requiredString(reason, 'Block reason is required.', 10_000),
    ...optionalField('nextAction', nextAction, 2_000, 'Next action'),
  };
}

export function validateUnblockInput(itemId, nextAction, actor) {
  return {
    id: requiredString(itemId, 'Item ID is required.', 240),
    actor: requireActor(actor),
    action: 'unblock',
    ...optionalField('nextAction', nextAction, 2_000, 'Next action'),
  };
}

export function readTransitionItem(payload, expected) {
  if (!isRecord(payload) || !isRecord(payload.item) || !isRecord(expected)) {
    throw new TypeError('The endpoint returned an incompatible transition response.');
  }
  const item = payload.item;
  const id = requiredString(item.id, 'The transitioned item is missing id.', 240);
  if (expected.id && id !== expected.id) throw new TypeError('The endpoint returned a different transitioned item.');
  const status = requiredString(item.status, 'The transitioned item is missing status.', 40);
  const summary = nullableString(item.summary, 10_000, 'Summary');
  const nextAction = nullableString(item.nextAction, 2_000, 'Next action');
  if (item.claimedBy !== null || item.claimExpiresAt !== null) {
    throw new TypeError('The transitioned item did not release its claim.');
  }
  if (!Number.isInteger(item.version) || item.version < 1) {
    throw new TypeError('The transitioned item returned an invalid version.');
  }

  if (expected.action === 'block') {
    if (status !== 'blocked') throw new TypeError('The item did not become blocked.');
    if (summary !== expected.reason) throw new TypeError('The endpoint returned a different block reason.');
  } else if (expected.action === 'unblock') {
    if (status !== 'ready') throw new TypeError('The item did not become ready.');
  } else {
    throw new TypeError('The transition action is unsupported.');
  }
  if (expected.nextAction && nextAction !== expected.nextAction) {
    throw new TypeError('The endpoint returned a different next action.');
  }
  return { id, status, summary, nextAction, version: item.version };
}

export function createTransitionIdempotencyTracker(generateKey) {
  return createIdempotencyTracker(generateKey);
}

export function transitionForStatus(status) {
  if (status === 'ready' || status === 'active') return 'block';
  if (status === 'blocked') return 'unblock';
  return null;
}

function requireActor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('Choose an active session actor before changing work state.');
  }
  return validateActor(actor);
}

function optionalField(name, value, maxLength, label) {
  const output = optionalString(value, maxLength, label);
  return output ? { [name]: output } : {};
}

function requiredString(value, message, maxLength) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output) throw new TypeError(message);
  rejectCredential(output);
  if (output.length > maxLength) throw new TypeError(`${message.replace(/\.$/, '')} (maximum ${maxLength} characters).`);
  return output;
}

function optionalString(value, maxLength, label) {
  const output = typeof value === 'string' ? value.trim() : '';
  rejectCredential(output);
  if (output.length > maxLength) throw new TypeError(`${label} may contain at most ${maxLength} characters.`);
  return output;
}

function nullableString(value, maxLength, label) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`The transitioned item returned an invalid ${label.toLowerCase()}.`);
  const output = value.trim();
  rejectCredential(output);
  if (output.length > maxLength) throw new TypeError(`The transitioned item returned an invalid ${label.toLowerCase()}.`);
  return output || null;
}

function rejectCredential(value) {
  if (/stn\.tok_/i.test(value)) throw new TypeError('Credential-shaped values are not valid transition fields.');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
