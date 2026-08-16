import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';
import { normalizeActivityProjects, readProjectActivity } from './project-activity.js';

const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const CONNECTION_RESET_STATES = ['connecting', 'editing', 'disconnected', 'connection failed'];
const CURRENTNESS_COPY = {
  current: 'current',
  partial: 'partial evidence',
  stale: 'stale evidence',
  unknown: 'freshness unknown',
};

export function installProjectActivityController() {
  const dashboard = document.querySelector('#dashboard');
  const actions = document.querySelector('.dashboard-secondary-actions')
    || document.querySelector('.dashboard-actions');
  const projectFilter = document.querySelector('#project-filter');
  const refreshBoardButton = document.querySelector('#refresh');
  const connectionState = document.querySelector('#connection-state');
  if (!dashboard || !actions || !(projectFilter instanceof HTMLSelectElement) || !refreshBoardButton) return null;
  if (document.querySelector('#project-activity-button')) return null;

  ensureStyles('stensibly-project-activity-styles', '/project-activity.css');

  const openButton = element('button');
  openButton.id = 'project-activity-button';
  openButton.type = 'button';
  openButton.className = 'secondary';
  openButton.textContent = 'project activity';
  if (refreshBoardButton.parentElement === actions) actions.insertBefore(openButton, refreshBoardButton);
  else actions.append(openButton);

  const dialog = element('dialog', 'project-activity-dialog');
  dialog.id = 'project-activity-dialog';
  dialog.setAttribute('aria-labelledby', 'project-activity-title');
  const panel = element('article', 'project-activity-panel');
  const head = element('header', 'project-activity-head');
  const headingCopy = element('div');
  const eyebrow = element('p', 'eyebrow');
  eyebrow.textContent = 'Project activity';
  const title = element('h2');
  title.id = 'project-activity-title';
  title.textContent = 'What happened while you were away';
  headingCopy.append(eyebrow, title);
  const closeButton = element('button');
  closeButton.type = 'button';
  closeButton.textContent = 'close';
  closeButton.setAttribute('aria-label', 'Close Project Activity');
  head.append(headingCopy, closeButton);

  const toolbar = element('div', 'project-activity-toolbar');
  const projectLabel = element('label');
  projectLabel.textContent = 'Project';
  const projectSelect = element('select');
  projectSelect.id = 'project-activity-project';
  projectSelect.setAttribute('aria-label', 'Activity project');
  projectLabel.append(projectSelect);
  const toolbarActions = element('div', 'project-activity-toolbar-actions');
  const state = element('span');
  state.id = 'project-activity-state';
  state.setAttribute('role', 'status');
  state.textContent = 'waiting';
  const refreshButton = element('button');
  refreshButton.type = 'button';
  refreshButton.textContent = 'refresh activity';
  toolbarActions.append(state, refreshButton);
  toolbar.append(projectLabel, toolbarActions);

  const error = element('p', 'project-activity-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const body = element('div', 'project-activity-body');
  body.append(emptyBlock('Choose a project to inspect its recent admitted activity.'));
  panel.append(head, toolbar, error, body);
  dialog.append(panel);
  document.body.append(dialog);

  const gate = createRequestGate();
  let currentActivity = null;
  let projectFingerprint = '';
  let opener = null;

  syncProjects();

  openButton.addEventListener('click', () => {
    syncProjects();
    if (!projectSelect.value) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : openButton;
    dialog.showModal();
    closeButton.focus();
    void loadActivity();
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    gate.invalidate();
    refreshButton.disabled = false;
    state.textContent = 'closed';
    const target = opener;
    opener = null;
    if (target?.isConnected) target.focus();
  });
  refreshButton.addEventListener('click', () => void loadActivity());
  projectSelect.addEventListener('change', () => {
    gate.invalidate();
    currentActivity = currentActivity?.project === projectSelect.value ? currentActivity : null;
    void loadActivity();
  });
  projectFilter.addEventListener('change', () => {
    if (projectFilter.value && [...projectSelect.options].some((option) => option.value === projectFilter.value)) {
      projectSelect.value = projectFilter.value;
      if (dialog.open) {
        gate.invalidate();
        currentActivity = currentActivity?.project === projectFilter.value ? currentActivity : null;
        void loadActivity();
      }
    }
  });

  const projectObserver = new MutationObserver(() => syncProjects());
  projectObserver.observe(projectFilter, { childList: true, subtree: true });
  const dashboardObserver = new MutationObserver(() => {
    syncProjects();
    if (dashboard.hidden && dialog.open) dialog.close();
  });
  dashboardObserver.observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });
  const connectionObserver = connectionState
    ? new MutationObserver(() => {
      const label = connectionState.textContent?.trim() || '';
      if (!CONNECTION_RESET_STATES.includes(label)) return;
      gate.invalidate();
      currentActivity = null;
      if (dialog.open) dialog.close();
    })
    : null;
  connectionObserver?.observe(connectionState, { childList: true, subtree: true, characterData: true });

  function syncProjects() {
    const projects = normalizeActivityProjects([...projectFilter.options].map((option) => option.value));
    const nextFingerprint = projects.join('\u0000');
    const filterDefault = projects.includes(projectFilter.value) ? projectFilter.value : '';
    const previous = projectSelect.value;
    const desired = filterDefault || (projects.includes(previous) ? previous : projects[0] || '');
    if (nextFingerprint !== projectFingerprint) {
      projectFingerprint = nextFingerprint;
      projectSelect.replaceChildren(...projects.map((project) => {
        const option = element('option');
        option.value = project;
        option.textContent = project;
        return option;
      }));
    }
    projectSelect.value = desired;
    openButton.disabled = dashboard.hidden || projects.length === 0;
    openButton.title = projects.length
      ? 'Open recent correspondence and work history for one project'
      : 'No visible project is available';
    if (dialog.open && !desired) {
      dialog.close();
      return;
    }
    if (dialog.open && desired !== previous) {
      gate.invalidate();
      currentActivity = currentActivity?.project === desired ? currentActivity : null;
      queueMicrotask(() => void loadActivity());
    }
  }

  async function loadActivity() {
    const project = projectSelect.value;
    if (!dialog.open || !project) return;
    const connection = readConnection();
    if (!connection.endpoint || !connection.token) {
      showFailure('Connection context is unavailable. Reconnect before loading Project Activity.');
      return;
    }

    const requestId = gate.begin();
    refreshButton.disabled = true;
    clearError();
    state.textContent = currentActivity?.project === project ? 'refreshing' : 'loading';
    if (!currentActivity || currentActivity.project !== project) {
      body.replaceChildren(emptyBlock('Loading recent admitted project activity…', 'project-activity-loading'));
    }

    let response;
    try {
      response = await fetch(
        `${connection.endpoint}/api/v1/projects/${encodeURIComponent(project)}/activity?limit=30`,
        {
          headers: { authorization: `Bearer ${connection.token}` },
          cache: 'no-store',
        },
      );
    } catch {
      if (!isCurrent(requestId, project, connection)) return;
      showFailure('The Project Activity request could not reach the API. Check the connection and retry.');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!isCurrent(requestId, project, connection)) return;
    if (!response.ok) {
      const failure = describeHttpFailure(response.status, payload);
      const validation = formatValidationIssues(payload);
      const serverRequestId = safeRequestId(response.headers.get('x-request-id'), connection.token);
      const baseMessage = response.status === 404
        ? 'Project Activity is unavailable on this backend or outside the token project boundary.'
        : failure.message;
      showFailure([baseMessage, validation, serverRequestId ? `Request ID: ${serverRequestId}` : ''].filter(Boolean).join(' '));
      return;
    }

    let activity;
    try {
      activity = readProjectActivity(payload, project);
    } catch (cause) {
      if (!isCurrent(requestId, project, connection)) return;
      showFailure(cause instanceof Error
        ? cause.message
        : 'The endpoint returned incompatible Project Activity.');
      return;
    }

    currentActivity = activity;
    refreshButton.disabled = false;
    state.textContent = `observed ${formatTimestamp(activity.asOf)}`;
    renderActivity(activity, body);
  }

  function isCurrent(requestId, project, expectedConnection) {
    const connection = readConnection();
    return gate.isCurrent(requestId)
      && dialog.open
      && projectSelect.value === project
      && connection.endpoint === expectedConnection.endpoint
      && connection.token === expectedConnection.token;
  }

  function showFailure(message) {
    refreshButton.disabled = false;
    state.textContent = 'needs attention';
    error.textContent = redactCredentialText(message);
    error.hidden = false;
    if (!currentActivity || currentActivity.project !== projectSelect.value) {
      body.replaceChildren(emptyBlock('No valid Project Activity view is available yet.'));
    }
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }

  return {
    reset() {
      gate.invalidate();
      currentActivity = null;
      clearError();
      syncProjects();
      if (dialog.open) dialog.close();
    },
    destroy() {
      gate.invalidate();
      projectObserver.disconnect();
      dashboardObserver.disconnect();
      connectionObserver?.disconnect();
      dialog.remove();
      openButton.remove();
    },
  };
}

