const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const credentialPattern = /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,231}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|authorization\s*:|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

export function createRepositoryAttachmentDraft(setup) {
  const input = record(setup, 'Project setup');
  const project = projectSlug(input.project);
  const proposal = record(input.proposal, 'Repository setup proposal');
  const recovery = record(input.recovery, 'Repository attachment recovery');
  if (recovery.state !== 'attachment_required') {
    throw new TypeError('Repository attachment recovery is unavailable.');
  }
  const repository = record(recovery.repository, 'Repository recovery target');
  const repositoryFullName = repositoryName(repository.fullName);
  const defaultBranch = exactText(repository.defaultBranch, 'Default branch', 240);
  if (
    projectSlug(proposal.project) !== project
    || repositoryName(proposal.repositoryFullName) !== repositoryFullName
    || exactText(proposal.defaultBranch, 'Proposed default branch', 240) !== defaultBranch
  ) {
    throw new TypeError('Repository recovery does not match the saved proposal.');
  }
  const requested = record(recovery.requested, 'Repository setup request');
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
  return `# Stensibly project contract\n\nThis file is repository-authored context and declared policy. Agents should consume the imported project attachment through Stensibly REST or MCP rather than treating this Markdown file as live authority.\n\n\`\`\`stensibly\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n\n## Goal\n\n${goal}\n\n## Boundaries\n\n${boundaries}\n\n## Evidence and handoff expectations\n\n${evidenceAndHandoff}\n\n## Escalation\n\n${escalation}\n`;
}

export async function localDraftSourceRevision(source) {
  const admitted = reviewSource(source);
  const bytes = new TextEncoder().encode(admitted);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `local-draft:sha256:${hex}`;
}

export function reviewSource(value) {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0')) {
    throw new TypeError('STENSIBLY.md source is required.');
  }
  if (new TextEncoder().encode(value).byteLength > 256_000) {
    throw new TypeError('STENSIBLY.md source exceeds 256 KB.');
  }
  if (credentialPattern.test(value)) {
    throw new TypeError('STENSIBLY.md source contains credential-shaped material.');
  }
  return value;
}

export function reviewSourceRevision(value) {
  return exactText(value, 'STENSIBLY.md source revision', 240);
}

export function readProjectAttachmentReview(payload, expected) {
  const root = record(payload, 'Attachment review response');
  const input = record(root.review, 'Attachment review');
  const context = reviewExpectation(expected);
  if (
    input.version !== 1
    || input.authorizesAttachmentAcceptance !== false
    || input.authorizesProviderEffect !== false
    || input.containsSecrets !== false
  ) {
    throw new TypeError('Attachment review metadata is incompatible.');
  }
  const project = projectSlug(input.project);
  const proposalId = exactText(input.proposalId, 'Repository setup proposal id', 160);
  const proposalSemanticFingerprint = hash(input.proposalSemanticFingerprint, 'Repository setup proposal fingerprint');
  const repositoryFullName = repositoryName(input.repositoryFullName);
  const defaultBranch = exactText(input.defaultBranch, 'Default branch', 240);
  const sourceRevision = reviewSourceRevision(input.sourceRevision);
  if (
    project !== context.project
    || proposalId !== context.proposalId
    || proposalSemanticFingerprint !== context.proposalSemanticFingerprint
    || repositoryFullName !== context.repositoryFullName
    || defaultBranch !== context.defaultBranch
    || sourceRevision !== context.sourceRevision
  ) {
    throw new TypeError('Attachment review does not match the current owner action.');
  }
  const snapshot = attachmentSnapshot(input.snapshot, context);
  const exactReplay = boolean(input.exactReplay, 'Exact replay');
  const requiresAuthorityWidening = boolean(
    input.requiresAuthorityWidening,
    'Authority widening requirement',
  );
  const diff = attachmentDiff(input.diff);
  if (exactReplay && (requiresAuthorityWidening || diff !== null)) {
    throw new TypeError('Attachment replay metadata is incompatible.');
  }
  if (diff?.widensAuthority === true && !requiresAuthorityWidening) {
    throw new TypeError('Attachment widening metadata is incompatible.');
  }
  return deepFreeze({
    version: 1,
    project,
    proposalId,
    proposalSemanticFingerprint,
    repositoryFullName,
    defaultBranch,
    sourceRevision,
    snapshot,
    diff,
    requiresAuthorityWidening,
    exactReplay,
    authorizesAttachmentAcceptance: false,
    authorizesProviderEffect: false,
    containsSecrets: false,
  });
}

