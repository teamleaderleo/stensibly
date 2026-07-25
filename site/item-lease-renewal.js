import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import {
  createClaimIdempotencyTracker,
  leaseRenewalAvailability,
  readClaimedItem,
  validateClaimInput,
} from './item-claim.js';
import {
  createRequestGate,
  redactCredentialText,
  safeRequestId,
} from './item-detail.js';

export function createLeaseRenewalController({
  getConnection,
  getContext,
  onChanged = async () => {},
  reportConnectionIssue = () => {},
  setBusy = () => {},
  announce = () => {},
}) {
  const gate = createRequestGate();
  const idempotency = createClaimIdempotencyTracker();
  let inFlight = false;

  function section(item) {
    const section = element('section', 'detail-section detail-renewal-section');
    const heading = element('h3');
    heading.textContent = 'Lease renewal';
    section.append(heading);

    const { principal, actor } = getContext();
    const availability = leaseRenewalAvailability(item, actor);
    const summary = element('p', 'detail-renewal-summary');
    summary.textContent = redactCredentialText(availability.message);
    section.append(summary);

    if (!principal?.capabilities.write) {
      section.append(emptyBlock('A write-capable token is required to renew a lease.'));
      return section;
    }
    if (!availability.available || !actor) return section;

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
      void submitRenewal(event, item, input, submit, actionState, error);
    });
    section.append(form);
    return section;
  }

  async function submitRenewal(event, item, input, submitButton, actionState, error) {
    event.preventDefault();
    if (submitButton.disabled || inFlight) return;
    const { principal, actor } = getContext();
    const { endpoint, token, connected } = getConnection();
    const availability = leaseRenewalAvailability(item, actor);
    if (
      !connected
      || !endpoint
      || !token
      || !principal?.capabilities.write
      || !actor
      || !availability.available
    ) {
      setError(error, availability.message || 'Lease renewal is unavailable.');
      return;
    }

    let renewal;
    try {
      renewal = validateClaimInput(item.id, input.value, actor);
    } catch (cause) {
      setError(error, cause instanceof Error ? cause.message : 'Lease renewal validation failed.');
      return;
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.keyFor(renewal);
    } catch (cause) {
      setError(error, cause instanceof Error ? cause.message : 'Could not generate a renewal idempotency key.');
      return;
    }

    const requestId = gate.begin();
    inFlight = true;
    submitButton.disabled = true;
    actionState.textContent = 'renewing';
    clearError(error);
    setBusy(true, 'renewing lease');

    let response;
    try {
      response = await fetch(`${endpoint}/api/v1/items/${encodeURIComponent(renewal.id)}/renew`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ actor: renewal.actor, leaseSeconds: renewal.leaseSeconds }),
      });
    } catch {
      if (!gate.isCurrent(requestId)) return;
      inFlight = false;
      submitButton.disabled = false;
      actionState.textContent = 'retry available';
      setBusy(false, 'needs attention');
      setError(error, 'The renewal request could not reach the API. Retry the unchanged duration to reuse the same idempotency key.');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!gate.isCurrent(requestId)) return;
    if (!response.ok) {
      inFlight = false;
      submitButton.disabled = false;
      setBusy(false, 'needs attention');
      const failure = describeHttpFailure(response.status, payload);
      const validation = formatValidationIssues(payload);
      const serverRequestId = safeRequestId(response.headers.get('x-request-id'), token);
      const baseMessage = response.status === 404
        ? 'This item no longer exists or is outside the token project boundary.'
        : failure.message;
      const conflictHint = response.status === 409
        ? 'Refresh detail to inspect the current holder and lease expiry.'
        : '';
      const message = [
        baseMessage,
        validation,
        conflictHint,
        serverRequestId ? `Request ID: ${serverRequestId}` : '',
      ].filter(Boolean).join(' ');
      actionState.textContent = response.status === 409 ? 'conflict' : 'retry available';
      setError(error, message);
      if (response.status === 401 || response.status === 403) reportConnectionIssue(message);
      return;
    }

    let renewed;
    try {
      renewed = readClaimedItem(payload, renewal.id, renewal.actor.id);
    } catch (cause) {
      inFlight = false;
      submitButton.disabled = false;
      actionState.textContent = 'retry available';
      setBusy(false, 'needs attention');
      setError(error, cause instanceof Error ? cause.message : 'The endpoint returned an incompatible renewed item.');
      return;
    }

    inFlight = false;
    idempotency.reset();
    actionState.textContent = 'renewed';
    setBusy(false, 'renewed');
    announce(`Renewed lease until ${formatTimestamp(renewed.claimExpiresAt)}.`);
    try {
      await onChanged(renewed.id);
    } catch {
      submitButton.disabled = false;
      setBusy(false, 'needs attention');
      setError(error, 'The renewal succeeded, but the board did not refresh. Use refresh to load the current server state.');
    }
  }

  function reset() {
    gate.invalidate();
    idempotency.reset();
    inFlight = false;
  }

  function syncContext() {
    reset();
  }

  function isInFlight() {
    return inFlight;
  }

  return { section, reset, syncContext, isInFlight };
}

function setError(node, message) {
  node.textContent = redactCredentialText(message);
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
