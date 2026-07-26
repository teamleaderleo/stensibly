import { createRequestGate } from './item-detail.js';

const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const ITEM_ID_DATA_KEY = 'semanticItemId';
const GENERATION_DATA_KEY = 'semanticClaimGeneration';

export function readSemanticClaimGeneration(body, expectedItemId = '') {
  if (!(body instanceof Element)) return null;
  const itemId = body.dataset[ITEM_ID_DATA_KEY] || '';
  if (expectedItemId && itemId !== expectedItemId) return null;
  const raw = body.dataset[GENERATION_DATA_KEY];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const generation = Number(raw);
  return Number.isInteger(generation) && generation >= 0 ? generation : null;
}

export function installSemanticGenerationController() {
  const board = document.querySelector('#board');
  const dialog = document.querySelector('#item-detail-dialog');
  const body = document.querySelector('#item-detail-body');
  const refreshButton = document.querySelector('#item-detail-refresh');
  const contextPanel = document.querySelector('#session-context-panel');
  if (!board || !dialog || !body || !refreshButton || !contextPanel) return null;

  const gate = createRequestGate();
  let itemId = '';
  let loading = false;
  let loadQueued = false;
  let contextFingerprint = readContext().fingerprint;

  board.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest('button.card[data-item-id]');
    if (!(card instanceof HTMLButtonElement) || !board.contains(card)) return;
    const nextItemId = card.dataset.itemId || '';
    if (!nextItemId) return;
    itemId = nextItemId;
    resetProjection();
    scheduleLoad();
  });

  refreshButton.addEventListener('click', () => {
    if (!dialog.open || !itemId) return;
    resetProjection();
    scheduleLoad();
  });

  dialog.addEventListener('close', () => {
    itemId = '';
    resetProjection();
  });

  const bodyObserver = new MutationObserver(() => {
    if (!dialog.open || !itemId) return;
    scheduleLoad();
  });
  bodyObserver.observe(body, { childList: true, subtree: true });

  const contextObserver = new MutationObserver(() => {
    const next = readContext().fingerprint;
    if (next === contextFingerprint) return;
    contextFingerprint = next;
    resetProjection();
    scheduleLoad();
  });
  contextObserver.observe(contextPanel, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });

  function scheduleLoad() {
    if (loadQueued || loading || !itemId) return;
    loadQueued = true;
    queueMicrotask(() => {
      loadQueued = false;
      if (dialog.open) void loadGeneration();
    });
  }

  async function loadGeneration() {
    if (loading || !dialog.open || !itemId) return;
    const context = readContext();
    if (!context.endpoint || !context.token) return;

    loading = true;
    const expectedItemId = itemId;
    const expectedContext = context.fingerprint;
    const requestId = gate.begin();
    try {
      const response = await fetch(
        `${context.endpoint}/api/v1/items/${encodeURIComponent(expectedItemId)}`,
        {
          headers: { authorization: `Bearer ${context.token}` },
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!isCurrent(requestId, expectedItemId, expectedContext)) return;
      if (!response.ok || !payload || typeof payload !== 'object' || !payload.item) {
        clearProjection();
        return;
      }
      const returnedItemId = typeof payload.item.id === 'string' ? payload.item.id : '';
      const generation = payload.item.claimGeneration;
      if (
        returnedItemId !== expectedItemId
        || !Number.isInteger(generation)
        || generation < 0
      ) {
        clearProjection();
        return;
      }
      body.dataset[ITEM_ID_DATA_KEY] = returnedItemId;
      body.dataset[GENERATION_DATA_KEY] = String(generation);
    } catch {
      if (isCurrent(requestId, expectedItemId, expectedContext)) clearProjection();
    } finally {
      if (gate.isCurrent(requestId)) loading = false;
    }
  }

  function isCurrent(requestId, expectedItemId, expectedContext) {
    return gate.isCurrent(requestId)
      && dialog.open
      && itemId === expectedItemId
      && readContext().fingerprint === expectedContext;
  }

  function resetProjection() {
    gate.invalidate();
    loading = false;
    clearProjection();
  }

  function clearProjection() {
    delete body.dataset[ITEM_ID_DATA_KEY];
    delete body.dataset[GENERATION_DATA_KEY];
  }

  return { reset: resetProjection };
}

function readContext() {
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
  const panel = document.querySelector('#session-context-panel');
  const mode = panel?.dataset.mode === 'write' ? 'write' : 'read';
  return {
    token,
    endpoint,
    fingerprint: `${mode}\u0000${endpoint}\u0000${tokenDiscriminator(token)}`,
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

if (typeof document !== 'undefined') installSemanticGenerationController();
