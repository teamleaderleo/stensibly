import {
  describeHttpFailure,
  isPlausibleToken,
  normalizeEndpoint,
  readItems,
} from './connection.js';
import {
  DASHBOARD_VISIBILITY_WAKE_MS,
  acceptDashboardRefreshResult,
  clearDashboardRefreshState,
  dashboardRefreshDelay,
  dashboardRefreshMode,
  readDashboardRefreshState,
} from './dashboard-refresh-policy.js';
import {
  clearDashboardSnapshot,
  persistDashboardSnapshot,
  readDashboardSnapshot,
} from './dashboard-snapshot-cache.js';
import {
  collectRenderedBlockedIds,
  reconcileBatchTargets,
  summarizeBatchResults,
} from './decision-tray-batch.js';
import { resolveItemActionOutcome } from './item-resolution.js';
import { createItemDetailController } from './item-detail-controller.js';
import { createItemCreateController } from './item-create-controller.js';
import { createSessionContextController } from './session-context-controller.js';
import { isHostedSessionSentinel } from './hosted-session.js';
import { createStudioRadar } from './studio-radar.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const TRAY_BATCH_LABEL = '⚡ Clear Blockers';
const TRAY_BATCH_PROGRESS = 'Clearing…';

const form = document.querySelector('#connect-form');
const dashboard = document.querySelector('#dashboard');
const disconnected = document.querySelector('#disconnected-state');
const connectionTitle = document.querySelector('#connection-title');
const connectionState = document.querySelector('#connection-state');
const connectionError = document.querySelector('#connection-error');
const connectionPanel = document.querySelector('#connection-panel');
const connectionLoginSlot = document.querySelector('#connection-login-slot');
const connectionSystemSlot = document.querySelector('#connection-system-slot');
const connectedSummary = document.querySelector('#connected-summary');
const connectedEndpoint = document.querySelector('#connected-endpoint');
const cancelConnection = document.querySelector('#cancel-connection');
const projectFilter = document.querySelector('#project-filter');
const board = document.querySelector('#board');
const boardAnnouncer = document.querySelector('#board-announcer');
const agents = document.querySelector('#agents');
const lastUpdated = document.querySelector('#last-updated');
const syncState = document.querySelector('#sync-state');
const focusList = document.querySelector('#focus-list');
const focusCount = document.querySelector('#focus-count');
const recentList = document.querySelector('#recent-list');
const agentCount = document.querySelector('#agent-count');

const columns = [
  ['blocked', 'Needs attention', 'waiting on a named condition'],
  ['active', 'In motion', 'held and being worked now'],
  ['ready', 'Ready next', 'available to begin'],
  ['done', 'Done', 'completed work'],
];

const browserSessionStorage = optionalSessionStorage();
const browserLocalStorage = optionalLocalStorage();
const storedRefreshState = readDashboardRefreshState(browserSessionStorage);
let items = [];
let refreshTimer;
let refreshLevel = storedRefreshState.level;
let refreshFingerprint = storedRefreshState.fingerprint;
let lastSuccessfulUpdateLabel = '';
let requestGeneration = 0;
let connected = false;
let endpoint = savedEndpoint();
let token = readSessionValue('stensiblyToken');
let dashboardSnapshot = null;
let dataFreshness = 'waking';

let itemDetail;
let itemCreate;
const sessionContext = createSessionContextController({
  getConnection: () => ({ endpoint, token, connected }),
  reportConnectionIssue: (message) => showConnectedIssue(message),
  onChange: () => {
    itemCreate?.sync();
    itemDetail?.syncContext();
  },
});
itemDetail = createItemDetailController({
  board,
  getConnection: () => ({ endpoint, token, connected }),
  getItems: () => items,
  getContext: () => ({
    principal: sessionContext.getPrincipal(),
    actor: sessionContext.getActor(),
  }),
  reportConnectionIssue: (message) => showConnectedIssue(message),
  onChanged: async () => {
    await refreshCurrent({ interactive: true });
  },
});
itemCreate = createItemCreateController({
  getConnection: () => ({ endpoint, token, connected }),
  getContext: () => ({
    principal: sessionContext.getPrincipal(),
    actor: sessionContext.getActor(),
  }),
  getSelectedProject: () => projectFilter.value,
  reportConnectionIssue: (message) => showConnectedIssue(message),
  onCreated: async (item) => {
    await refreshCurrent({ interactive: true });
    if (!items.some((candidate) => candidate.id === item.id)) return;
    projectFilter.value = item.project;
    render();
    const card = [...board.querySelectorAll('button.card[data-item-id]')]
      .find((button) => button.dataset.itemId === item.id);
    card?.click();
  },
});
itemCreate.sync();

