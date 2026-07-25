import { actionEmptyState, classifyLease, describeLease } from './item-lease-state.js';
import { redactCredentialText } from './item-detail.js';
import { createLeaseRenewalController } from './item-lease-renewal.js';
import { readStoredActor } from './session-context.js';

const ACTOR_STORAGE_KEY = 'stensiblyActor';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';

const ACTIONS = [
  {
    name: 'claim',
    heading: 'Claim',
    form: '.detail-claim-form',
    error: '.detail-claim-error',
    state: '.detail-claim-actions span',
  },
  {
    name: 'renewal',
    heading: 'Lease renewal',
    form: '.detail-renewal-form',
    error: '.detail-renewal-error',
    state: '.detail-renewal-actions span',
  },
  {
    name: 'progress',
    heading: 'Record progress',
    form: '.detail-progress-form',
    error: '.detail-progress-error',
    state: '.detail-progress-actions span',
  },
  {
    name: 'transition',
    heading: 'Block or unblock',
    form: '.detail-transition-form',
    error: '.detail-transition-error',
    state: '.detail-transition-actions span',
  },
  {
    name: 'complete',
    heading: 'Complete work',
    form: '.detail-complete-form',
    error: '.detail-complete-error',
    state: '.detail-complete-actions span',
  },
];

