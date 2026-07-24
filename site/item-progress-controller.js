import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';
import {
  createProgressIdempotencyTracker,
  readProgressEvent,
  validateProgressInput,
} from './item-progress.js';
import { readStoredActor } from './session-context.js';

const ACTOR_STORAGE_KEY = 'stensiblyActor';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';

export function installProgressController() {
  const board = document.querySelector('#board');
  const dialog = document.querySelector('#item-detail-dialog');
  const body = document.querySelector('#item-detail-body');
  const refreshButton = document.querySelector('#item-detail-refresh');
  const detailState = document.querySelector('#item-detail-state');
  const announcer = document.querySelector('#item-detail-announcer');
  const contextPanel = document.querySelector('#session-context-panel');
  if (!board || !dialog || !body || !refreshButton || !detailState || !announcer || !contextPanel) return null;

  ensureStyles('stensibly-item-claim-styles', '/item-claim.css');
  ensureStyles('stensibly-item-progress-styles', '/item-progress.css');

  const gate = createRequestGate();
  const idempotency = createProgressIdempotencyTracker();
  let itemId = '';
  let contextFingerprint = readContext().fingerprint;
  let renderQueued = false;
  let formState = freshState();
  const locks = { refresh: false };

  board.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest('button.card[data-item-id]');
    if (!(card instanceof HTMLButtonElement) || !board.contains(card)) return;
    const nextItemId = card.dataset.itemId || '';
    if (!nextItemId) return;
    gate.invalidate();
    idempotency.reset();
    itemId = nextItemId;
    formState = freshState();
    scheduleRender();
  });

  dialog.addEventListener('close', () => {
    gate.invalidate();
    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    itemId = '';
    formState = freshState();
  });

  const bodyObserver = new MutationObserver(() => scheduleRender());
  bodyObserver.observe(body, { childList: true, subtree: true });

  const contextObserver = new MutationObserver(() => {
    const next = readContext().fingerprint;
    if (next === contextFingerprint) return;
    contextFingerprint = next;
    gate.invalidate();
    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    formState = { ...formState, phase: 'ready', message: '' };
    scheduleRender();
  });
  contextObserver.observe(contextPanel, { attributes: true, childList: true, subtree: true, characterData: true });

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

    bodyObserver.disconnect();
    try {
      body.querySelector('#item-progress-section')?.remove();
      const section = sectionBlock('Record progress');
      section.id = 'item-progress-section';
      const note = element('p', 'detail-progress-note');
      note.textContent = 'Appends historical evidence. This does not replace the item summary or current next action.';
      section.append(note);

      const context = readContext();
      if (!context.canWrite || !context.actor) {
        section.append(emptyBlock('A write-capable token and active session actor are required to record progress.'));
        eventSection.before(section);
        return;
      }

      const form = element('form', 'detail-progress-form');
      const summaryLabel = element('label');
      summaryLabel.textContent = 'Progress summary';
      const summary = element('textarea');
      summary.name = 'summary';
      summary.required = true;
      summary.maxLength = 10_000;
      summary.rows = 4;
      summary.value = formState.summary;
      summaryLabel.append(summary);

      const nextLabel = element('label');
      nextLabel.textContent = 'Next action for the event (optional)';
      const nextAction = element('textarea');
      nextAction.name = 'nextAction';
      nextAction.maxLength = 2_000;
      nextAction.rows = 2;
      nextAction.value = formState.nextAction;
      nextLabel.append(nextAction);

      const actions = element('div', 'detail-progress-actions');
      const submit = element('button');
      submit.type = 'submit';
      submit.textContent = 'record progress';
      submit.disabled = formState.phase === 'submitting';
      const actionState = element('span');
      actionState.textContent = phaseLabel(formState.phase);
      actions.append(submit, actionState);

      const actionError = element('p', 'detail-progress-error');
      actionError.setAttribute('role', 'alert');
      actionError.hidden = !formState.message;
      actionError.textContent = redactCredentialText(formState.message);

      const onInput = () => {
        if (formState.phase === 'submitting') return;
        const nextSummary = summary.value;
        const nextNextAction = nextAction.value;
        if (nextSummary === formState.summary && nextNextAction === formState.nextAction) return;
        idempotency.reset();
        formState = { phase: 'ready', summary: nextSummary, nextAction: nextNextAction, message: '' };
        actionState.textContent = 'ready';
        actionError.hidden = true;
        actionError.textContent = '';
      };
      summary.addEventListener('input', onInput);
      nextAction.addEventListener('input', onInput);
      form.addEventListener('submit', (event) => void submitProgress(event, summary, nextAction));
      form.append(summaryLabel, nextLabel, actions, actionError);
      section.append(form);
      eventSection.before(section);

      if (formState.phase === 'submitting') lockOtherActions(body, refreshButton, locks);
      else restoreOtherActions(body, refreshButton, locks);
    } finally {
      bodyObserver.observe(body, { childList: true, subtree: true });
    }
  }

  async function submitProgress(event, summary, nextAction) {
    event.preventDefault();
    if (formState.phase === 'submitting') return;
    if (refreshButton.disabled && !locks.refresh) {
      formState = { ...formState, phase: 'ready', message: 'Another item-detail action is still running. Try again after it finishes.' };
      render();
      return;
    }

    const context = readContext();
    if (!context.canWrite || !context.actor || !context.endpoint || !context.token) {
      setFailure('Write context is unavailable. Reconnect and choose an active session actor.', 'authorization failed');
      return;
    }

    let input;
    try {
      input = validateProgressInput(itemId, summary.value, nextAction.value, context.actor);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Progress validation failed.', 'needs attention');
      return;
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.keyFor(input);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Could not generate a progress idempotency key.', 'needs attention');
      return;
    }

    const requestId = gate.begin();
    const expectedContext = context.fingerprint;
    formState = {
      phase: 'submitting',
      summary: input.payload.summary,
      nextAction: input.payload.nextAction || '',
      message: '',
    };
    detailState.textContent = 'recording progress';
    render();

    let response;
    try {
      response = await fetch(`${context.endpoint}/api/v1/items/${encodeURIComponent(input.id)}/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ actor: input.actor, type: input.type, payload: input.payload }),
      });
    } catch {
      if (!isCurrent(requestId, input.id, expectedContext)) return;
      setFailure('The progress request could not reach the API. Retry the unchanged form to reuse the same idempotency key.', 'needs attention', 'retry available');
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
        ? 'Refresh event history to check whether the progress was already recorded, or change the form to generate a new key.'
        : '';
      const message = [baseMessage, validation, conflictHint, serverRequestId ? `Request ID: ${serverRequestId}` : '']
        .filter(Boolean)
        .join(' ');
      setFailure(
        message,
        response.status === 409 ? 'conflict' : response.status === 401 || response.status === 403 ? 'authorization failed' : 'needs attention',
        response.status === 409 ? 'conflict' : 'retry available',
      );
      return;
    }

    let progressEvent;
    try {
      progressEvent = readProgressEvent(payload, {
        itemId: input.id,
        actorId: input.actor.id,
        summary: input.payload.summary,
        nextAction: input.payload.nextAction || '',
      });
    } catch (cause) {
      if (!isCurrent(requestId, input.id, expectedContext)) return;
      setFailure(cause instanceof Error ? cause.message : 'The endpoint returned incompatible progress.', 'needs attention', 'retry available');
      return;
    }

    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    formState = { phase: 'recorded', summary: '', nextAction: '', message: '' };
    detailState.textContent = 'progress recorded';
    announcer.textContent = `Progress recorded at ${formatTimestamp(progressEvent.createdAt)}.`;
    render();
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
    fingerprint: `${canWrite ? 'write' : 'read'}\u0000${endpoint}\u0000${token ? 'token' : 'no-token'}\u0000${actorFingerprint}`,
  };
}

function findEventSection(body) {
  return [...body.children].find((child) => {
    if (!(child instanceof HTMLElement) || !child.classList.contains('detail-section')) return false;
    return child.querySelector('h3')?.textContent?.startsWith('Event history');
  }) || null;
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
  if (phase === 'recorded') return 'recorded';
  return phase;
}

function freshState() {
  return { phase: 'ready', summary: '', nextAction: '', message: '' };
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
  for (const button of body.querySelectorAll('form:not(.detail-progress-form) button[type="submit"]')) {
    if (button.disabled) continue;
    button.disabled = true;
    button.dataset.progressLocked = 'true';
  }
}

function restoreOtherActions(body, refreshButton, locks) {
  if (locks.refresh) {
    refreshButton.disabled = false;
    locks.refresh = false;
  }
  for (const button of body.querySelectorAll('button[data-progress-locked="true"]')) {
    button.disabled = false;
    delete button.dataset.progressLocked;
  }
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'the server-reported time' : date.toLocaleString();
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

if (typeof document !== 'undefined') installProgressController();
