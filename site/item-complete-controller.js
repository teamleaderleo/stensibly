import {
  canCompleteStatus,
  createCompleteIdempotencyTracker,
  readCompletedItem,
  validateCompleteInput,
} from './item-complete.js';
import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';
import { readSemanticClaimGeneration } from './item-semantic-generation-controller.js';
import { readStoredActor } from './session-context.js';

const ACTOR_STORAGE_KEY = 'stensiblyActor';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const ITEM_STATUSES = ['ready', 'active', 'blocked', 'done', 'archived'];
const SIDECAR_IDS = [
  'item-progress-section',
  'item-block-transition-section',
  'item-complete-section',
];

export function installCompleteController() {
  const board = document.querySelector('#board');
  const dialog = document.querySelector('#item-detail-dialog');
  const body = document.querySelector('#item-detail-body');
  const refreshButton = document.querySelector('#item-detail-refresh');
  const boardRefreshButton = document.querySelector('#refresh');
  const detailState = document.querySelector('#item-detail-state');
  const announcer = document.querySelector('#item-detail-announcer');
  const contextPanel = document.querySelector('#session-context-panel');
  if (!board || !dialog || !body || !refreshButton || !detailState || !announcer || !contextPanel) return null;

  ensureStyles('stensibly-item-complete-styles', '/item-complete.css');

  const gate = createRequestGate();
  const idempotency = createCompleteIdempotencyTracker();
  const locks = { refresh: false };
  let itemId = '';
  let currentStatus = '';
  let contextFingerprint = readContext().fingerprint;
  let renderQueued = false;
  let formState = freshState();

  board.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest('button.card[data-item-id]');
    if (!(card instanceof HTMLButtonElement) || !board.contains(card)) return;
    const nextItemId = card.dataset.itemId || '';
    if (!nextItemId) return;
    gate.invalidate();
    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    itemId = nextItemId;
    currentStatus = statusFromCard(card);
    formState = freshState();
    scheduleRender();
  });

  dialog.addEventListener('close', () => {
    gate.invalidate();
    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    itemId = '';
    currentStatus = '';
    formState = freshState();
  });

  const bodyObserver = new MutationObserver((records) => {
    if (records.every(isSidecarOnlyMutation)) return;
    const nextStatus = readRenderedStatus(body) || statusFromBoard(board, itemId) || currentStatus;
    if (nextStatus && nextStatus !== currentStatus) {
      currentStatus = nextStatus;
      if (formState.phase !== 'submitting') {
        idempotency.reset();
        formState = stateForStatusChange(currentStatus, formState);
      }
    } else if (nextStatus && formState.phase === 'completed') {
      formState = freshState();
    }
    scheduleRender();
  });
  bodyObserver.observe(body, { childList: true, subtree: true });

  const contextObserver = new MutationObserver(() => {
    const next = readContext().fingerprint;
    if (next === contextFingerprint) return;
    contextFingerprint = next;
    gate.invalidate();
    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    formState = { ...freshState(), summary: formState.summary };
    scheduleRender();
  });
  contextObserver.observe(contextPanel, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (!dialog.open || !itemId) return;
    const eventSection = findEventSection(body);
    if (!eventSection) return;
    const renderedStatus = readRenderedStatus(body);
    if (
      renderedStatus
      && renderedStatus !== currentStatus
      && !['submitting', 'completed'].includes(formState.phase)
    ) {
      currentStatus = renderedStatus;
      idempotency.reset();
      formState = stateForStatusChange(currentStatus, formState);
    }

    bodyObserver.disconnect();
    try {
      body.querySelector('#item-complete-section')?.remove();
      const section = sectionBlock('Complete work');
      section.id = 'item-complete-section';
      const context = readContext();

      if (!context.canWrite || !context.actor) {
        section.append(emptyBlock('A write-capable token and active session actor are required to complete work.'));
        eventSection.before(section);
        return;
      }
      if (!canCompleteStatus(currentStatus)) {
        section.append(emptyBlock(`Completion is unavailable while this item is ${currentStatus || 'in its current state'}.`));
        eventSection.before(section);
        return;
      }

      const note = element('p', 'detail-complete-note');
      note.textContent = 'Completion moves the item to done and releases any lease. Entering a summary replaces the current summary; leaving it blank preserves the current summary.';
      const form = element('form', 'detail-complete-form');
      const label = element('label');
      label.textContent = 'Completion summary (optional)';
      const summary = element('textarea');
      summary.name = 'summary';
      summary.maxLength = 10_000;
      summary.rows = 4;
      summary.value = formState.summary;
      label.append(summary);

      const actions = element('div', 'detail-complete-actions');
      const submit = element('button');
      submit.type = 'submit';
      submit.textContent = 'complete item';
      submit.disabled = formState.phase === 'submitting';
      const state = element('span');
      state.textContent = phaseLabel(formState.phase);
      actions.append(submit, state);

      const error = element('p', 'detail-complete-error');
      error.setAttribute('role', 'alert');
      error.hidden = !formState.message;
      error.textContent = redactCredentialText(formState.message);

      summary.addEventListener('input', () => {
        if (formState.phase === 'submitting') return;
        if (summary.value === formState.summary) return;
        idempotency.reset();
        formState = { phase: 'ready', summary: summary.value, message: '' };
        state.textContent = 'ready';
        error.hidden = true;
        error.textContent = '';
      });
      form.addEventListener('submit', (event) => void submitCompletion(event, summary));
      form.append(label, actions, error);
      section.append(note, form);
      eventSection.before(section);

      if (formState.phase === 'submitting') lockOtherActions(body, refreshButton, locks);
      else restoreOtherActions(body, refreshButton, locks);
    } finally {
      bodyObserver.observe(body, { childList: true, subtree: true });
    }
  }

  async function submitCompletion(event, summary) {
    event.preventDefault();
    if (formState.phase === 'submitting') return;
    if (refreshButton.disabled && !locks.refresh) {
      setFailure('Another item-detail action is still running. Try again after it finishes.', 'needs attention', 'ready');
      return;
    }

    const context = readContext();
    if (!context.canWrite || !context.actor || !context.endpoint || !context.token) {
      setFailure('Write context is unavailable. Reconnect and choose an active session actor.', 'authorization failed');
      return;
    }

    let input;
    try {
      input = validateCompleteInput(
        itemId,
        summary.value,
        context.actor,
        readSemanticClaimGeneration(body, itemId),
      );
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Completion validation failed.', 'needs attention', 'ready');
      return;
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.keyFor(input);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Could not generate a completion idempotency key.', 'needs attention', 'ready');
      return;
    }

    const requestId = gate.begin();
    const expectedContext = context.fingerprint;
    formState = { phase: 'submitting', summary: input.summary || '', message: '' };
    detailState.textContent = 'completing item';
    render();

    let response;
    try {
      response = await fetch(`${context.endpoint}/api/v1/items/${encodeURIComponent(input.id)}/complete`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${context.token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          actor: input.actor,
          expectedClaimGeneration: input.expectedClaimGeneration,
          ...(input.summary ? { summary: input.summary } : {}),
        }),
      });
    } catch {
      if (!isCurrent(requestId, input.id, expectedContext)) return;
      setFailure('The completion request could not reach the API. Retry the unchanged form to reuse the same idempotency key.', 'needs attention');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!isCurrent(requestId, input.id, expectedContext)) return;
    if (!response.ok) {
      const failure = describeHttpFailure(response.status, payload);
      const validation = formatValidationIssues(payload);
      const serverRequestId = safeRequestId(response.headers.get('x-request-id'), context.token);
      const baseMessage = response.status === 404
        ? 'This item no longer exists or is outside the token project boundary.'
        : failure.message;
      const conflictHint = response.status === 409
        ? 'Refresh detail to inspect the current status, holder, and claim generation before retrying.'
        : '';
      const message = [baseMessage, validation, conflictHint, serverRequestId ? `Request ID: ${serverRequestId}` : '']
        .filter(Boolean)
        .join(' ');
      setFailure(
        message,
        response.status === 409
          ? 'conflict'
          : response.status === 401 || response.status === 403
            ? 'authorization failed'
            : 'needs attention',
        response.status === 409 ? 'conflict' : 'retry available',
      );
      return;
    }

    let completed;
    try {
      completed = readCompletedItem(payload, {
        id: input.id,
        expectedClaimGeneration: input.expectedClaimGeneration,
        ...(input.summary ? { summary: input.summary } : {}),
      });
    } catch (cause) {
      if (!isCurrent(requestId, input.id, expectedContext)) return;
      setFailure(cause instanceof Error ? cause.message : 'The endpoint returned an incompatible completed item.', 'needs attention');
      return;
    }

    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    currentStatus = completed.status;
    formState = { phase: 'completed', summary: '', message: '' };
    detailState.textContent = 'item completed';
    announcer.textContent = 'Item completed and claim released.';
    render();
    if (boardRefreshButton instanceof HTMLButtonElement) boardRefreshButton.click();
    refreshButton.click();
  }

  function isCurrent(requestId, expectedItemId, expectedContext) {
    return gate.isCurrent(requestId)
      && dialog.open
      && itemId === expectedItemId
      && readContext().fingerprint === expectedContext;
  }

  function setFailure(message, globalState, phase = 'retry available') {
    restoreOtherActions(body, refreshButton, locks);
    formState = { ...formState, phase, message: redactCredentialText(message) };
    detailState.textContent = globalState;
    render();
  }

  return {
    reset() {
      gate.invalidate();
      idempotency.reset();
      restoreOtherActions(body, refreshButton, locks);
      formState = freshState();
      render();
    },
  };
}

