/**
 * One-tap item resolution protocol (#1632 monitor polish, F1 repair).
 *
 * Every mutation body carries the click-time item's exact claim generation,
 * built through the hardened dashboard contracts (`item-complete.js`,
 * `item-block.js`) so a missing, stale-typed, or out-of-range generation
 * fails closed locally with zero requests instead of being guessed.
 *
 * The complete-to-unblock fallback fires only on the canonical blocked-item
 * transition refusal (HTTP 409 `conflict` with a canonical machine reason),
 * which is the sole server answer that means "unblock first". Authentication,
 * authorization, malformed input, stale-generation conflicts, held claims,
 * unknown failures, and network ambiguity never become a second mutation
 * attempt. Both attempts share one idempotency key, so an ambiguous outcome
 * replays exactly or conflicts conservatively.
 */

import { validateCompleteInput } from './item-complete.js';
import { validateUnblockInput } from './item-block.js';

const BLOCKED_TRANSITION_REFUSALS = new Set([
  'Only blocked work at the current claim generation can be unblocked',
  'Only blocked work can be unblocked',
]);

export function buildCompleteRequestBody(itemId, actor, expectedClaimGeneration) {
  return validateCompleteInput(itemId, undefined, actor, expectedClaimGeneration);
}

export function buildUnblockRequestBody(itemId, actor, expectedClaimGeneration) {
  return validateUnblockInput(itemId, undefined, actor, expectedClaimGeneration);
}

export function isBlockedTransitionRefusal(conflict) {
  if (!conflict || typeof conflict !== 'object') return false;
  return conflict.status === 409
    && conflict.code === 'conflict'
    && BLOCKED_TRANSITION_REFUSALS.has(conflict.message);
}

export async function readConflictShape(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return {
    status: response.status,
    code: typeof payload.code === 'string' ? payload.code : '',
    message: typeof payload.error === 'string' ? payload.error : '',
  };
}

export async function resolveItemActionOutcome(context) {
  const {
    endpoint,
    token,
    itemId,
    item,
    actor,
    fetchImpl = (...args) => globalThis.fetch(...args),
    generateKey = defaultIdempotencyKey,
  } = context || {};

  let completeBody;
  try {
    completeBody = buildCompleteRequestBody(itemId, actor, item?.claimGeneration);
  } catch {
    return 'failed';
  }

  const idempotencyKey = generateKey();
  const post = (path, body) => fetchImpl(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  let completeResponse;
  try {
    completeResponse = await post(
      `/api/v1/items/${encodeURIComponent(itemId)}/complete`,
      completeBody,
    );
  } catch {
    return 'failed';
  }
  if (completeResponse.ok) return 'completed';

  const conflict = await readConflictShape(completeResponse);
  if (!isBlockedTransitionRefusal(conflict)) return 'failed';

  let unblockBody;
  try {
    unblockBody = buildUnblockRequestBody(itemId, actor, item?.claimGeneration);
  } catch {
    return 'failed';
  }
  let unblockResponse;
  try {
    unblockResponse = await post(
      `/api/v1/items/${encodeURIComponent(itemId)}/unblock`,
      unblockBody,
    );
  } catch {
    return 'failed';
  }
  return unblockResponse.ok ? 'unblocked' : 'failed';
}

function defaultIdempotencyKey() {
  return `stn.done-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
