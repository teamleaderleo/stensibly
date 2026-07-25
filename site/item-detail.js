const dependencyDirections = new Set(['incoming', 'outgoing']);
const dependencyKinds = new Set(['blocks', 'depends_on', 'related_to', 'duplicates', 'supersedes']);
const reservationModes = new Set(['exclusive', 'shared']);
const completedStatuses = new Set(['done', 'archived']);

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
  return {
    item: payload.item,
    events: payload.events.filter(isRecord),
    artifacts: payload.artifacts.filter(isRecord),
    dependencies: (payload.dependencies || []).map(readDependency).filter(Boolean),
    reservations: (payload.reservations || []).map(readReservation).filter(Boolean),
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
    || !holderActorId
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
    expiresAt: textValue(value.expiresAt),
    createdAt: textValue(value.createdAt),
    updatedAt: textValue(value.updatedAt),
  };
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

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