function renderActivity(activity, body) {
  const fragment = document.createDocumentFragment();
  fragment.append(renderCompleteness(activity));
  if (!activity.entries.length) {
    fragment.append(emptyBlock('No admitted project activity is available for this recent window.'));
    body.replaceChildren(fragment);
    return;
  }
  const list = element('ol', 'project-activity-list');
  for (const entry of activity.entries) list.append(renderEntry(entry));
  fragment.append(list);
  body.replaceChildren(fragment);
}

function renderCompleteness(activity) {
  const block = element('section', 'project-activity-completeness');
  const issues = [];
  const { completeness, sourceCompleteness } = activity;
  if (completeness.correspondenceTruncated) issues.push('correspondence source window is truncated');
  if (completeness.orchestratorTruncated) issues.push('work-history source window is truncated');
  if (completeness.omittedEntryCount) {
    issues.push(`${completeness.omittedEntryCount} admitted entr${completeness.omittedEntryCount === 1 ? 'y' : 'ies'} omitted by the view limit`);
  }
  if (sourceCompleteness.correspondence.threadsWithoutProviderProjection) {
    const count = sourceCompleteness.correspondence.threadsWithoutProviderProjection;
    issues.push(`${count} correspondence thread${plural(count)} missing provider projection`);
  }
  if (sourceCompleteness.correspondence.providerViewsWithoutMailboxState) {
    const count = sourceCompleteness.correspondence.providerViewsWithoutMailboxState;
    issues.push(`${count} provider view${plural(count)} missing mailbox state`);
  }
  if (sourceCompleteness.correspondence.rejectedCandidates) {
    const count = sourceCompleteness.correspondence.rejectedCandidates;
    issues.push(`${count} correspondence candidate${plural(count)} rejected during admission`);
  }
  const heading = element('strong');
  heading.textContent = issues.length ? 'Coverage is partial' : 'Coverage accepted';
  const copy = element('p');
  copy.textContent = issues.length
    ? issues.join(' · ')
    : `${activity.entries.length} recent admitted entr${activity.entries.length === 1 ? 'y' : 'ies'} assembled from correspondence and work evidence.`;
  block.dataset.state = issues.length ? 'partial' : 'complete';
  block.append(heading, copy);
  return block;
}

