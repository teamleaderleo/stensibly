import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';
import {
  MAX_ACTIVITY_CONCURRENCY,
  aggregateActorActivity,
  mapWithConcurrency,
  normalizeActivityCandidates,
  readActorActivityDetail,
} from './actor-activity.js';

const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const ITEM_STATUSES = ['ready', 'active', 'blocked', 'done'];

export function installActorActivityController() {
  const dashboard = document.querySelector('#dashboard');
  const actions = document.querySelector('.dashboard-actions');
  const board = document.querySelector('#board');
  const projectFilter = document.querySelector('#project-filter');
  const refreshBoardButton = document.querySelector('#refresh');
  const connectForm = document.querySelector('#connect-form');
  if (!dashboard || !actions || !board || !projectFilter || !refreshBoardButton || !connectForm) return null;
  if (document.querySelector('#actor-activity-button')) return null;

  ensureStyles('stensibly-actor-activity-styles', '/actor-activity.css');

  const openButton = element('button');
  openButton.id = 'actor-activity-button';
  openButton.type = 'button';
  openButton.className = 'secondary';
  openButton.textContent = 'actor activity';
  actions.insertBefore(openButton, refreshBoardButton);

  const dialog = element('dialog', 'actor-activity-dialog');
  dialog.id = 'actor-activity-dialog';
  dialog.setAttribute('aria-labelledby', 'actor-activity-title');
  const panel = element('article', 'actor-activity-panel');
  const head = element('header', 'actor-activity-head');
  const headingCopy = element('div');
  const eyebrow = element('p', 'eyebrow');
  eyebrow.textContent = 'Bounded recent sample';
  const title = element('h2');
  title.id = 'actor-activity-title';
  title.textContent = 'Actor activity';
  headingCopy.append(eyebrow, title);
  const closeButton = element('button');
  closeButton.type = 'button';
  closeButton.textContent = 'close';
  closeButton.setAttribute('aria-label', 'Close actor activity');
  head.append(headingCopy, closeButton);

  const toolbar = element('div', 'actor-activity-toolbar');
  const state = element('span');
  state.id = 'actor-activity-state';
  state.setAttribute('role', 'status');
  state.textContent = 'waiting';
  const refreshButton = element('button');
  refreshButton.type = 'button';
  refreshButton.textContent = 'refresh activity';
  toolbar.append(state, refreshButton);

  const error = element('p', 'actor-activity-error');
  error.id = 'actor-activity-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const body = element('div', 'actor-activity-body');
  body.append(emptyBlock('Open the view to inspect a bounded sample of actor activity.'));
  panel.append(head, toolbar, error, body);
  dialog.append(panel);
  document.body.append(dialog);

  const gate = createRequestGate();
  let opener = null;
  let currentSample = null;
  let lastCandidateFingerprint = '';
  let syncQueued = false;

  syncCandidates();

  openButton.addEventListener('click', () => {
    const candidates = syncCandidates();
    if (!candidates.length) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : openButton;
    dialog.showModal();
    closeButton.focus();
    void loadActivity();
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    gate.invalidate();
    refreshButton.disabled = false;
    state.textContent = 'closed';
    const target = opener;
    opener = null;
    if (target?.isConnected) target.focus();
  });
  refreshButton.addEventListener('click', () => void loadActivity());
  projectFilter.addEventListener('change', () => {
    gate.invalidate();
    currentSample = null;
    queueMicrotask(() => {
      syncCandidates();
      if (dialog.open) void loadActivity();
    });
  });

  const boardObserver = new MutationObserver(() => scheduleSync());
  boardObserver.observe(board, { childList: true, subtree: true });
  const dashboardObserver = new MutationObserver(() => {
    if (dashboard.hidden && dialog.open) dialog.close();
    scheduleSync();
  });
  dashboardObserver.observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });
  const connectionObserver = new MutationObserver(() => {
    if (!connectForm.hidden && dialog.open) dialog.close();
  });
  connectionObserver.observe(connectForm, { attributes: true, attributeFilter: ['hidden'] });

  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      syncCandidates();
    });
  }

  function syncCandidates() {
    const candidates = activityCandidates(board);
    const nextFingerprint = candidateFingerprint(candidates);
    openButton.disabled = dashboard.hidden || candidates.length === 0;
    openButton.title = candidates.length
      ? 'Inspect actor activity sampled from up to 20 current board items'
      : 'No authorized board items are available to sample';
    if (dialog.open && !candidates.length) dialog.close();
    if (dialog.open && lastCandidateFingerprint && nextFingerprint !== lastCandidateFingerprint) {
      state.textContent = 'board changed · refresh activity';
    }
    lastCandidateFingerprint = nextFingerprint;
    return candidates;
  }

  async function loadActivity() {
    const candidates = activityCandidates(board);
    if (!dialog.open || !candidates.length) return;
    const connection = readConnection();
    if (!connection.endpoint || !connection.token) {
      showFailure('Connection context is unavailable. Reconnect before loading actor activity.', '');
      return;
    }

    const fingerprint = requestFingerprint(connection, candidates);
    const requestId = gate.begin();
    refreshButton.disabled = true;
    clearError();
    state.textContent = currentSample?.fingerprint === fingerprint ? 'refreshing sample' : 'loading sample';
    if (!currentSample || currentSample.fingerprint !== fingerprint) {
      body.replaceChildren(emptyBlock('Loading actor activity from the current authorized board sample…'));
    }

    let outcomes;
    try {
      outcomes = await mapWithConcurrency(
        candidates,
        MAX_ACTIVITY_CONCURRENCY,
        (candidate) => fetchActivityDetail(connection, candidate),
      );
    } catch {
      if (!isCurrent(requestId, fingerprint)) return;
      showFailure('Actor activity could not be loaded. Retry the current sample.', fingerprint);
      return;
    }
    if (!isCurrent(requestId, fingerprint)) return;

    const details = outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.detail);
    const failures = outcomes.filter((outcome) => !outcome.ok);
    if (!details.length) {
      const first = failures[0]?.message || 'No sampled item details were available.';
      showFailure(`${failures.length} sampled item details were unavailable. ${first}`, fingerprint);
      return;
    }

    let activity;
    try {
      activity = aggregateActorActivity(details);
    } catch (cause) {
      if (!isCurrent(requestId, fingerprint)) return;
      showFailure(cause instanceof Error ? cause.message : 'The sampled activity response was incompatible.', fingerprint);
      return;
    }

    currentSample = { fingerprint, activity, requestedItems: candidates.length, failures: failures.length };
    refreshButton.disabled = false;
    state.textContent = `generated ${formatTimestamp(activity.generatedAt)}`;
    renderActivity(activity, candidates.length, failures.length);
    if (failures.length) {
      const first = failures[0]?.message || 'One or more item details were unavailable.';
      showInlineError(`${failures.length} of ${candidates.length} sampled item details were unavailable. ${first}`);
    }
  }

  async function fetchActivityDetail(connection, candidate) {
    let response;
    try {
      response = await fetch(`${connection.endpoint}/api/v1/items/${encodeURIComponent(candidate.id)}`, {
        headers: { authorization: `Bearer ${connection.token}` },
        cache: 'no-store',
      });
    } catch {
      return { ok: false, message: 'An item detail request could not reach the API.' };
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = describeHttpFailure(response.status, payload);
      const validation = formatValidationIssues(payload);
      const requestId = safeRequestId(response.headers.get('x-request-id'), connection.token);
      const base = response.status === 404
        ? 'A sampled item no longer exists or left the token project boundary.'
        : failure.message;
      return {
        ok: false,
        message: [base, validation, requestId ? `Request ID: ${requestId}` : ''].filter(Boolean).join(' '),
      };
    }
    try {
      return { ok: true, detail: readActorActivityDetail(payload, candidate) };
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'A sampled item returned incompatible activity detail.',
      };
    }
  }

  function isCurrent(requestId, expectedFingerprint) {
    const connection = readConnection();
    const candidates = activityCandidates(board);
    return gate.isCurrent(requestId)
      && dialog.open
      && requestFingerprint(connection, candidates) === expectedFingerprint;
  }

  function showFailure(message, fingerprint) {
    refreshButton.disabled = false;
    state.textContent = 'needs attention';
    showInlineError(message);
    if (!currentSample || currentSample.fingerprint !== fingerprint) {
      body.replaceChildren(emptyBlock('No valid actor activity sample is available yet.'));
    }
  }

  function showInlineError(message) {
    error.textContent = redactCredentialText(String(message).slice(0, 1_200));
    error.hidden = false;
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }

  return {
    reset() {
      gate.invalidate();
      currentSample = null;
      clearError();
      syncCandidates();
      if (dialog.open) dialog.close();
    },
    destroy() {
      gate.invalidate();
      boardObserver.disconnect();
      dashboardObserver.disconnect();
      connectionObserver.disconnect();
      dialog.remove();
      openButton.remove();
    },
  };
}

