import { createIdempotencyTracker } from './item-create.js';
import { validateActor } from './session-context.js';

export function validateCompleteInput(itemId, summary, actor) {
  const id = requiredString(itemId, 'Item ID is required.', 240);
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('Choose an active session actor before completing work.');
  }
  const completionSummary = optionalString(summary, 10_000, 'Completion summary');
  return {
    id,
    actor: validateActor(actor),
    action: 'complete',
    ...(completionSummary ? { summary: completionSummary } : {}),
  };
}

export function readCompletedItem(payload, expected) {
  if (!isRecord(payload) || !isRecord(payload.item) || !isRecord(expected)) {
    throw new TypeError('The endpoint returned an incompatible completion response.');
  }
  const item = payload.item;
  const id = requiredString(item.id, 'The completed item is missing id.', 240);
  if (expected.id && id !== expected.id) throw new TypeError('The endpoint returned a different completed item.');
  const status = requiredString(item.status, 'The completed item is missing status.', 40);
  if (status !== 'done') throw new TypeError('The item did not become done.');
  const summary = nullableString(item.summary, 10_000, 'summary');
  if (item.nextAction !== null) throw new TypeError('The completed item did not clear its next action.');
  if (item.claimedBy !== null || item.claimExpiresAt !== null) {
    throw new TypeError('The completed item did not release its claim.');
  }
  if (!Number.isInteger(item.version) || item.version < 1) {
    throw new TypeError('The completed item returned an invalid version.');
  }
  if (typeof expected.summary === 'string' && summary !== expected.summary) {
    throw new TypeError('The endpoint returned a different completion summary.');
  }
  return { id, status, summary, nextAction: null, version: item.version };
}

export function createCompletionIdempotencyTracker(generateKey) {
  return createIdempotencyTracker(generateKey);
}

export function canCompleteStatus(status) {
  return ['ready', 'active', 'blocked'].includes(status);
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
  if (typeof value !== 'string') throw new TypeError(`The completed item returned an invalid ${label}.`);
  const output = value.trim();
  rejectCredential(output);
  if (output.length > maxLength) throw new TypeError(`The completed item returned an invalid ${label}.`);
  return output || null;
}

function rejectCredential(value) {
  if (/stn\.tok_/i.test(value)) throw new TypeError('Credential-shaped values are not valid completion fields.');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
