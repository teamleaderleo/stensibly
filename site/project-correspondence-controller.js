import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';
import {
  normalizeCorrespondenceProjects,
  readProjectCorrespondence,
} from './project-correspondence.js';

const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const CONNECTION_RESET_STATES = ['connecting', 'editing', 'disconnected', 'connection failed'];
const CURRENTNESS_COPY = {
  current: 'current',
  partial: 'partial evidence',
  stale: 'stale evidence',
  unknown: 'freshness unknown',
};

export function installProjectCorrespondenceController() {
  const dashboard = document.querySelector('#dashboard');
  const actions = document.querySelector('.dashboard-secondary-actions')
    || document.querySelector('.dashboard-actions');
  const projectFilter = document.querySelector('#project-filter');
  const refreshBoardButton = document.querySelector('#refresh');
  const connectionState = document.querySelector('#connection-state');
  if (!dashboard || !actions || !(projectFilter instanceof HTMLSelectElement) || !refreshBoardButton) return null;
  if (document.querySelector('#project-correspondence-button')) return null;

  ensureStyles('stensibly-project-correspondence-styles', '/project-correspondence.css');

  const openButton = element('button');
  openButton.id = 'project-correspondence-button';
  openButton.type = 'button';
  openButton.className = 'secondary';
  openButton.textContent = 'correspondence';
  if (refreshBoardButton.parentElement === actions) actions.insertBefore(openButton, refreshBoardButton);
  else actions.append(openButton);

  const dialog = element('dialog', 'project-correspondence-dialog');
  dialog.id = 'project-correspondence-dialog';
  dialog.setAttribute('aria-labelledby', 'project-correspondence-title');
  const panel = element('article', 'project-correspondence-panel');
  const head = element('header', 'project-correspondence-head');
  const headingCopy = element('div');
  const eyebrow = element('p', 'eyebrow');
  eyebrow.textContent = 'Project correspondence';
  const title = element('h2');
  title.id = 'project-correspondence-title';
  title.textContent = 'Recent agent correspondence';
  headingCopy.append(eyebrow, title);
  const closeButton = element('button');
  closeButton.type = 'button';
  closeButton.textContent = 'close';
  closeButton.setAttribute('aria-label', 'Close project correspondence');
  head.append(headingCopy, closeButton);

  const toolbar = element('div', 'project-correspondence-toolbar');
  const projectLabel = element('label');
  projectLabel.textContent = 'Project';
  const projectSelect = element('select');
  projectSelect.id = 'project-correspondence-project';
  projectSelect.setAttribute('aria-label', 'Correspondence project');
  projectLabel.append(projectSelect);
  const toolbarActions = element('div', 'project-correspondence-toolbar-actions');
  const state = element('span');
  state.id = 'project-correspondence-state';
  state.setAttribute('role', 'status');
  state.textContent = 'waiting';
  const refreshButton = element('button');
  refreshButton.type = 'button';
  refreshButton.textContent = 'refresh correspondence';
  toolbarActions.append(state, refreshButton);
  toolbar.append(projectLabel, toolbarActions);

  const error = element('p', 'project-correspondence-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const body = element('div', 'project-correspondence-body');
  body.append(emptyBlock('Choose a project to inspect its recent correspondence.', 'project-correspondence-empty'));
  panel.append(head, toolbar, error, body);
  dialog.append(panel);
  document.body.append(dialog);

  const gate = createRequestGate();
  let currentCorrespondence = null;
  let projectFingerprint = '';
  let opener = null;

  syncProjects();

  openButton.addEventListener('click', () => {
    syncProjects();
    if (!projectSelect.value) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : openButton;
    dialog.showModal();
    closeButton.focus();
    void loadCorrespondence();
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
  refreshButton.addEventListener('click', () => void loadCorrespondence());
  projectSelect.addEventListener('change', () => {
    gate.invalidate();
    currentCorrespondence = currentCorrespondence?.project === projectSelect.value
      ? currentCorrespondence
      : null;
    void loadCorrespondence();
  });
  projectFilter.addEventListener('change', () => {
    if (projectFilter.value && [...projectSelect.options].some((option) => option.value === projectFilter.value)) {
      projectSelect.value = projectFilter.value;
      if (dialog.open) {
        gate.invalidate();
        currentCorrespondence = currentCorrespondence?.project === projectFilter.value
          ? currentCorrespondence
          : null;
        void loadCorrespondence();
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
      currentCorrespondence = null;
      if (dialog.open) dialog.close();
    })
    : null;
  connectionObserver?.observe(connectionState, { childList: true, subtree: true, characterData: true });

  function syncProjects() {
    const projects = normalizeCorrespondenceProjects([...projectFilter.options].map((option) => option.value));
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
      ? 'Open recent Gmail and Outlook correspondence for one project'
      : 'No visible project is available';
    if (dialog.open && !desired) {
      dialog.close();
      return;
    }
    if (dialog.open && desired !== previous) {
      gate.invalidate();
      currentCorrespondence = currentCorrespondence?.project === desired ? currentCorrespondence : null;
      queueMicrotask(() => void loadCorrespondence());
    }
  }

  async function loadCorrespondence() {
    const project = projectSelect.value;
    if (!dialog.open || !project) return;
    const connection = readConnection();
    if (!connection.endpoint || !connection.token) {
      showFailure('Connection context is unavailable. Reconnect before loading correspondence.');
      return;
    }

    const requestId = gate.begin();
    refreshButton.disabled = true;
    clearError();
    state.textContent = currentCorrespondence?.project === project ? 'refreshing' : 'loading';
    if (!currentCorrespondence || currentCorrespondence.project !== project) {
      body.replaceChildren(emptyBlock('Loading recent project correspondence…', 'project-correspondence-loading'));
    }

    let response;
    try {
      response = await fetch(
        `${connection.endpoint}/api/v1/projects/${encodeURIComponent(project)}/correspondence?limit=12`,
        {
          headers: { authorization: `Bearer ${connection.token}` },
          cache: 'no-store',
        },
      );
    } catch {
      if (!isCurrent(requestId, project, connection)) return;
      showFailure('The correspondence request could not reach the API. Check the connection and retry.');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!isCurrent(requestId, project, connection)) return;
    if (!response.ok) {
      const failure = describeHttpFailure(response.status, payload);
      const validation = formatValidationIssues(payload);
      const serverRequestId = safeRequestId(response.headers.get('x-request-id'), connection.token);
      const baseMessage = response.status === 404
        ? 'Correspondence is unavailable on this backend or outside the token project boundary.'
        : failure.message;
      showFailure([baseMessage, validation, serverRequestId ? `Request ID: ${serverRequestId}` : ''].filter(Boolean).join(' '));
      return;
    }

    let correspondence;
    try {
      correspondence = readProjectCorrespondence(payload, project);
    } catch (cause) {
      if (!isCurrent(requestId, project, connection)) return;
      showFailure(cause instanceof Error
        ? cause.message
        : 'The endpoint returned incompatible project correspondence.');
      return;
    }

    currentCorrespondence = correspondence;
    refreshButton.disabled = false;
    state.textContent = `observed ${formatTimestamp(correspondence.asOf)}`;
    renderCorrespondence(correspondence, body);
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
    if (!currentCorrespondence || currentCorrespondence.project !== projectSelect.value) {
      body.replaceChildren(emptyBlock('No valid correspondence view is available yet.', 'project-correspondence-empty'));
    }
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }

  return {
    reset() {
      gate.invalidate();
      currentCorrespondence = null;
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

function renderCorrespondence(correspondence, body) {
  const fragment = document.createDocumentFragment();
  fragment.append(renderCompleteness(correspondence));
  if (!correspondence.rows.length) {
    fragment.append(emptyBlock('No projected correspondence is available for this project yet.', 'project-correspondence-empty'));
    body.replaceChildren(fragment);
    return;
  }

  const list = element('ol', 'project-correspondence-list');
  for (const thread of correspondence.rows) list.append(renderThread(thread));
  fragment.append(list);
  body.replaceChildren(fragment);
}

function renderCompleteness(correspondence) {
  const block = element('section', 'project-correspondence-completeness');
  const { completeness } = correspondence;
  const issues = [];
  if (completeness.truncated) issues.push('recent window is truncated');
  if (completeness.threadsWithoutProviderProjection) {
    issues.push(`${completeness.threadsWithoutProviderProjection} thread${plural(completeness.threadsWithoutProviderProjection)} missing provider projection`);
  }
  if (completeness.providerViewsWithoutMailboxState) {
    issues.push(`${completeness.providerViewsWithoutMailboxState} provider view${plural(completeness.providerViewsWithoutMailboxState)} missing mailbox state`);
  }
  if (completeness.rejectedCandidates) {
    issues.push(`${completeness.rejectedCandidates} candidate${plural(completeness.rejectedCandidates)} rejected during projection`);
  }
  const heading = element('strong');
  heading.textContent = issues.length ? 'Coverage is partial' : 'Coverage accepted';
  const copy = element('p');
  copy.textContent = issues.length
    ? issues.join(' · ')
    : `Up to ${correspondence.rows.length} recent correspondence thread${plural(correspondence.rows.length)} projected from durable evidence.`;
  block.dataset.state = issues.length ? 'partial' : 'complete';
  block.append(heading, copy);
  return block;
}

function renderThread(thread) {
  const row = element('li', 'project-correspondence-thread');
  row.dataset.currentness = thread.freshness.currentness;

  const head = element('header', 'project-correspondence-thread-head');
  const copy = element('div');
  const title = element('strong');
  title.textContent = redactCredentialText(thread.title);
  const handle = element('code');
  handle.textContent = thread.handle;
  copy.append(title, handle);
  const badge = element('span', 'project-correspondence-currentness');
  badge.textContent = CURRENTNESS_COPY[thread.freshness.currentness] || thread.freshness.currentness;
  head.append(copy, badge);

  const meta = element('p', 'project-correspondence-meta');
  meta.textContent = `${thread.provider} · ${thread.semanticClass} · ${thread.lifecycle} · ${formatTimestamp(thread.newestMaterialAt)}`;
  const current = copyLine('Current', thread.materialPreview.current);
  const next = copyLine(
    thread.lifecycle === 'resolved' ? 'Resolution condition' : 'Next / resolution',
    thread.materialPreview.nextOrResolutionCondition,
  );
  row.append(head, meta, current, next);

  const attribution = [thread.attribution.callsign, thread.attribution.actor, thread.attribution.runId]
    .filter(Boolean)
    .join(' · ');
  if (attribution) row.append(copyLine('Attribution', attribution));
  if (
    thread.freshness.coverage !== 'continuous'
    || thread.freshness.subscriptionHealth !== 'healthy'
    || thread.freshness.truncated
  ) {
    row.append(copyLine(
      'Evidence state',
      [
        thread.freshness.coverage,
        thread.freshness.subscriptionHealth,
        thread.freshness.truncated ? 'truncated' : '',
      ].filter(Boolean).join(' · '),
    ));
  }

  row.append(renderStages(thread.stages));
  return row;
}

function renderStages(stages) {
  const details = element('details', 'project-correspondence-stages');
  const summary = element('summary');
  summary.textContent = `${stages.length} evidence stage${plural(stages.length)}`;
  details.append(summary);
  if (!stages.length) {
    details.append(emptyBlock('No bounded stage evidence is available.', 'project-correspondence-empty'));
    return details;
  }
  const list = element('ol');
  for (const stage of stages) {
    const item = element('li');
    const label = element('strong');
    label.textContent = stageLabel(stage.kind);
    const meta = element('span');
    meta.textContent = formatTimestamp(stage.happenedAt);
    const evidence = element('code');
    evidence.textContent = redactCredentialText(stage.evidenceRef);
    item.append(label, meta, evidence);
    if (stage.causalPredecessorStageId) {
      const relation = element('small');
      relation.textContent = `Causal predecessor: ${stage.causalPredecessorStageId}`;
      item.append(relation);
    }
    list.append(item);
  }
  details.append(list);
  return details;
}

function stageLabel(kind) {
  return kind.replaceAll('_', ' ');
}

function copyLine(label, value) {
  const line = element('p');
  const strong = element('strong');
  strong.textContent = `${label}: `;
  line.append(strong, document.createTextNode(redactCredentialText(value)));
  return line;
}

function readConnection() {
  let endpoint = '';
  let token = '';
  try {
    endpoint = localStorage.getItem(ENDPOINT_STORAGE_KEY) || '';
  } catch {
    endpoint = '';
  }
  try {
    token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    token = '';
  }
  return { endpoint, token };
}

function formatTimestamp(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime())
    ? redactCredentialText(String(value || 'unknown time'))
    : date.toLocaleString();
}

function ensureStyles(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

function emptyBlock(message, className) {
  const block = element('p', className);
  block.textContent = message;
  return block;
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

function plural(count) {
  return count === 1 ? '' : 's';
}

if (typeof document !== 'undefined') installProjectCorrespondenceController();