export function readProjectAttachmentAcceptance(payload, review) {
  const root = record(payload, 'Attachment acceptance response');
  const accepted = acceptedAttachment(root.attachment, review);
  const replayed = boolean(root.replayed, 'Attachment replay result');
  return deepFreeze({ attachment: accepted, replayed });
}

export function readAcceptedProjectAttachment(payload, review) {
  const root = record(payload, 'Accepted attachment response');
  return acceptedAttachment(root.attachment, review);
}

function acceptedAttachment(value, review) {
  const expected = record(review, 'Reviewed attachment');
  const input = record(value, 'Accepted project attachment');
  const id = exactText(input.id, 'Accepted attachment id', 200);
  const project = projectSlug(input.project);
  const sourceRevision = reviewSourceRevision(input.sourceRevision);
  const snapshot = record(input.snapshot, 'Accepted attachment snapshot');
  const snapshotSha256 = hash(snapshot.snapshotSha256, 'Accepted snapshot fingerprint');
  if (
    project !== expected.project
    || sourceRevision !== expected.sourceRevision
    || snapshotSha256 !== expected.snapshot.snapshotSha256
  ) {
    throw new TypeError('Accepted attachment does not match the reviewed snapshot.');
  }
  return deepFreeze({ id, project, sourceRevision, snapshotSha256 });
}

function attachmentSnapshot(value, expected) {
  const input = record(value, 'Attachment snapshot');
  if (input.format !== 'stensibly.project-attachment' || input.schemaVersion !== 1) {
    throw new TypeError('Attachment snapshot metadata is incompatible.');
  }
  const contract = record(input.contract, 'Attachment contract');
  if (projectSlug(contract.project) !== expected.project) {
    throw new TypeError('Attachment snapshot project does not match the owner action.');
  }
  const repositories = textList(contract.repositories, 'Attachment repositories', 1, 32, 512)
    .map(repositoryName);
  if (!repositories.includes(expected.repositoryFullName)) {
    throw new TypeError('Attachment snapshot omits the reviewed repository.');
  }
  const source = record(input.source, 'Attachment source');
  if (source.path !== 'STENSIBLY.md') {
    throw new TypeError('Attachment source path is incompatible.');
  }
  hash(source.contentSha256, 'Attachment source fingerprint');
  const snapshotSha256 = hash(input.snapshotSha256, 'Attachment snapshot fingerprint');
  const serialized = JSON.stringify(input);
  if (credentialPattern.test(serialized)) {
    throw new TypeError('Attachment snapshot contains credential-shaped material.');
  }
  return deepFreeze(input);
}

function attachmentDiff(value) {
  if (value === null) return null;
  const input = record(value, 'Attachment diff');
  const from = hash(input.from, 'Attachment diff source fingerprint');
  const to = hash(input.to, 'Attachment diff target fingerprint');
  const widensAuthority = boolean(input.widensAuthority, 'Attachment diff widening result');
  if (!Array.isArray(input.changes) || input.changes.length > 256) {
    throw new TypeError('Attachment diff changes are invalid.');
  }
  if (credentialPattern.test(JSON.stringify(input))) {
    throw new TypeError('Attachment diff contains credential-shaped material.');
  }
  const changes = input.changes.map((value) => {
    const change = record(value, 'Attachment change');
    const field = exactText(change.field, 'Attachment change field', 240);
    const kind = member(change.kind, new Set(['added', 'removed', 'changed']), 'Attachment change kind');
    const authorityEffect = member(
      change.authorityEffect,
      new Set(['widens', 'narrows', 'neutral']),
      'Attachment authority effect',
    );
    return deepFreeze({ field, kind, authorityEffect });
  });
  return deepFreeze({ from, to, widensAuthority, changes });
}

function reviewExpectation(value) {
  const input = record(value, 'Attachment review expectation');
  return deepFreeze({
    project: projectSlug(input.project),
    proposalId: exactText(input.proposalId, 'Repository setup proposal id', 160),
    proposalSemanticFingerprint: hash(
      input.proposalSemanticFingerprint,
      'Repository setup proposal fingerprint',
    ),
    repositoryFullName: repositoryName(input.repositoryFullName),
    defaultBranch: exactText(input.defaultBranch, 'Default branch', 240),
    sourceRevision: reviewSourceRevision(input.sourceRevision),
  });
}

function projectSlug(value) {
  const text = exactText(value, 'Project', 80);
  if (!/^[a-z0-9][a-z0-9-_]*$/u.test(text)) throw new TypeError('Project is invalid.');
  return text;
}

function repositoryName(value) {
  const text = exactText(value, 'Repository', 512);
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

function hash(value, label) {
  const text = exactText(value, label, 71);
  if (!hashPattern.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
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

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} is invalid.`);
  return value;
}

function member(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
