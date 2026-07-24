const ITEM_STATUSES = ['ready', 'active', 'blocked', 'done', 'archived'];
const ITEM_KINDS = ['task', 'finding', 'question', 'decision', 'tip', 'handoff', 'note'];
const ARTIFACT_KINDS = ['file', 'url', 'commit', 'issue', 'document', 'image', 'log', 'dataset', 'other'];
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export function readProjectBrief(payload, expectedProject = '') {
  if (!isRecord(payload) || !isRecord(payload.brief)) {
    throw new TypeError('The endpoint returned an incompatible project brief response.');
  }
  const brief = payload.brief;
  const project = requiredString(brief.project, 'The project brief is missing project.', 80);
  if (!PROJECT_PATTERN.test(project)) throw new TypeError('The project brief returned an invalid project slug.');
  if (expectedProject && project !== expectedProject) {
    throw new TypeError('The endpoint returned a different project brief.');
  }
  const generatedAt = timestamp(brief.generatedAt, 'The project brief returned an invalid generated time.');
  const counts = readCounts(brief.counts);
  return {
    project,
    generatedAt,
    counts,
    ready: readItems(brief.ready, 'ready'),
    active: readItems(brief.active, 'active'),
    blocked: readItems(brief.blocked, 'blocked'),
    knowledge: readItems(brief.knowledge),
    recentlyCompleted: readItems(brief.recentlyCompleted, 'done'),
    recentArtifacts: readArtifacts(brief.recentArtifacts),
  };
}

export function normalizeBriefProjects(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter((value) => PROJECT_PATTERN.test(value) && value.length <= 80 && !/stn\.tok_/i.test(value)))]
    .sort((left, right) => left.localeCompare(right));
}

export function safeBriefArtifactHref(value) {
  const uri = typeof value === 'string' ? value.trim() : '';
  if (!uri || /stn\.tok_/i.test(uri)) return '';
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password) return '';
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function readCounts(value) {
  if (!isRecord(value) || !isRecord(value.byStatus) || !isRecord(value.byKind)) {
    throw new TypeError('The project brief returned invalid counts.');
  }
  const total = count(value.total, 'total');
  const byStatus = Object.fromEntries(ITEM_STATUSES.map((status) => [status, count(value.byStatus[status], status)]));
  const byKind = Object.fromEntries(ITEM_KINDS.map((kind) => [kind, count(value.byKind[kind], kind)]));
  if (sumCounts(byStatus) !== total || sumCounts(byKind) !== total) {
    throw new TypeError('The project brief returned contradictory counts.');
  }
  return { total, byStatus, byKind };
}

function readItems(value, expectedStatus = '') {
  if (!Array.isArray(value)) throw new TypeError('The project brief returned an invalid item list.');
  if (value.length > 100) throw new TypeError('The project brief returned too many items.');
  return value.map((item) => readItem(item, expectedStatus));
}

function readItem(value, expectedStatus) {
  if (!isRecord(value)) throw new TypeError('The project brief returned an invalid item.');
  const id = requiredString(value.id, 'A project brief item is missing id.', 240);
  const kind = enumString(value.kind, ITEM_KINDS, 'item kind');
  const title = requiredString(value.title, 'A project brief item is missing title.', 240);
  const status = enumString(value.status, ITEM_STATUSES, 'item status');
  if (expectedStatus && status !== expectedStatus) {
    throw new TypeError(`The project brief returned an item outside the ${expectedStatus} section.`);
  }
  const priority = integer(value.priority, 0, 100, 'item priority');
  const summary = nullableString(value.summary, 10_000, 'item summary');
  const nextAction = nullableString(value.nextAction, 2_000, 'item next action');
  const claimedBy = nullableString(value.claimedBy, 120, 'item claimant');
  const claimExpiresAt = nullableTimestamp(value.claimExpiresAt, 'item lease expiry');
  const updatedAt = timestamp(value.updatedAt, 'A project brief item returned an invalid updated time.');
  return { id, kind, title, status, priority, summary, nextAction, claimedBy, claimExpiresAt, updatedAt };
}

function readArtifacts(value) {
  if (!Array.isArray(value)) throw new TypeError('The project brief returned an invalid artifact list.');
  if (value.length > 100) throw new TypeError('The project brief returned too many artifacts.');
  return value.map((artifact) => {
    if (!isRecord(artifact)) throw new TypeError('The project brief returned an invalid artifact.');
    return {
      id: requiredString(artifact.id, 'A project brief artifact is missing id.', 240),
      itemId: requiredString(artifact.itemId, 'A project brief artifact is missing item id.', 240),
      itemTitle: requiredString(artifact.itemTitle, 'A project brief artifact is missing item title.', 240),
      actorId: requiredString(artifact.actorId, 'A project brief artifact is missing actor id.', 120),
      kind: enumString(artifact.kind, ARTIFACT_KINDS, 'artifact kind'),
      label: requiredString(artifact.label, 'A project brief artifact is missing label.', 240),
      uri: requiredString(artifact.uri, 'A project brief artifact is missing URI.', 4_096),
      createdAt: timestamp(artifact.createdAt, 'A project brief artifact returned an invalid created time.'),
    };
  });
}

function sumCounts(value) {
  return Object.values(value).reduce((total, entry) => total + entry, 0);
}

function count(value, label) {
  return integer(value, 0, 1_000_000, `${label} count`);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`The project brief returned an invalid ${label}.`);
  }
  return value;
}

function enumString(value, allowed, label) {
  const output = requiredString(value, `The project brief returned an invalid ${label}.`, 120);
  if (!allowed.includes(output)) throw new TypeError(`The project brief returned an invalid ${label}.`);
  return output;
}

function nullableString(value, maxLength, label) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`The project brief returned an invalid ${label}.`);
  const output = value.trim();
  rejectCredential(output);
  if (output.length > maxLength) throw new TypeError(`The project brief returned an invalid ${label}.`);
  return output || null;
}

function nullableTimestamp(value, label) {
  if (value === null) return null;
  return timestamp(value, `The project brief returned an invalid ${label}.`);
}

function timestamp(value, message) {
  const output = requiredString(value, message, 120);
  if (Number.isNaN(Date.parse(output))) throw new TypeError(message);
  return output;
}

function requiredString(value, message, maxLength) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output) throw new TypeError(message);
  rejectCredential(output);
  if (output.length > maxLength) throw new TypeError(message);
  return output;
}

function rejectCredential(value) {
  if (/stn\.tok_/i.test(value)) throw new TypeError('Credential-shaped values are not valid project brief fields.');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
