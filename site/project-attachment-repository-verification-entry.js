import { readProjectSetupStatus } from './project-setup-status.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;

export function installProjectAttachmentRepositoryVerification() {
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
  const observer = new MutationObserver(schedule);
  observer.observe(body, { childList: true, subtree: true, characterData: true });
  const onProjectChange = () => {
    generation += 1;
    schedule();
  };
  const onToggle = () => {
    generation += 1;
    if (panel.open) schedule();
  };
  projectSelect.addEventListener('change', onProjectChange);
  panel.addEventListener('toggle', onToggle);
  schedule();

  async function sync() {
    if (!panel.open) return;
    const state = document.querySelector('#project-attachment-review-state');
    const result = document.querySelector('#project-attachment-review-result');
    if (!(state instanceof HTMLElement) || !(result instanceof HTMLElement)) return;
    if (state.textContent?.trim() !== 'accepted · verification pending') return;
    if (result.querySelector('[data-project-attachment-repository-verification]')) return;

    const project = projectSelect.value;
    const connection = readConnection();
    if (!project || !connection.endpoint || !connection.token) return;
    const requestId = ++generation;
    state.textContent = 'accepted · verifying repository';

    const verificationBox = document.createElement('section');
    verificationBox.dataset.projectAttachmentRepositoryVerification = 'true';
    verificationBox.className = 'project-attachment-repository-verification';
    const copy = document.createElement('p');
    copy.className = 'project-setup-status-note';
    copy.textContent = 'Running guarded get_repo and immutable STENSIBLY.md fetch_file verification…';
    verificationBox.append(copy);
    result.append(verificationBox);

    let setupResponse;
    try {
      setupResponse = await apiFetch(
        connection,
        `/api/v1/projects/${encodeURIComponent(project)}/setup-status`,
        { method: 'GET' },
      );
    } catch {
      if (requestId !== generation) return;
      fail('Setup status could not be reread for repository verification.');
      return;
    }
    let setupPayload = null;
    try { setupPayload = await setupResponse.json(); }
    catch { setupPayload = null; }
    if (requestId !== generation) return;
    if (!setupResponse.ok) {
      fail('Setup status could not be reread for repository verification.');
      return;
    }
    let setup;
    try { setup = readProjectSetupStatus(setupPayload, project); }
    catch {
      fail('Setup status changed incompatibly before repository verification.');
      return;
    }
    const proposal = setup.repositorySetupObservation;
    if (!proposal) {
      fail('The saved repository proposal is unavailable. Refresh setup status before verification.');
      return;
    }

    let response;
    try {
      response = await apiFetch(
        connection,
        `/api/v1/projects/${encodeURIComponent(project)}/attachment/verify-repository`,
        {
          method: 'POST',
          body: JSON.stringify({
            repositoryFullName: proposal.repositoryFullName,
            expectedDefaultBranch: proposal.defaultBranch,
          }),
        },
      );
    } catch {
      if (requestId !== generation) return;
      fail('Guarded repository verification could not reach the API.');
      return;
    }
    let payload = null;
    try { payload = await response.json(); }
    catch { payload = null; }
    if (requestId !== generation) return;
    if (!response.ok) {
      fail(repositoryVerificationFailure(response.status));
      return;
    }

    let verification;
    try {
      verification = readRepositoryVerification(payload, {
        project,
        repositoryFullName: proposal.repositoryFullName,
        defaultBranch: proposal.defaultBranch,
      });
    } catch {
      fail('The repository verification response did not match the accepted project context.');
      return;
    }
    state.textContent = 'accepted · repository verified';
    verificationBox.replaceChildren(
      fact('Repository verification', 'verified'),
      fact('Repository', verification.repositoryFullName),
      fact('Default branch', verification.defaultBranch),
      fact('Source path', verification.sourcePath),
      fact('Immutable commit', verification.commitSha),
      fact('Source fingerprint', verification.sourceContentSha256),
      message('Guarded get_repo and immutable fetch_file matched the accepted STENSIBLY.md source. Repository onboarding is verified.'),
    );

    function fail(messageText) {
      state.textContent = 'accepted · verification incomplete';
      const note = document.createElement('p');
      note.className = 'project-setup-status-error';
      note.textContent = messageText;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'secondary';
      retry.textContent = 'retry repository verification';
      retry.addEventListener('click', () => {
        verificationBox.remove();
        state.textContent = 'accepted · verification pending';
        schedule();
      }, { once: true });
      verificationBox.replaceChildren(note, retry);
    }
  }

  return {
    sync,
    destroy() {
      generation += 1;
      observer.disconnect();
      projectSelect.removeEventListener('change', onProjectChange);
      panel.removeEventListener('toggle', onToggle);
    },
  };
}

export function readRepositoryVerification(payload, expected) {
  const root = record(payload);
  const verification = record(root.verification);
  const attachment = record(verification.attachment);
  const steps = record(verification.steps);
  if (
    verification.version !== 1
    || verification.project !== expected.project
    || verification.repositoryFullName !== expected.repositoryFullName
    || verification.defaultBranch !== expected.defaultBranch
    || verification.verified !== true
    || verification.authorizesMutation !== false
    || verification.containsSecrets !== false
    || steps.repositoryMetadata !== 'get_repo'
    || steps.immutableFileRead !== 'fetch_file'
    || steps.immutableReadRef !== 'exact_commit_sha'
  ) throw new TypeError('repository verification mismatch');
  const sourcePath = exactSourcePath(verification.sourcePath);
  if (
    !sourcePath
    || typeof verification.commitSha !== 'string'
    || !COMMIT_SHA_PATTERN.test(verification.commitSha)
    || typeof verification.sourceContentSha256 !== 'string'
    || !SHA256_PATTERN.test(verification.sourceContentSha256)
    || typeof attachment.id !== 'string'
    || attachment.id.length < 1
    || typeof attachment.snapshotSha256 !== 'string'
    || !SHA256_PATTERN.test(attachment.snapshotSha256)
  ) throw new TypeError('repository verification identity mismatch');
  return Object.freeze({
    repositoryFullName: verification.repositoryFullName,
    defaultBranch: verification.defaultBranch,
    sourcePath,
    commitSha: verification.commitSha,
    sourceContentSha256: verification.sourceContentSha256,
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshotSha256,
  });
}

async function apiFetch(connection, path, init) {
  return window.fetch(`${connection.endpoint}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${connection.token}`,
      ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    cache: 'no-store',
  });
}

function repositoryVerificationFailure(status) {
  if (status === 401) return 'Reconnect before repository verification.';
  if (status === 403) return 'Admin access is required for repository verification.';
  if (status === 409) return 'The live repository or accepted STENSIBLY.md no longer matches the reviewed onboarding decision.';
  if (status === 501) return 'Guarded repository verification is unavailable on this server.';
  if (status >= 500) return 'Guarded repository verification could not prove the accepted attachment.';
  return 'Repository verification failed.';
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

function exactSourcePath(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 4096
    || value !== value.trim()
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return null;
  const segments = value.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
    || segments.at(-1) !== 'STENSIBLY.md'
  ) return null;
  return value;
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid record');
  return value;
}