const quickDispatchForm = document.querySelector('#quick-dispatch-form');
const quickDispatchInput = document.querySelector('#quick-dispatch-input');
const quickDispatchProject = document.querySelector('#quick-dispatch-project');
const quickDispatchToast = document.querySelector('#quick-dispatch-toast');
const activityProjectSelect = document.querySelector('#activity-project-select');
const activityRefreshBtn = document.querySelector('#activity-refresh-btn');
const activityFeedList = document.querySelector('#activity-feed-list');

const radarCanvas = document.querySelector('#radar-canvas');
const radarStrip = document.querySelector('#radar-selected-strip');
const stripCallsign = document.querySelector('#strip-callsign');
const stripStatus = document.querySelector('#strip-status');
const stripTitle = document.querySelector('#strip-title');
const stripNext = document.querySelector('#strip-next');
const stripActionDone = document.querySelector('#strip-action-done');
const stripActionOpen = document.querySelector('#strip-action-open');
let currentRadarItem = null;
let trayRenderedBlockedIds = [];

const radar = createStudioRadar({
  canvas: radarCanvas,
  onSelectFlight: (flight) => {
    currentRadarItem = flight;
    if (radarStrip) {
      radarStrip.hidden = false;
      if (stripCallsign) stripCallsign.textContent = flight.callsign;
      if (stripStatus) stripStatus.textContent = flight.status.toUpperCase();
      if (stripTitle) stripTitle.textContent = flight.title;
      if (stripNext) stripNext.textContent = flight.nextAction ? `Next: ${flight.nextAction}` : '';
    }
  },
});

stripActionOpen?.addEventListener('click', () => {
  if (currentRadarItem?.id) {
    const card = [...board.querySelectorAll('button.card[data-item-id]')].find(
      (c) => c.dataset.itemId === currentRadarItem.id
    );
    card?.click();
  }
});

stripActionDone?.addEventListener('click', async () => {
  if (currentRadarItem?.id) {
    await completeItemDirect(currentRadarItem.id);
  }
});

form.elements.endpoint.value = endpoint;
form.elements.token.value = '';

form.addEventListener('submit', connect);
document.querySelector('#refresh').addEventListener('click', () => refreshCurrent({ interactive: true }));
document.querySelector('#change-connection').addEventListener('click', beginConnectionChange);
document.querySelector('#disconnect-connection').addEventListener('click', disconnect);
cancelConnection.addEventListener('click', cancelConnectionChange);
projectFilter.addEventListener('change', render);
document.addEventListener('visibilitychange', handleVisibilityChange);
focusList?.addEventListener('click', openOverviewRecord);
recentList?.addEventListener('click', openOverviewRecord);
quickDispatchForm?.addEventListener('submit', handleQuickDispatch);
activityRefreshBtn?.addEventListener('click', loadActivityFeed);
activityProjectSelect?.addEventListener('change', loadActivityFeed);

document.querySelector('#decision-tray')?.addEventListener('click', async (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest('button[data-decision-action]');
  if (!(button instanceof HTMLButtonElement)) return;
  const action = button.dataset.decisionAction;
  const itemId = button.dataset.itemId;
  if (!itemId) return;

  if (action === 'go') {
    button.disabled = true;
    button.textContent = 'Executing…';
    await completeItemDirect(itemId);
  } else if (action === 'open') {
    const card = [...board.querySelectorAll('button.card[data-item-id]')].find((c) => c.dataset.itemId === itemId);
    card?.click();
  }
});

document.querySelector('#tray-batch-approve')?.addEventListener('click', async (event) => {
  const button = event.target;
  if (!(button instanceof HTMLButtonElement) || button.disabled) return;
  button.disabled = true;
  button.textContent = TRAY_BATCH_PROGRESS;
  try {
    const { targets, stale } = reconcileBatchTargets(trayRenderedBlockedIds, isStillVisibleBlockedItem);
    const results = [];
    for (const itemId of targets) {
      results.push({ id: itemId, outcome: await resolveItemOutcome(itemId) });
    }
    const summary = summarizeBatchResults(results, { staleCount: stale.length });
    showQuickToast(summary.summaryLine, summary.failed > 0);
    if (summary.resolved > 0) await refreshCurrent({ interactive: true });
  } finally {
    button.textContent = TRAY_BATCH_LABEL;
    button.disabled = false;
  }
});

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    quickDispatchInput?.focus();
    quickDispatchInput?.select();
  }
});

if (token && isPlausibleToken(token)) {
  dashboardSnapshot = isHostedSessionSentinel(token)
    ? readDashboardSnapshot(browserLocalStorage, { endpoint })
    : null;
  items = dashboardSnapshot ? [...dashboardSnapshot.items] : [];
  connected = true;
  dataFreshness = dashboardSnapshot ? 'cached' : 'syncing';
  updateDashboard();
  showConnectedState({ warming: true });
  void refreshCurrent({ initial: true });
} else {
  if (token) clearStoredToken();
  showConnectionForm();
}