export function installLeaseStateController() {
  const board = document.querySelector('#board');
  const dialog = document.querySelector('#item-detail-dialog');
  const body = document.querySelector('#item-detail-body');
  const refreshButton = document.querySelector('#item-detail-refresh');
  const detailState = document.querySelector('#item-detail-state');
  const announcer = document.querySelector('#item-detail-announcer');
  const contextPanel = document.querySelector('#session-context-panel');
  const connectionTitle = document.querySelector('#connection-title');
  const connectionState = document.querySelector('#connection-state');
  const connectionError = document.querySelector('#connection-error');
  const connectedSummary = document.querySelector('#connected-summary');
  const connectedEndpoint = document.querySelector('#connected-endpoint');
  const connectForm = document.querySelector('#connect-form');
  const cancelConnection = document.querySelector('#cancel-connection');
  const dashboard = document.querySelector('#dashboard');
  const disconnected = document.querySelector('#disconnected-state');
  if (!board || !dialog || !body || !refreshButton || !contextPanel) return null;

  ensureStyles('stensibly-item-lease-state-styles', '/item-lease-state.css');

  let itemId = '';
  let contextFingerprint = readContext().fingerprint;
  let renderQueued = false;
  let conflict = null;

  const renewal = createLeaseRenewalController({
    getConnection: () => {
      const context = readContext();
      return {
        endpoint: context.endpoint,
        token: context.token,
        connected: Boolean(context.endpoint && context.token),
      };
    },
    getContext: () => {
      const context = readContext();
      return {
        principal: { capabilities: { write: context.canWrite } },
        actor: context.actor,
      };
    },
    onChanged: async () => {
      refreshButton.click();
    },
    reportConnectionIssue: (message) => {
      if (
        !connectionTitle
        || !connectionState
        || !connectionError
        || !connectedSummary
        || !connectedEndpoint
        || !connectForm
        || !cancelConnection
        || !dashboard
        || !disconnected
      ) return;
      const context = readContext();
      connectionTitle.textContent = 'Connection needs attention';
      connectForm.hidden = true;
      connectedSummary.hidden = false;
      cancelConnection.hidden = true;
      connectedEndpoint.textContent = context.endpoint;
      connectionError.textContent = redactCredentialText(message);
      connectionError.hidden = false;
      connectionState.textContent = 'retrying';
      connectionState.classList.add('error');
      dashboard.hidden = false;
      disconnected.hidden = true;
    },
    setBusy: (busy, label = '') => {
      if (label && detailState) detailState.textContent = label;
      refreshButton.dataset.renewalBusy = busy ? 'true' : 'false';
      const otherActionBusy = Boolean(
        body.querySelector('form:not(.detail-renewal-form) button[type="submit"]:disabled'),
      );
      refreshButton.disabled = busy || otherActionBusy;
    },
    announce: (message) => {
      if (announcer) announcer.textContent = message;
    },
  });

  board.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest('button.card[data-item-id]');
    if (!(card instanceof HTMLButtonElement) || !board.contains(card)) return;
    const nextItemId = card.dataset.itemId || '';
    if (!nextItemId) return;
    itemId = nextItemId;
    conflict = null;
    renewal.reset();
    scheduleRender();
  });

  dialog.addEventListener('close', () => {
    itemId = '';
    conflict = null;
    renewal.reset();
  });

  const bodyObserver = new MutationObserver(() => scheduleRender());
  bodyObserver.observe(body, { childList: true, subtree: true, attributes: true });

  const contextObserver = new MutationObserver(() => {
    const next = readContext().fingerprint;
    if (next === contextFingerprint) return;
    contextFingerprint = next;
    conflict = null;
    renewal.syncContext();
    scheduleRender();
  });
  contextObserver.observe(contextPanel, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });

  const clock = setInterval(() => {
    if (dialog.open && itemId) scheduleRender();
  }, 60_000);

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
    const item = { id: itemId, ...readRenderedItem(body) };
    if (!item.status) return;
    const context = readContext();
    const captured = captureConflict(body, itemId, item.status);
    let refreshConflict = false;
    if (captured) {
      if (!conflict || conflict.signature !== captured.signature) conflict = captured;
      if (!conflict.refreshed) {
        conflict.refreshed = true;
        refreshConflict = true;
      }
    }
    if (conflict && conflict.status !== item.status) conflict = null;

    bodyObserver.disconnect();
    try {
      renderLeaseState(body, item, context.actor);
      renderClaimAcquisitionState(body, item, context.actor);
      renderLeaseRenewal(body, item, context);
      polishEmptyStates(body, item.status, context);
      restoreConflict(body, itemId, item.status);
      bindConflictClearing(body);
    } finally {
      bodyObserver.observe(body, { childList: true, subtree: true, attributes: true });
    }

    if (refreshConflict) queueMicrotask(() => refreshButton.click());
  }

  function renderLeaseRenewal(root, item, context) {
    const fingerprint = [
      item.id,
      item.status,
      item.claimedBy || '',
      item.claimExpiresAt || '',
      context.renderFingerprint,
      String(Math.floor(Date.now() / 60_000)),
    ].join('\u0000');
    const existing = findSection(root, 'Lease renewal');
    if (existing?.dataset.renewalFingerprint === fingerprint) return;

    existing?.remove();
    const claimSection = findSection(root, 'Claim');
    if (!claimSection) return;
    const section = renewal.section(item);
    section.dataset.renewalFingerprint = fingerprint;
    claimSection.after(section);
  }

  function restoreConflict(root, expectedItemId, status) {
    if (!conflict || conflict.itemId !== expectedItemId || conflict.status !== status) return;
    const action = ACTIONS.find((entry) => entry.name === conflict.action);
    if (!action) return;
    const form = root.querySelector(action.form);
    if (!(form instanceof HTMLFormElement)) return;
    for (const field of form.querySelectorAll('input[name], textarea[name], select[name]')) {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) continue;
      if (!Object.prototype.hasOwnProperty.call(conflict.values, field.name)) continue;
      field.value = conflict.values[field.name];
    }
    const error = form.querySelector(action.error);
    if (error instanceof HTMLElement) {
      error.textContent = conflict.message;
      error.hidden = false;
    }
    const state = form.querySelector(action.state);
    if (state instanceof HTMLElement) state.textContent = 'conflict';
  }

  function bindConflictClearing(root) {
    for (const action of ACTIONS) {
      const form = root.querySelector(action.form);
      if (!(form instanceof HTMLFormElement) || form.dataset.leaseConflictBound === 'true') continue;
      form.dataset.leaseConflictBound = 'true';
      form.addEventListener('input', () => {
        if (conflict?.action === action.name) conflict = null;
      });
    }
  }

  return {
    reset() {
      conflict = null;
      renewal.reset();
      scheduleRender();
    },
    destroy() {
      clearInterval(clock);
      renewal.reset();
      bodyObserver.disconnect();
      contextObserver.disconnect();
    },
  };
}