function renderEntry(entry) {
  const row = element('li', 'project-activity-entry');
  row.dataset.source = entry.sourceClass;
  row.dataset.currentness = entry.currentness;
  row.dataset.state = entry.activityState;

  const head = element('header', 'project-activity-entry-head');
  const copy = element('div');
  const title = element('strong');
  title.textContent = humanize(entry.activityClass);
  const source = element('code');
  source.textContent = sourceCopy(entry.sourceClass);
  copy.append(title, source);
  const badge = element('span', 'project-activity-currentness');
  badge.textContent = CURRENTNESS_COPY[entry.currentness] || entry.currentness;
  head.append(copy, badge);

  const meta = element('p', 'project-activity-meta');
  meta.textContent = [
    humanize(entry.activityState),
    entry.provider,
    formatTimestamp(entry.happenedAt),
  ].filter(Boolean).join(' · ');
  row.append(head, meta);

  if (entry.summary) row.append(copyLine('Current', redactCredentialText(entry.summary)));
  if (entry.nextOrResolution) row.append(copyLine('Next / resolution', redactCredentialText(entry.nextOrResolution)));

  const attribution = [entry.callsign, entry.actorId].filter(Boolean).join(' · ');
  if (attribution) row.append(copyLine('Actor', attribution));
  if (entry.workItemId) row.append(codeLine('Work item', entry.workItemId));
  if (entry.attemptId) row.append(codeLine('Attempt', entry.attemptId));
  if (entry.runId) row.append(codeLine('Run', entry.runId));

  const evidence = element('details', 'project-activity-evidence');
  const evidenceSummary = element('summary');
  const evidenceCount = entry.relatedEvidenceIds.length;
  evidenceSummary.textContent = evidenceCount
    ? `Evidence · ${evidenceCount} related`
    : 'Evidence';
  evidence.append(evidenceSummary, codeLine('Source', entry.sourceId));
  if (entry.causalPredecessorSourceId) {
    evidence.append(codeLine('Causal predecessor', entry.causalPredecessorSourceId));
  }
  for (const related of entry.relatedEvidenceIds) evidence.append(codeLine('Related', related));
  row.append(evidence);
  return row;
}

function copyLine(label, value) {
  const line = element('p', 'project-activity-copy');
  const strong = element('strong');
  strong.textContent = `${label}: `;
  line.append(strong, document.createTextNode(value));
  return line;
}

function codeLine(label, value) {
  const line = element('p', 'project-activity-code-line');
  const strong = element('strong');
  strong.textContent = `${label}: `;
  const code = element('code');
  code.textContent = value;
  line.append(strong, code);
  return line;
}

function sourceCopy(sourceClass) {
  return sourceClass === 'correspondence' ? 'correspondence' : 'work history';
}

function humanize(value) {
  return value.replaceAll('_', ' ');
}

function emptyBlock(message, className = 'project-activity-empty') {
  const block = element('p', className);
  block.textContent = message;
  return block;
}

function readConnection() {
  const endpoint = (localStorage.getItem(ENDPOINT_STORAGE_KEY) || '').trim().replace(/\/+$/u, '');
  const token = (localStorage.getItem(TOKEN_STORAGE_KEY) || '').trim();
  return { endpoint, token };
}

function ensureStyles(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

function element(tag, className = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function formatTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

function plural(value) {
  return value === 1 ? '' : 's';
}

if (typeof document !== 'undefined') installProjectActivityController();
