const PROVIDERS = ['gmail', 'outlook'];
const SEMANTIC_CLASSES = ['handoff', 'review', 'decision', 'incident'];
const LIFECYCLES = ['active', 'waiting', 'resolved'];
const CURRENTNESS = ['current', 'partial', 'stale', 'unknown'];
const COVERAGE = ['continuous', 'unknown'];
const SUBSCRIPTION_HEALTH = ['healthy', 'degraded', 'recovering'];
const STAGE_KINDS = [
  'outbound_reserved',
  'provider_send_accepted',
  'provider_message_identified',
  'mailbox_observed',
  'reconciliation_committed',
  'semantic_admission_linked',
  'disposition_converged',
  'provider_subscription_degraded',
  'provider_subscription_recovered',
];
const HANDLE_PATTERN = /^STN-(HANDOFF|REVIEW|DECISION|INCIDENT):[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4,8}$/;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function readProjectCorrespondence(payload, expectedProject = '') {
  if (!isRecord(payload) || !isRecord(payload.correspondence)) {
    throw new TypeError('The endpoint returned an incompatible project correspondence response.');
  }
  const source = payload.correspondence;
  if (source.version !== 'project-correspondence/v1') {
    throw new TypeError('The endpoint returned an unsupported project correspondence version.');
  }
  const project = requiredString(source.project, 'Project correspondence is missing project.', 120);
  if (!PROJECT_PATTERN.test(project)) throw new TypeError('Project correspondence returned an invalid project slug.');
  if (expectedProject && project !== expectedProject) {
    throw new TypeError('The endpoint returned correspondence for a different project.');
  }
  const asOf = timestamp(source.asOf, 'Project correspondence returned an invalid observation time.');
  if (!Array.isArray(source.rows) || source.rows.length > 50) {
    throw new TypeError('Project correspondence returned an invalid thread list.');
  }
  const completeness = readCompleteness(source.completeness);
  fixedFalse(source.authorizesOperation, 'operation authority');
  fixedFalse(source.authorizesMutation, 'mutation authority');
  fixedFalse(source.grantsAuthority, 'authority grant');
  fixedFalse(source.grantsResponsibility, 'responsibility grant');
  fixedFalse(source.grantsApproval, 'approval grant');
  return {
    version: 'project-correspondence/v1',
    project,
    asOf,
    rows: source.rows.map((row) => readThread(row, project, asOf)),
    completeness,
  };
}

export function normalizeCorrespondenceProjects(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter((value) => value.length <= 120 && PROJECT_PATTERN.test(value) && !credentialShaped(value)))]
    .sort(codeUnitCompare);
}

function readThread(value, expectedProject, asOf) {
  if (!isRecord(value)) throw new TypeError('Project correspondence returned an invalid thread.');
  if (value.version !== 'correspondence-projection/v1') {
    throw new TypeError('Project correspondence returned an unsupported thread version.');
  }
  const project = requiredString(value.project, 'A correspondence thread is missing project.', 120);
  if (project !== expectedProject) throw new TypeError('A correspondence thread escaped the project boundary.');
  const handle = requiredString(value.handle, 'A correspondence thread is missing handle.', 80);
  if (!HANDLE_PATTERN.test(handle)) throw new TypeError('A correspondence thread returned an invalid handle.');
  const newestMaterialAt = timestamp(value.newestMaterialAt, 'A correspondence thread returned an invalid material time.');
  if (Date.parse(newestMaterialAt) > Date.parse(asOf)) {
    throw new TypeError('A correspondence thread material time is after the response observation time.');
  }
  fixedFalse(value.containsRawMailBody, 'raw mail body disclosure');
  fixedFalse(value.containsQuotedMailBody, 'quoted mail disclosure');
  fixedFalse(value.attachmentsAdmitted, 'attachment admission');
  fixedFalse(value.authorizesOperation, 'thread operation authority');
  fixedFalse(value.authorizesMutation, 'thread mutation authority');
  fixedFalse(value.grantsAuthority, 'thread authority grant');
  fixedFalse(value.grantsResponsibility, 'thread responsibility grant');
  fixedFalse(value.grantsApproval, 'thread approval grant');
  return {
    projectionFingerprint: fingerprint(value.projectionFingerprint),
    threadId: identifier(value.threadId, 'thread ID', 240),
    handle,
    title: displayText(value.title, 'thread title', 240),
    semanticClass: enumString(value.semanticClass, SEMANTIC_CLASSES, 'semantic class'),
    lifecycle: enumString(value.lifecycle, LIFECYCLES, 'lifecycle'),
    provider: enumString(value.provider, PROVIDERS, 'provider'),
    newestMaterialAt,
    freshness: readFreshness(value.freshness, asOf),
    attribution: readAttribution(value.attribution),
    materialPreview: readPreview(value.materialPreview),
    stages: readStages(value.stages, asOf),
  };
}

