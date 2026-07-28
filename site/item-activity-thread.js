import { payloadEntries, redactCredentialText } from './item-detail.js';

const projectedPayloadKeys = new Set([
  'actorCallsign',
  'actorDisplayName',
  'actorName',
  'callsign',
  'claimGeneration',
  'externalRunId',
  'generation',
  'message',
  'note',
  'outcome',
  'reason',
  'runGeneration',
  'runId',
  'sourceRunId',
  'summary',
  'title',
  'workerCallsign',
]);
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export function projectActivityThread(events) {
  if (!Array.isArray(events)) return [];
  const projected = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = isRecord(events[index]) ? events[index] : {};
    const payload = isRecord(event.payload) ? event.payload : {};
    const id = safeText(event.id, 200);
    const type = safeText(event.type, 160) || 'event';
    const actorId = safeText(event.actorId, 120);
    const callsign = firstSafeText(
      120,
      event.callsign,
      payload.callsign,
      payload.workerCallsign,
      payload.actorCallsign,
    );
    const actorName = firstSafeText(
      160,
      event.actorName,
      event.actorDisplayName,
      payload.actorName,
      payload.actorDisplayName,
    );
    const runId = firstSafeText(
      200,
      event.runId,
      payload.runId,
      payload.sourceRunId,
      payload.externalRunId,
    );
    const generation = firstNonNegativeInteger(
      event.runGeneration,
      payload.runGeneration,
      payload.generation,
      event.claimGeneration,
      payload.claimGeneration,
    );
    const summary = firstSafeText(
      500,
      event.summary,
      payload.summary,
      payload.message,
      payload.note,
      payload.reason,
      payload.outcome,
      payload.title,
    );
    const identity = actorIdentity(actorId, callsign, actorName);
    projected.push({
      key: id || `event-${index + 1}`,
      id,
      type,
      createdAt: safeText(event.createdAt, 80),
      actorId,
      actorName,
      callsign,
      actorKey: identity.key,
      actorLabel: identity.label,
      runId,
      generation,
      summary,
      payloadEntries: payloadEntries(payload).filter((entry) => !projectedPayloadKeys.has(entry.key)),
      position: index,
    });
  }

  return projected;
}

export function activityThreadFilterOptions(entries) {
  return {
    actors: uniqueOptions(entries, 'actorKey', 'actorLabel'),
    runs: uniqueOptions(entries, 'runId', 'runId'),
    types: uniqueOptions(entries, 'type', 'type'),
  };
}

export function filterActivityThread(entries, filters = {}) {
  const actor = safeText(filters.actor, 500);
  const run = safeText(filters.run, 200);
  const type = safeText(filters.type, 160);
  return entries.filter((entry) => (
    (!actor || entry.actorKey === actor)
    && (!run || entry.runId === run)
    && (!type || entry.type === type)
  ));
}

export function activityThreadSection(events, { eventsTruncated = null } = {}) {
  const entries = projectActivityThread(events);
  const options = activityThreadFilterOptions(entries);
  const section = node('section', 'detail-section detail-activity-section');
  const heading = node('h3');
  heading.textContent = `Activity thread · ${entries.length} shown`;
  section.append(heading);

  if (eventsTruncated === true) {
    const partial = node('p', 'detail-history-partial');
    partial.setAttribute('role', 'status');
    partial.textContent = 'Partial history: earlier activity is not shown in this bounded window.';
    section.append(partial);
  }

  if (!entries.length) {
    section.append(emptyMessage('No public activity has been recorded for this item.'));
    return section;
  }

  const controls = node('div', 'detail-thread-filters');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Filter activity thread');
  const actor = filterSelect('Actor', 'All actors', options.actors);
  const run = filterSelect('Run', 'All runs', options.runs);
  const type = filterSelect('Event', 'All event types', options.types);
  const reset = node('button', 'detail-thread-reset');
  reset.type = 'button';
  reset.textContent = 'reset filters';
  controls.append(actor.label, run.label, type.label, reset);
  section.append(controls);

  const status = node('p', 'detail-thread-filter-status');
  status.setAttribute('aria-live', 'polite');
  const list = node('ol', 'detail-activity-thread');
  section.append(status, list);

  const render = () => {
    const visible = filterActivityThread(entries, {
      actor: actor.select.value,
      run: run.select.value,
      type: type.select.value,
    });
    list.replaceChildren(...renderEntries(visible));
    status.textContent = `Showing ${visible.length} of ${entries.length} public events.`;
    if (!visible.length) list.append(emptyMessage('No activity matches these filters.', 'li'));
  };

  actor.select.addEventListener('change', render);
  run.select.addEventListener('change', render);
  type.select.addEventListener('change', render);
  reset.addEventListener('click', () => {
    actor.select.value = '';
    run.select.value = '';
    type.select.value = '';
    render();
    actor.select.focus();
  });
  render();
  return section;
}

