import { validateActor } from './session-context.js';

const ITEM_KINDS = ['task', 'finding', 'question', 'decision', 'tip', 'handoff', 'note'];
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export function validateCreateItem(input, actor) {
  if (!isRecord(input)) throw new TypeError('Enter the new item fields.');
  if (!isRecord(actor)) throw new TypeError('Choose an active session actor before creating work.');

  const project = requiredString(input.project, 'Project is required.', 80);
  if (!PROJECT_PATTERN.test(project)) throw new TypeError('Use a lowercase project slug.');
  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (!ITEM_KINDS.includes(kind)) throw new TypeError('Choose a supported item kind.');
  const title = requiredString(input.title, 'Title is required.', 240);
  const summary = optionalString(input.summary, 10_000, 'Summary');
  const nextAction = optionalString(input.nextAction, 2_000, 'Next action');
  const priority = input.priority === '' || input.priority === undefined
    ? 50
    : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
    throw new TypeError('Priority must be a whole number from 0 to 100.');
  }

  return {
    project,
    kind,
    title,
    ...(summary ? { summary } : {}),
    ...(nextAction ? { nextAction } : {}),
    priority,
    actor: validateActor(actor),
  };
}

export function readCreatedItem(payload) {
  if (!isRecord(payload) || !isRecord(payload.item)) {
    throw new TypeError('The endpoint returned an incompatible created-item response.');
  }
  const item = payload.item;
  const id = requiredString(item.id, 'The created item is missing id.', 240);
  const project = requiredString(item.project, 'The created item is missing project.', 80);
  const title = requiredString(item.title, 'The created item is missing title.', 240);
  if (!PROJECT_PATTERN.test(project)) {
    throw new TypeError('The created item returned an invalid project slug.');
  }
  return { id, project, title };
}

export function formatValidationIssues(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.issues)) return '';
  return payload.issues
    .filter(isRecord)
    .slice(0, 8)
    .map((issue) => {
      const rawPath = typeof issue.path === 'string' ? issue.path.trim().slice(0, 120) : '';
      const path = rawPath ? `${rawPath}: ` : '';
      const message = typeof issue.message === 'string' ? issue.message.trim().slice(0, 240) : '';
      return message ? `${path}${message}` : '';
    })
    .filter(Boolean)
    .join(' · ')
    .slice(0, 1_200);
}

export function createIdempotencyTracker(generateKey = defaultKey) {
  let fingerprint = '';
  let key = '';
  return {
    keyFor(value) {
      const nextFingerprint = JSON.stringify(value);
      if (!key || nextFingerprint !== fingerprint) {
        fingerprint = nextFingerprint;
        key = generateKey();
      }
      return key;
    },
    reset() {
      fingerprint = '';
      key = '';
    },
    current() {
      return key;
    },
  };
}

export function itemKinds() {
  return [...ITEM_KINDS];
}

function defaultKey() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `web_${uuid}`;
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.some((value) => value !== 0)) {
    return `web_${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new TypeError('This browser cannot generate a safe idempotency key.');
}

function requiredString(value, message, maxLength) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output) throw new TypeError(message);
  if (/stn\.tok_/i.test(output)) throw new TypeError('Credential-shaped values are not valid item fields.');
  if (output.length > maxLength) throw new TypeError(`${message.replace(/\.$/, '')} (maximum ${maxLength} characters).`);
  return output;
}

function optionalString(value, maxLength, label) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (/stn\.tok_/i.test(output)) throw new TypeError('Credential-shaped values are not valid item fields.');
  if (output.length > maxLength) throw new TypeError(`${label} may contain at most ${maxLength} characters.`);
  return output;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