function readFreshness(value, asOf) {
  if (!isRecord(value)) throw new TypeError('A correspondence thread returned invalid freshness.');
  const lastSuccessfulReconciliationAt = value.lastSuccessfulReconciliationAt === null
    ? null
    : timestamp(value.lastSuccessfulReconciliationAt, 'A correspondence thread returned an invalid reconciliation time.');
  if (lastSuccessfulReconciliationAt && Date.parse(lastSuccessfulReconciliationAt) > Date.parse(asOf)) {
    throw new TypeError('A correspondence reconciliation time is after the response observation time.');
  }
  return {
    coverage: enumString(value.coverage, COVERAGE, 'coverage'),
    subscriptionHealth: enumString(value.subscriptionHealth, SUBSCRIPTION_HEALTH, 'subscription health'),
    currentness: enumString(value.currentness, CURRENTNESS, 'currentness'),
    truncated: boolean(value.truncated, 'freshness truncation'),
    lastSuccessfulReconciliationAt,
  };
}

function readAttribution(value) {
  if (!isRecord(value)) throw new TypeError('A correspondence thread returned invalid attribution.');
  return {
    actor: nullableIdentifier(value.actor, 'actor', 160),
    callsign: nullableIdentifier(value.callsign, 'callsign', 160),
    runId: nullableIdentifier(value.runId, 'run ID', 240),
  };
}

function readPreview(value) {
  if (!isRecord(value)) throw new TypeError('A correspondence thread returned an invalid preview.');
  return {
    current: displayText(value.current, 'current summary', 800),
    nextOrResolutionCondition: displayText(
      value.nextOrResolutionCondition,
      'next or resolution condition',
      800,
    ),
  };
}

function readStages(value, asOf) {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError('A correspondence thread returned an invalid stage list.');
  }
  const ids = new Set();
  const rows = value.map((entry) => {
    if (!isRecord(entry)) throw new TypeError('A correspondence thread returned an invalid stage.');
    const stageId = identifier(entry.stageId, 'stage ID', 240);
    if (ids.has(stageId)) throw new TypeError('A correspondence thread returned duplicate stage IDs.');
    ids.add(stageId);
    const happenedAt = timestamp(entry.happenedAt, 'A correspondence stage returned an invalid time.');
    if (Date.parse(happenedAt) > Date.parse(asOf)) {
      throw new TypeError('A correspondence stage time is after the response observation time.');
    }
    return {
      stageId,
      kind: enumString(entry.kind, STAGE_KINDS, 'stage kind'),
      happenedAt,
      evidenceRef: identifier(entry.evidenceRef, 'stage evidence', 512),
      causalPredecessorStageId: nullableIdentifier(entry.causalPredecessorStageId, 'causal predecessor', 240),
    };
  });
  for (const row of rows) {
    if (row.causalPredecessorStageId && !ids.has(row.causalPredecessorStageId)) {
      throw new TypeError('A correspondence stage names a missing causal predecessor.');
    }
  }
  return rows;
}

function readCompleteness(value) {
  if (!isRecord(value)) throw new TypeError('Project correspondence returned invalid completeness.');
  return {
    truncated: boolean(value.truncated, 'project truncation'),
    threadsWithoutProviderProjection: count(value.threadsWithoutProviderProjection, 'threads without provider projection'),
    providerViewsWithoutMailboxState: count(value.providerViewsWithoutMailboxState, 'provider views without mailbox state'),
    rejectedCandidates: count(value.rejectedCandidates, 'rejected candidates'),
  };
}

function fingerprint(value) {
  const output = requiredString(value, 'A correspondence thread returned an invalid fingerprint.', 80);
  if (!SHA256_PATTERN.test(output)) throw new TypeError('A correspondence thread returned an invalid fingerprint.');
  return output;
}

function identifier(value, label, maxLength) {
  const output = requiredString(value, `A correspondence thread returned an invalid ${label}.`, maxLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@+\-=]*$/.test(output)) {
    throw new TypeError(`A correspondence thread returned an invalid ${label}.`);
  }
  return output;
}

function nullableIdentifier(value, label, maxLength) {
  if (value === null) return null;
  return identifier(value, label, maxLength);
}

function displayText(value, label, maxLength) {
  return requiredString(value, `A correspondence thread returned invalid ${label}.`, maxLength);
}

function enumString(value, allowed, label) {
  const output = requiredString(value, `A correspondence thread returned an invalid ${label}.`, 120);
  if (!allowed.includes(output)) throw new TypeError(`A correspondence thread returned an invalid ${label}.`);
  return output;
}

function timestamp(value, message) {
  const output = requiredString(value, message, 120);
  const parsed = Date.parse(output);
  if (Number.isNaN(parsed)) throw new TypeError(message);
  return output;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new TypeError(`Project correspondence returned an invalid ${label} count.`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`Project correspondence returned invalid ${label}.`);
  return value;
}

function fixedFalse(value, label) {
  if (value !== false) throw new TypeError(`Project correspondence returned unexpected ${label}.`);
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