async function connect(event) {
  event.preventDefault();
  clearRefreshTimer();
  const requestId = beginRequest();
  hideConnectionError();

  let candidateEndpoint;
  try {
    candidateEndpoint = normalizeEndpoint(form.elements.endpoint.value);
  } catch (error) {
    showConnectionForm(error instanceof Error ? error.message : String(error), {
      keepDashboard: connected,
      allowCancel: connected,
    });
    return;
  }

  const suppliedToken = form.elements.token.value.trim();
  const endpointChanged = candidateEndpoint !== endpoint;
  if (endpointChanged && !suppliedToken) {
    showConnectionForm('Enter the token again before sending credentials to a different endpoint.', {
      keepDashboard: connected,
      allowCancel: connected,
    });
    return;
  }

  const candidateToken = suppliedToken || token;
  const tokenChanged = candidateToken !== token;
  if (!isPlausibleToken(candidateToken)) {
    showConnectionForm('Enter a complete Stensibly token in the stn.tok_… format.', {
      keepDashboard: connected,
      allowCancel: connected,
    });
    return;
  }

  if (endpointChanged || tokenChanged) {
    itemDetail.reset();
    sessionContext.reset();
    resetRefreshPolicy();
  }
  setConnectionStatus('connecting');
  try {
    const nextItems = await loadItems(candidateEndpoint, candidateToken);
    if (!isCurrentRequest(requestId)) return;
    endpoint = candidateEndpoint;
    token = candidateToken;
    acceptRefreshResult(nextItems, { initial: true });
    connected = true;
    dataFreshness = 'live';
    localStorage.stensiblyEndpoint = endpoint;
    writeSessionValue('stensiblyToken', token);
    persistHostedSnapshot();
    form.elements.endpoint.value = endpoint;
    form.elements.token.value = '';
    updateDashboard();
    showConnectedState();
    void sessionContext.refresh();
    scheduleRefresh();
  } catch (error) {
    if (!isCurrentRequest(requestId)) return;
    const message = await explainConnectionFailure(error, candidateEndpoint);
    if (!isCurrentRequest(requestId)) return;
    const failedCurrentConnection = candidateEndpoint === endpoint
      && candidateToken === token
      && isTerminalConnectionFailure(error);
    if (failedCurrentConnection) {
      if (isCredentialFailure(error)) clearStoredToken();
      clearPersistedSnapshot();
      connected = false;
      items = [];
      itemDetail.reset();
      sessionContext.reset();
      resetRefreshPolicy();
    }
    showConnectionForm(message, {
      keepDashboard: connected,
      allowCancel: connected,
    });
  }
}

async function refreshCurrent({ interactive = false, initial = false } = {}) {
  if (!endpoint || !token) {
    showConnectionForm();
    return;
  }
  if (!interactive && !initial && document.hidden) {
    scheduleRefresh();
    return;
  }

  clearRefreshTimer();
  const requestId = beginRequest();
  if (interactive || initial) setConnectionStatus(interactive ? 'refreshing' : 'connecting');

  try {
    const nextItems = await loadItems(endpoint, token);
    if (!isCurrentRequest(requestId)) return;
    acceptRefreshResult(nextItems, { interactive, initial });
    connected = true;
    dataFreshness = 'live';
    persistHostedSnapshot();
    updateDashboard();
    showConnectedState();
    if (interactive || initial) void sessionContext.refresh();
    scheduleRefresh();
  } catch (error) {
    if (!isCurrentRequest(requestId)) return;
    const hostedSignInRequired = initial
      && isHostedSessionSentinel(token)
      && error instanceof ConnectionFailure
      && error.kind === 'invalid_token';
    const message = await explainConnectionFailure(error, endpoint);
    if (!isCurrentRequest(requestId)) return;
    if (isTerminalConnectionFailure(error)) {
      if (isCredentialFailure(error)) clearStoredToken();
      clearPersistedSnapshot();
      connected = false;
      items = [];
      itemDetail.reset();
      sessionContext.reset();
      resetRefreshPolicy();
      showConnectionForm(hostedSignInRequired ? '' : message);
      return;
    }
    if (!connected) {
      showConnectionForm(message);
      return;
    }
    dataFreshness = items.length || dashboardSnapshot ? 'degraded' : 'syncing';
    renderDataFreshness();
    showConnectedIssue(message);
    scheduleRefresh();
  }
}

