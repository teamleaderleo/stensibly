const form = document.querySelector('#connect-form');
const dashboard = document.querySelector('#dashboard');
const disconnected = document.querySelector('#disconnected-state');
const connectionState = document.querySelector('#connection-state');
const projectFilter = document.querySelector('#project-filter');
const board = document.querySelector('#board');
const agents = document.querySelector('#agents');
const lastUpdated = document.querySelector('#last-updated');

const columns = [
  ['ready', 'Ready', 'waiting for a willing creature'],
  ['active', 'Active', 'currently being interfered with'],
  ['blocked', 'Blocked', 'staring into the middle distance'],
  ['done', 'Done', 'ostensibly handled'],
];

let items = [];
let refreshTimer;
let endpoint = localStorage.stensiblyEndpoint || '';
let token = sessionStorage.stensiblyToken || '';

form.elements.endpoint.value = endpoint;
form.elements.token.value = token;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  endpoint = normalizeEndpoint(form.elements.endpoint.value);
  token = form.elements.token.value.trim();
  localStorage.stensiblyEndpoint = endpoint;
  sessionStorage.stensiblyToken = token;
  await refresh();
});

document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#disconnect').addEventListener('click', () => {
  token = '';
  sessionStorage.removeItem('stensiblyToken');
  form.elements.token.value = '';
  clearInterval(refreshTimer);
  setDisconnected('disconnected');
});
projectFilter.addEventListener('change', render);

if (endpoint && token) refresh();

async function refresh() {
  clearInterval(refreshTimer);
  connectionState.textContent = 'connecting';
  connectionState.classList.remove('error');
  try {
    const response = await fetch(endpoint + '/api/v1/items', {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed with ${response.status}`);
    items = Array.isArray(data.items) ? data.items.filter((item) => item.status !== 'archived') : [];
    connectionState.textContent = 'connected';
    dashboard.hidden = false;
    disconnected.hidden = true;
    populateProjects();
    render();
    lastUpdated.textContent = `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    refreshTimer = setInterval(refresh, 15000);
  } catch (error) {
    setDisconnected(error instanceof Error ? error.message : String(error));
  }
}

function setDisconnected(message) {
  dashboard.hidden = true;
  disconnected.hidden = false;
  disconnected.querySelector('p').textContent = 'No ledger connected.';
  disconnected.querySelector('span').textContent = message;
  connectionState.textContent = 'error';
  connectionState.classList.add('error');
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
    : '<p class="empty">quiet. suspiciously quiet.</p>';

  board.innerHTML = columns.map(([status, label, hint]) => {
    const matching = visible
      .filter((item) => item.status === status)
      .sort((left, right) => right.priority - left.priority || right.updatedAt.localeCompare(left.updatedAt));
    return `<section class="column" style="--status:${statusColor(status)}">
      <header class="column-head">
        <div><h3>${label}</h3><small>${hint}</small></div>
        <span class="count">${matching.length}</span>
      </header>
      <div class="cards">
        ${matching.length ? matching.map(renderCard).join('') : '<p class="empty">nothing here</p>'}
      </div>
    </section>`;
  }).join('');
}

function renderCard(item) {
  const owner = item.claimedBy ? `held by ${escapeHtml(item.claimedBy)}` : relativeTime(item.updatedAt);
  const lease = item.claimExpiresAt ? leaseTime(item.claimExpiresAt) : `v${item.version}`;
  return `<article class="card" style="--status:${statusColor(item.status)}">
    <div class="card-top"><span>${escapeHtml(item.kind)} · ${escapeHtml(item.project)}</span><span>p${item.priority}</span></div>
    <h4>${escapeHtml(item.title)}</h4>
    ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}
    ${item.nextAction ? `<p>next · ${escapeHtml(item.nextAction)}</p>` : ''}
    <div class="card-meta"><span>${owner}</span><span>${lease}</span></div>
  </article>`;
}

function normalizeEndpoint(value) {
  return value.trim().replace(/\/+$/, '');
}

function statusColor(status) {
  return ({ ready: 'var(--ready)', active: 'var(--active)', blocked: 'var(--blocked)', done: 'var(--done)' })[status] || 'var(--muted)';
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
