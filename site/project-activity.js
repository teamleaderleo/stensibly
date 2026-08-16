const SOURCE_CLASSES = ['correspondence', 'orchestrator_activity'];
const ACTIVITY_CLASSES = [
  'correspondence_changed',
  'work_started',
  'progress_evidence',
  'provider_effect',
  'verification',
  'blocked',
  'handoff',
  'completed',
  'reconciliation_required',
  'attention_required',
];
const ACTIVITY_STATES = [
  'active',
  'waiting',
  'resolved',
  'observed',
  'in_progress',
  'succeeded',
  'failed',
  'blocked',
  'ambiguous',
  'stale',
  'conflicted',
];
const CURRENTNESS = ['current', 'partial', 'stale', 'unknown'];
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#@+\-=]*$/;
const ENTRY_ID_PATTERN = /^project_activity:[a-f0-9]{64}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function readProjectActivity(payload, expectedProject = '') {
  if (!isRecord(payload) || !isRecord(payload.activity) || !isRecord(payload.sourceCompleteness)) {
    throw new TypeError('The endpoint returned an incompatible Project Activity response.');
  }
  const source = payload.activity;
  if (source.version !== 'project-activity/v1') {
    throw new TypeError('The endpoint returned an unsupported Project Activity version.');
  }
  const project = requiredString(source.project, 'Project Activity is missing project.', 80);
  if (!PROJECT_PATTERN.test(project)) throw new TypeError('Project Activity returned an invalid project slug.');
  if (expectedProject && project !== expectedProject) {
    throw new TypeError('The endpoint returned activity for a different project.');
  }
  const asOf = timestamp(source.asOf, 'Project Activity returned an invalid observation time.');
  const projectionFingerprint = fingerprint(source.projectionFingerprint, 'Project Activity projection fingerprint');
  if (!Array.isArray(source.entries) || source.entries.length > 50) {
    throw new TypeError('Project Activity returned an invalid entry list.');
  }
  const completeness = readCompleteness(source.completeness);
  const sourceCompleteness = readSourceCompleteness(payload.sourceCompleteness);
  if (
    completeness.correspondenceTruncated !== sourceCompleteness.correspondence.truncated
    || completeness.orchestratorTruncated !== sourceCompleteness.orchestrator.truncated
  ) {
    throw new TypeError('Project Activity completeness disagrees with its source envelope.');
  }
  fixedFalse(source.containsPrivateReasoning, 'private reasoning disclosure');
  fixedFalse(source.containsRawProviderBody, 'raw provider body disclosure');
  fixedFalse(source.authorizesOperation, 'operation authority');
  fixedFalse(source.authorizesMutation, 'mutation authority');
  fixedFalse(source.grantsAuthority, 'authority grant');
  fixedFalse(source.grantsResponsibility, 'responsibility grant');
  fixedFalse(source.grantsApproval, 'approval grant');

  const entries = source.entries.map((entry) => readEntry(entry, project, asOf));
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    const previousTime = Date.parse(previous.happenedAt);
    const currentTime = Date.parse(current.happenedAt);
    if (currentTime > previousTime) {
      throw new TypeError('Project Activity entries are not newest first.');
    }
    if (currentTime === previousTime && current.entryId < previous.entryId) {
      throw new TypeError('Project Activity tie ordering is invalid.');
    }
  }
  const entryIds = new Set(entries.map((entry) => entry.entryId));
  if (entryIds.size !== entries.length) throw new TypeError('Project Activity returned duplicate entry IDs.');

  return {
    version: 'project-activity/v1',
    projectionFingerprint,
    project,
    asOf,
    entries,
    completeness,
    sourceCompleteness,
  };
}

export function normalizeActivityProjects(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter((value) => value.length <= 80 && PROJECT_PATTERN.test(value) && !credentialShaped(value)))]
    .sort(codeUnitCompare);
}