async function loadItems(apiEndpoint, apiToken) {
  let response;
  try {
    response = await fetch(apiEndpoint + '/api/v1/items', {
      headers: { authorization: `Bearer ${apiToken}` },
      cache: 'no-store',
    });
  } catch (error) {
    throw new ConnectionFailure('fetch_failed', error instanceof Error ? error.message : String(error));
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = describeHttpFailure(response.status, payload);
    throw new ConnectionFailure(failure.kind, failure.message);
  }

  try {
    return readItems(payload).filter((item) => item.status !== 'archived');
  } catch (error) {
    throw new ConnectionFailure(
      'incompatible_response',
      error instanceof Error ? error.message : 'The endpoint returned an incompatible response.',
    );
  }
}

async function explainConnectionFailure(error, apiEndpoint) {
  if (!(error instanceof ConnectionFailure) || error.kind !== 'fetch_failed') {
    return error instanceof Error ? error.message : String(error);
  }
  if (navigator.onLine === false) return 'This browser is offline. Reconnect and try again.';

  try {
    await fetch(apiEndpoint + '/health', {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
    });
    return `The API host is reachable, but this browser request was blocked. Allow ${window.location.origin} in STENSIBLY_ALLOWED_ORIGINS and verify the API CORS settings.`;
  } catch {
    return 'The endpoint could not be reached. Check the URL, DNS, proxy path, or whether the API is running.';
  }
}

function isTerminalConnectionFailure(error) {
  return error instanceof ConnectionFailure && [
    'invalid_token',
    'forbidden',
    'forbidden_origin',
    'incompatible_api',
    'incompatible_response',
  ].includes(error.kind);
}

function isCredentialFailure(error) {
  return error instanceof ConnectionFailure && ['invalid_token', 'forbidden'].includes(error.kind);
}

function beginConnectionChange() {
  invalidateRequests();
  clearRefreshTimer();
  itemDetail.reset();
  sessionContext.reset();
  form.elements.endpoint.value = endpoint;
  form.elements.token.value = '';
  showConnectionForm('', { keepDashboard: true, allowCancel: true });
  form.elements.endpoint.focus();
}

function cancelConnectionChange() {
  if (!connected) return;
  invalidateRequests();
  form.elements.endpoint.value = endpoint;
  form.elements.token.value = '';
  showConnectedState();
  void sessionContext.refresh();
  scheduleRefresh();
}

function disconnect() {
  invalidateRequests();
  clearRefreshTimer();
  itemDetail.reset({ announce: 'Item detail closed because the ledger disconnected.' });
  sessionContext.reset();
  clearStoredToken();
  clearPersistedSnapshot();
  connected = false;
  items = [];
  resetRefreshPolicy();
  form.elements.endpoint.value = endpoint;
  form.elements.token.value = '';
  showConnectionForm();
}

function clearStoredToken() {
  token = '';
  removeSessionValue('stensiblyToken');
  form.elements.token.value = '';
}

function optionalSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function optionalLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readSessionValue(key) {
  try {
    return browserSessionStorage?.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeSessionValue(key, value) {
  try {
    browserSessionStorage?.setItem(key, value);
  } catch {
    // Session persistence is optional; the accepted in-memory result remains authoritative.
  }
}

function removeSessionValue(key) {
  try {
    browserSessionStorage?.removeItem(key);
  } catch {
    // Disconnect and reset remain available when storage access is blocked.
  }
}

function beginRequest() {
  requestGeneration += 1;
  return requestGeneration;
}

function invalidateRequests() {
  requestGeneration += 1;
}

function isCurrentRequest(requestId) {
  return requestId === requestGeneration;
}

function showConnectedState({ warming = false } = {}) {
  placeConnectionPanel(connectionSystemSlot);
  connectionTitle.textContent = 'Studio connected';
  form.hidden = true;
  connectedSummary.hidden = false;
  cancelConnection.hidden = true;
  connectedEndpoint.textContent = endpoint;
  hideConnectionError();
  setConnectionStatus(warming ? 'revalidating' : 'connected');
  dashboard.hidden = false;
  disconnected.hidden = true;
  renderDataFreshness();
}

function showConnectedIssue(message) {
  placeConnectionPanel(connectionSystemSlot);
  connectionTitle.textContent = 'Connection needs attention';
  form.hidden = true;
  connectedSummary.hidden = false;
  cancelConnection.hidden = true;
  connectedEndpoint.textContent = endpoint;
  showConnectionError(message);
  setConnectionStatus('retrying', true);
  dashboard.hidden = false;
  disconnected.hidden = true;
  dataFreshness = 'degraded';
  renderDataFreshness();
}

function showConnectionForm(message = '', { keepDashboard = false, allowCancel = false } = {}) {
  placeConnectionPanel(keepDashboard ? connectionSystemSlot : connectionLoginSlot);
  connectionTitle.textContent = allowCancel ? 'Change connection' : 'Continue to Stensibly';
  form.hidden = false;
  connectedSummary.hidden = true;
  cancelConnection.hidden = !allowCancel;
  if (message) {
    showConnectionError(message);
    setConnectionStatus('connection failed', true);
  } else {
    hideConnectionError();
    setConnectionStatus(allowCancel ? 'editing' : 'disconnected');
  }

  if (!keepDashboard) {
    dashboard.hidden = true;
    disconnected.hidden = false;
    disconnected.querySelector('p').textContent = 'Your studio is ready when you are.';
    disconnected.querySelector('span').textContent = 'Continue with GitHub above. Your existing hosted session will be restored automatically.';
  }
}

function placeConnectionPanel(slot) {
  if (!connectionPanel || !slot || connectionPanel.parentElement === slot) return;
  slot.append(connectionPanel);
}

function showConnectionError(message) {
  connectionError.textContent = message;
  connectionError.hidden = false;
}

function hideConnectionError() {
  connectionError.textContent = '';
  connectionError.hidden = true;
}

function setConnectionStatus(label, isError = false) {
  connectionState.textContent = label;
  connectionState.classList.toggle('error', isError);
}

function acceptRefreshResult(nextItems, { interactive = false, initial = false } = {}) {
  const nextState = acceptDashboardRefreshResult({
    storage: browserSessionStorage,
    previousFingerprint: refreshFingerprint,
    currentLevel: refreshLevel,
    nextItems,
    interactive,
    initial,
  });
  items = nextState.items;
  refreshLevel = nextState.level;
  refreshFingerprint = nextState.fingerprint;
}

function resetRefreshPolicy() {
  refreshLevel = 0;
  refreshFingerprint = '';
  lastSuccessfulUpdateLabel = '';
  clearDashboardRefreshState(browserSessionStorage);
}

function updateDashboard() {
  populateProjects();
  render();
  lastSuccessfulUpdateLabel = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  itemDetail.reconcile();
  renderDataFreshness();
}

function scheduleRefresh() {
  clearRefreshTimer();
  if (!connected) return;
  if (document.hidden) {
    renderRefreshMode(dashboardRefreshMode({ hidden: true, level: refreshLevel }));
    return;
  }
  const delay = dashboardRefreshDelay(refreshLevel);
  renderRefreshMode(dashboardRefreshMode({ hidden: false, level: refreshLevel }));
  refreshTimer = setTimeout(() => void refreshCurrent(), delay);
}

function handleVisibilityChange() {
  clearRefreshTimer();
  if (!connected) return;
  if (document.hidden) {
    renderRefreshMode(dashboardRefreshMode({ hidden: true, level: refreshLevel }));
    return;
  }
  renderRefreshMode(dashboardRefreshMode({ hidden: false, level: refreshLevel, waking: true }));
  refreshTimer = setTimeout(
    () => void refreshCurrent(),
    DASHBOARD_VISIBILITY_WAKE_MS,
  );
}

function renderRefreshMode(mode) {
  const updated = lastSuccessfulUpdateLabel
    ? `updated ${lastSuccessfulUpdateLabel}`
    : 'waiting for update';
  lastUpdated.textContent = `${updated} · ${mode}`;
}

function clearRefreshTimer() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
}

function populateProjects() {
  const selected = projectFilter.value;
  const projects = [...new Set(items.map((item) => item.project))].sort();
  const options = '<option value="">all projects</option>' + projects
    .map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`)
    .join('');
  projectFilter.innerHTML = options;
  if (projects.includes(selected)) projectFilter.value = selected;

  if (quickDispatchProject) {
    const defaultProject = selected || projects[0] || 'scrapbook';
    quickDispatchProject.innerHTML = projects.length
      ? projects.map((p) => `<option value="${escapeHtml(p)}" ${p === defaultProject ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')
      : '<option value="scrapbook">scrapbook</option>';
  }

  if (activityProjectSelect) {
    activityProjectSelect.innerHTML = options;
    if (projects.includes(selected)) activityProjectSelect.value = selected;
  }
}

function render() {
  const selected = projectFilter.value;
  const visible = selected ? items.filter((item) => item.project === selected) : items;
  document.querySelector('#ledger-name').textContent = selected || 'All projects';

  renderStudioBrief(visible);
  renderDecisionTray(visible);
  radar?.update(visible);

  for (const status of ['ready', 'active', 'blocked', 'done']) {
    document.querySelector(`#metric-${status}`).textContent = String(visible.filter((item) => item.status === status).length);
  }

  const activeActors = [...new Set(
    visible.filter((item) => item.status === 'active' && item.claimedBy).map((item) => item.claimedBy),
  )].sort();
  if (agentCount) agentCount.textContent = `${activeActors.length} active`;
  agents.innerHTML = activeActors.length
    ? activeActors.map((actor) => `<div class="agent">${escapeHtml(actor)}</div>`).join('')
    : '<p class="empty">Nothing active right now.</p>';

  renderOverview(visible);

  board.innerHTML = columns.map(([status, label, hint]) => {
    const matching = visible
      .filter((item) => item.status === status)
      .sort((left, right) => right.priority - left.priority || right.updatedAt.localeCompare(left.updatedAt));
    return `<section class="column ${statusClass(status)}">
      <header class="column-head">
        <div><h3>${label}</h3><small>${hint}</small></div>
        <span class="count">${matching.length}</span>
      </header>
      <div class="cards">
        ${matching.length ? matching.map(renderCard).join('') : '<p class="empty">Nothing here yet.</p>'}
      </div>
    </section>`;
  }).join('');
  if (boardAnnouncer) {
    const announcement = `${visible.length} ${visible.length === 1 ? 'work item' : 'work items'} loaded for ${selected || 'all projects'}.`;
    if (boardAnnouncer.textContent !== announcement) boardAnnouncer.textContent = announcement;
  }
}

function renderOverview(visible) {
  const attentionRank = { blocked: 0, active: 1, ready: 2, done: 3 };
  const attention = [...visible]
    .filter((item) => item.status !== 'done')
    .sort((left, right) => (attentionRank[left.status] ?? 4) - (attentionRank[right.status] ?? 4)
      || right.priority - left.priority
      || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);
  const recent = [...visible]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);

  if (focusCount) focusCount.textContent = String(attention.length);
  if (focusList) {
    focusList.innerHTML = attention.length
      ? attention.map((item) => renderOverviewItem(item, { showNextAction: true })).join('')
      : '<p class="empty">Nothing needs your attention.</p>';
  }
  if (recentList) {
    recentList.innerHTML = recent.length
      ? recent.map((item) => renderOverviewItem(item)).join('')
      : '<p class="empty">No recent work yet.</p>';
  }
}

