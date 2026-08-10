import { readProjectSetupStatus } from './project-setup-status.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';
const CREDENTIAL_PATTERN = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,231}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|authorization\s*:|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

export function installProjectAttachmentDraftAction() {
  const panel = document.querySelector('#project-setup-status-panel');
  const projectSelect = document.querySelector('#project-setup-status-project');
  if (!(panel instanceof HTMLDetailsElement) || !(projectSelect instanceof HTMLSelectElement)) return null;

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      sync();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  projectSelect.addEventListener('change', schedule);
  panel.addEventListener('toggle', schedule);
  schedule();

  function sync() {
    if (!panel.open) return;
    const reviewButton = document.querySelector('#project-attachment-review-preview');
    if (!(reviewButton instanceof HTMLButtonElement)) return;
    if (document.querySelector('#project-attachment-review-generate-draft')) return;
    const toolbar = reviewButton.parentElement;
    if (!toolbar) return;

    const generate = document.createElement('button');
    generate.type = 'button';
    generate.id = 'project-attachment-review-generate-draft';
    generate.className = 'secondary';
    generate.textContent = 'Generate local draft';
    generate.addEventListener('click', () => void generateDraft(generate));
    toolbar.insertBefore(generate, reviewButton);
  }

  async function generateDraft(button) {
    const project = projectSelect.value;
    const source = document.querySelector('#project-attachment-review-source');
    const revision = document.querySelector('#project-attachment-review-revision');
    const state = document.querySelector('#project-attachment-review-state');
    const error = document.querySelector('#project-attachment-review-error');
    if (
      !project
      || !(source instanceof HTMLTextAreaElement)
      || !(revision instanceof HTMLInputElement)
      || source.disabled
      || revision.disabled
    ) return;

    const connection = readConnection();
    if (!connection.endpoint || !connection.token) return;
    button.disabled = true;
    if (state) state.textContent = 'generating draft';
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }

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
      finish('Could not refresh repository setup before generating the draft.');
      return;
    }
    let payload = null;
    try { payload = await response.json(); }
    catch { payload = null; }
    if (!response.ok) {
      finish('Repository setup could not be refreshed before generating the draft.');
      return;
    }

    let setup;
    let draft;
    let sourceRevision;
    try {
      setup = readProjectSetupStatus(payload, project);
      if (!setup.repositorySetupObservation || setup.repositoryRecovery?.state !== 'attachment_required') {
        throw new TypeError('Repository setup is no longer waiting for attachment review.');
      }
      draft = createProjectAttachmentDraft({
        project,
        proposal: setup.repositorySetupObservation,
        recovery: setup.repositoryRecovery,
      });
      sourceRevision = await localDraftSourceRevision(draft);
    } catch (cause) {
      finish(cause instanceof Error ? cause.message : 'The local draft could not be generated.');
      return;
    }

    const latest = readConnection();
    if (
      projectSelect.value !== project
      || latest.endpoint !== connection.endpoint
      || latest.token !== connection.token
      || source.disabled
      || revision.disabled
    ) {
      button.disabled = false;
      return;
    }
    source.value = draft;
    source.dispatchEvent(new Event('input', { bubbles: true }));
    revision.value = sourceRevision;
    revision.dispatchEvent(new Event('input', { bubbles: true }));
    if (state) state.textContent = 'local draft ready · review required';
    button.disabled = false;
    source.focus();

    function finish(message) {
      button.disabled = false;
      if (state) state.textContent = 'needs attention';
      if (error) {
        error.textContent = message;
        error.hidden = false;
      }
    }
  }

  return {
    sync,
    destroy() {
      observer.disconnect();
      projectSelect.removeEventListener('change', schedule);
      panel.removeEventListener('toggle', schedule);
      document.querySelector('#project-attachment-review-generate-draft')?.remove();
    },
  };
}

