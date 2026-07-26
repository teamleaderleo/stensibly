import { createIdempotencyTracker } from './item-create.js';
import { validateActor } from './session-context.js';

export function validateHandoffInput(
  itemId,
  summary,
  nextAction,
  toActorId,
  actor,
  expectedClaimGeneration,
) {
  const id = requiredString(itemId, 'Item ID is required.', 240);
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('Choose an active session actor before handing off work.');
  }
  const generation = nonNegativeInteger(expectedClaimGeneration);
  if (generation === null) {
    throw new TypeError('Refresh item detail to load the current claim generation before handing off work.');
  }
  const handoffSummary = requiredString(summary, 'Handoff summary is required.', 10_000);
  const handoffNextAction = requiredString(nextAction, 'Handoff next action is required.', 2_000);
  const targetActorId = optionalString(toActorId, 120, 'Target actor ID');
  return {
    id,
    actor: validateActor(actor),
    action: 'handoff',
    expectedClaimGeneration: generation,
    summary: handoffSummary,
    nextAction: handoffNextAction,
    ...(targetActorId ? { toActorId: targetActorId } : {}),
  };
}

export function readHandedOffItem(payload, expected = {}) {
  if (!isRecord(payload) || !isRecord(payload.item) || !isRecord(expected)) {
    throw new TypeError('The endpoint returned an incompatible handed-off item response.');
  }
  const item = payload.item;
  const id = requiredString(item.id, 'The handed-off item is missing id.', 240);
  if (expected.id && id !== expected.id) {
    throw new TypeError('The endpoint returned a different handed-off item.');
  }
  const status = requiredString(item.status, 'The handed-off item is missing status.', 40);
  if (status !== 'ready') throw new TypeError('The handed-off item did not become ready.');
  if (item.claimedBy !== null || item.claimExpiresAt !== null) {
    throw new TypeError('The handed-off item did not release its claim.');
  }
  if (!Number.isInteger(item.version) || item.version < 1) {
    throw new TypeError('The handed-off item returned an invalid version.');
  }
  const previousGeneration = nonNegativeInteger(expected.expectedClaimGeneration);
  if (previousGeneration === null || item.claimGeneration !== previousGeneration + 1) {
    throw new TypeError('The handed-off item did not advance the claim generation exactly once.');
  }
  const summary = requiredString(item.summary, 'The handed-off item is missing summary.', 10_000);
  const nextAction = requiredString(item.nextAction, 'The handed-off item is missing next action.', 2_000);
  if (expected.summary && summary !== expected.summary) {
    throw new TypeError('The endpoint returned a different handoff summary.');
  }
  if (expected.nextAction && nextAction !== expected.nextAction) {
    throw new TypeError('The endpoint returned a different handoff next action.');
  }
  return {
    id,
    status,
    summary,
    nextAction,
    claimGeneration: item.claimGeneration,
    version: item.version,
  };
}

export function createHandoffIdempotencyTracker(generateKey) {
  return createIdempotencyTracker(generateKey);
}

export function canHandoffStatus(status) {
  return status === 'ready' || status === 'active' || status === 'blocked';
}

export function handoffEventLabel(type) {
  return type === 'work.handed_off' ? 'Handoff · work.handed_off' : type;
}

function requiredString(value, message, maxLength) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output) throw new TypeError(message);
  rejectCredential(output);
  if (output.length > maxLength) {
    throw new TypeError(`${message.replace(/\.$/, '')} (maximum ${maxLength} characters).`);
  }
  return output;
}

function optionalString(value, maxLength, label) {
  const output = typeof value === 'string' ? value.trim() : '';
  rejectCredential(output);
  if (output.length > maxLength) throw new TypeError(`${label} may contain at most ${maxLength} characters.`);
  return output;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function rejectCredential(value) {
  if (/stn\.tok_/i.test(value)) throw new TypeError('Credential-shaped values are not valid handoff fields.');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
