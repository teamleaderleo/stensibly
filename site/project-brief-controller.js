import { describeHttpFailure } from './connection.js';
import { formatValidationIssues } from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';
import {
  normalizeBriefProjects,
  readProjectBrief,
  safeBriefArtifactHref,
} from './project-brief.js';

const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const STATUS_ORDER = ['ready', 'active', 'blocked', 'done', 'archived'];
const KIND_ORDER = ['task', 'finding', 'question', 'decision', 'tip', 'handoff', 'note'];

export function installProjectBriefController() {
  const dashboard = document.querySelector('#dashboard');
  const actions = document.querySelector('.dashboard-actions');
  const projectFilter = document.querySelector('#project-filter');
  const refreshBoardButton = document.querySelector('#refresh');
  if (!dashboard || !actions || !(projectFilter instanceof HTMLSelectElement) || !refreshBoardButton) return null;
  if (document.querySelector('#project-brief-button')) return null;

  ensureStyles('stensibly-project-brief-styles', '/project-brief.css');

  const openButton = element('button');
  openButton.id = 'project-brief-button';
  openButton.type = 'button';
  openButton.className = 'secondary';
  openButton.textContent = 'project brief';
  actions.insertBefore(openButton, refreshBoardButton);

  const dialog = element('dialog', 'project-brief-dialog');
  dialog.id = 'project-brief-dialog';
  dialog.setAttribute('aria-labelledby', 'project-brief-title');
  const panel = element('article', 'project-brief-panel');
  const head = element('header', 'project-brief-head');
  const headingCopy = element('div');
  const eyebrow = element('p', 'eyebrow');
  eyebrow.textContent = 'Server-owned project view';
  const title = element('h2');
  title.id = 'project-brief-title';
  title.textContent = 'Project brief';
  headingCopy.append(eyebrow, title);
  const closeButton = element('button');
  closeButton.type = 'button';
  closeButton.textContent = 'close';
  closeButton.setAttribute('aria-label', 'Close project brief');
  head.append(headingCopy, closeButton);

  const toolbar = element('div', 'project-brief-toolbar');
  const projectLabel = element('label');
  projectLabel.textContent = 'Project';
  const projectSelect = element('select');
  projectSelect.id = 'project-brief-project';
  projectSelect.setAttribute('aria-label', 'Project brief project');
  projectLabel.append(projectSelect);
  const toolbarActions = element('div', 'project-brief-toolbar-actions');
  const state = element('span');
  state.id = 'project-brief-state';
  state.setAttribute('role', 'status');
  state.textContent = 'waiting';
  const refreshButton = element('button');
  refreshButton.type = 'button';
  refreshButton.textContent = 'refresh brief';
  toolbarActions.append(state, refreshButton);
  toolbar.append(projectLabel, toolbarActions);

  const error = element('p', 'project-brief-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const body = element('div', 'project-brief-body');
  body.append(emptyBlock('Choose a project to load its brief.', 'project-brief-empty'));
  panel.append(head, toolbar, error, body);
  dialog.append(panel);
  document.body.append(dialog);

  const gate = createRequestGate();
  let currentBrief = null;
  let projectFingerprint = '';
  let opener = null;

  syncProjects();

  openButton.addEventListener('click', () => {
    syncProjects();
    if (!projectSelect.value) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : openButton;
    dialog.showModal();
    closeButton.focus();
    void loadBrief();
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
  refreshButton.addEventListener('click', () => void loadBrief());
  projectSelect.addEventListener('change', () => {
    gate.invalidate();
    currentBrief = currentBrief?.project === projectSelect.value ? currentBrief : null;
    void loadBrief();
  });
  projectFilter.addEventListener('change', () => {
    if (projectFilter.value && [...projectSelect.options].some((option) => option.value === projectFilter.value)) {
      projectSelect.value = projectFilter.value;
      if (dialog.open) {
        gate.invalidate();
        currentBrief = currentBrief?.project === projectFilter.value ? currentBrief : null;
        void loadBrief();
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

  function syncProjects() {
    const projects = normalizeBriefProjects([...projectFilter.options].map((option) => option.value));
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
    openButton.title = projects.length ? 'Open a compact server-owned project brief' : 'No visible project is available';
    if (dialog.open && !desired) {
      dialog.close();
      return;
    }
    if (dialog.open && desired !== previous) {
      gate.invalidate();
      currentBrief = currentBrief?.project === desired ? currentBrief : null;
      queueMicrotask(() => void loadBrief());
    }
  }

  async function loadBrief() {
    const project = projectSelect.value;
    if (!dialog.open || !project) return;
    const connection = readConnection();
    if (!connection.endpoint || !connection.token) {
      showFailure('Connection context is unavailable. Reconnect before loading a project brief.');
      return;
    }

    const requestId = gate.begin();
    refreshButton.disabled = true;
    clearError();
    state.textContent = currentBrief?.project === project ? 'refreshing' : 'loading';
    if (!currentBrief || currentBrief.project !== project) {
      body.replaceChildren(emptyBlock('Loading the server-owned project brief…', 'project-brief-loading'));
    }

    let response;
    try {
      response = await fetch(`${connection.endpoint}/api/v1/projects/${encodeURIComponent(project)}/brief?limit=10`, {
        headers: { authorization: `Bearer ${connection.token}` },
        cache: 'no-store',
      });
    } catch {
      if (!isCurrent(requestId, project)) return;
      showFailure('The project brief request could not reach the API. Check the connection and retry.');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!isCurrent(requestId, project)) return;
    if (!response.ok) {
      const failure = describeHttpFailure(response.status, payload);
      const validation = formatValidationIssues(payload);
      const serverRequestId = safeRequestId(response.headers.get('x-request-id'), connection.token);
      const baseMessage = response.status === 404
        ? 'This project no longer exists or is outside the token project boundary.'
        : failure.message;
      showFailure([baseMessage, validation, serverRequestId ? `Request ID: ${serverRequestId}` : ''].filter(Boolean).join(' '));
      return;
    }

    let brief;
    try {
      brief = readProjectBrief(payload, project);
    } catch (cause) {
      if (!isCurrent(requestId, project)) return;
      showFailure(cause instanceof Error ? cause.message : 'The endpoint returned an incompatible project brief.');
      return;
    }

    currentBrief = brief;
    refreshButton.disabled = false;
    state.textContent = `generated ${formatTimestamp(brief.generatedAt)}`;
    renderBrief(brief);
  }

  function isCurrent(requestId, project) {
    return gate.isCurrent(requestId) && dialog.open && projectSelect.value === project;
  }

  function showFailure(message) {
    refreshButton.disabled = false;
    state.textContent = 'needs attention';
    error.textContent = redactCredentialText(message);
    error.hidden = false;
    if (!currentBrief || currentBrief.project !== projectSelect.value) {
      body.replaceChildren(emptyBlock('No valid project brief is available yet.', 'project-brief-empty'));
    }
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }

  return {
    reset() {
      gate.invalidate();
      currentBrief = null;
      clearError();
      syncProjects();
      if (dialog.open) dialog.close();
    },
    destroy() {
      gate.invalidate();
      projectObserver.disconnect();
      dashboardObserver.disconnect();
      dialog.remove();
      openButton.remove();
    },
  };
}

function renderBrief(brief) {
  const body = document.querySelector('#project-brief-dialog .project-brief-body');
  if (!body) return;
  const fragment = document.createDocumentFragment();
  const summary = element('section', 'project-brief-summary');
  const meta = element('p', 'project-brief-meta');
  meta.textContent = `${brief.project} · ${brief.counts.total} total items · generated ${formatTimestamp(brief.generatedAt)}`;
  const counts = element('div', 'project-brief-counts');
  for (const status of STATUS_ORDER) {
    const card = element('article');
    const label = element('span');
    label.textContent = status;
    const value = element('strong');
    value.textContent = String(brief.counts.byStatus[status]);
    card.append(label, value);
    counts.append(card);
  }
  const kinds = element('div', 'project-brief-kind-counts');
  for (const kind of KIND_ORDER) {
    const value = brief.counts.byKind[kind];
    if (!value) continue;
    const badge = element('span');
    badge.textContent = `${kind} · ${value}`;
    kinds.append(badge);
  }
  summary.append(meta, counts, kinds);
  fragment.append(summary);

  const grid = element('div', 'project-brief-grid');
  grid.append(
    itemSection('Ready work', brief.ready),
    itemSection('Active work', brief.active),
    itemSection('Blocked work', brief.blocked),
    itemSection('Knowledge', brief.knowledge),
    itemSection('Recently completed', brief.recentlyCompleted),
    artifactSection('Recent artifacts', brief.recentArtifacts),
  );
  fragment.append(grid);
  body.replaceChildren(fragment);
}

function itemSection(title, items) {
  const section = sectionBlock(title);
  if (!items.length) {
    section.append(emptyBlock('No items in this section.', 'project-brief-empty'));
    return section;
  }
  const list = element('ul', 'project-brief-list');
  for (const item of items) {
    const row = element('li', 'project-brief-item');
    const heading = element('strong');
    heading.textContent = redactCredentialText(item.title);
    const meta = element('p', 'project-brief-item-meta');
    meta.textContent = `${item.kind} · ${item.status} · priority ${item.priority} · updated ${formatTimestamp(item.updatedAt)}`;
    row.append(heading, meta);
    if (item.summary) row.append(copyLine('Summary', item.summary));
    if (item.nextAction) row.append(copyLine('Next action', item.nextAction));
    if (item.claimedBy) {
      const lease = item.claimExpiresAt ? ` until ${formatTimestamp(item.claimExpiresAt)}` : '';
      row.append(copyLine('Claim', `${item.claimedBy}${lease}`));
    }
    list.append(row);
  }
  section.append(list);
  return section;
}

function artifactSection(title, artifacts) {
  const section = sectionBlock(title);
  if (!artifacts.length) {
    section.append(emptyBlock('No recent artifact references.', 'project-brief-empty'));
    return section;
  }
  const list = element('ul', 'project-brief-list');
  for (const artifact of artifacts) {
    const row = element('li', 'project-brief-artifact');
    const label = element('strong');
    label.textContent = redactCredentialText(artifact.label);
    const item = element('p');
    item.textContent = redactCredentialText(artifact.itemTitle);
    const uri = redactCredentialText(artifact.uri);
    const href = safeBriefArtifactHref(artifact.uri);
    if (href) {
      const link = element('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = uri;
      row.append(label, item, link);
    } else {
      const code = element('code');
      code.textContent = uri;
      row.append(label, item, code);
    }
    const meta = element('p', 'project-brief-artifact-meta');
    meta.textContent = `${artifact.kind} · actor ${artifact.actorId} · ${formatTimestamp(artifact.createdAt)}`;
    row.append(meta);
    list.append(row);
  }
  section.append(list);
  return section;
}

function sectionBlock(title) {
  const section = element('section', 'project-brief-section');
  const heading = element('h3');
  heading.textContent = title;
  section.append(heading);
  return section;
}

function copyLine(label, value) {
  const line = element('p');
  line.textContent = `${label}: ${redactCredentialText(value)}`;
  return line;
}

function emptyBlock(message, className) {
  const block = element('p', className);
  block.textContent = message;
  return block;
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
  return Number.isNaN(date.getTime()) ? redactCredentialText(String(value || 'unknown time')) : date.toLocaleString();
}

function ensureStyles(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

if (typeof document !== 'undefined') installProjectBriefController();
