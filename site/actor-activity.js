const ITEM_STATUSES = ['ready', 'active', 'blocked', 'done', 'archived'];
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export const MAX_ACTIVITY_ITEMS = 20;
export const MAX_ACTIVITY_CONCURRENCY = 4;
export const MAX_EVENTS_PER_ITEM = 20;
export const MAX_ACTIVITY_EVENTS = 200;

export function normalizeActivityCandidates(values, limit = MAX_ACTIVITY_ITEMS) {
  if (!Array.isArray(values)) return [];
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_ITEMS) {
    throw new TypeError(`Activity item limit must be between 1 and ${MAX_ACTIVITY_ITEMS}.`);
  }
  const output = [];
  const seen = new Set();
  for (const value of values) {
    try {
      const candidate = readCandidate(value);
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      output.push(candidate);
      if (output.length >= limit) break;
    } catch {
      // Ignore malformed DOM-derived candidates rather than requesting invented IDs.
    }
  }
  return output;
}

export function readActorActivityDetail(payload, expectedCandidate) {
  const expected = readCandidate(expectedCandidate);
  if (!isRecord(payload) || !isRecord(payload.item) || !Array.isArray(payload.events)) {
    throw new TypeError('The endpoint returned an incompatible activity detail response.');
  }
  const item = {
    id: requiredString(payload.item.id, 'Activity detail is missing item id.', 240),
    project: projectString(payload.item.project),
    title: requiredString(payload.item.title, 'Activity detail is missing item title.', 240),
    status: enumString(payload.item.status, ITEM_STATUSES, 'item status'),
    claimedBy: nullableString(payload.item.claimedBy, 120, 'item claimant'),
    updatedAt: timestamp(payload.item.updatedAt, 'Activity detail returned an invalid item update time.'),
  };
  if (item.id !== expected.id || item.project !== expected.project) {
    throw new TypeError('The endpoint returned activity detail outside the requested item boundary.');
  }
  const events = payload.events.slice(-MAX_EVENTS_PER_ITEM).map((event) => readEvent(event, item.id));
  return { item, events };
}

export function aggregateActorActivity(details, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(details)) throw new TypeError('Activity details must be an array.');
  const generated = timestamp(generatedAt, 'Activity generated time is invalid.');
  const actors = new Map();
  const allEvents = [];
  let systemEventCount = 0;

  for (const detail of details) {
    if (!isRecord(detail) || !isRecord(detail.item) || !Array.isArray(detail.events)) continue;
    const item = detail.item;
    if (item.claimedBy) {
      const actor = actorRecord(actors, item.claimedBy);
      actor.currentClaims.push({
        itemId: item.id,
        project: item.project,
        title: item.title,
        status: item.status,
        updatedAt: item.updatedAt,
      });
      actor.latestAt = later(actor.latestAt, item.updatedAt);
    }
    for (const event of detail.events) {
      allEvents.push({ ...event, project: item.project, itemTitle: item.title });
      if (!event.actorId) systemEventCount += 1;
    }
  }

  allEvents.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const retainedEvents = allEvents.slice(0, MAX_ACTIVITY_EVENTS);
  for (const event of retainedEvents) {
    if (!event.actorId) continue;
    const actor = actorRecord(actors, event.actorId);
    actor.eventCount += 1;
    if (actor.events.length < 20) actor.events.push(event);
    actor.latestAt = later(actor.latestAt, event.createdAt);
  }

  const actorList = [...actors.values()]
    .map((actor) => ({
      ...actor,
      currentClaims: actor.currentClaims
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.itemId.localeCompare(right.itemId)),
      events: actor.events
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)),
    }))
    .sort((left, right) => right.latestAt.localeCompare(left.latestAt) || left.id.localeCompare(right.id));

  return {
    generatedAt: generated,
    sampledItems: details.length,
    observedEventCount: allEvents.length,
    eventCount: retainedEvents.length,
    systemEventCount,
    actorCount: actorList.length,
    actors: actorList,
  };
}

export async function mapWithConcurrency(values, concurrency, worker) {
  if (!Array.isArray(values)) throw new TypeError('Concurrent work values must be an array.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_ACTIVITY_CONCURRENCY) {
    throw new TypeError(`Activity concurrency must be between 1 and ${MAX_ACTIVITY_CONCURRENCY}.`);
  }
  if (typeof worker !== 'function') throw new TypeError('Concurrent activity worker is required.');
  const results = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => run()));
  return results;
}

function readCandidate(value) {
  if (!isRecord(value)) throw new TypeError('Activity candidate is invalid.');
  return {
    id: requiredString(value.id, 'Activity candidate is missing item id.', 240),
    project: projectString(value.project),
    title: requiredString(value.title, 'Activity candidate is missing item title.', 240),
    status: enumString(value.status, ITEM_STATUSES, 'item status'),
  };
}

function readEvent(value, expectedItemId) {
  if (!isRecord(value)) throw new TypeError('Activity detail returned an invalid event.');
  const itemId = requiredString(value.itemId, 'Activity event is missing item id.', 240);
  if (itemId !== expectedItemId) throw new TypeError('Activity event belongs to a different item.');
  return {
    id: requiredString(value.id, 'Activity event is missing id.', 240),
    itemId,
    actorId: nullableString(value.actorId, 120, 'event actor'),
    type: requiredString(value.type, 'Activity event is missing type.', 160),
    createdAt: timestamp(value.createdAt, 'Activity event returned an invalid created time.'),
  };
}

function actorRecord(actors, id) {
  let actor = actors.get(id);
  if (!actor) {
    actor = { id, latestAt: '', currentClaims: [], eventCount: 0, events: [] };
    actors.set(id, actor);
  }
  return actor;
}

function later(left, right) {
  return !left || right > left ? right : left;
}

function projectString(value) {
  const project = requiredString(value, 'Activity detail returned an invalid project.', 80);
  if (!PROJECT_PATTERN.test(project)) throw new TypeError('Activity detail returned an invalid project.');
  return project;
}

function enumString(value, allowed, label) {
  const output = requiredString(value, `Activity detail returned an invalid ${label}.`, 160);
  if (!allowed.includes(output)) throw new TypeError(`Activity detail returned an invalid ${label}.`);
  return output;
}

function nullableString(value, maxLength, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`Activity detail returned an invalid ${label}.`);
  const output = value.trim();
  rejectCredential(output);
  if (!output || output.length > maxLength) throw new TypeError(`Activity detail returned an invalid ${label}.`);
  return output;
}

function timestamp(value, message) {
  const output = requiredString(value, message, 120);
  if (Number.isNaN(Date.parse(output))) throw new TypeError(message);
  return output;
}

function requiredString(value, message, maxLength) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output || output.length > maxLength) throw new TypeError(message);
  rejectCredential(output);
  return output;
}

function rejectCredential(value) {
  if (/stn\.tok_/i.test(value)) throw new TypeError('Credential-shaped values are not valid actor activity fields.');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
