import { createIdempotencyTracker } from './item-create.js';
import { validateActor } from './session-context.js';

export function validateCompleteInput(itemId, summary, actor, expectedClaimGeneration) {
  const id = requiredString(itemId, 'Item ID is required.', 240);
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('Choose an active session actor before completing work.');
  }
  const generation = positiveInteger(expectedClaimGeneration);
  if (generation === null) {
    throw new TypeError('Refresh item detail to load the current claim generation before completing work.');
  }
  const replacementSummary = optionalString(summary, 10_000, 'Completion summary');
  return {
    id,
    actor: validateActor(actor),
    action: 'complete',
    expectedClaimGeneration: generation,
    ...(replacementSummary ? { summary: replacementSummary } : {}),
  };
}

export function readCompletedItem(payload, expected = {}) {
  if (!isRecord(payload) || !isRecord(payload.item) || !isRecord(expected)) {
    throw new TypeError('The endpoint returned an incompatible completed-item response.');
  }
  const item = payload.item;
  const id = requiredString(item.id, 'The completed item is missing id.', 240);
  if (expected.id && id !== expected.id) {
    throw new TypeError('The endpoint returned a different completed item.');
  }
  const status = requiredString(item.status, 'The completed item is missing status.', 40);
  if (status !== 'done') throw new TypeError('The completed item did not become done.');
  if (item.claimedBy !== null || item.claimExpiresAt !== null) {
    throw new TypeError('The completed item did not release its claim.');
  }
  if (!Number.isInteger(item.version) || item.version < 1) {
    throw new TypeError('The completed item returned an invalid version.');
  }
  const previousGeneration = positiveInteger(expected.expectedClaimGeneration);
  if (previousGeneration === null || item.claimGeneration !== previousGeneration + 1) {
    throw new TypeError('The completed item did not advance the claim generation exactly once.');
  }
  const summary = nullableString(item.summary, 10_000, 'summary');
  if (Object.prototype.hasOwnProperty.call(expected, 'summary') && summary !== expected.summary) {
    throw new TypeError('The endpoint returned a different completion summary.');
  }
  return {
    id,
    status,
    summary,
    claimGeneration: item.claimGeneration,
    version: item.version,
  };
}

export function createCompleteIdempotencyTracker(generateKey) {
  return createIdempotencyTracker(generateKey);
}

export function canCompleteStatus(status) {
  return status === 'ready' || status === 'active' || status === 'blocked';
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

function nullableString(value, maxLength, label) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`The completed item returned an invalid ${label}.`);
  const output = value.trim();
  rejectCredential(output);
  if (output.length > maxLength) throw new TypeError(`The completed item returned an invalid ${label}.`);
  return output || null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function rejectCredential(value) {
  if (/stn\.tok_/i.test(value)) throw new TypeError('Credential-shaped values are not valid completion fields.');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
