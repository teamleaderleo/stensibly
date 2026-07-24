import { createIdempotencyTracker } from './item-create.js';
import { validateActor } from './session-context.js';

export const PROGRESS_EVENT_TYPE = 'item.progress';

export function validateProgressInput(itemId, summary, nextAction, actor) {
  const id = requiredString(itemId, 'Item ID is required.', 240);
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('Choose an active session actor before recording progress.');
  }
  const progressSummary = requiredString(summary, 'Progress summary is required.', 10_000);
  const progressNextAction = optionalString(nextAction, 2_000, 'Next action');
  return {
    id,
    actor: validateActor(actor),
    type: PROGRESS_EVENT_TYPE,
    payload: {
      summary: progressSummary,
      ...(progressNextAction ? { nextAction: progressNextAction } : {}),
    },
  };
}

export function readProgressEvent(payload, expected = {}) {
  if (!isRecord(payload) || !isRecord(payload.event)) {
    throw new TypeError('The endpoint returned an incompatible progress-event response.');
  }
  const event = payload.event;
  const id = requiredString(event.id, 'The progress event is missing id.', 240);
  const itemId = requiredString(event.itemId, 'The progress event is missing item id.', 240);
  const actorId = requiredString(event.actorId, 'The progress event is missing actor id.', 120);
  const type = requiredString(event.type, 'The progress event is missing type.', 120);
  const createdAt = requiredString(event.createdAt, 'The progress event is missing its timestamp.', 120);
  if (type !== PROGRESS_EVENT_TYPE) throw new TypeError('The endpoint returned a different event type.');
  if (expected.itemId && itemId !== expected.itemId) throw new TypeError('The endpoint returned progress for a different item.');
  if (expected.actorId && actorId !== expected.actorId) throw new TypeError('The endpoint returned progress from a different actor.');
  if (Number.isNaN(Date.parse(createdAt))) throw new TypeError('The progress event returned an invalid timestamp.');
  if (!isRecord(event.payload)) throw new TypeError('The progress event returned an invalid payload.');
  const summary = requiredString(event.payload.summary, 'The progress event is missing its summary.', 10_000);
  const nextAction = optionalString(event.payload.nextAction, 2_000, 'Next action');
  if (expected.summary && summary !== expected.summary) throw new TypeError('The endpoint returned a different progress summary.');
  if ((expected.nextAction || '') !== nextAction) throw new TypeError('The endpoint returned a different next action.');
  return { id, itemId, actorId, type, createdAt };
}

export function createProgressIdempotencyTracker(generateKey) {
  return createIdempotencyTracker(generateKey);
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

function rejectCredential(value) {
  if (/stn\.tok_/i.test(value)) throw new TypeError('Credential-shaped values are not valid progress fields.');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