function readEntry(value, expectedProject, asOf) {
  if (!isRecord(value)) throw new TypeError('Project Activity returned an invalid entry.');
  const entryFingerprint = fingerprint(value.entryFingerprint, 'Project Activity entry fingerprint');
  const entryId = requiredString(value.entryId, 'Project Activity returned an invalid entry ID.', 96);
  if (!ENTRY_ID_PATTERN.test(entryId) || entryId !== `project_activity:${entryFingerprint.slice('sha256:'.length)}`) {
    throw new TypeError('Project Activity returned an invalid entry identity.');
  }
  const project = requiredString(value.project, 'A Project Activity entry is missing project.', 80);
  if (project !== expectedProject) throw new TypeError('A Project Activity entry escaped the project boundary.');
  const happenedAt = timestamp(value.happenedAt, 'A Project Activity entry returned an invalid time.');
  if (Date.parse(happenedAt) > Date.parse(asOf)) {
    throw new TypeError('A Project Activity entry is after the response observation time.');
  }
  const sourceClass = enumString(value.sourceClass, SOURCE_CLASSES, 'source class');
  const activityClass = enumString(value.activityClass, ACTIVITY_CLASSES, 'activity class');
  const activityState = enumString(value.activityState, ACTIVITY_STATES, 'activity state');
  const currentness = enumString(value.currentness, CURRENTNESS, 'currentness');
  const provider = nullableIdentifier(value.provider, 'provider', 160);
  const summary = nullableDisplay(value.summary, 'summary', 800);
  const nextOrResolution = nullableDisplay(value.nextOrResolution, 'next or resolution', 800);
  const causalPredecessorSourceId = nullableIdentifier(
    value.causalPredecessorSourceId,
    'causal predecessor source ID',
    512,
  );
  const relatedEvidenceIds = identifierArray(value.relatedEvidenceIds, 'related evidence', 64, 512);

  fixedFalse(value.containsPrivateReasoning, 'entry private reasoning disclosure');
  fixedFalse(value.containsRawProviderBody, 'entry raw provider body disclosure');
  fixedFalse(value.authorizesOperation, 'entry operation authority');
  fixedFalse(value.authorizesMutation, 'entry mutation authority');
  fixedFalse(value.grantsAuthority, 'entry authority grant');
  fixedFalse(value.grantsResponsibility, 'entry responsibility grant');
  fixedFalse(value.grantsApproval, 'entry approval grant');

  const entry = {
    entryId,
    entryFingerprint,
    workspace: identifier(value.workspace, 'workspace', 120),
    project,
    sourceClass,
    sourceId: identifier(value.sourceId, 'source ID', 512),
    sourceFingerprint: fingerprint(value.sourceFingerprint, 'source fingerprint'),
    happenedAt,
    activityClass,
    activityState,
    currentness,
    actorId: nullableIdentifier(value.actorId, 'actor ID', 160),
    callsign: nullableIdentifier(value.callsign, 'callsign', 160),
    workItemId: nullableIdentifier(value.workItemId, 'work item ID', 240),
    attemptId: nullableIdentifier(value.attemptId, 'attempt ID', 240),
    runId: nullableIdentifier(value.runId, 'run ID', 240),
    provider,
    summary,
    nextOrResolution,
    causalPredecessorSourceId,
    relatedEvidenceIds,
  };

  if (sourceClass === 'correspondence') {
    if (
      activityClass !== 'correspondence_changed'
      || !['gmail', 'outlook'].includes(provider)
      || summary === null
      || nextOrResolution === null
      || entry.workItemId !== null
      || entry.attemptId !== null
      || causalPredecessorSourceId !== null
    ) {
      throw new TypeError('Project Activity correspondence semantics are incompatible.');
    }
  } else {
    if (
      activityClass === 'correspondence_changed'
      || entry.callsign !== null
      || summary !== null
      || currentness !== (activityState === 'stale' ? 'stale' : 'unknown')
    ) {
      throw new TypeError('Project Activity orchestrator semantics are incompatible.');
    }
  }
  return entry;
}

function readCompleteness(value) {
  if (!isRecord(value)) throw new TypeError('Project Activity returned invalid completeness.');
  return {
    correspondenceTruncated: boolean(value.correspondenceTruncated, 'correspondence truncation'),
    orchestratorTruncated: boolean(value.orchestratorTruncated, 'orchestrator truncation'),
    omittedEntryCount: count(value.omittedEntryCount, 'omitted entries'),
  };
}

function readSourceCompleteness(value) {
  if (!isRecord(value.correspondence) || !isRecord(value.orchestrator)) {
    throw new TypeError('Project Activity returned invalid source completeness.');
  }
  return {
    correspondence: {
      truncated: boolean(value.correspondence.truncated, 'correspondence source truncation'),
      threadsWithoutProviderProjection: count(
        value.correspondence.threadsWithoutProviderProjection,
        'threads without provider projection',
      ),
      providerViewsWithoutMailboxState: count(
        value.correspondence.providerViewsWithoutMailboxState,
        'provider views without mailbox state',
      ),
      rejectedCandidates: count(value.correspondence.rejectedCandidates, 'rejected correspondence candidates'),
    },
    orchestrator: {
      truncated: boolean(value.orchestrator.truncated, 'orchestrator source truncation'),
    },
  };
}

function identifierArray(value, label, maximum, maxLength) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`Project Activity returned invalid ${label}.`);
  }
  const rows = value.map((entry) => identifier(entry, label, maxLength));
  if (new Set(rows).size !== rows.length) throw new TypeError(`Project Activity returned duplicate ${label}.`);
  return rows;
}

function fingerprint(value, label) {
  const output = requiredString(value, `Project Activity returned invalid ${label}.`, 80);
  if (!SHA256_PATTERN.test(output)) throw new TypeError(`Project Activity returned invalid ${label}.`);
  return output;
}

function identifier(value, label, maxLength) {
  const output = requiredString(value, `Project Activity returned invalid ${label}.`, maxLength);
  if (!IDENTIFIER_PATTERN.test(output)) throw new TypeError(`Project Activity returned invalid ${label}.`);
  return output;
}

function nullableIdentifier(value, label, maxLength) {
  if (value === null) return null;
  return identifier(value, label, maxLength);
}

function nullableDisplay(value, label, maxLength) {
  if (value === null) return null;
  return requiredString(value, `Project Activity returned invalid ${label}.`, maxLength);
}

function enumString(value, allowed, label) {
  const output = requiredString(value, `Project Activity returned an invalid ${label}.`, 120);
  if (!allowed.includes(output)) throw new TypeError(`Project Activity returned an invalid ${label}.`);
  return output;
}

function timestamp(value, message) {
  const output = requiredString(value, message, 120);
  const parsed = new Date(output);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== output) throw new TypeError(message);
  return output;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new TypeError(`Project Activity returned an invalid ${label} count.`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`Project Activity returned invalid ${label}.`);
  return value;
}

function fixedFalse(value, label) {
  if (value !== false) throw new TypeError(`Project Activity returned unexpected ${label}.`);
}

function requiredString(value, message, maxLength) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output || output.length > maxLength || credentialShaped(output)) throw new TypeError(message);
  return output;
}

function credentialShaped(value) {
  return /(?:stn\.(?:tok|svc)_|github_pat_|gh[pousr]_|sk-(?:proj-)?|xox[baprs]-|bearer\s+)/i.test(value);
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
