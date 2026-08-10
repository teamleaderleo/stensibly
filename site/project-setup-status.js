const SETUP_STEPS = [
  'deployment',
  'backend',
  'account',
  'workspace',
  'project',
  'oauth_discovery',
  'mcp_connection',
  'first_read',
  'repository',
  'proofwake',
];
const STEP_SET = new Set(SETUP_STEPS);
const STEP_STATES = new Set(['missing', 'ready', 'degraded', 'deferred']);
const OVERALL_STATES = new Set(['not_configured', 'partially_configured', 'ready', 'degraded']);
const MODES = new Set(['local', 'hosted_preview', 'production']);
const WORK_PROFILES = new Set(['read_only', 'draft_pr']);
const REPOSITORY_SETUP_SOURCES = new Set(['operator_supplied', 'github_conversation_context']);
const REQUIRED_CONTEXT_FIELDS = [
  'repositoryFullName',
  'defaultBranch',
  'runnerProfiles',
  'workProfile',
  'checks',
];
const credentialPattern = /(?:github_pat_|gh[pousr]_|stn\.(?:tok|svc)_|sk-(?:proj-)?|xox[baprs]-|(?:env|secret):\/\/|bearer\s+)/iu;

export function readProjectSetupStatus(payload, expectedProject) {
  const root = record(payload, 'Setup-status response');
  const input = record(root.setupStatus, 'Setup status');
  const project = projectSlug(expectedProject);
  const version = exactInteger(input.version, 'Setup-status version', 1, 1);
  const mode = member(input.mode, MODES, 'Setup mode');
  const state = member(input.state, OVERALL_STATES, 'Setup state');
  const observedAt = timestamp(input.observedAt, 'Setup observation time');
  const serviceOrigin = origin(input.serviceOrigin, mode !== 'local', 'Setup service origin');
  const mcpEndpoint = endpoint(input.mcpEndpoint, serviceOrigin);
  const lastVerifiedStep = optionalStep(input.lastVerifiedStep, 'Last verified setup step');
  const nextStep = optionalStep(input.nextStep, 'Next setup step');
  const requiredReady = exactInteger(input.requiredReady, 'Ready-step count', 0, SETUP_STEPS.length);
  const requiredTotal = exactInteger(input.requiredTotal, 'Required-step count', 0, SETUP_STEPS.length);
  if (requiredReady > requiredTotal) throw new TypeError('Ready-step count exceeds required-step count.');
  const degradedSteps = stepList(input.degradedSteps, 'Degraded setup steps');
  const optionalAttentionSteps = stepList(input.optionalAttentionSteps, 'Optional attention steps');
  const steps = setupStepList(input.steps);
  if (input.containsSecrets !== false) throw new TypeError('Setup status must be secret-free.');

  return Object.freeze({
    version,
    mode,
    state,
    observedAt,
    serviceOrigin,
    mcpEndpoint,
    lastVerifiedStep,
    nextStep,
    requiredReady,
    requiredTotal,
    degradedSteps,
    optionalAttentionSteps,
    steps,
    repositoryRecovery: repositoryRecovery(input.repositoryRecovery, project),
    repositorySetupObservation: repositorySetupObservation(input.repositorySetupObservation, project),
    containsSecrets: false,
  });
}

export function setupStepLabel(step) {
  switch (step) {
    case 'deployment': return 'Deployment';
    case 'backend': return 'Backend';
    case 'account': return 'Account';
    case 'workspace': return 'Workspace';
    case 'project': return 'Project';
    case 'oauth_discovery': return 'OAuth discovery';
    case 'mcp_connection': return 'MCP connection';
    case 'first_read': return 'First verified read';
    case 'repository': return 'Repository';
    case 'proofwake': return 'ProofWake';
    default: throw new TypeError('Unknown setup step.');
  }
}