function renderEntries(entries) {
  return entries.map((entry) => {
    const row = node('li', 'detail-thread-entry');
    row.dataset.depth = '0';
    row.id = `activity-event-${entry.position + 1}`;

    const head = node('div', 'detail-thread-head');
    const eventName = node('strong');
    eventName.textContent = redactCredentialText(entry.type);
    const when = node('time');
    when.textContent = formatTimestamp(entry.createdAt) || 'unknown time';
    if (entry.createdAt) when.dateTime = entry.createdAt;
    head.append(eventName, when);
    row.append(head);

    const author = node('div', 'detail-thread-author');
    const authorName = node('span', 'detail-thread-author-name');
    authorName.textContent = redactCredentialText(entry.actorLabel);
    author.append(authorName);
    if (entry.callsign && entry.actorId) author.append(badge(`actor · ${entry.actorId}`));
    if (!entry.callsign && entry.actorName && entry.actorId) author.append(badge(`actor · ${entry.actorId}`));
    if (entry.runId) author.append(badge(`run · ${entry.runId}`));
    if (entry.generation !== null) author.append(badge(`generation · ${entry.generation}`));
    row.append(author);

    if (entry.summary) {
      const summary = node('p', 'detail-thread-summary');
      summary.textContent = redactCredentialText(entry.summary);
      row.append(summary);
    }

    if (entry.payloadEntries.length) {
      const payload = node('dl', 'detail-payload detail-thread-payload');
      for (const entryValue of entry.payloadEntries) appendTerm(payload, entryValue.key, entryValue.value);
      row.append(payload);
    }
    return row;
  });
}

function actorIdentity(actorId, callsign, actorName) {
  if (actorId && callsign) {
    return {
      key: `actor+callsign:${JSON.stringify([actorId, callsign])}`,
      label: `${callsign} · ${actorId}`,
    };
  }
  if (actorId) return { key: `actor:${JSON.stringify(actorId)}`, label: actorName || actorId };
  if (callsign) return { key: `callsign:${JSON.stringify(callsign)}`, label: callsign };
  if (actorName) return { key: `name:${JSON.stringify(actorName)}`, label: actorName };
  return { key: 'system', label: 'System' };
}

function uniqueOptions(entries, valueKey, labelKey) {
  const values = new Map();
  for (const entry of entries) {
    const value = safeText(entry[valueKey], 500);
    const label = safeText(entry[labelKey], 300);
    if (value && label && !values.has(value)) values.set(value, label);
  }
  return [...values].map(([value, label]) => ({ value, label }));
}

function filterSelect(labelText, allText, options) {
  const label = node('label');
  label.append(document.createTextNode(labelText));
  const select = node('select');
  select.setAttribute('aria-label', `${labelText} filter`);
  const all = node('option');
  all.value = '';
  all.textContent = allText;
  select.append(all);
  for (const option of options) {
    const item = node('option');
    item.value = option.value;
    item.textContent = redactCredentialText(option.label);
    select.append(item);
  }
  label.append(select);
  return { label, select };
}

function badge(value) {
  const item = node('span', 'detail-thread-badge');
  item.textContent = redactCredentialText(value);
  return item;
}

function appendTerm(list, label, value) {
  const term = node('dt');
  term.textContent = redactCredentialText(label);
  const description = node('dd');
  description.textContent = redactCredentialText(value || '—');
  list.append(term, description);
}

function emptyMessage(message, tagName = 'p') {
  const empty = node(tagName, 'detail-empty');
  empty.textContent = message;
  return empty;
}

function node(tagName, className = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? redactCredentialText(value) : date.toLocaleString();
}

function firstSafeText(maximum, ...values) {
  for (const value of values) {
    const output = safeText(value, maximum);
    if (output) return output;
  }
  return '';
}

function firstNonNegativeInteger(...values) {
  for (const value of values) {
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

function safeText(value, maximum) {
  const output = typeof value === 'string' ? value.trim() : '';
  return output && output.length <= maximum && !unsafeTextPattern.test(output) ? output : '';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
