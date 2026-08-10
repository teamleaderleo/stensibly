import { readProjectSetupStatus } from './project-setup-status.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function installProjectAttachmentReviewAction() {
  const panel = document.querySelector('#project-setup-status-panel');
  const projectSelect = document.querySelector('#project-setup-status-project');
  const body = document.querySelector('#project-setup-status-body');
  if (
    !(panel instanceof HTMLDetailsElement)
    || !(projectSelect instanceof HTMLSelectElement)
    || !body
  ) return null;

  let generation = 0;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void sync();
    });
  };
  const invalidate = () => {
    generation += 1;
    document.querySelector('#project-attachment-review-action')?.remove();
  };

  const bodyObserver = new MutationObserver(schedule);
  bodyObserver.observe(body, { childList: true });
  const onProjectChange = () => {
    invalidate();
    schedule();
  };
  const onToggle = () => {
    if (!panel.open) invalidate();
    else schedule();
  };
  projectSelect.addEventListener('change', onProjectChange);
  panel.addEventListener('toggle', onToggle);
  schedule();

  async function sync() {
    if (!panel.open || document.querySelector('#project-attachment-review-action')) return;
    const project = projectSelect.value;
    if (!project) return;
    const connection = readConnection();
    if (!connection.endpoint || !connection.token) return;
    const requestId = ++generation;

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
      return;
    }
    if (requestId !== generation || !panel.open || projectSelect.value !== project) return;
    if (!response.ok) return;

    let payload;
    try { payload = await response.json(); }
    catch { return; }
    let setup;
    try { setup = readProjectSetupStatus(payload, project); }
    catch { return; }
    if (setup.repositoryRecovery?.state !== 'attachment_required') return;

    const latest = readConnection();
    if (latest.endpoint !== connection.endpoint || latest.token !== connection.token) return;
    body.append(createReviewAction({ project, connection, recovery: setup.repositoryRecovery }));
  }

  return {
    sync,
    destroy() {
      generation += 1;
      bodyObserver.disconnect();
      projectSelect.removeEventListener('change', onProjectChange);
      panel.removeEventListener('toggle', onToggle);
      document.querySelector('#project-attachment-review-action')?.remove();
    },
  };
}

function createReviewAction({ project, connection, recovery }) {
  const section = document.createElement('section');
  section.id = 'project-attachment-review-action';
  section.className = 'project-attachment-review-action';

  const heading = document.createElement('h5');
  heading.textContent = 'Review repository attachment';
  const intro = message(
    'Paste the reviewed STENSIBLY.md bytes and their stable source revision. Preview is effect-free; confirmation uses the existing admin attachment action.',
  );
  const sourceLabel = document.createElement('label');
  sourceLabel.textContent = 'Reviewed STENSIBLY.md';
  const source = document.createElement('textarea');
  source.id = 'project-attachment-review-source';
  source.rows = 12;
  source.spellcheck = false;
  source.autocomplete = 'off';
  source.placeholder = 'Paste the exact reviewed STENSIBLY.md contents';
  sourceLabel.append(source);

  const revisionLabel = document.createElement('label');
  revisionLabel.textContent = 'Source revision';
  const revision = document.createElement('input');
  revision.id = 'project-attachment-review-revision';
  revision.type = 'text';
  revision.autocomplete = 'off';
  revision.placeholder = 'Exact commit SHA or stable repository revision';
  revisionLabel.append(revision);

  const toolbar = document.createElement('div');
  toolbar.className = 'project-attachment-review-toolbar';
  const reviewButton = button('Review attachment');
  reviewButton.id = 'project-attachment-review-preview';
  const cancelButton = button('Cancel review', 'secondary');
  cancelButton.id = 'project-attachment-review-cancel';
  const state = document.createElement('span');
  state.id = 'project-attachment-review-state';
  state.setAttribute('role', 'status');
  state.textContent = 'waiting';
  toolbar.append(reviewButton, cancelButton, state);

  const error = document.createElement('p');
  error.className = 'project-setup-status-error';
  error.id = 'project-attachment-review-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const result = document.createElement('div');
  result.id = 'project-attachment-review-result';

  let reviewed = null;
  let requestGeneration = 0;
  const invalidateReview = () => {
    requestGeneration += 1;
    reviewed = null;
    result.replaceChildren();
    error.textContent = '';
    error.hidden = true;
    state.textContent = 'waiting';
  };
  source.addEventListener('input', invalidateReview);
  revision.addEventListener('input', invalidateReview);
  cancelButton.addEventListener('click', () => {
    invalidateReview();
    source.value = '';
    revision.value = '';
    source.focus();
  });
  reviewButton.addEventListener('click', async () => {
    const sourceBytes = source.value;
    const sourceRevision = revision.value.trim();
    revision.value = sourceRevision;
    invalidateReview();
    if (!sourceBytes || !sourceRevision) {
      showError(error, 'Reviewed source and source revision are required.');
      state.textContent = 'needs input';
      return;
    }
    const requestId = ++requestGeneration;
    reviewButton.disabled = true;
    cancelButton.disabled = true;
    state.textContent = 'reviewing';
    let response;
    try {
      response = await apiFetch(
        connection,
        `/api/v1/projects/${encodeURIComponent(project)}/attachment/review`,
        {
          method: 'POST',
          body: JSON.stringify({ source: sourceBytes, sourceRevision }),
        },
      );
    } catch {
      finishButtons();
      showError(error, 'Attachment review could not reach the API.');
      state.textContent = 'needs attention';
      return;
    }
    let payload = null;
    try { payload = await response.json(); }
    catch { payload = null; }
    if (requestId !== requestGeneration) return;
    finishButtons();
    if (!response.ok) {
      showError(error, reviewFailure(response.status));
      state.textContent = 'needs attention';
      return;
    }
    try {
      reviewed = readReview(payload, {
        project,
        repositoryFullName: recovery.repository.fullName,
        defaultBranch: recovery.repository.defaultBranch,
        sourceRevision,
      });
    } catch {
      showError(error, 'The API returned an incompatible attachment review.');
      state.textContent = 'needs attention';
      return;
    }
    error.hidden = true;
    state.textContent = reviewed.exactReplay ? 'reviewed replay' : 'reviewed';
    renderReviewResult({
      container: result,
      review: reviewed,
      project,
      connection,
      recovery,
      source,
      revision,
      onAccepted: () => {
        reviewButton.disabled = true;
        cancelButton.disabled = true;
        source.disabled = true;
        revision.disabled = true;
        state.textContent = 'accepted · verification pending';
      },
    });

    function finishButtons() {
      reviewButton.disabled = false;
      cancelButton.disabled = false;
    }
  });

  section.append(heading, intro, sourceLabel, revisionLabel, toolbar, error, result);
  return section;
}

