const dependencyDirections = new Set(['incoming', 'outgoing']);
const dependencyKinds = new Set(['blocks', 'depends_on', 'related_to', 'duplicates', 'supersedes']);
const reservationModes = new Set(['exclusive', 'shared']);
const runStatuses = new Set(['running', 'waiting', 'succeeded', 'failed', 'cancelled']);
const activeRunStatuses = new Set(['running', 'waiting']);
const completedStatuses = new Set(['done', 'archived']);
const itemHistoryContractVersion = 1;
const maxPublicEventPayloadEntries = 20;
const maxPublicEventPayloadKeyLength = 80;
const unsafePayloadKeys = new Set(['__proto__', 'constructor', 'prototype']);
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

export function readItemDetail(payload, expectedItemId = '') {
  if (!isRecord(payload) || !isRecord(payload.item)) {
    throw new TypeError('The endpoint returned an incompatible item detail response.');
  }
  const itemId = typeof payload.item.id === 'string' ? payload.item.id : '';
  if (!itemId) throw new TypeError('The item detail response is missing an item ID.');
  if (expectedItemId && itemId !== expectedItemId) {
    throw new TypeError('The endpoint returned detail for a different item.');
  }
  if (!Array.isArray(payload.events) || !Array.isArray(payload.artifacts)) {
    throw new TypeError('The item detail response is missing events or artifacts.');
  }
  if (payload.dependencies !== undefined && !Array.isArray(payload.dependencies)) {
    throw new TypeError('The item detail response contains incompatible dependencies.');
  }
  if (payload.reservations !== undefined && !Array.isArray(payload.reservations)) {
    throw new TypeError('The item detail response contains incompatible reservations.');
  }
  if (payload.runs !== undefined && !Array.isArray(payload.runs)) {
    throw new TypeError('The item detail response contains incompatible runs.');
  }
  if (payload.historyContractVersion !== itemHistoryContractVersion) {
    throw new TypeError('The item detail response uses an incompatible history contract.');
  }
  if (typeof payload.eventsTruncated !== 'boolean') {
    throw new TypeError('The item detail response is missing event-history completeness.');
  }
  return {
    historyContractVersion: itemHistoryContractVersion,
    eventsTruncated: payload.eventsTruncated,
    item: payload.item,
    events: payload.events.map((event) => readPublicEvent(event, itemId)).filter(Boolean),
    artifacts: payload.artifacts.filter(isRecord),
    dependencies: (payload.dependencies || []).map(readDependency).filter(Boolean),
    reservations: (payload.reservations || []).map(readReservation).filter(Boolean),
    runs: (payload.runs || []).map((run) => readRun(run, itemId)).filter(Boolean),
  };
}

export function readPublicEvent(value, expectedItemId = '') {
  if (!isRecord(value)) return null;
  const id = boundedTextValue(value.id, 200);
  const itemId = boundedTextValue(value.itemId, 200);
  const actorId = nullableBoundedText(value.actorId, 120);
  const type = boundedTextValue(value.type, 160);
  const createdAt = timestampValue(value.createdAt);
  if (
    !id
    || !itemId
    || (expectedItemId && itemId !== expectedItemId)
    || actorId === undefined
    || !type
    || !createdAt
  ) return null;
  return {
    id,
    itemId,
    actorId,
    type,
    payload: readPublicEventPayload(value.payload),
    createdAt,
  };
}

export function dependencyRelationship(dependency) {
  const direction = dependency?.direction;
  const kind = dependency?.kind;
  if (kind === 'depends_on') return direction === 'incoming' ? 'Required by' : 'Depends on';
  if (kind === 'blocks') return direction === 'incoming' ? 'Blocked by' : 'Blocks';
  if (kind === 'duplicates') return direction === 'incoming' ? 'Duplicated by' : 'Duplicates';
  if (kind === 'supersedes') return direction === 'incoming' ? 'Superseded by' : 'Supersedes';
  return 'Related to';
}

export function dependencyBlocksCurrent(dependency) {
  const status = typeof dependency?.status === 'string' ? dependency.status : '';
  if (!status || completedStatuses.has(status)) return false;
  return (
    (dependency.direction === 'outgoing' && dependency.kind === 'depends_on')
    || (dependency.direction === 'incoming' && dependency.kind === 'blocks')
  );
}

export function reservationCapacityLabel(reservation) {
  const usedUnits = nonNegativeInteger(reservation?.usedUnits);
  const capacity = positiveInteger(reservation?.capacity);
  const availableUnits = nonNegativeInteger(reservation?.availableUnits);
  if (usedUnits === null || capacity === null || availableUnits === null) return 'Capacity unavailable';
  return `${usedUnits} of ${capacity} units used · ${availableUnits} available`;
}

export function reservationIsFull(reservation) {
  return nonNegativeInteger(reservation?.availableUnits) === 0;
}

export function runIsActive(run) {
  return activeRunStatuses.has(run?.status);
}

export function runStatusLabel(run) {
  return {
    running: 'running',
    waiting: 'waiting',
    succeeded: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
  }[run?.status] || 'status unavailable';
}

export function safeArtifactHref(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function payloadEntries(payload, maxLength = 500, maxEntries = 20) {
  if (!isRecord(payload)) return [];
  return Object.entries(payload).slice(0, maxEntries).map(([key, value]) => ({
    key,
    value: displayValue(value, maxLength),
  }));
}

export function safeRequestId(value, activeToken = '') {
  const requestId = typeof value === 'string' ? value.trim() : '';
  if (!requestId || requestId.length > 160) return null;
  if (/stn\.tok_/i.test(requestId)) return null;
  if (activeToken && requestId.includes(activeToken)) return null;
  return /^[A-Za-z0-9._:-]+$/.test(requestId) ? requestId : null;
}

export function redactCredentialText(value, activeToken = '') {
  let output = String(value ?? '');
  if (activeToken) output = output.split(activeToken).join('[redacted token]');
  return output.replace(/stn\.tok_[A-Za-z0-9._-]+/gi, '[redacted token]');
}

export function createRequestGate() {
  let generation = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(requestId) {
      return requestId === generation;
    },
  };
}

