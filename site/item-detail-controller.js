import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import {
  createClaimIdempotencyTracker,
  describeClaim,
  readClaimedItem,
  validateClaimInput,
} from './item-claim.js';
import {
  createRequestGate,
  payloadEntries,
  readItemDetail,
  redactCredentialText,
  safeArtifactHref,
  safeRequestId,
} from './item-detail.js';

export function createItemDetailController({
  board,
  getConnection,
  getItems,
  getContext = () => ({ principal: null, actor: null }),
  onChanged = async () => {},
  reportConnectionIssue = () => {},
}) {
  const dialog = document.querySelector('#item-detail-dialog');
  const closeButton = document.querySelector('#item-detail-close');
  const refreshButton = document.querySelector('#item-detail-refresh');
  const title = document.querySelector('#item-detail-title');
  const subtitle = document.querySelector('#item-detail-subtitle');
  const state = document.querySelector('#item-detail-state');
  const error = document.querySelector('#item-detail-error');
  const body = document.querySelector('#item-detail-body');
  const announcer = document.querySelector('#item-detail-announcer');
  const gate = createRequestGate();
  const claimGate = createRequestGate();
  const claimIdempotency = createClaimIdempotencyTracker();

  let selectedItemId = '';
  let triggerItemId = '';
  let restoreFocus = true;
  let currentDetail = null;
  let claimInFlight = false;

  board.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest('button.card[data-item-id]');
    if (!(card instanceof HTMLButtonElement) || !board.contains(card)) return;
    const itemId = card.dataset.itemId || '';
    if (!itemId) return;
    open(itemId);
  });

  closeButton.addEventListener('click', () => close());
  refreshButton.addEventListener('click', () => void refresh({ interactive: true }));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    gate.invalidate();
    claimGate.invalidate();
    claimIdempotency.reset();
    claimInFlight = false;
    refreshButton.disabled = false;
    currentDetail = null;
    const itemId = triggerItemId;
    selectedItemId = '';
    triggerItemId = '';
    clearError();
    if (restoreFocus && itemId) {
      const currentCard = [...board.querySelectorAll('button.card[data-item-id]')]
        .find((button) => button.dataset.itemId === itemId);
      (currentCard || document.querySelector('#refresh'))?.focus();
    }
    restoreFocus = true;
  });

  function open(itemId) {
    selectedItemId = itemId;
    currentDetail = null;
    triggerItemId = itemId;
    restoreFocus = true;
    title.textContent = 'Item detail';
    subtitle.textContent = redactCredentialText(itemId);
    state.textContent = 'loading';
    clearError();
    body.replaceChildren(loadingBlock());
    if (!dialog.open) dialog.showModal();
    closeButton.focus();
    void refresh({ interactive: false });
  }

  async function refresh({ interactive = false } = {}) {
    if (!selectedItemId || !dialog.open || claimInFlight) return;
    const { endpoint, token, connected } = getConnection();
    if (!connected || !endpoint || !token) {
      reset({ announce: 'Item detail closed because the ledger disconnected.' });
      return;
    }

    const requestId = gate.begin();
    refreshButton.disabled = true;
    if (interactive) state.textContent = 'refreshing';
    clearError();

    try {
      const detail = await loadDetail(endpoint, token, selectedItemId);
      if (!gate.isCurrent(requestId) || !dialog.open || detail.item.id !== selectedItemId) return;
      currentDetail = detail;
      renderDetail(detail);
      state.textContent = `updated ${formatTime(new Date())}`;
    } catch (cause) {
      if (!gate.isCurrent(requestId) || !dialog.open) return;
      const failure = normalizeFailure(cause);
      state.textContent = failure.kind === 'missing' ? 'closed' : 'needs attention';
      showError(failure.message);
      if (failure.kind === 'missing') {
        currentDetail = null;
        body.replaceChildren(emptyBlock('This item is no longer available on the current ledger.'));
      } else if (!body.firstElementChild || body.firstElementChild.classList.contains('detail-loading')) {
        body.replaceChildren(emptyBlock('The board remains available. Retry item detail when the connection is healthy.'));
      }
    } finally {
      if (gate.isCurrent(requestId)) refreshButton.disabled = false;
    }
  }

  async function loadDetail(endpoint, token, itemId) {
    let response;
    try {
      response = await fetch(`${endpoint}/api/v1/items/${encodeURIComponent(itemId)}`, {
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
    } catch {
      throw new DetailFailure('network', 'The item detail request could not reach the API.');
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const requestId = safeRequestId(response.headers.get('x-request-id'), token);
      if (response.status === 404) {
        throw new DetailFailure('missing', withRequestId('This item no longer exists or is outside the token project boundary.', requestId));
      }
      const failure = describeHttpFailure(response.status, payload);
      throw new DetailFailure(
        failure.kind,
        withRequestId(redactCredentialText(failure.message, token), requestId),
      );
    }

    try {
      return readItemDetail(payload, itemId);
    } catch (cause) {
      throw new DetailFailure(
        'incompatible_response',
        cause instanceof Error ? cause.message : 'The endpoint returned incompatible item detail.',
      );
    }
  }

  function reconcile() {
    if (!selectedItemId || !dialog.open) return;
    if (!getItems().some((item) => item.id === selectedItemId)) {
      reset({ announce: 'Item detail closed because the item left the current board.' });
      return;
    }
    void refresh({ interactive: false });
  }

  function reset({ announce = '' } = {}) {
    gate.invalidate();
    claimGate.invalidate();
    claimIdempotency.reset();
    claimInFlight = false;
    refreshButton.disabled = false;
    currentDetail = null;
    restoreFocus = false;
    if (dialog.open) dialog.close();
    selectedItemId = '';
    triggerItemId = '';
    if (announce) announcer.textContent = announce;
  }

  function close() {
    gate.invalidate();
    claimGate.invalidate();
    claimIdempotency.reset();
    claimInFlight = false;
    refreshButton.disabled = false;
    if (dialog.open) dialog.close();
  }

  function renderDetail(detail) {
    const item = detail.item;
    title.textContent = text(item.title, 'Untitled item');
    subtitle.textContent = [text(item.kind), text(item.project), text(item.status)].filter(Boolean).join(' · ');

    const fragment = document.createDocumentFragment();
    fragment.append(
      itemOverview(item, detail.events),
      claimSection(item),
      eventSection(detail.events),
      artifactSection(detail.artifacts),
    );
    body.replaceChildren(fragment);
  }

  function itemOverview(item, events) {
    const section = sectionBlock('Current state');
    const grid = element('dl', 'detail-grid');
    const blockedReason = item.status === 'blocked' ? latestBlockedReason(events) : '';
    const fields = [
      ['Project', item.project],
      ['Kind', item.kind],
      ['Status', item.status],
      ['Priority', item.priority],
      ['Version', item.version],
      ['Claimed by', item.claimedBy],
      ['Lease expires', formatTimestamp(item.claimExpiresAt)],
      ['Created', formatTimestamp(item.createdAt)],
      ['Updated', formatTimestamp(item.updatedAt)],
    ];
    for (const [label, value] of fields) appendTerm(grid, label, display(value));
    section.append(grid);
    if (item.summary) section.append(copyBlock('Summary', item.summary));
    if (item.nextAction) section.append(copyBlock('Next action', item.nextAction));
    if (blockedReason) section.append(copyBlock('Block reason', blockedReason));
    return section;
  }

  function claimSection(item) {
    const section = sectionBlock('Claim');
    const { principal, actor } = getContext();
    const summary = element('p', 'detail-claim-summary');
    summary.textContent = redactCredentialText(describeClaim(item, actor));
    section.append(summary);

    if (!principal?.capabilities.write || !actor) {
      section.append(emptyBlock('A write-capable token and active session actor are required to claim work.'));
      return section;
    }

    if (!['ready', 'active'].includes(item.status)) {
      section.append(emptyBlock(`Claim is unavailable while this item is ${text(item.status, 'in its current state')}.`));
      return section;
    }

    const form = element('form', 'detail-claim-form');
    const label = element('label');
    label.textContent = 'Lease seconds';
    const input = element('input');
    input.name = 'leaseSeconds';
    input.type = 'number';
    input.min = '30';
    input.max = '86400';
    input.step = '1';
    input.value = '1800';
    label.append(input);

    const actions = element('div', 'detail-claim-actions');
    const submit = element('button');
    submit.type = 'submit';
    submit.textContent = item.claimedBy === actor.id ? 'extend lease' : 'claim item';
    const actionState = element('span');
    actionState.textContent = 'ready';
    actions.append(submit, actionState);

    const actionError = element('p', 'detail-claim-error');
    actionError.hidden = true;
    actionError.setAttribute('role', 'alert');
    form.append(label, actions, actionError);
    form.addEventListener('submit', (event) => void submitClaim(event, item, input, submit, actionState, actionError));
    section.append(form);
    return section;
  }

  async function submitClaim(event, item, input, submitButton, actionState, actionError) {
    event.preventDefault();
    if (submitButton.disabled || claimInFlight) return;
    const { principal, actor } = getContext();
    const { endpoint, token, connected } = getConnection();
    if (!connected || !endpoint || !token || !principal?.capabilities.write || !actor) {
      syncContext();
      return;
    }

    let claim;
    try {
      claim = validateClaimInput(item.id, input.value, actor);
    } catch (cause) {
      setClaimError(actionError, cause instanceof Error ? cause.message : 'Claim validation failed.');
      return;
    }

    let idempotencyKey;
    try {
      idempotencyKey = claimIdempotency.keyFor(claim);
    } catch (cause) {
      setClaimError(actionError, cause instanceof Error ? cause.message : 'Could not generate a claim idempotency key.');
      return;
    }

    gate.invalidate();
    const requestId = claimGate.begin();
    claimInFlight = true;
    refreshButton.disabled = true;
    submitButton.disabled = true;
    state.textContent = 'claiming';
    clearError();
    clearClaimError(actionError);

    let response;
    try {
      response = await fetch(`${endpoint}/api/v1/items/${encodeURIComponent(claim.id)}/claim`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ actor: claim.actor, leaseSeconds: claim.leaseSeconds }),
      });
    } catch {
      if (!claimGate.isCurrent(requestId)) return;
      claimInFlight = false;
      refreshButton.disabled = false;
      submitButton.disabled = false;
      actionState.textContent = 'retry available';
      setClaimError(actionError, 'The claim request could not reach the API. Retry the unchanged lease to reuse the same idempotency key.');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!claimGate.isCurrent(requestId)) return;
    if (!response.ok) {
      claimInFlight = false;
      refreshButton.disabled = false;
      submitButton.disabled = false;
      const failure = describeHttpFailure(response.status, payload);
      const validation = formatValidationIssues(payload);
      const serverRequestId = safeRequestId(response.headers.get('x-request-id'), token);
      const baseMessage = response.status === 404
        ? 'This item no longer exists or is outside the token project boundary.'
        : failure.message;
      const conflictHint = response.status === 409
        ? 'Refresh detail to inspect the current holder and lease.'
        : '';
      const message = [baseMessage, validation, conflictHint, serverRequestId ? `Request ID: ${serverRequestId}` : '']
        .filter(Boolean)
        .join(' ');
      actionState.textContent = response.status === 409 ? 'conflict' : 'retry available';
      setClaimError(actionError, message);
      if (response.status === 401 || response.status === 403) reportConnectionIssue(message);
      return;
    }

    let claimed;
    try {
      claimed = readClaimedItem(payload, claim.id, claim.actor.id);
    } catch (cause) {
      claimInFlight = false;
      refreshButton.disabled = false;
      submitButton.disabled = false;
      actionState.textContent = 'retry available';
      setClaimError(actionError, cause instanceof Error ? cause.message : 'The endpoint returned an incompatible claimed item.');
      return;
    }

    claimInFlight = false;
    refreshButton.disabled = false;
    claimIdempotency.reset();
    actionState.textContent = 'claimed';
    announcer.textContent = `Claimed item until ${formatTimestamp(claimed.claimExpiresAt)}.`;
    try {
      await onChanged(claimed.id);
    } catch {
      setClaimError(actionError, 'The claim succeeded, but the board did not refresh. Use refresh to load the current server state.');
    }
  }

  function syncContext() {
    claimGate.invalidate();
    claimIdempotency.reset();
    claimInFlight = false;
    refreshButton.disabled = false;
    if (dialog.open && currentDetail) renderDetail(currentDetail);
  }

  function setClaimError(node, message) {
    node.textContent = redactCredentialText(message);
    node.hidden = false;
  }

  function clearClaimError(node) {
    node.textContent = '';
    node.hidden = true;
  }

  function eventSection(events) {
    const section = sectionBlock(`Event history · ${events.length}`);
    if (!events.length) {
      section.append(emptyBlock('No events have been recorded for this item.'));
      return section;
    }
    const list = element('ol', 'detail-events');
    for (const event of [...events].reverse()) {
      const row = element('li', 'detail-event');
      const head = element('div', 'detail-event-head');
      const eventName = element('strong');
      eventName.textContent = text(event.type, 'event');
      const when = element('time');
      when.textContent = formatTimestamp(event.createdAt) || 'unknown time';
      if (typeof event.createdAt === 'string') when.dateTime = event.createdAt;
      head.append(eventName, when);
      row.append(head);
      const actor = element('p', 'detail-event-actor');
      actor.textContent = event.actorId ? `actor · ${text(event.actorId)}` : 'system event';
      row.append(actor);
      const entries = payloadEntries(event.payload);
      if (entries.length) {
        const payload = element('dl', 'detail-payload');
        for (const entry of entries) appendTerm(payload, entry.key, entry.value);
        row.append(payload);
      }
      list.append(row);
    }
    section.append(list);
    return section;
  }

  function artifactSection(artifacts) {
    const section = sectionBlock(`Artifacts · ${artifacts.length}`);
    if (!artifacts.length) {
      section.append(emptyBlock('No artifact references are attached.'));
      return section;
    }
    const list = element('ul', 'detail-artifacts');
    for (const artifact of artifacts) {
      const row = element('li', 'detail-artifact');
      const label = element('strong');
      label.textContent = text(artifact.label, text(artifact.kind, 'artifact'));
      row.append(label);
      const uri = text(artifact.uri);
      if (uri) {
        const href = safeArtifactHref(uri);
        if (href) {
          const link = element('a', 'detail-artifact-link');
          link.href = href;
          link.target = '_blank';
          link.rel = 'noreferrer noopener';
          link.textContent = uri;
          row.append(link);
        } else {
          const value = element('code');
          value.textContent = uri;
          row.append(value);
        }
      }
      const meta = [text(artifact.kind), text(artifact.mimeType), formatTimestamp(artifact.createdAt)].filter(Boolean);
      if (meta.length) {
        const line = element('span', 'detail-artifact-meta');
        line.textContent = meta.join(' · ');
        row.append(line);
      }
      const metadata = payloadEntries(artifact.metadata, 300, 10);
      if (metadata.length) {
        const values = element('dl', 'detail-payload');
        for (const entry of metadata) appendTerm(values, entry.key, entry.value);
        row.append(values);
      }
      list.append(row);
    }
    section.append(list);
    return section;
  }

  function showError(message) {
    error.textContent = redactCredentialText(message);
    error.hidden = false;
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }

  return { reconcile, reset, close, syncContext };
}

