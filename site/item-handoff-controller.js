import {
  canHandoffStatus,
  createHandoffIdempotencyTracker,
  readHandedOffItem,
  validateHandoffInput,
} from './item-handoff.js';
import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';
import { readStoredActor } from './session-context.js';

const ACTOR_STORAGE_KEY = 'stensiblyActor';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const ITEM_STATUSES = ['ready', 'active', 'blocked', 'done', 'archived'];
const SIDECAR_IDS = [
  'item-progress-section',
  'item-block-transition-section',
  'item-complete-section',
  'item-handoff-section',
  'item-lease-state',
];

export function installHandoffController() {
  const board = document.querySelector('#board');
  const dialog = document.querySelector('#item-detail-dialog');
  const body = document.querySelector('#item-detail-body');
  const refreshButton = document.querySelector('#item-detail-refresh');
  const boardRefreshButton = document.querySelector('#refresh');
  const detailState = document.querySelector('#item-detail-state');
  const announcer = document.querySelector('#item-detail-announcer');
  const contextPanel = document.querySelector('#session-context-panel');
  if (!board || !dialog || !body || !refreshButton || !detailState || !announcer || !contextPanel) return null;

  ensureStyles('stensibly-item-handoff-styles', '/item-handoff.css');

  const gate = createRequestGate();
  const idempotency = createHandoffIdempotencyTracker();
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
    if (
      nextStatus
      && nextStatus !== currentStatus
      && !['submitting', 'handed-off'].includes(formState.phase)
    ) {
      currentStatus = nextStatus;
      idempotency.reset();
      formState = stateForStatusChange(currentStatus, formState);
    } else if (nextStatus && nextStatus === currentStatus && formState.phase === 'handed-off') {
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
    formState = {
      ...freshState(),
      summary: formState.summary,
      nextAction: formState.nextAction,
      toActorId: formState.toActorId,
    };
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
      && !['submitting', 'handed-off'].includes(formState.phase)
    ) {
      currentStatus = renderedStatus;
      idempotency.reset();
      formState = stateForStatusChange(currentStatus, formState);
    }

    bodyObserver.disconnect();
    try {
      body.querySelector('#item-handoff-section')?.remove();
      const section = sectionBlock('Hand off work');
      section.id = 'item-handoff-section';
      const context = readContext();

      if (!context.canWrite || !context.actor) {
        section.append(emptyBlock('A write-capable token and active session actor are required to hand off work.'));
        appendStoredError(section);
        eventSection.before(section);
        return;
      }
      if (!canHandoffStatus(currentStatus)) {
        section.append(emptyBlock(`Handoff is unavailable while this item is ${currentStatus || 'in its current state'}.`));
        appendStoredError(section);
        eventSection.before(section);
        return;
      }

      const note = element('p', 'detail-handoff-note');
      note.textContent = 'Handoff replaces the current summary and next action, returns the item to ready, and releases any lease. A target actor ID is routing context only; it does not claim the item.';
      const form = element('form', 'detail-handoff-form');

      const summaryLabel = element('label');
      summaryLabel.textContent = 'Handoff summary';
      const summary = element('textarea');
      summary.name = 'summary';
      summary.required = true;
      summary.maxLength = 10_000;
      summary.rows = 4;
      summary.value = formState.summary;
      summaryLabel.append(summary);

      const nextActionLabel = element('label');
      nextActionLabel.textContent = 'Next action';
      const nextAction = element('textarea');
      nextAction.name = 'nextAction';
      nextAction.required = true;
      nextAction.maxLength = 2_000;
      nextAction.rows = 3;
      nextAction.value = formState.nextAction;
      nextActionLabel.append(nextAction);

      const targetLabel = element('label');
      targetLabel.textContent = 'Target actor ID (optional)';
      const toActorId = element('input');
      toActorId.name = 'toActorId';
      toActorId.type = 'text';
      toActorId.maxLength = 120;
      toActorId.autocomplete = 'off';
      toActorId.value = formState.toActorId;
      targetLabel.append(toActorId);

      const actions = element('div', 'detail-handoff-actions');
      const submit = element('button');
      submit.type = 'submit';
      submit.textContent = 'record handoff';
      submit.disabled = formState.phase === 'submitting';
      const state = element('span');
      state.textContent = phaseLabel(formState.phase);
      actions.append(submit, state);

      const error = element('p', 'detail-handoff-error');
      error.setAttribute('role', 'alert');
      error.hidden = !formState.message;
      error.textContent = redactCredentialText(formState.message);

      const onInput = () => {
        if (formState.phase === 'submitting') return;
        const nextValues = {
          summary: summary.value,
          nextAction: nextAction.value,
          toActorId: toActorId.value,
        };
        if (
          nextValues.summary === formState.summary
          && nextValues.nextAction === formState.nextAction
          && nextValues.toActorId === formState.toActorId
        ) return;
        idempotency.reset();
        formState = { phase: 'ready', ...nextValues, message: '' };
        state.textContent = 'ready';
        error.hidden = true;
        error.textContent = '';
      };
      summary.addEventListener('input', onInput);
      nextAction.addEventListener('input', onInput);
      toActorId.addEventListener('input', onInput);
      form.addEventListener('submit', (event) => void submitHandoff(event, summary, nextAction, toActorId));
      form.append(summaryLabel, nextActionLabel, targetLabel, actions, error);
      section.append(note, form);
      eventSection.before(section);

      if (formState.phase === 'submitting') lockOtherActions(body, refreshButton, locks);
      else restoreOtherActions(body, refreshButton, locks);
    } finally {
      bodyObserver.observe(body, { childList: true, subtree: true });
    }
  }

  async function submitHandoff(event, summary, nextAction, toActorId) {
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
      input = validateHandoffInput(itemId, summary.value, nextAction.value, toActorId.value, context.actor);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Handoff validation failed.', 'needs attention', 'ready');
      return;
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.keyFor(input);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Could not generate a handoff idempotency key.', 'needs attention', 'ready');
      return;
    }

    const requestId = gate.begin();
    const expectedContext = context.fingerprint;
    formState = {
      phase: 'submitting',
      summary: input.summary,
      nextAction: input.nextAction,
      toActorId: input.toActorId || '',
      message: '',
    };
    detailState.textContent = 'recording handoff';
    render();

    let response;
    try {
      response = await fetch(`${context.endpoint}/api/v1/items/${encodeURIComponent(input.id)}/handoff`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          actor: input.actor,
          summary: input.summary,
          nextAction: input.nextAction,
          ...(input.toActorId ? { toActorId: input.toActorId } : {}),
        }),
      });
    } catch {
      if (!isCurrent(requestId, input.id, expectedContext)) return;
      setFailure('The handoff request could not reach the API. Retry the unchanged form to reuse the same idempotency key.', 'needs attention');
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
        ? 'Refresh detail to inspect the current status and holder before retrying.'
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

    let handedOff;
    try {
      handedOff = readHandedOffItem(payload, {
        id: input.id,
        summary: input.summary,
        nextAction: input.nextAction,
      });
    } catch (cause) {
      if (!isCurrent(requestId, input.id, expectedContext)) return;
      setFailure(cause instanceof Error ? cause.message : 'The endpoint returned an incompatible handed-off item.', 'needs attention');
      return;
    }

    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    currentStatus = handedOff.status;
    formState = { ...freshState(), phase: 'handed-off' };
    detailState.textContent = 'handoff recorded';
    announcer.textContent = input.toActorId
      ? `Handoff recorded for ${redactCredentialText(input.toActorId)}. The item is ready and unclaimed.`
      : 'Handoff recorded. The item is ready and unclaimed.';
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

  function appendStoredError(section) {
    if (!formState.message) return;
    const error = element('p', 'detail-handoff-error');
    error.setAttribute('role', 'alert');
    error.textContent = redactCredentialText(formState.message);
    section.append(error);
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
    fingerprint: `${canWrite ? 'write' : 'read'}\u0000${endpoint}\u0000${token ? 'token' : 'no-token'}\u0000${actorFingerprint}`,
  };
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
  if (phase === 'submitting') return 'recording';
  if (phase === 'handed-off') return 'recorded';
  return phase;
}

function freshState() {
  return { phase: 'ready', summary: '', nextAction: '', toActorId: '', message: '' };
}

function stateForStatusChange(status, previous) {
  const next = freshState();
  if (!canHandoffStatus(status) || !['conflict', 'retry available'].includes(previous.phase)) return next;
  return {
    ...next,
    phase: previous.phase,
    summary: previous.summary,
    nextAction: previous.nextAction,
    toActorId: previous.toActorId,
    message: previous.message,
  };
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
  for (const button of body.querySelectorAll('form:not(.detail-handoff-form) button[type="submit"]')) {
    if (button.disabled) continue;
    button.disabled = true;
    button.dataset.handoffLocked = 'true';
  }
}

function restoreOtherActions(body, refreshButton, locks) {
  if (locks.refresh) {
    refreshButton.disabled = false;
    locks.refresh = false;
  }
  for (const button of body.querySelectorAll('button[data-handoff-locked="true"]')) {
    button.disabled = false;
    delete button.dataset.handoffLocked;
  }
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

if (typeof document !== 'undefined') installHandoffController();
