export function readItemDetail(payload, expectedItemId = '') {
  if (!isRecord(payload) || !isRecord(payload.item)) {
    throw new TypeError('The endpoint returned an incompatible item detail response.');
  }
  const itemId = typeof payload.item.id === 'string' ? payload.item.id : '';
  if (!itemId) {
    throw new TypeError('The item detail response is missing an item ID.');
  }
  if (expectedItemId && itemId !== expectedItemId) {
    throw new TypeError('The endpoint returned detail for a different item.');
  }
  if (!Array.isArray(payload.events) || !Array.isArray(payload.artifacts)) {
    throw new TypeError('The item detail response is missing events or artifacts.');
  }
  return {
    item: payload.item,
    events: payload.events.filter(isRecord),
    artifacts: payload.artifacts.filter(isRecord),
  };
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

export function payloadEntries(payload, maxLength = 500) {
  if (!isRecord(payload)) return [];
  return Object.entries(payload).map(([key, value]) => ({
    key,
    value: displayValue(value, maxLength),
  }));
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

function displayValue(value, maxLength) {
  let output;
  if (value === null) {
    output = 'null';
  } else if (typeof value === 'string') {
    output = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    output = String(value);
  } else {
    try {
      output = JSON.stringify(value);
    } catch {
      output = String(value);
    }
  }
  return output.length > maxLength ? `${output.slice(0, maxLength)}…` : output;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
