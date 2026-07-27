import {
  describeHttpFailure,
  isPlausibleToken,
  normalizeEndpoint,
  readItems,
} from './connection.js';
import { createItemDetailController } from './item-detail-controller.js';
import { createItemCreateController } from './item-create-controller.js';
import { createSessionContextController } from './session-context-controller.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const REFRESH_INTERVAL_MS = 15000;

const form = document.querySelector('#connect-form');
const dashboard = document.querySelector('#dashboard');
const disconnected = document.querySelector('#disconnected-state');
const connectionTitle = document.querySelector('#connection-title');
const connectionState = document.querySelector('#connection-state');
const connectionError = document.querySelector('#connection-error');
const connectedSummary = document.querySelector('#connected-summary');
const connectedEndpoint = document.querySelector('#connected-endpoint');
const cancelConnection = document.querySelector('#cancel-connection');
const projectFilter = document.querySelector('#project-filter');
const board = document.querySelector('#board');
const agents = document.querySelector('#agents');
const lastUpdated = document.querySelector('#last-updated');

const columns = [
  ['ready', 'Ready', 'available to begin'],
  ['active', 'Active', 'being worked on now'],
  ['blocked', 'Blocked', 'waiting on a named condition'],
  ['done', 'Done', 'completed work'],
];

let items = [];
let refreshTimer;
let requestGeneration = 0;
let connected = false;
let endpoint = savedEndpoint();
let token = sessionStorage.stensiblyToken || '';

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
    await refreshCurrent();
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

form.elements.endpoint.value = endpoint;
form.elements.token.value = '';

form.addEventListener('submit', connect);
document.querySelector('#refresh').addEventListener('click', () => refreshCurrent({ interactive: true }));
document.querySelector('#change-connection').addEventListener('click', beginConnectionChange);
document.querySelector('#disconnect-connection').addEventListener('click', disconnect);
cancelConnection.addEventListener('click', cancelConnectionChange);
projectFilter.addEventListener('change', render);

if (token && isPlausibleToken(token)) {
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
  }
  setConnectionStatus('connecting');
  try {
    const nextItems = await loadItems(candidateEndpoint, candidateToken);
    if (!isCurrentRequest(requestId)) return;
    endpoint = candidateEndpoint;
    token = candidateToken;
    items = nextItems;
    connected = true;
    localStorage.stensiblyEndpoint = endpoint;
    sessionStorage.stensiblyToken = token;
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
      connected = false;
      items = [];
      itemDetail.reset();
      sessionContext.reset();
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

  clearRefreshTimer();
  const requestId = beginRequest();
  if (interactive || initial) setConnectionStatus(interactive ? 'refreshing' : 'connecting');

  try {
    const nextItems = await loadItems(endpoint, token);
    if (!isCurrentRequest(requestId)) return;
    items = nextItems;
    connected = true;
    updateDashboard();
    showConnectedState();
    if (interactive || initial) void sessionContext.refresh();
    scheduleRefresh();
  } catch (error) {
    if (!isCurrentRequest(requestId)) return;
    const message = await explainConnectionFailure(error, endpoint);
    if (!isCurrentRequest(requestId)) return;
    if (isTerminalConnectionFailure(error)) {
      if (isCredentialFailure(error)) clearStoredToken();
      connected = false;
      items = [];
      itemDetail.reset();
      sessionContext.reset();
      showConnectionForm(message);
      return;
    }
    if (!connected) {
      showConnectionForm(message);
      return;
    }
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
  connected = false;
  items = [];
  form.elements.endpoint.value = endpoint;
  form.elements.token.value = '';
  showConnectionForm();
}

function clearStoredToken() {
  token = '';
  sessionStorage.removeItem('stensiblyToken');
  form.elements.token.value = '';
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

function showConnectedState() {
  connectionTitle.textContent = 'Project desk connected';
  form.hidden = true;
  connectedSummary.hidden = false;
  cancelConnection.hidden = true;
  connectedEndpoint.textContent = endpoint;
  hideConnectionError();
  setConnectionStatus('connected');
  dashboard.hidden = false;
  disconnected.hidden = true;
}

function showConnectedIssue(message) {
  connectionTitle.textContent = 'Connection needs attention';
  form.hidden = true;
  connectedSummary.hidden = false;
  cancelConnection.hidden = true;
  connectedEndpoint.textContent = endpoint;
  showConnectionError(message);
  setConnectionStatus('retrying', true);
  dashboard.hidden = false;
  disconnected.hidden = true;
}

function showConnectionForm(message = '', { keepDashboard = false, allowCancel = false } = {}) {
  connectionTitle.textContent = allowCancel ? 'Change connection' : 'Welcome back';
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
    disconnected.querySelector('p').textContent = 'Your project desk is ready when you are.';
    disconnected.querySelector('span').textContent = 'Continue with GitHub, or use the advanced connection for another endpoint.';
  }
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

function updateDashboard() {
  populateProjects();
  render();
  lastUpdated.textContent = `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  itemDetail.reconcile();
}

function scheduleRefresh() {
  clearRefreshTimer();
  refreshTimer = setTimeout(() => void refreshCurrent(), REFRESH_INTERVAL_MS);
}

function clearRefreshTimer() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
}

function populateProjects() {
  const selected = projectFilter.value;
  const projects = [...new Set(items.map((item) => item.project))].sort();
  projectFilter.innerHTML = '<option value="">all projects</option>' + projects
    .map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`)
    .join('');
  if (projects.includes(selected)) projectFilter.value = selected;
}

function render() {
  const selected = projectFilter.value;
  const visible = selected ? items.filter((item) => item.project === selected) : items;
  document.querySelector('#ledger-name').textContent = selected || 'All projects';

  for (const status of ['ready', 'active', 'blocked', 'done']) {
    document.querySelector(`#metric-${status}`).textContent = String(visible.filter((item) => item.status === status).length);
  }

  const activeActors = [...new Set(
    visible.filter((item) => item.status === 'active' && item.claimedBy).map((item) => item.claimedBy),
  )].sort();
  agents.innerHTML = activeActors.length
    ? activeActors.map((actor) => `<div class="agent">${escapeHtml(actor)}</div>`).join('')
    : '<p class="empty">Nothing active right now.</p>';

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
}

function renderCard(item) {
  const owner = item.claimedBy ? `held by ${escapeHtml(item.claimedBy)}` : relativeTime(item.updatedAt);
  const lease = item.claimExpiresAt ? leaseTime(item.claimExpiresAt) : `v${item.version}`;
  return `<button class="card ${statusClass(item.status)}" type="button" data-item-id="${escapeHtml(item.id)}" aria-label="Open ${escapeHtml(item.title)}">
    <div class="card-top"><span>${escapeHtml(item.kind)} · ${escapeHtml(item.project)}</span><span>p${item.priority}</span></div>
    <h4>${escapeHtml(item.title)}</h4>
    ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}
    ${item.nextAction ? `<p>next · ${escapeHtml(item.nextAction)}</p>` : ''}
    <div class="card-meta"><span>${owner}</span><span>${lease}</span></div>
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