function renderOverviewItem(item, { showNextAction = false } = {}) {
  const supporting = showNextAction
    ? item.nextAction || item.summary || 'Open the record to choose the next action.'
    : `${item.kind} · ${item.project}${item.claimedBy ? ` · ${item.claimedBy}` : ''}`;
  return `<button class="overview-item ${statusClass(item.status)}" type="button" data-overview-item-id="${escapeHtml(item.id)}" aria-label="Open ${escapeHtml(item.title)}">
    <span class="overview-status" aria-hidden="true"></span>
    <span class="overview-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(supporting)}</small></span>
    <span class="overview-meta"><strong>${escapeHtml(item.status)}</strong><span>${relativeTime(item.updatedAt)}</span></span>
  </button>`;
}

function openOverviewRecord(event) {
  if (!(event.target instanceof Element)) return;
  const trigger = event.target.closest('[data-overview-item-id]');
  if (!(trigger instanceof HTMLButtonElement)) return;
  const itemId = trigger.dataset.overviewItemId || '';
  if (!itemId) return;
  const card = [...board.querySelectorAll('button.card[data-item-id]')]
    .find((candidate) => candidate.dataset.itemId === itemId);
  card?.click();
}

function renderDataFreshness() {
  if (!syncState) return;
  const labels = {
    live: lastSuccessfulUpdateLabel ? `Live · ${lastSuccessfulUpdateLabel}` : 'Live',
    cached: dashboardSnapshot ? `Saved · ${formatSnapshotTime(dashboardSnapshot.savedAt)}` : 'Saved view',
    syncing: 'Syncing quietly',
    degraded: 'Offline · showing saved data',
    waking: 'Restoring studio',
  };
  syncState.dataset.state = dataFreshness;
  const copy = syncState.querySelector('span');
  if (copy) copy.textContent = labels[dataFreshness] || 'Standing by';
}

function formatSnapshotTime(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'earlier';
}

function persistHostedSnapshot() {
  if (!isHostedSessionSentinel(token)) return false;
  const savedAt = new Date().toISOString();
  const persisted = persistDashboardSnapshot(browserLocalStorage, { endpoint, items, savedAt });
  if (persisted) dashboardSnapshot = { version: 1, endpoint, savedAt, items: [...items] };
  return persisted;
}

function clearPersistedSnapshot() {
  dashboardSnapshot = null;
  clearDashboardSnapshot(browserLocalStorage);
}

function renderCard(item) {
  const owner = item.claimedBy ? `held by ${escapeHtml(item.claimedBy)}` : relativeTime(item.updatedAt);
  const lease = item.claimExpiresAt ? leaseTime(item.claimExpiresAt) : `v${item.version}`;
  return `<button class="card ${statusClass(item.status)}" type="button" data-item-id="${escapeHtml(item.id)}" aria-label="Open ${escapeHtml(item.title)}">
    <span class="card-top"><span>${escapeHtml(item.kind)} · ${escapeHtml(item.project)}</span><span>p${item.priority}</span></span>
    <span class="card-copy"><strong class="card-title">${escapeHtml(item.title)}</strong>${item.summary ? `<span class="card-summary">${escapeHtml(item.summary)}</span>` : ''}</span>
    <span class="card-next"><span>Next move</span><strong>${escapeHtml(item.nextAction || 'Open the work record and choose a concrete next action.')}</strong></span>
    <span class="card-meta"><span>${owner}</span><span>${lease}</span></span>
  </button>`;
}

