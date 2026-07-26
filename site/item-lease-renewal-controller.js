import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';
import {
  createLeaseRenewalIdempotencyTracker,
  leaseRenewalAvailability,
  readRenewalAuthority,
  readRenewedItem,
  validateLeaseRenewalInput,
} from './item-lease-renewal.js';
import { readStoredActor } from './session-context.js';

const ACTOR_STORAGE_KEY = 'stensiblyActor';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';

export function installLeaseRenewalController() {
  const board = document.querySelector('#board');
  const dialog = document.querySelector('#item-detail-dialog');
  const body = document.querySelector('#item-detail-body');
  const refreshButton = document.querySelector('#item-detail-refresh');
  const detailState = document.querySelector('#item-detail-state');
  const announcer = document.querySelector('#item-detail-announcer');
  const contextPanel = document.querySelector('#session-context-panel');
  if (!board || !dialog || !body || !refreshButton || !contextPanel) return null;

  const detailGate = createRequestGate();
  const renewalGate = createRequestGate();
  const idempotency = createLeaseRenewalIdempotencyTracker();
  let itemId = '';
  let authorityResult = null;
  let loading = false;
  let renewalInFlight = false;
  let loadQueued = false;
  let contextFingerprint = readContext().fingerprint;

  board.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest('button.card[data-item-id]');
    if (!(card instanceof HTMLButtonElement) || !board.contains(card)) return;
    const selected = card.dataset.itemId || '';
    if (!selected) return;
    itemId = selected;
    resetAll();
    scheduleLoad();
  });

  dialog.addEventListener('close', () => {
    itemId = '';
    resetAll();
  });

  refreshButton.addEventListener('click', () => {
    if (!itemId || renewalInFlight) return;
    resetAuthority();
    scheduleLoad();
  });

  const bodyObserver = new MutationObserver(() => {
    if (!dialog.open || !itemId || renewalInFlight) return;
    if (!findSection(body, 'Claim')) return;
    const renewalSection = body.querySelector('[data-lease-renewal-section="true"]');
    if (!renewalSection && !loading) {
      resetAuthority();
      scheduleLoad();
    }
  });
  bodyObserver.observe(body, { childList: true, subtree: true });

  const contextObserver = new MutationObserver(() => {
    const next = readContext().fingerprint;
    if (next === contextFingerprint) return;
    contextFingerprint = next;
    resetAll();
    if (dialog.open && itemId) {
      render();
      scheduleLoad();
    }
  });
  contextObserver.observe(contextPanel, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });

  function scheduleLoad() {
    if (loadQueued || loading || renewalInFlight || !itemId || !dialog.open) return;
    loadQueued = true;
    queueMicrotask(() => {
      loadQueued = false;
      void loadAuthority();
    });
  }

  async function loadAuthority() {
    const context = readContext();
    if (!context.connected || !itemId || !dialog.open || renewalInFlight) {
      authorityResult = { status: 'absent', authority: null };
      render();
      return;
    }

    const requestedItemId = itemId;
    const requestId = detailGate.begin();
    loading = true;
    try {
      const response = await fetch(`${context.endpoint}/api/v1/items/${encodeURIComponent(requestedItemId)}`, {
        headers: { authorization: `Bearer ${context.token}` },
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null);
      if (!detailRequestCurrent(requestId, requestedItemId, context.fingerprint)) return;
      if (!response.ok) {
        authorityResult = { status: 'absent', authority: null };
        render(`Authority refresh failed. ${safeFailureMessage(response, payload, context.token)}`);
        return;
      }
      authorityResult = readRenewalAuthority(payload, requestedItemId);
      render();
    } catch (cause) {
      if (!detailRequestCurrent(requestId, requestedItemId, context.fingerprint)) return;
      authorityResult = { status: 'absent', authority: null };
      const message = cause instanceof Error && cause.name === 'TypeError'
        ? cause.message
        : 'The authority request could not reach the API.';
      render(message);
    } finally {
      if (detailGate.isCurrent(requestId)) loading = false;
    }
  }

  function detailRequestCurrent(requestId, requestedItemId, requestedContextFingerprint) {
    return (
      detailGate.isCurrent(requestId)
      && requestedItemId === itemId
      && requestedContextFingerprint === readContext().fingerprint
      && dialog.open
    );
  }

  function render(loadMessage = '') {
    if (!dialog.open || !itemId) return;
    const claimSection = findSection(body, 'Claim');
    if (!claimSection) return;

    bodyObserver.disconnect();
    try {
      body.querySelector('[data-lease-renewal-section="true"]')?.remove();
      claimSection.querySelector('[data-claim-acquisition-note="true"]')?.remove();
      reconcileAcquisition(claimSection, authorityResult);
      claimSection.after(renewalSection(authorityResult, loadMessage));
    } finally {
      bodyObserver.observe(body, { childList: true, subtree: true });
    }
  }

  function reconcileAcquisition(section, result) {
    const form = section.querySelector('.detail-claim-form');
    if (!(form instanceof HTMLFormElement)) return;
    const submit = form.querySelector('button[type="submit"]');
    const serverAuthority = result?.status === 'available' ? result.authority : null;
    const serverHasLiveAuthority = serverAuthority
      && ['live', 'expiring', 'superseded'].includes(serverAuthority.state);
    const legacyExtendControl = submit instanceof HTMLButtonElement
      && /extend lease/i.test(submit.textContent || '');

    if (serverHasLiveAuthority || (!serverAuthority && legacyExtendControl)) {
      form.hidden = true;
      const note = element('p', 'detail-empty detail-claim-renewal-note');
      note.dataset.claimAcquisitionNote = 'true';
      note.textContent = serverHasLiveAuthority
        ? 'A server-owned claim already exists. Use the separate Lease renewal section when the current authority permits it.'
        : 'Lease extension awaits the server-owned authority view. Refresh after the claim-generation contract is available.';
      section.append(note);
      return;
    }

    form.hidden = false;
    if (submit instanceof HTMLButtonElement) submit.textContent = 'claim item';
  }

  function renewalSection(result, loadMessage) {
    const section = element('section', 'detail-section detail-renewal-section');
    section.dataset.leaseRenewalSection = 'true';
    const heading = element('h3');
    heading.textContent = 'Lease renewal';
    section.append(heading);

    const context = readContext();
    const availability = leaseRenewalAvailability(result, context.actor);
    const summary = element('p', 'detail-renewal-summary');
    summary.textContent = redactCredentialText(loadMessage || availability.message, context.token);
    section.append(summary);

    if (!context.canWrite) {
      section.append(emptyBlock('A write-capable token is required to renew a lease.'));
      return section;
    }
    if (!availability.available || !context.actor || result?.status !== 'available' || !result.authority) {
      return section;
    }

    const form = element('form', 'detail-renewal-form');
    const label = element('label');
    label.textContent = 'New lease seconds';
    const input = element('input');
    input.name = 'leaseSeconds';
    input.type = 'number';
    input.min = '30';
    input.max = '86400';
    input.step = '1';
    input.value = '1800';
    label.append(input);

    const actions = element('div', 'detail-renewal-actions');
    const submit = element('button');
    submit.type = 'submit';
    submit.textContent = 'renew lease';
    const actionState = element('span');
    actionState.textContent = 'ready';
    actions.append(submit, actionState);

    const error = element('p', 'detail-renewal-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    form.append(label, actions, error);
    form.addEventListener('submit', (event) => {
      void submitRenewal(event, result.authority, input, submit, actionState, error);
    });
    section.append(form);
    return section;
  }

  async function submitRenewal(event, authority, input, submitButton, actionState, error) {
    event.preventDefault();
    if (submitButton.disabled || renewalInFlight) return;
    const context = readContext();
    const currentAvailability = leaseRenewalAvailability({ status: 'available', authority }, context.actor);
    if (!context.connected || !context.canWrite || !context.actor || !currentAvailability.available) {
      setError(error, currentAvailability.message, context.token);
      return;
    }

    let renewal;
    try {
      renewal = validateLeaseRenewalInput(itemId, input.value, context.actor, authority.generation);
    } catch (cause) {
      setError(error, cause instanceof Error ? cause.message : 'Lease renewal validation failed.', context.token);
      return;
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.keyFor(renewal);
    } catch (cause) {
      setError(error, cause instanceof Error ? cause.message : 'Could not generate a renewal idempotency key.', context.token);
      return;
    }

    detailGate.invalidate();
    const requestId = renewalGate.begin();
    renewalInFlight = true;
    submitButton.disabled = true;
    refreshButton.disabled = true;
    actionState.textContent = 'renewing';
    clearError(error);
    if (detailState) detailState.textContent = 'renewing lease';

    let response;
    try {
      response = await fetch(`${context.endpoint}/api/v1/items/${encodeURIComponent(renewal.id)}/renew`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          actor: renewal.actor,
          leaseSeconds: renewal.leaseSeconds,
          expectedClaimGeneration: renewal.expectedClaimGeneration,
        }),
      });
    } catch {
      if (!renewalRequestCurrent(requestId, renewal.id, context.fingerprint)) return;
      unlockRenewal(submitButton);
      actionState.textContent = 'retry available';
      setError(
        error,
        'The renewal request could not reach the API. Retry the unchanged duration and generation to reuse the same idempotency key.',
        context.token,
      );
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!renewalRequestCurrent(requestId, renewal.id, context.fingerprint)) return;
    if (!response.ok) {
      unlockRenewal(submitButton);
      const failure = describeHttpFailure(response.status, payload);
      const validation = formatValidationIssues(payload);
      const serverRequestId = safeRequestId(response.headers.get('x-request-id'), context.token);
      const conflictHint = response.status === 409
        ? 'The claim generation changed. Refresh detail before attempting another renewal.'
        : '';
      const message = [
        response.status === 404
          ? 'This item no longer exists or is outside the token project boundary.'
          : failure.message,
        validation,
        conflictHint,
        serverRequestId ? `Request ID: ${serverRequestId}` : '',
      ].filter(Boolean).join(' ');
      actionState.textContent = response.status === 409 ? 'conflict' : 'retry available';
      setError(error, message, context.token);
      return;
    }

    let renewed;
    try {
      renewed = readRenewedItem(
        payload,
        renewal.id,
        renewal.actor.id,
        renewal.expectedClaimGeneration,
      );
    } catch (cause) {
      unlockRenewal(submitButton);
      actionState.textContent = 'retry available';
      setError(
        error,
        cause instanceof Error ? cause.message : 'The endpoint returned an incompatible renewed item.',
        context.token,
      );
      return;
    }

    renewalInFlight = false;
    refreshButton.disabled = false;
    idempotency.reset();
    actionState.textContent = 'renewed';
    if (detailState) detailState.textContent = 'renewed';
    if (announcer) announcer.textContent = `Renewed lease until ${formatTimestamp(renewed.claimExpiresAt)}.`;
    document.querySelector('#refresh')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    resetAuthority();
    refreshButton.click();
  }

  function renewalRequestCurrent(requestId, requestedItemId, requestedContextFingerprint) {
    return (
      renewalGate.isCurrent(requestId)
      && requestedItemId === itemId
      && requestedContextFingerprint === readContext().fingerprint
      && dialog.open
    );
  }

  function unlockRenewal(submitButton) {
    renewalInFlight = false;
    refreshButton.disabled = false;
    submitButton.disabled = false;
    if (detailState) detailState.textContent = 'needs attention';
  }

  function resetAuthority() {
    detailGate.invalidate();
    authorityResult = null;
    loading = false;
    idempotency.reset();
  }

  function resetAll() {
    resetAuthority();
    renewalGate.invalidate();
    renewalInFlight = false;
    refreshButton.disabled = false;
  }

  return {
    reset: resetAll,
    isInFlight: () => renewalInFlight,
    destroy() {
      resetAll();
      bodyObserver.disconnect();
      contextObserver.disconnect();
    },
  };
}

