import {
  createTransitionIdempotencyTracker,
  readTransitionItem,
  transitionForStatus,
  validateBlockInput,
  validateUnblockInput,
} from './item-block.js';
import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';
import { readStoredActor } from './session-context.js';

const ACTOR_STORAGE_KEY = 'stensiblyActor';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const ITEM_STATUSES = ['ready', 'active', 'blocked', 'done', 'archived'];

export function installBlockController() {
  const board = document.querySelector('#board');
  const dialog = document.querySelector('#item-detail-dialog');
  const body = document.querySelector('#item-detail-body');
  const refreshButton = document.querySelector('#item-detail-refresh');
  const detailState = document.querySelector('#item-detail-state');
  const announcer = document.querySelector('#item-detail-announcer');
  const contextPanel = document.querySelector('#session-context-panel');
  if (!board || !dialog || !body || !refreshButton || !detailState || !announcer || !contextPanel) return null;

  ensureStyles('stensibly-item-block-styles', '/item-block.css');

  const gate = createRequestGate();
  const idempotency = createTransitionIdempotencyTracker();
  const locks = { refresh: false };
  let itemId = '';
  let currentStatus = '';
  let contextFingerprint = readContext().fingerprint;
  let renderQueued = false;
  let formState = freshState(null);

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
    formState = freshState(transitionForStatus(currentStatus));
    scheduleRender();
  });

  dialog.addEventListener('close', () => {
    gate.invalidate();
    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    itemId = '';
    currentStatus = '';
    formState = freshState(null);
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
    } else if (nextStatus && formState.phase === 'transitioned') {
      formState = freshState(transitionForStatus(currentStatus));
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
      ...freshState(transitionForStatus(currentStatus)),
      reason: formState.reason,
      nextAction: formState.nextAction,
    };
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
    const renderedStatus = readRenderedStatus(body);
    if (
      renderedStatus
      && renderedStatus !== currentStatus
      && !['submitting', 'transitioned'].includes(formState.phase)
    ) {
      currentStatus = renderedStatus;
      idempotency.reset();
      formState = stateForStatusChange(currentStatus, formState);
    }

    bodyObserver.disconnect();
    try {
      body.querySelector('#item-block-transition-section')?.remove();
      ensureBlockReasonPresentation(body, currentStatus);
      const section = sectionBlock('Block or unblock');
      section.id = 'item-block-transition-section';
      const context = readContext();
      const action = transitionForStatus(currentStatus);

      if (!context.canWrite || !context.actor) {
        section.append(emptyBlock('A write-capable token and active session actor are required to change this item state.'));
        eventSection.before(section);
        return;
      }
      if (!action) {
        section.append(emptyBlock(`Block and unblock are unavailable while this item is ${currentStatus || 'in its current state'}.`));
        eventSection.before(section);
        return;
      }
      if (formState.mode !== action && formState.phase !== 'submitting') {
        formState = stateForStatusChange(currentStatus, formState);
      }
      section.append(action === 'block' ? blockForm() : unblockForm());
      eventSection.before(section);
      if (formState.phase === 'submitting') lockOtherActions(body, refreshButton, locks);
      else restoreOtherActions(body, refreshButton, locks);
    } finally {
      bodyObserver.observe(body, { childList: true, subtree: true });
    }
  }

  function blockForm() {
    const fragment = document.createDocumentFragment();
    const note = element('p', 'detail-transition-note');
    note.textContent = 'Blocking replaces the current summary with this reason, releases the current lease, and optionally replaces the next action.';
    const form = element('form', 'detail-transition-form');
    const reasonLabel = element('label');
    reasonLabel.textContent = 'Block reason';
    const reason = element('textarea');
    reason.name = 'reason';
    reason.required = true;
    reason.maxLength = 10_000;
    reason.rows = 4;
    reason.value = formState.reason;
    reasonLabel.append(reason);
    const next = nextActionField('Next action after the blocker is resolved (optional)');
    const controls = transitionControls('block item');
    bindInputs(reason, next.input, controls.error, controls.state);
    form.addEventListener('submit', (event) => void submitTransition(event, 'block', reason, next.input));
    form.append(reasonLabel, next.label, controls.actions, controls.error);
    fragment.append(note, form);
    return fragment;
  }

  function unblockForm() {
    const fragment = document.createDocumentFragment();
    const note = element('p', 'detail-transition-note');
    note.textContent = 'Unblocking returns this item to ready, leaves the block summary intact, clears lease state, and optionally replaces the next action.';
    const form = element('form', 'detail-transition-form');
    const next = nextActionField('Next action (optional)');
    const controls = transitionControls('unblock item');
    bindInputs(null, next.input, controls.error, controls.state);
    form.addEventListener('submit', (event) => void submitTransition(event, 'unblock', null, next.input));
    form.append(next.label, controls.actions, controls.error);
    fragment.append(note, form);
    return fragment;
  }

  function nextActionField(labelText) {
    const label = element('label');
    label.textContent = labelText;
    const input = element('textarea');
    input.name = 'nextAction';
    input.maxLength = 2_000;
    input.rows = 2;
    input.value = formState.nextAction;
    label.append(input);
    return { label, input };
  }

  function transitionControls(buttonText) {
    const actions = element('div', 'detail-transition-actions');
    const submit = element('button');
    submit.type = 'submit';
    submit.textContent = buttonText;
    submit.disabled = formState.phase === 'submitting';
    const state = element('span');
    state.textContent = phaseLabel(formState.phase);
    actions.append(submit, state);
    const error = element('p', 'detail-transition-error');
    error.setAttribute('role', 'alert');
    error.hidden = !formState.message;
    error.textContent = redactCredentialText(formState.message);
    return { actions, state, error };
  }

  function bindInputs(reason, nextAction, error, state) {
    const onInput = () => {
      if (formState.phase === 'submitting') return;
      const nextReason = reason?.value || '';
      const nextNextAction = nextAction.value;
      if (nextReason === formState.reason && nextNextAction === formState.nextAction) return;
      idempotency.reset();
      formState = {
        mode: formState.mode,
        phase: 'ready',
        reason: nextReason,
        nextAction: nextNextAction,
        message: '',
      };
      state.textContent = 'ready';
      error.hidden = true;
      error.textContent = '';
    };
    reason?.addEventListener('input', onInput);
    nextAction.addEventListener('input', onInput);
  }

  async function submitTransition(event, action, reason, nextAction) {
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
      input = action === 'block'
        ? validateBlockInput(itemId, reason?.value, nextAction.value, context.actor)
        : validateUnblockInput(itemId, nextAction.value, context.actor);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Transition validation failed.', 'needs attention', 'ready');
      return;
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.keyFor(input);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Could not generate a transition idempotency key.', 'needs attention', 'ready');
      return;
    }

    const requestId = gate.begin();
    const expectedContext = context.fingerprint;
    formState = {
      mode: action,
      phase: 'submitting',
      reason: input.reason || '',
      nextAction: input.nextAction || '',
      message: '',
    };
    detailState.textContent = action === 'block' ? 'blocking item' : 'unblocking item';
    render();

    let response;
    try {
      const requestBody = action === 'block'
        ? { actor: input.actor, reason: input.reason, ...(input.nextAction ? { nextAction: input.nextAction } : {}) }
        : { actor: input.actor, ...(input.nextAction ? { nextAction: input.nextAction } : {}) };
      response = await fetch(`${context.endpoint}/api/v1/items/${encodeURIComponent(input.id)}/${action}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });
    } catch {
      if (!isCurrent(requestId, input.id, action, expectedContext)) return;
      setFailure(`The ${action} request could not reach the API. Retry the unchanged form to reuse the same idempotency key.`, 'needs attention');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!isCurrent(requestId, input.id, action, expectedContext)) return;
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
        response.status === 409 ? 'conflict' : response.status === 401 || response.status === 403 ? 'authorization failed' : 'needs attention',
        response.status === 409 ? 'conflict' : 'retry available',
      );
      return;
    }

    let transitioned;
    try {
      transitioned = readTransitionItem(payload, input);
    } catch (cause) {
      if (!isCurrent(requestId, input.id, action, expectedContext)) return;
      setFailure(cause instanceof Error ? cause.message : 'The endpoint returned an incompatible transition.', 'needs attention');
      return;
    }

    idempotency.reset();
    restoreOtherActions(body, refreshButton, locks);
    currentStatus = transitioned.status;
    formState = { ...freshState(transitionForStatus(currentStatus)), phase: 'transitioned' };
    detailState.textContent = action === 'block' ? 'item blocked' : 'item unblocked';
    announcer.textContent = action === 'block' ? 'Item blocked and claim released.' : 'Item unblocked and returned to ready.';
    render();
    refreshButton.click();
  }

  function isCurrent(requestId, expectedItemId, expectedAction, expectedContext) {
    return gate.isCurrent(requestId)
      && dialog.open
      && itemId === expectedItemId
      && formState.mode === expectedAction
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
      formState = freshState(transitionForStatus(currentStatus));
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

function ensureBlockReasonPresentation(body, status) {
  if (status !== 'blocked') return;
  const currentState = [...body.querySelectorAll('.detail-section')]
    .find((section) => section.querySelector('h3')?.textContent === 'Current state');
  if (!currentState) return;
  const alreadyShown = [...currentState.querySelectorAll('.detail-copy h4')]
    .some((heading) => heading.textContent === 'Block reason');
  if (alreadyShown) return;
  const reason = latestRenderedBlockReason(body);
  if (!reason) return;
  const block = element('div', 'detail-copy');
  const heading = element('h4');
  heading.textContent = 'Block reason';
  const copy = element('p');
  copy.textContent = reason;
  block.append(heading, copy);
  currentState.append(block);
}

function latestRenderedBlockReason(body) {
  for (const row of body.querySelectorAll('.detail-event')) {
    const type = row.querySelector('.detail-event-head strong')?.textContent?.trim();
    if (type !== 'work.blocked' && type !== 'item.blocked') continue;
    for (const term of row.querySelectorAll('.detail-payload dt')) {
      if (term.textContent?.trim() !== 'reason') continue;
      return term.nextElementSibling?.textContent?.trim() || '';
    }
  }
  return '';
}

function isSidecarOnlyMutation(record) {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest('#item-progress-section, #item-block-transition-section')) return true;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.length > 0 && nodes.every((node) => {
    return node instanceof Element && ['item-progress-section', 'item-block-transition-section'].includes(node.id);
  });
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
  if (phase === 'submitting') return 'saving';
  if (phase === 'transitioned') return 'saved';
  return phase;
}

function freshState(mode) {
  return { mode, phase: 'ready', reason: '', nextAction: '', message: '' };
}

function stateForStatusChange(status, previous) {
  const next = freshState(transitionForStatus(status));
  if (!['conflict', 'retry available'].includes(previous.phase)) return next;
  return {
    ...next,
    phase: previous.phase,
    reason: next.mode === 'block' ? previous.reason : '',
    nextAction: previous.nextAction,
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
  for (const button of body.querySelectorAll('form:not(.detail-transition-form) button[type="submit"]')) {
    if (button.disabled) continue;
    button.disabled = true;
    button.dataset.transitionLocked = 'true';
  }
}

function restoreOtherActions(body, refreshButton, locks) {
  if (locks.refresh) {
    refreshButton.disabled = false;
    locks.refresh = false;
  }
  for (const button of body.querySelectorAll('button[data-transition-locked="true"]')) {
    button.disabled = false;
    delete button.dataset.transitionLocked;
  }
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

if (typeof document !== 'undefined') installBlockController();