function savedEndpoint() {
  try {
    return normalizeEndpoint(localStorage.stensiblyEndpoint || DEFAULT_ENDPOINT);
  } catch {
    localStorage.removeItem('stensiblyEndpoint');
    return DEFAULT_ENDPOINT;
  }
}

function statusClass(status) {
  return ({
    ready: 'status-ready',
    active: 'status-active',
    blocked: 'status-blocked',
    done: 'status-done',
  })[status] || 'status-muted';
}

function relativeTime(value) {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function leaseTime(value) {
  const remaining = Date.parse(value) - Date.now();
  if (remaining <= 0) return 'lease expired';
  if (remaining < 60000) return `lease ${Math.ceil(remaining / 1000)}s`;
  return `lease ${Math.ceil(remaining / 60000)}m`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]);
}

class ConnectionFailure extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ConnectionFailure';
    this.kind = kind;
  }
}

function renderStudioBrief(visible) {
  const blocked = visible.filter((item) => item.status === 'blocked');
  const active = visible.filter((item) => item.status === 'active');
  const ready = visible.filter((item) => item.status === 'ready');
  const headline = document.querySelector('#studio-brief-headline');
  const activeSummary = document.querySelector('#brief-active-summary');
  const blockedSummary = document.querySelector('#brief-blocked-summary');
  const readySummary = document.querySelector('#brief-ready-summary');

  if (headline) {
    if (blocked.length > 0) {
      headline.textContent = `Attention needed on ${blocked.length} ${blocked.length === 1 ? 'obligation' : 'obligations'}`;
    } else if (active.length > 0) {
      headline.textContent = `Studio is in motion · ${active.length} ${active.length === 1 ? 'task' : 'tasks'} held`;
    } else {
      headline.textContent = 'Studio is standing by · all clear';
    }
  }

  if (activeSummary) {
    if (active.length > 0) {
      const holders = [...new Set(active.map((item) => item.claimedBy).filter(Boolean))];
      const detail = holders.length ? ` (${holders.slice(0, 3).join(', ')})` : '';
      activeSummary.textContent = `${active.length} ${active.length === 1 ? 'task' : 'tasks'} active${detail}`;
    } else {
      activeSummary.textContent = '0 agents actively holding work';
    }
  }

  if (blockedSummary) {
    if (blocked.length > 0) {
      const topTitle = blocked[0].title;
      blockedSummary.textContent = `Blocked: ${topTitle.slice(0, 50)}${topTitle.length > 50 ? '…' : ''}`;
    } else {
      blockedSummary.textContent = 'All lanes clear · no blockers';
    }
  }

  if (readySummary) {
    readySummary.textContent = `${ready.length} ${ready.length === 1 ? 'task' : 'tasks'} available to claim`;
  }
}