function safeFailureMessage(response, payload, token) {
  const failure = describeHttpFailure(response.status, payload);
  const validation = formatValidationIssues(payload);
  const requestId = safeRequestId(response.headers.get('x-request-id'), token);
  return [failure.message, validation, requestId ? `Request ID: ${requestId}` : '']
    .filter(Boolean)
    .map((part) => redactCredentialText(part, token))
    .join(' ');
}

function readContext() {
  const panel = document.querySelector('#session-context-panel');
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
  const canWrite = panel?.dataset.mode === 'write';
  const actorFingerprint = actor ? `${actor.id}\u0000${actor.name}\u0000${actor.kind}` : '';
  return {
    actor,
    token,
    endpoint,
    canWrite,
    connected: Boolean(endpoint && token),
    fingerprint: `${canWrite ? 'write' : 'read'}\u0000${endpoint}\u0000${token}\u0000${actorFingerprint}`,
  };
}

function findSection(root, heading) {
  return [...root.querySelectorAll('.detail-section')].find((section) => {
    return section.querySelector('h3')?.textContent?.trim() === heading;
  }) || null;
}

function setError(node, message, token = '') {
  node.textContent = redactCredentialText(message, token);
  node.hidden = false;
}

function clearError(node) {
  node.textContent = '';
  node.hidden = true;
}

function emptyBlock(message) {
  const block = element('p', 'detail-empty');
  block.textContent = message;
  return block;
}

function formatTimestamp(value) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? redactCredentialText(value) : date.toLocaleString();
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

if (typeof document !== 'undefined') installLeaseRenewalController();