function readContext() {
  const panel = document.querySelector('#session-context-panel');
  const canWrite = panel?.dataset.mode === 'write';
  let actor = null;
  let token = '';
  let endpoint = '';
  try {
    actor = readStoredActor(sessionStorage.getItem(ACTOR_STORAGE_KEY) || '');
    token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    actor = null;
    token = '';
  }
  try {
    endpoint = localStorage.getItem(ENDPOINT_STORAGE_KEY) || '';
  } catch {
    endpoint = '';
  }
  const actorFingerprint = actor ? `${actor.id}\u0000${actor.name}\u0000${actor.kind}` : '';
  return {
    actor,
    canWrite,
    endpoint,
    token,
    fingerprint: `${canWrite ? 'write' : 'read'}\u0000${endpoint}\u0000${tokenDiscriminator(token)}\u0000${actorFingerprint}`,
  };
}

function tokenDiscriminator(token) {
  if (!token) return 'no-token';
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (Math.imul(hash, 31) + token.charCodeAt(index)) | 0;
  }
  return `token-${(hash >>> 0).toString(36)}`;
}

function readRenderedStatus(body) {
  for (const term of body.querySelectorAll('.detail-grid dt')) {
    if (term.textContent?.trim() !== 'Status') continue;
    const status = term.nextElementSibling?.textContent?.trim() || '';
    return ITEM_STATUSES.includes(status) ? status : '';
  }
  return '';
}