function repositorySetupObservation(value, project) {
  if (value === null || value === undefined) return null;
  const input = record(value, 'Repository setup observation');
  if (
    input.version !== 1
    || input.authorizesProviderEffect !== false
    || input.containsSecrets !== false
  ) {
    throw new TypeError('Repository setup observation metadata is incompatible.');
  }
  if (projectSlug(input.project) !== project) {
    throw new TypeError('Repository setup observation project does not match the selected project.');
  }
  const id = safeText(input.id, 'Repository setup observation id', 160);
  if (!/^repo_setup_[A-Za-z0-9-]{8,120}$/u.test(id)) {
    throw new TypeError('Repository setup observation id is invalid.');
  }
  const semanticFingerprint = safeText(
    input.semanticFingerprint,
    'Repository setup observation fingerprint',
    71,
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(semanticFingerprint)) {
    throw new TypeError('Repository setup observation fingerprint is invalid.');
  }
  return Object.freeze({
    version: 1,
    id,
    project,
    repositoryFullName: repositoryName(input.repositoryFullName),
    defaultBranch: safeText(input.defaultBranch, 'Default branch', 240),
    sourceKind: member(input.sourceKind, REPOSITORY_SETUP_SOURCES, 'Repository setup source'),
    semanticFingerprint,
    observedAt: timestamp(input.observedAt, 'Repository setup observation time'),
    authorizesProviderEffect: false,
    containsSecrets: false,
  });
}