async function handleQuickDispatch(event) {
  event.preventDefault();
  const rawTitle = quickDispatchInput?.value?.trim();
  if (!rawTitle) return;
  const project = quickDispatchProject?.value || projectFilter.value || (items[0]?.project || 'scrapbook');
  const actor = sessionContext.getActor() || { id: 'operator', name: 'Operator', kind: 'human' };

  if (!connected || !token) {
    showQuickToast('Connect to a studio first.', true);
    return;
  }

  const submitButton = document.querySelector('#quick-dispatch-submit');
  if (submitButton) submitButton.disabled = true;

  try {
    const key = `stn.quick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await fetch(`${endpoint}/api/v1/items`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({
        project,
        kind: 'task',
        title: rawTitle,
        priority: 50,
        actor,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const msg = data.message || `Failed to dispatch (HTTP ${response.status})`;
      showQuickToast(msg, true);
      return;
    }

    if (quickDispatchInput) quickDispatchInput.value = '';
    showQuickToast(`Dispatched "${rawTitle.slice(0, 30)}${rawTitle.length > 30 ? '…' : ''}" to ${project}!`);
    await refreshCurrent({ interactive: true });
  } catch (error) {
    showQuickToast(error instanceof Error ? error.message : 'Dispatch failed', true);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function showQuickToast(message, isError = false) {
  if (!quickDispatchToast) return;
  quickDispatchToast.textContent = message;
  quickDispatchToast.style.background = isError ? 'var(--blocked)' : 'var(--done)';
  quickDispatchToast.style.color = isError ? 'var(--blocked-ink)' : 'var(--done-ink)';
  quickDispatchToast.hidden = false;
  setTimeout(() => {
    quickDispatchToast.hidden = true;
  }, 4000);
}

async function loadActivityFeed() {
  if (!activityFeedList || !connected || !token) return;
  const project = activityProjectSelect?.value || projectFilter.value || (items[0]?.project || '');
  if (!project) {
    activityFeedList.innerHTML = '<p class="empty">No project selected.</p>';
    return;
  }

  activityFeedList.innerHTML = '<p class="empty">Loading activity for ' + escapeHtml(project) + '…</p>';
  try {
    const response = await fetch(`${endpoint}/api/v1/projects/${encodeURIComponent(project)}/activity`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      activityFeedList.innerHTML = '<p class="empty">Could not load activity (HTTP ' + response.status + ').</p>';
      return;
    }
    const data = await response.json();
    const entries = data?.activity?.entries || [];
    if (!entries.length) {
      activityFeedList.innerHTML = '<p class="empty">No recent activity recorded for ' + escapeHtml(project) + '.</p>';
      return;
    }
    activityFeedList.innerHTML = entries.map((entry) => {
      const time = relativeTime(entry.happenedAt);
      const icon = ({
        completed: '✅',
        blocked: '⚠️',
        handoff: '🤝',
        work_started: '🚀',
        provider_effect: '📦',
        verification: '🔍',
      })[entry.activityClass] || '⚡';
      return `<article class="overview-item status-${escapeHtml(entry.dispositionState || 'ready')}">
        <span class="brief-icon" aria-hidden="true">${icon}</span>
        <span class="overview-copy">
          <strong>${escapeHtml(entry.summary || entry.activityClass)}</strong>
          <small>${escapeHtml(entry.sourceClass)} · ${escapeHtml(entry.actor || 'studio')}</small>
        </span>
        <span class="overview-meta">
          <strong>${escapeHtml(entry.dispositionState || 'observed')}</strong>
          <span>${escapeHtml(time)}</span>
        </span>
      </article>`;
    }).join('');
  } catch (err) {
    activityFeedList.innerHTML = '<p class="empty">Activity loading failed.</p>';
  }
}

function renderDecisionTray(visible) {
  const decisionTray = document.querySelector('#decision-tray');
  const decisionCards = document.querySelector('#decision-tray-cards');
  if (!decisionTray || !decisionCards) return;

  const blocked = visible.filter((item) => item.status === 'blocked');
  if (!blocked.length) {
    decisionTray.hidden = true;
    trayRenderedBlockedIds = [];
    return;
  }

  decisionTray.hidden = false;
  trayRenderedBlockedIds = collectRenderedBlockedIds(visible);
  decisionCards.innerHTML = blocked.map((item) => {
    return `<article class="decision-card">
      <div class="decision-card-top">
        <span>${escapeHtml(item.project)}</span>
        <span>p${item.priority}</span>
      </div>
      <h3 class="decision-card-title">${escapeHtml(item.title)}</h3>
      <p class="decision-card-desc">${escapeHtml(item.nextAction || item.summary || 'Waiting on your decision')}</p>
      <div class="decision-card-actions">
        <button class="btn-go" type="button" data-decision-action="go" data-item-id="${escapeHtml(item.id)}">🚀 Okay, Go</button>
        <button class="btn-open" type="button" data-decision-action="open" data-item-id="${escapeHtml(item.id)}">Details →</button>
      </div>
    </article>`;
  }).join('');
}

function isStillVisibleBlockedItem(itemId) {
  const selected = projectFilter.value;
  return items.some((item) => item.id === itemId
    && item.status === 'blocked'
    && (!selected || item.project === selected));
}

async function resolveItemOutcome(itemId) {
  const item = items.find((i) => i.id === itemId);
  if (!item) return 'failed';
  try {
    return await resolveItemActionOutcome({
      endpoint,
      token,
      itemId,
      item,
      actor: sessionContext.getActor() || { id: 'operator', name: 'Operator', kind: 'human' },
    });
  } catch {
    return 'failed';
  }
}

async function completeItemDirect(itemId) {
  if (!connected || !token) {
    showQuickToast('Connect to a studio first.', true);
    return;
  }
  const item = items.find((i) => i.id === itemId);
  if (!item) return;

  const outcome = await resolveItemOutcome(itemId);
  if (outcome === 'completed') {
    showQuickToast(`Completed "${item.title.slice(0, 30)}"!`);
  } else if (outcome === 'unblocked') {
    showQuickToast(`Unblocked "${item.title.slice(0, 30)}"!`);
  } else {
    showQuickToast(`Could not update "${item.title.slice(0, 30)}". Open the record to retry.`, true);
    return;
  }
  await refreshCurrent({ interactive: true });
}