function statusFromCard(card) {
  const column = card.closest('section.column');
  return ITEM_STATUSES.find((status) => column?.classList.contains(status)) || '';
}

function statusFromBoard(board, itemId) {
  const card = [...board.querySelectorAll('button.card[data-item-id]')]
    .find((candidate) => candidate.dataset.itemId === itemId);
  return card ? statusFromCard(card) : '';
}

function findEventSection(body) {
  return [...body.children].find((child) => {
    if (!(child instanceof HTMLElement) || !child.classList.contains('detail-section')) return false;
    return child.querySelector('h3')?.textContent?.startsWith('Event history');
  }) || null;
}

function isSidecarOnlyMutation(record) {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest(`#${SIDECAR_IDS.join(', #')}`)) return true;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.length > 0 && nodes.every((node) => node instanceof Element && SIDECAR_IDS.includes(node.id));
}

function sectionBlock(heading) {
  const section = element('section', 'detail-section');
  const title = element('h3');
  title.textContent = heading;
  section.append(title);
  return section;
}

function emptyBlock(message) {
  const block = element('p', 'detail-empty');
  block.textContent = message;
  return block;
}

function phaseLabel(phase) {
  if (phase === 'submitting') return 'completing';
  if (phase === 'completed') return 'completed';
  return phase;
}

function freshState() {
  return { phase: 'ready', summary: '', message: '' };
}

function stateForStatusChange(status, previous) {
  const next = freshState();
  if (!canCompleteStatus(status) || !['conflict', 'retry available'].includes(previous.phase)) return next;
  return { ...next, phase: previous.phase, summary: previous.summary, message: previous.message };
}

function ensureStyles(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

function lockOtherActions(body, refreshButton, locks) {
  if (!refreshButton.disabled) {
    refreshButton.disabled = true;
    locks.refresh = true;
  }
  for (const button of body.querySelectorAll('form:not(.detail-complete-form) button[type="submit"]')) {
    if (button.disabled) continue;
    button.disabled = true;
    button.dataset.completeLocked = 'true';
  }
}

function restoreOtherActions(body, refreshButton, locks) {
  if (locks.refresh) {
    refreshButton.disabled = false;
    locks.refresh = false;
  }
  for (const button of body.querySelectorAll('button[data-complete-locked="true"]')) {
    button.disabled = false;
    delete button.dataset.completeLocked;
  }
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

if (typeof document !== 'undefined') installCompleteController();