function activityCandidates(board) {
  const values = [];
  for (const column of board.querySelectorAll('section.column')) {
    const status = ITEM_STATUSES.find((candidate) => column.classList.contains(`status-${candidate}`)) || '';
    if (!status) continue;
    for (const card of column.querySelectorAll('button.card[data-item-id]')) {
      const identity = card.querySelector('.card-top span')?.textContent?.trim() || '';
      const separator = identity.indexOf(' · ');
      values.push({
        id: card.dataset.itemId || '',
        project: separator >= 0 ? identity.slice(separator + 3) : '',
        title: card.querySelector('h4')?.textContent || '',
        status,
      });
    }
  }
  return normalizeActivityCandidates(values);
}

function candidateFingerprint(candidates) {
  return candidates.map((candidate) => `${candidate.id}\u0000${candidate.project}`).join('\u0001');
}

function requestFingerprint(connection, candidates) {
  return `${connection.endpoint}\u0000${connection.token}\u0000${candidateFingerprint(candidates)}`;
}

function readConnection() {
  let token = '';
  let endpoint = '';
  try {
    token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    token = '';
  }
  try {
    endpoint = localStorage.getItem(ENDPOINT_STORAGE_KEY) || '';
  } catch {
    endpoint = '';
  }
  return { endpoint, token };
}