function captureConflict(body, itemId, status) {
  for (const action of ACTIONS) {
    const form = body.querySelector(action.form);
    if (!(form instanceof HTMLFormElement)) continue;
    const state = form.querySelector(action.state)?.textContent?.trim();
    const error = form.querySelector(action.error);
    const message = error instanceof HTMLElement && !error.hidden ? error.textContent?.trim() || '' : '';
    if (state !== 'conflict' || !message) continue;
    const values = {};
    for (const field of form.querySelectorAll('input[name], textarea[name], select[name]')) {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) continue;
      values[field.name] = field.value;
    }
    return {
      signature: `${itemId}\u0000${action.name}\u0000${message}`,
      itemId,
      status,
      action: action.name,
      message: redactCredentialText(message),
      values,
      refreshed: false,
    };
  }
  return null;
}

function renderLeaseState(body, item, actor) {
  const section = findSection(body, 'Claim');
  if (!section) return;
  section.querySelector('#item-lease-state')?.remove();
  const classification = classifyLease(item);
  const state = document.createElement('p');
  state.id = 'item-lease-state';
  state.className = 'detail-lease-state';
  state.dataset.leaseState = classification.state;
  state.textContent = redactCredentialText(describeLease(item, actor));
  const summary = section.querySelector('.detail-claim-summary');
  if (summary) summary.after(state);
  else section.append(state);
}

function renderClaimAcquisitionState(body, item, actor) {
  const section = findSection(body, 'Claim');
  const form = section?.querySelector('.detail-claim-form');
  if (!(section instanceof HTMLElement) || !(form instanceof HTMLFormElement)) return;
  section.querySelector('.detail-claim-renewal-note')?.remove();
  const submit = form.querySelector('button[type="submit"]');
  if (submit instanceof HTMLButtonElement) submit.textContent = 'claim item';

  const lease = classifyLease(item);
  const liveClaim = item.status === 'active' && item.claimedBy && lease.state !== 'expired';
  form.hidden = Boolean(liveClaim);
  if (!liveClaim) return;

  const note = document.createElement('p');
  note.className = 'detail-empty detail-claim-renewal-note';
  note.textContent = item.claimedBy === actor?.id
    ? 'This item is already held by the active actor. Use Lease renewal below to extend the live lease.'
    : `This item is currently held by ${redactCredentialText(item.claimedBy)}. Claim acquisition becomes available after release or server-side expiry.`;
  section.append(note);
}

function polishEmptyStates(body, status, context) {
  for (const action of ACTIONS) {
    const section = findSection(body, action.heading);
    const empty = section?.querySelector('.detail-empty:not(.detail-claim-renewal-note)');
    if (!(empty instanceof HTMLElement)) continue;
    const message = actionEmptyState(action.name, status, context.canWrite, Boolean(context.actor));
    if (message) empty.textContent = message;
  }
}

function readRenderedItem(body) {
  const fields = {};
  for (const term of body.querySelectorAll('.detail-grid dt')) {
    const key = term.textContent?.trim() || '';
    const value = term.nextElementSibling?.textContent?.trim() || '';
    fields[key] = value === '—' ? '' : value;
  }
  return {
    status: fields.Status || '',
    claimedBy: fields['Claimed by'] || null,
    claimExpiresAt: latestRenderedClaimExpiry(body) || fields['Lease expires'] || null,
  };
}

function latestRenderedClaimExpiry(body) {
  for (const row of body.querySelectorAll('.detail-event')) {
    const type = row.querySelector('.detail-event-head strong')?.textContent?.trim();
    if (!['claim.created', 'claim.renewed'].includes(type)) continue;
    for (const term of row.querySelectorAll('.detail-payload dt')) {
      if (term.textContent?.trim() !== 'expiresAt') continue;
      const value = term.nextElementSibling?.textContent?.trim() || '';
      if (value && !Number.isNaN(Date.parse(value))) return value;
    }
  }
  return '';
}

function findSection(body, heading) {
  return [...body.querySelectorAll('.detail-section')].find((section) => {
    return section.querySelector('h3')?.textContent?.trim() === heading;
  }) || null;
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
    fingerprint: `${canWrite ? 'write' : 'read'}\u0000${endpoint}\u0000${token}\u0000${actorFingerprint}`,
    renderFingerprint: `${canWrite ? 'write' : 'read'}\u0000${endpoint}\u0000${token ? 'token' : 'no-token'}\u0000${actorFingerprint}`,
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

if (typeof document !== 'undefined') installLeaseStateController();
