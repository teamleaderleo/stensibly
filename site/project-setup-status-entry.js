import { readProjectSetupStatus, setupStepLabel } from './project-setup-status.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const RESET_CONNECTION_STATES = new Set(['connecting', 'editing', 'disconnected', 'connection failed']);

export function installProjectSetupStatusCard() {
  const sessionContext = document.querySelector('#session-context-panel');
  const dashboard = document.querySelector('#dashboard');
  const projectFilter = document.querySelector('#project-filter');
  const connectionState = document.querySelector('#connection-state');
  if (!sessionContext || !dashboard || !(projectFilter instanceof HTMLSelectElement)) return null;
  if (document.querySelector('#project-setup-status-panel')) return null;

  installStylesheet();
  sessionContext.insertAdjacentHTML('beforebegin', panelMarkup());

  const panel = document.querySelector('#project-setup-status-panel');
  const projectSelect = document.querySelector('#project-setup-status-project');
  const refreshButton = document.querySelector('#project-setup-status-refresh');
  const status = document.querySelector('#project-setup-status-state');
  const error = document.querySelector('#project-setup-status-error');
  const body = document.querySelector('#project-setup-status-body');
  if (
    !(panel instanceof HTMLDetailsElement)
    || !(projectSelect instanceof HTMLSelectElement)
    || !(refreshButton instanceof HTMLButtonElement)
    || !status
    || !error
    || !body
  ) {
    panel?.remove();
    return null;
  }

  let requestGeneration = 0;
  let projectFingerprint = '';
  syncProjects();

  const onToggle = () => {
    if (panel.open) void refresh();
    else invalidate();
  };
  const onRefresh = () => void refresh();
  const onProjectChange = () => {
    invalidate();
    if (panel.open) void refresh();
  };
  const onFilterChange = () => {
    syncProjects();
    if (panel.open) void refresh();
  };
  panel.addEventListener('toggle', onToggle);
  refreshButton.addEventListener('click', onRefresh);
  projectSelect.addEventListener('change', onProjectChange);
  projectFilter.addEventListener('change', onFilterChange);

  const projectObserver = new MutationObserver(syncProjects);
  projectObserver.observe(projectFilter, { childList: true, subtree: true });
  const dashboardObserver = new MutationObserver(() => {
    syncProjects();
    if (dashboard.hidden) reset();
  });
  dashboardObserver.observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });
  const connectionObserver = connectionState
    ? new MutationObserver(() => {
        const label = connectionState.textContent?.trim().toLowerCase() || '';
        if (RESET_CONNECTION_STATES.has(label)) reset();
      })
    : null;
  connectionObserver?.observe(connectionState, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  async function refresh() {
    const project = projectSelect.value;
    if (!panel.open || !project) return;
    const connection = readConnection();
    if (!connection.endpoint || !connection.token) {
      showFailure('Connect this studio before reading project setup.');
      return;
    }

    const requestId = ++requestGeneration;
    clearFailure();
    refreshButton.disabled = true;
    status.textContent = 'reading';
    body.replaceChildren(messageBlock('Reading server-owned setup status…', 'project-setup-status-loading'));

    let response;
    try {
      response = await window.fetch(
        `${connection.endpoint}/api/v1/projects/${encodeURIComponent(project)}/setup-status`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${connection.token}`,
          },
          cache: 'no-store',
        },
      );
    } catch {
      if (!current(requestId, project, connection)) return;
      showFailure('Setup status could not reach the API. Check the connection and retry.');
      return;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!current(requestId, project, connection)) return;
    if (!response.ok) {
      showFailure(httpFailure(response.status));
      return;
    }

    let setupStatus;
    try {
      setupStatus = readProjectSetupStatus(payload, project);
    } catch {
      showFailure('The API returned an incompatible setup-status response.');
      return;
    }

    refreshButton.disabled = false;
    status.textContent = stateLabel(setupStatus.state);
    renderSetupStatus(body, setupStatus);
  }

  function current(requestId, project, connection) {
    const latest = readConnection();
    return requestId === requestGeneration
      && panel.open
      && projectSelect.value === project
      && latest.endpoint === connection.endpoint
      && latest.token === connection.token;
  }

  function syncProjects() {
    const projects = [...projectFilter.options]
      .map((option) => option.value.trim())
      .filter((value) => /^[a-z0-9][a-z0-9-_]{0,79}$/u.test(value));
    const unique = [...new Set(projects)];
    const nextFingerprint = unique.join('\u0000');
    const previous = projectSelect.value;
    const filtered = unique.includes(projectFilter.value) ? projectFilter.value : '';
    const desired = filtered || (unique.includes(previous) ? previous : unique[0] || '');
    if (nextFingerprint !== projectFingerprint) {
      projectFingerprint = nextFingerprint;
      projectSelect.replaceChildren(...unique.map((project) => {
        const option = document.createElement('option');
        option.value = project;
        option.textContent = project;
        return option;
      }));
    }
    projectSelect.value = desired;
    panel.dataset.available = desired ? 'true' : 'false';
    refreshButton.disabled = !desired;
    if (panel.open && !desired) reset();
  }

  function reset() {
    invalidate();
    clearFailure();
    refreshButton.disabled = !projectSelect.value;
    status.textContent = 'waiting';
    body.replaceChildren(messageBlock('Open this card to read the selected project setup.', 'project-setup-status-empty'));
    if (panel.open) panel.open = false;
  }

  function invalidate() {
    requestGeneration += 1;
  }

  function showFailure(message) {
    refreshButton.disabled = !projectSelect.value;
    status.textContent = 'needs attention';
    error.textContent = message;
    error.hidden = false;
    body.replaceChildren(messageBlock('No compatible setup status is available yet.', 'project-setup-status-empty'));
  }

  function clearFailure() {
    error.textContent = '';
    error.hidden = true;
  }

  return {
    refresh,
    reset,
    destroy() {
      invalidate();
      projectObserver.disconnect();
      dashboardObserver.disconnect();
      connectionObserver?.disconnect();
      panel.removeEventListener('toggle', onToggle);
      refreshButton.removeEventListener('click', onRefresh);
      projectSelect.removeEventListener('change', onProjectChange);
      projectFilter.removeEventListener('change', onFilterChange);
      panel.remove();
    },
  };
}

function renderSetupStatus(container, setup) {
  const fragment = document.createDocumentFragment();
  const summary = document.createElement('section');
  summary.className = 'project-setup-status-summary';
  summary.append(
    fact('Overall', stateLabel(setup.state)),
    fact('Next required', setup.nextStep ? setupStepLabel(setup.nextStep) : 'Required path complete'),
    fact('Last verified', setup.lastVerifiedStep ? setupStepLabel(setup.lastVerifiedStep) : 'None yet'),
    fact('Observed', formatTimestamp(setup.observedAt)),
  );
  fragment.append(summary);

  const steps = document.createElement('ol');
  steps.className = 'project-setup-status-steps';
  for (const entry of setup.steps) {
    const row = document.createElement('li');
    row.dataset.state = entry.state;
    const copy = document.createElement('span');
    copy.textContent = setupStepLabel(entry.step);
    const meta = document.createElement('small');
    meta.textContent = `${entry.required ? 'required' : 'optional'} · ${stateLabel(entry.state)}`;
    row.append(copy, meta);
    steps.append(row);
  }
  fragment.append(steps);
  fragment.append(repositorySection(setup));
  container.replaceChildren(fragment);
}

function repositorySection(setup) {
  const section = document.createElement('section');
  section.className = 'project-setup-status-repository';
  const heading = document.createElement('h4');
  heading.textContent = 'Repository setup';
  section.append(heading);

  const recovery = setup.repositoryRecovery;
  if (!recovery) {
    const repositoryStep = setup.steps.find((entry) => entry.step === 'repository');
    const message = repositoryStep?.state === 'ready'
      ? 'The accepted project attachment is ready for guarded repository work.'
      : repositoryStep?.state === 'deferred'
        ? 'Repository setup is deferred for this project.'
        : 'No repository continuation is currently active.';
    section.append(messageBlock(message, 'project-setup-status-note'));
    return section;
  }

  if (recovery.state === 'repository_context_required') {
    section.append(messageBlock(
      'Repository context is needed before Stensibly can prepare an attachment plan.',
      'project-setup-status-note',
    ));
    const list = document.createElement('ul');
    for (const field of recovery.requiredFields) {
      const item = document.createElement('li');
      item.textContent = contextFieldLabel(field);
      list.append(item);
    }
    section.append(list);
    return section;
  }

  section.append(
    fact('Repository', recovery.repository.fullName),
    fact('Default branch', recovery.repository.defaultBranch),
    fact('Work profile', recovery.requested.workProfile === 'draft_pr' ? 'Draft pull request' : 'Read only'),
    fact('Runner profiles', recovery.requested.runnerProfiles.join(', ')),
  );
  if (recovery.requested.checks.length) {
    const checksHeading = document.createElement('strong');
    checksHeading.textContent = 'Checks';
    const checks = document.createElement('ul');
    for (const check of recovery.requested.checks) {
      const item = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = check;
      item.append(code);
      checks.append(item);
    }
    section.append(checksHeading, checks);
  }
  section.append(
    messageBlock(
      'Next: review STENSIBLY.md and accept the first attachment with admin acknowledgement.',
      'project-setup-status-note',
    ),
    messageBlock(
      'After acceptance, verify guarded repository metadata with get_repo and an immutable fetch_file read at an exact commit SHA.',
      'project-setup-status-note',
    ),
  );
  return section;
}

function fact(label, value) {
  const row = document.createElement('div');
  const key = document.createElement('span');
  key.textContent = label;
  const content = document.createElement('strong');
  content.textContent = value;
  row.append(key, content);
  return row;
}

function messageBlock(message, className) {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = message;
  return element;
}

function contextFieldLabel(field) {
  switch (field) {
    case 'repositoryFullName': return 'Repository';
    case 'defaultBranch': return 'Default branch';
    case 'runnerProfiles': return 'Runner profiles';
    case 'workProfile': return 'Repository work profile';
    case 'checks': return 'Checks';
    default: return 'Repository context';
  }
}

function stateLabel(value) {
  return String(value || '').replaceAll('_', ' ');
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
}

function httpFailure(status) {
  if (status === 401) return 'Sign in or reconnect before reading setup status.';
  if (status === 403) return 'This connection cannot read setup status for the selected project.';
  if (status === 404) return 'Setup status is unavailable on this server or project.';
  if (status === 400) return 'The server rejected this setup-status request.';
  if (status >= 500) return 'The server could not read setup status. Retry after the service recovers.';
  return 'Setup status could not be read.';
}

function readConnection() {
  return { endpoint: storedEndpoint(), token: storedToken() };
}

function storedEndpoint() {
  try {
    const value = String(localStorage.getItem(ENDPOINT_STORAGE_KEY) || DEFAULT_ENDPOINT).trim();
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      ? parsed.origin
      : DEFAULT_ENDPOINT;
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

function storedToken() {
  try {
    return String(sessionStorage.getItem(TOKEN_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function installStylesheet() {
  if (document.querySelector('link[href="/project-setup-status.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/project-setup-status.css';
  document.head.append(link);
}

function panelMarkup() {
  return `<details class="project-setup-status" id="project-setup-status-panel" data-available="false">
    <summary class="project-setup-status-head">
      <div><p class="eyebrow">Onboarding</p><h3>Project setup</h3></div>
      <span id="project-setup-status-state" role="status">waiting</span>
    </summary>
    <div class="project-setup-status-content">
      <div class="project-setup-status-toolbar">
        <label>Project<select id="project-setup-status-project" aria-label="Setup-status project"></select></label>
        <button class="secondary" id="project-setup-status-refresh" type="button">refresh</button>
      </div>
      <p class="project-setup-status-error" id="project-setup-status-error" role="alert" hidden></p>
      <div class="project-setup-status-body" id="project-setup-status-body">
        <p class="project-setup-status-empty">Open this card to read the selected project setup.</p>
      </div>
      <p class="project-setup-status-footnote">Read-only. Attachment acceptance and provider effects stay behind their reviewed server actions.</p>
    </div>
  </details>`;
}