function repositoryRecovery(value, project) {
  if (value === null) return null;
  const input = record(value, 'Repository recovery');
  if (input.version !== 1) throw new TypeError('Repository recovery version is unsupported.');
  if (input.authorizesProviderEffect !== false || input.containsSecrets !== false) {
    throw new TypeError('Repository recovery must be read-only and secret-free.');
  }

  if (input.state === 'repository_context_required') {
    if (input.nextAction !== 'provide_repository_context') {
      throw new TypeError('Repository context recovery action is invalid.');
    }
    const fields = stringList(input.requiredFields, 'Repository context fields', 5, 5, 80);
    if (fields.some((field, index) => field !== REQUIRED_CONTEXT_FIELDS[index])) {
      throw new TypeError('Repository context fields are incompatible.');
    }
    return Object.freeze({
      version: 1,
      state: 'repository_context_required',
      nextAction: 'provide_repository_context',
      requiredFields: Object.freeze([...fields]),
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
  }

  if (input.state !== 'attachment_required') {
    throw new TypeError('Repository recovery state is unsupported.');
  }
  if (projectSlug(input.project) !== project) {
    throw new TypeError('Repository recovery project does not match the selected project.');
  }
  const repository = record(input.repository, 'Repository recovery target');
  const fullName = repositoryName(repository.fullName);
  const defaultBranch = safeText(repository.defaultBranch, 'Default branch', 240);
  const requested = record(input.requested, 'Requested repository setup');
  const runnerProfiles = identifierList(requested.runnerProfiles, 'Runner profiles', 1, 16);
  const workProfile = member(requested.workProfile, WORK_PROFILES, 'Repository work profile');
  const checks = stringList(requested.checks, 'Repository checks', 0, 32, 512).map((check) =>
    safeText(check, 'Repository check', 512));
  const nextAction = record(input.nextAction, 'Repository setup action');
  if (
    nextAction.kind !== 'review_and_accept_project_attachment'
    || nextAction.requiresAdmin !== true
    || nextAction.acceptAuthorityWidening !== true
  ) {
    throw new TypeError('Repository setup action is incompatible.');
  }
  const verification = record(input.verification, 'Repository verification');
  if (
    verification.repositoryMetadata !== 'get_repo'
    || verification.immutableFileRead !== 'fetch_file'
    || verification.immutableReadRef !== 'exact_commit_sha'
  ) {
    throw new TypeError('Repository verification recipe is incompatible.');
  }
  if (input.sourcePath !== 'STENSIBLY.md') {
    throw new TypeError('Repository setup source path is incompatible.');
  }

  return Object.freeze({
    version: 1,
    state: 'attachment_required',
    project,
    repository: Object.freeze({ fullName, defaultBranch }),
    requested: Object.freeze({
      runnerProfiles: Object.freeze([...runnerProfiles]),
      workProfile,
      checks: Object.freeze([...checks]),
    }),
    sourcePath: 'STENSIBLY.md',
    nextAction: Object.freeze({
      kind: 'review_and_accept_project_attachment',
      requiresAdmin: true,
      acceptAuthorityWidening: true,
    }),
    verification: Object.freeze({
      repositoryMetadata: 'get_repo',
      immutableFileRead: 'fetch_file',
      immutableReadRef: 'exact_commit_sha',
    }),
    authorizesProviderEffect: false,
    containsSecrets: false,
  });
}

function setupStepList(value) {
  if (!Array.isArray(value) || value.length !== SETUP_STEPS.length) {
    throw new TypeError('Setup steps are incomplete.');
  }
  const seen = new Set();
  const result = value.map((entry) => {
    const input = record(entry, 'Setup step');
    const step = member(input.step, STEP_SET, 'Setup step');
    if (seen.has(step)) throw new TypeError('Setup steps must be unique.');
    seen.add(step);
    const state = member(input.state, STEP_STATES, 'Setup step state');
    if (typeof input.required !== 'boolean') throw new TypeError('Setup step requirement is invalid.');
    return Object.freeze({ step, state, required: input.required });
  });
  if (SETUP_STEPS.some((step) => !seen.has(step))) throw new TypeError('Setup steps are incomplete.');
  return Object.freeze(result);
}

function stepList(value, label) {
  const values = stringList(value, label, 0, SETUP_STEPS.length, 40);
  const seen = new Set();
  return Object.freeze(values.map((value) => {
    const step = member(value, STEP_SET, label);
    if (seen.has(step)) throw new TypeError(`${label} must be unique.`);
    seen.add(step);
    return step;
  }));
}

function optionalStep(value, label) {
  return value === null ? null : member(value, STEP_SET, label);
}

function projectSlug(value) {
  const text = safeText(value, 'Project', 80);
  if (!/^[a-z0-9][a-z0-9-_]*$/u.test(text)) throw new TypeError('Project is invalid.');
  return text;
}

function repositoryName(value) {
  const text = safeText(value, 'Repository', 140);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(text)) {
    throw new TypeError('Repository is invalid.');
  }
  return text;
}

function identifierList(value, label, minimum, maximum) {
  const values = stringList(value, label, minimum, maximum, 120);
  if (values.some((entry) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry))) {
    throw new TypeError(`${label} contain an invalid identifier.`);
  }
  return Object.freeze([...new Set(values)]);
}

function stringList(value, label, minimum, maximum, itemMaximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} have an invalid length.`);
  }
  const result = value.map((entry) => safeText(entry, label, itemMaximum));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must be unique.`);
  return result;
}

function safeText(value, label, maximum) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || credentialPattern.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value, label) {
  const text = safeText(value, label, 64);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== text) {
    throw new TypeError(`${label} is invalid.`);
  }
  return text;
}

function origin(value, httpsRequired, label) {
  const text = safeText(value, label, 2048);
  let parsed;
  try { parsed = new URL(text); }
  catch { throw new TypeError(`${label} is invalid.`); }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || (httpsRequired && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) throw new TypeError(`${label} is invalid.`);
  return parsed.origin;
}

function endpoint(value, serviceOrigin) {
  const text = safeText(value, 'MCP endpoint', 2048);
  let parsed;
  try { parsed = new URL(text); }
  catch { throw new TypeError('MCP endpoint is invalid.'); }
  if (
    parsed.origin !== serviceOrigin
    || parsed.pathname !== '/mcp'
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) throw new TypeError('MCP endpoint is invalid.');
  return parsed.toString();
}

function member(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function exactInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}