function readDependency(value) {
  if (!isRecord(value)) return null;
  const direction = textValue(value.direction);
  const kind = textValue(value.kind);
  const itemId = textValue(value.itemId);
  if (!dependencyDirections.has(direction) || !dependencyKinds.has(kind) || !itemId) return null;
  return {
    id: textValue(value.id) || `${direction}:${kind}:${itemId}`,
    direction,
    kind,
    itemId,
    title: textValue(value.title) || itemId,
    status: textValue(value.status),
    createdAt: textValue(value.createdAt),
  };
}

function readReservation(value) {
  if (!isRecord(value)) return null;
  const id = textValue(value.id);
  const resource = textValue(value.resource);
  const mode = textValue(value.mode);
  const capacity = positiveInteger(value.capacity);
  const units = positiveInteger(value.units);
  const usedUnits = nonNegativeInteger(value.usedUnits);
  const availableUnits = nonNegativeInteger(value.availableUnits);
  const holderActorId = textValue(value.holderActorId);
  const expiresAt = textValue(value.expiresAt);
  const createdAt = textValue(value.createdAt);
  const updatedAt = textValue(value.updatedAt);
  if (
    !id
    || !resource
    || !reservationModes.has(mode)
    || capacity === null
    || units === null
    || units > capacity
    || usedUnits === null
    || usedUnits < units
    || availableUnits === null
    || availableUnits !== Math.max(0, capacity - usedUnits)
    || !holderActorId
    || !expiresAt
    || !createdAt
    || !updatedAt
  ) return null;
  return {
    id,
    resource,
    mode,
    capacity,
    units,
    usedUnits,
    availableUnits,
    holderActorId,
    expiresAt,
    createdAt,
    updatedAt,
  };
}

function readRun(value, expectedItemId) {
  if (!isRecord(value)) return null;
  const id = textValue(value.id);
  const itemId = textValue(value.itemId);
  const actorId = textValue(value.actorId);
  const harness = textValue(value.harness);
  const status = textValue(value.status);
  const startedAt = timestampValue(value.startedAt);
  const lastHeartbeatAt = timestampValue(value.lastHeartbeatAt);
  const endedAt = nullableTimestamp(value.endedAt);
  const childAgentCount = nullableNonNegativeInteger(value.childAgentCount);
  const toolCallCount = nullableNonNegativeInteger(value.toolCallCount);
  if (
    !id
    || itemId !== expectedItemId
    || !actorId
    || !harness
    || !runStatuses.has(status)
    || !startedAt
    || !lastHeartbeatAt
    || childAgentCount === undefined
    || toolCallCount === undefined
  ) return null;

  const startedMs = Date.parse(startedAt);
  const heartbeatMs = Date.parse(lastHeartbeatAt);
  if (heartbeatMs < startedMs) return null;
  if (activeRunStatuses.has(status)) {
    if (endedAt !== null) return null;
  } else {
    if (!endedAt || Date.parse(endedAt) < heartbeatMs) return null;
  }

  return {
    id,
    itemId,
    actorId,
    harness,
    model: nullableText(value.model),
    externalRunId: nullableText(value.externalRunId),
    repository: nullableText(value.repository),
    branch: nullableText(value.branch),
    worktree: nullableText(value.worktree),
    status,
    childAgentCount,
    toolCallCount,
    startedAt,
    lastHeartbeatAt,
    endedAt,
    outcome: nullableText(value.outcome),
  };
}

function readPublicEventPayload(value) {
  if (!isRecord(value)) return {};
  const output = {};
  let retained = 0;
  for (const [rawKey, entry] of Object.entries(value)) {
    if (retained >= maxPublicEventPayloadEntries) break;
    const key = boundedTextValue(rawKey, maxPublicEventPayloadKeyLength);
    if (!key || unsafePayloadKeys.has(key) || Object.hasOwn(output, key)) continue;
    output[key] = entry;
    retained += 1;
  }
  return output;
}

function boundedTextValue(value, maximum) {
  const output = textValue(value);
  return output && output.length <= maximum && !controlCharacterPattern.test(output)
    ? output
    : '';
}

function nullableBoundedText(value, maximum) {
  if (value === null || value === undefined) return null;
  const output = boundedTextValue(value, maximum);
  return output || undefined;
}

function displayValue(value, maxLength) {
  let output;
  if (value === undefined) {
    output = 'undefined';
  } else if (value === null) {
    output = 'null';
  } else if (typeof value === 'string') {
    output = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    output = String(value);
  } else {
    try {
      output = JSON.stringify(value);
    } catch {
      output = String(value);
    }
    if (output === undefined) output = String(value);
  }
  output = redactCredentialText(output);
  return output.length > maxLength ? `${output.slice(0, maxLength)}…` : output;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function nullableNonNegativeInteger(value) {
  if (value === null || value === undefined) return null;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const output = textValue(value);
  return output || null;
}

function timestampValue(value) {
  const output = textValue(value);
  return output && !Number.isNaN(Date.parse(output)) ? output : '';
}

function nullableTimestamp(value) {
  if (value === null || value === undefined) return null;
  const output = timestampValue(value);
  return output || undefined;
}

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