function renderActivity(activity, requestedItems, failureCount) {
  const body = document.querySelector('#actor-activity-dialog .actor-activity-body');
  if (!body) return;
  const fragment = document.createDocumentFragment();
  const note = element('p', 'actor-activity-note');
  note.textContent = `Bounded sample: ${activity.sampledItems} successful details from ${requestedItems} board items, at most 20 recent events per item and 200 events overall. This is not a complete workspace audit.`;
  fragment.append(note);

  const metrics = element('section', 'actor-activity-metrics');
  metrics.setAttribute('aria-label', 'Actor activity sample totals');
  metrics.append(
    metric('sampled items', activity.sampledItems),
    metric('recent events', activity.eventCount),
    metric('actors', activity.actorCount),
    metric('unavailable', failureCount),
  );
  fragment.append(metrics);

  if (activity.observedEventCount > activity.eventCount || activity.systemEventCount) {
    const detail = element('p', 'actor-activity-note');
    const truncated = activity.observedEventCount > activity.eventCount
      ? `${activity.eventCount} of ${activity.observedEventCount} observed events retained. `
      : '';
    detail.textContent = `${truncated}${activity.systemEventCount} system events had no actor attribution.`;
    fragment.append(detail);
  }

  if (!activity.actors.length) {
    fragment.append(emptyBlock('No actor-attributed claims or recent events were found in this sample.'));
    body.replaceChildren(fragment);
    return;
  }

  const list = element('div', 'actor-activity-list');
  for (const actor of activity.actors) list.append(actorBlock(actor));
  fragment.append(list);
  body.replaceChildren(fragment);
}

function actorBlock(actor) {
  const article = element('article', 'actor-activity-actor');
  const head = element('header', 'actor-activity-actor-head');
  const title = element('h3');
  title.textContent = redactCredentialText(actor.id);
  const latest = element('span');
  latest.textContent = actor.latestAt ? `latest ${formatTimestamp(actor.latestAt)}` : 'no recent time';
  head.append(title, latest);
  article.append(head);

  if (actor.currentClaims.length) {
    const claims = activitySection(`Current claims · ${actor.currentClaims.length}`);
    for (const claim of actor.currentClaims) {
      const row = element('li', 'actor-activity-row');
      const heading = element('strong');
      heading.textContent = redactCredentialText(claim.title);
      const meta = element('p');
      meta.textContent = `${claim.project} · ${claim.status} · updated ${formatTimestamp(claim.updatedAt)}`;
      row.append(heading, meta);
      claims.list.append(row);
    }
    article.append(claims.section);
  }

  if (actor.events.length) {
    const events = activitySection(`Recent events · ${actor.eventCount}`);
    for (const event of actor.events) {
      const row = element('li', 'actor-activity-row');
      const heading = element('strong');
      heading.textContent = redactCredentialText(event.type);
      const meta = element('p');
      meta.textContent = `${event.itemTitle} · ${event.project} · ${formatTimestamp(event.createdAt)}`;
      row.append(heading, meta);
      events.list.append(row);
    }
    article.append(events.section);
  }
  return article;
}

function activitySection(title) {
  const section = element('section', 'actor-activity-section');
  const heading = element('h4');
  heading.textContent = title;
  const list = element('ul');
  section.append(heading, list);
  return { section, list };
}

function metric(label, value) {
  const card = element('article');
  const name = element('span');
  name.textContent = label;
  const count = element('strong');
  count.textContent = String(value);
  card.append(name, count);
  return card;
}

function emptyBlock(message) {
  const block = element('p', 'actor-activity-empty');
  block.textContent = message;
  return block;
}

function formatTimestamp(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? redactCredentialText(value) : date.toLocaleString();
}

function ensureStyles(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

if (typeof document !== 'undefined') installActorActivityController();