function sectionBlock(heading) {
  const section = element('section', 'detail-section');
  const title = element('h3');
  title.textContent = heading;
  section.append(title);
  return section;
}

function copyBlock(label, value) {
  const block = element('div', 'detail-copy');
  const heading = element('h4');
  heading.textContent = label;
  const copy = element('p');
  copy.textContent = text(value);
  block.append(heading, copy);
  return block;
}

function appendTerm(list, label, value) {
  const term = element('dt');
  term.textContent = text(label);
  const description = element('dd');
  description.textContent = text(value, '—');
  list.append(term, description);
}

function loadingBlock() {
  return emptyBlock('Loading the server-owned item state…', 'detail-loading');
}

function emptyBlock(message, extraClass = '') {
  const block = element('p', `detail-empty ${extraClass}`.trim());
  block.textContent = message;
  return block;
}

function latestBlockedReason(events) {
  for (const event of [...events].reverse()) {
    if (event.type !== 'item.blocked' || !event.payload || typeof event.payload !== 'object') continue;
    const reason = event.payload.reason;
    if (typeof reason === 'string' && reason.trim()) return reason.trim();
  }
  return '';
}

function normalizeFailure(cause) {
  if (cause instanceof DetailFailure) return cause;
  return new DetailFailure('unknown', cause instanceof Error ? cause.message : 'Item detail failed.');
}

function withRequestId(message, requestId) {
  return requestId ? `${message} Request ID: ${requestId}` : message;
}

function formatTimestamp(value) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? redactCredentialText(value) : date.toLocaleString();
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function display(value) {
  return value === null || value === undefined || value === '' ? '' : redactCredentialText(String(value));
}

function text(value, fallback = '') {
  const output = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return redactCredentialText(output);
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

class DetailFailure extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'DetailFailure';
    this.kind = kind;
  }
}