function renderReviewResult({
  container,
  review,
  project,
  connection,
  recovery,
  source,
  revision,
  onAccepted,
}) {
  const card = document.createElement('div');
  card.className = 'project-attachment-review-result';
  card.append(
    fact('Repository', review.repositoryFullName),
    fact('Default branch', review.defaultBranch),
    fact('Snapshot fingerprint', review.snapshotSha256),
    fact('Source revision', review.sourceRevision),
    fact('Replay', review.exactReplay ? 'Exact accepted replay' : 'New acceptance candidate'),
    fact(
      'Authority acknowledgement',
      review.requiresAuthorityWidening ? 'Required before acceptance' : 'No widening acknowledgement required',
    ),
  );

  const acknowledgement = document.createElement('label');
  acknowledgement.className = 'project-attachment-review-ack';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'project-attachment-review-acknowledge';
  acknowledgement.append(
    checkbox,
    document.createTextNode(' I acknowledge the reviewed attachment widens project authority.'),
  );
  acknowledgement.hidden = !review.requiresAuthorityWidening;

  const acceptButton = button(review.exactReplay ? 'Confirm replay' : 'Accept reviewed attachment');
  acceptButton.id = 'project-attachment-review-accept';
  acceptButton.disabled = review.requiresAuthorityWidening;
  const acceptanceState = document.createElement('p');
  acceptanceState.className = 'project-setup-status-note';
  acceptanceState.textContent = 'Acceptance has not run.';
  checkbox.addEventListener('change', () => {
    acceptButton.disabled = review.requiresAuthorityWidening && !checkbox.checked;
  });
  acceptButton.addEventListener('click', async () => {
    if (source.disabled || revision.disabled) return;
    if (review.requiresAuthorityWidening && !checkbox.checked) return;
    acceptButton.disabled = true;
    checkbox.disabled = true;
    acceptanceState.textContent = 'Accepting the reviewed snapshot…';

    let acceptedResponse;
    try {
      acceptedResponse = await apiFetch(
        connection,
        `/api/v1/projects/${encodeURIComponent(project)}/attachment`,
        {
          method: 'PUT',
          body: JSON.stringify({
            snapshot: review.snapshot,
            sourceRevision: review.sourceRevision,
            acceptAuthorityWidening: review.requiresAuthorityWidening,
          }),
        },
      );
    } catch {
      acceptanceState.textContent = 'Attachment acceptance could not reach the API.';
      acceptButton.disabled = false;
      checkbox.disabled = false;
      return;
    }
    if (!acceptedResponse.ok) {
      acceptanceState.textContent = acceptanceFailure(acceptedResponse.status);
      acceptButton.disabled = false;
      checkbox.disabled = false;
      return;
    }

    let rereadResponse;
    try {
      rereadResponse = await apiFetch(
        connection,
        `/api/v1/projects/${encodeURIComponent(project)}/attachment`,
        { method: 'GET' },
      );
    } catch {
      acceptanceState.textContent = 'Attachment was accepted, but the canonical reread could not reach the API.';
      return;
    }
    let payload = null;
    try { payload = await rereadResponse.json(); }
    catch { payload = null; }
    if (!rereadResponse.ok) {
      acceptanceState.textContent = 'Attachment was accepted, but the canonical reread failed.';
      return;
    }
    try {
      readAcceptedAttachment(payload, {
        project,
        repositoryFullName: recovery.repository.fullName,
        sourceRevision: review.sourceRevision,
        snapshotSha256: review.snapshotSha256,
      });
    } catch {
      acceptanceState.textContent = 'Attachment was accepted, but the canonical reread did not match the reviewed snapshot.';
      return;
    }

    onAccepted();
    acceptanceState.textContent =
      'Accepted snapshot reread successfully. Guarded repository verification remains pending: get_repo, then fetch_file at an exact commit SHA.';
  });

  card.append(acknowledgement, acceptButton, acceptanceState);
  container.replaceChildren(card);
}