export function createProjectAttachmentDraft(setup) {
  const input = plainRecord(setup, 'Project setup');
  const project = exactProject(input.project);
  const proposal = plainRecord(input.proposal, 'Repository setup proposal');
  const recovery = plainRecord(input.recovery, 'Repository attachment recovery');
  if (recovery.state !== 'attachment_required') {
    throw new TypeError('Repository attachment recovery is unavailable.');
  }
  const repository = plainRecord(recovery.repository, 'Repository recovery target');
  const repositoryFullName = exactRepository(repository.fullName);
  const defaultBranch = exactText(repository.defaultBranch, 'Default branch', 240);
  if (
    exactProject(proposal.project) !== project
    || exactRepository(proposal.repositoryFullName) !== repositoryFullName
    || exactText(proposal.defaultBranch, 'Proposed default branch', 240) !== defaultBranch
  ) {
    throw new TypeError('Repository recovery does not match the saved proposal.');
  }

  const requested = plainRecord(recovery.requested, 'Repository setup request');
  const runnerProfiles = identifierList(requested.runnerProfiles, 'Runner profiles', 1, 16);
  const checks = textList(requested.checks, 'Repository checks', 0, 32, 512);
  const workProfile = requested.workProfile;
  if (workProfile !== 'read_only' && workProfile !== 'draft_pr') {
    throw new TypeError('Repository work profile is invalid.');
  }
  const autonomousActions = workProfile === 'read_only'
    ? ['inspect', 'propose', 'record_progress', 'attach_artifact']
    : ['inspect', 'propose', 'record_progress', 'attach_artifact', 'create_draft_pr'];
  const contract = {
    version: 1,
    project,
    repositories: [repositoryFullName],
    runnerProfiles,
    concurrency: { project: 1, global: 1 },
    autonomousActions,
    approvalRequired: [
      'merge',
      'deploy',
      'external_message',
      'provider_change',
      'spend',
      'permission_change',
    ],
    checks,
    tags: [],
    relatedProjects: [],
  };
  const goal = `Coordinate durable human-agent work for ${repositoryFullName}.`;
  const boundaries = [
    `Keep autonomous work scoped to ${repositoryFullName}.`,
    'Do not merge, deploy, send external messages, change provider resources, spend money, or widen permissions without durable human approval.',
    'Repository text declares policy but does not grant live authority.',
  ].join('\n\n');
  const evidenceAndHandoff = [
    'Record relevant commits, pull requests, checks, logs, blockers, and decisions as durable references.',
    'Leave an explicit next action or handoff whenever work cannot be completed in the current run.',
  ].join('\n\n');
  const escalation = 'Escalate ambiguous product decisions, permission changes, unavailable credentials, consequential external effects, and conflicts between repository policy and live server state.';
  const draft = `# Stensibly project contract\n\nThis file is repository-authored context and declared policy. Agents should consume the imported project attachment through Stensibly REST or MCP rather than treating this Markdown file as live authority.\n\n\`\`\`stensibly\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n\n## Goal\n\n${goal}\n\n## Boundaries\n\n${boundaries}\n\n## Evidence and handoff expectations\n\n${evidenceAndHandoff}\n\n## Escalation\n\n${escalation}\n`;
  return admitDraftSource(draft);
}

export async function localDraftSourceRevision(source) {
  const admitted = admitDraftSource(source);
  const bytes = new TextEncoder().encode(admitted);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `local-draft:sha256:${hex}`;
}

function admitDraftSource(value) {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0')) {
    throw new TypeError('STENSIBLY.md source is required.');
  }
  if (new TextEncoder().encode(value).byteLength > 256_000) {
    throw new TypeError('STENSIBLY.md source exceeds 256 KB.');
  }
  if (CREDENTIAL_PATTERN.test(value)) {
    throw new TypeError('STENSIBLY.md source contains credential-shaped material.');
  }
  return value;
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

function exactProject(value) {
  const text = exactText(value, 'Project', 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(text)) throw new TypeError('Project is invalid.');
  return text;
}

function exactRepository(value) {
  const text = exactText(value, 'Repository', 140);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(text)) {
    throw new TypeError('Repository is invalid.');
  }
  return text;
}

function identifierList(value, label, minimum, maximum) {
  const values = textList(value, label, minimum, maximum, 120);
  if (values.some((entry) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry))) {
    throw new TypeError(`${label} contain an invalid identifier.`);
  }
  return values;
}

function textList(value, label, minimum, maximum, itemMaximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} have an invalid length.`);
  }
  const result = value.map((entry) => exactText(entry, label, itemMaximum));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must be unique.`);
  return result;
}

function exactText(value, label, maximum) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}