function readReview(payload, expected) {
  const root = record(payload);
  const review = record(root.review);
  if (
    review.version !== 1
    || review.project !== expected.project
    || review.repositoryFullName !== expected.repositoryFullName
    || review.defaultBranch !== expected.defaultBranch
    || review.sourceRevision !== expected.sourceRevision
    || typeof review.requiresAuthorityWidening !== 'boolean'
    || typeof review.exactReplay !== 'boolean'
    || review.authorizesAttachmentAcceptance !== false
    || review.authorizesProviderEffect !== false
    || review.containsSecrets !== false
  ) throw new TypeError('review mismatch');
  const snapshot = record(review.snapshot);
  const snapshotSha256 = exactSha(snapshot.snapshotSha256);
  const contract = record(snapshot.contract);
  if (contract.project !== expected.project) throw new TypeError('snapshot project mismatch');
  if (!Array.isArray(contract.repositories) || !contract.repositories.includes(expected.repositoryFullName)) {
    throw new TypeError('snapshot repository mismatch');
  }
  const encoded = JSON.stringify(snapshot);
  if (encoded.length > 524_288) throw new TypeError('snapshot too large');
  return Object.freeze({
    repositoryFullName: review.repositoryFullName,
    defaultBranch: review.defaultBranch,
    sourceRevision: review.sourceRevision,
    requiresAuthorityWidening: review.requiresAuthorityWidening,
    exactReplay: review.exactReplay,
    snapshotSha256,
    snapshot: JSON.parse(encoded),
  });
}

function readAcceptedAttachment(payload, expected) {
  const root = record(payload);
  const attachment = record(root.attachment);
  if (attachment.project !== expected.project || attachment.sourceRevision !== expected.sourceRevision) {
    throw new TypeError('accepted attachment identity mismatch');
  }
  const snapshot = record(attachment.snapshot);
  if (exactSha(snapshot.snapshotSha256) !== expected.snapshotSha256) {
    throw new TypeError('accepted attachment fingerprint mismatch');
  }
  const contract = record(snapshot.contract);
  if (!Array.isArray(contract.repositories) || !contract.repositories.includes(expected.repositoryFullName)) {
    throw new TypeError('accepted attachment repository mismatch');
  }
  return attachment;
}

async function apiFetch(connection, path, init) {
  return window.fetch(`${connection.endpoint}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${connection.token}`,
      ...(init.method === 'POST' || init.method === 'PUT'
        ? { 'content-type': 'application/json' }
        : {}),
    },
    cache: 'no-store',
  });
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
  try { return String(sessionStorage.getItem(TOKEN_STORAGE_KEY) || '').trim(); }
  catch { return ''; }
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

function message(value) {
  const element = document.createElement('p');
  element.className = 'project-setup-status-note';
  element.textContent = value;
  return element;
}

function button(label, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  if (className) element.className = className;
  return element;
}

function showError(element, value) {
  element.textContent = value;
  element.hidden = false;
}

function reviewFailure(status) {
  if (status === 401) return 'Reconnect before reviewing an attachment.';
  if (status === 403) return 'Admin access is required to review this attachment action.';
  if (status === 409) return 'The saved repository proposal is unavailable or stale.';
  if (status === 400) return 'The reviewed source does not match the saved repository proposal.';
  if (status >= 500) return 'The server could not prepare the attachment review.';
  return 'Attachment review failed.';
}

function acceptanceFailure(status) {
  if (status === 401) return 'Reconnect before accepting the attachment.';
  if (status === 403) return 'Admin access is required to accept the attachment.';
  if (status === 409) return 'Acceptance requires a fresh authority-widening acknowledgement.';
  if (status === 400) return 'The reviewed attachment is no longer acceptable.';
  if (status >= 500) return 'The server could not accept the reviewed attachment.';
  return 'Attachment acceptance failed.';
}

function exactSha(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new TypeError('invalid sha');
  return value;
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid record');
  return value;
}
