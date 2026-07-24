const ITEM_KINDS = ['task', 'finding', 'question', 'decision', 'tip', 'handoff', 'note'];
const ITEM_STATUSES = ['ready', 'active', 'blocked', 'done'];
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export function normalizeBoardQuery(value) {
  const query = typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (query.length > 200) throw new TypeError('Board search may contain at most 200 characters.');
  rejectCredential(query);
  return query.toLocaleLowerCase();
}

export function normalizeBoardKind(value) {
  const kind = typeof value === 'string' ? value.trim() : '';
  return ITEM_KINDS.includes(kind) ? kind : '';
}

export function normalizeBoardStatus(value) {
  const status = typeof value === 'string' ? value.trim() : '';
  return ITEM_STATUSES.includes(status) ? status : '';
}

export function normalizeBoardProject(value) {
  const project = typeof value === 'string' ? value.trim() : '';
  if (!project || project.length > 80 || !PROJECT_PATTERN.test(project)) return '';
  rejectCredential(project);
  return project;
}

export function matchesBoardCard(card, filters) {
  if (!isRecord(card) || !isRecord(filters)) return false;
  const kind = normalizeBoardKind(card.kind);
  const status = normalizeBoardStatus(card.status);
  const project = normalizeBoardProject(card.project);
  const query = normalizeBoardQuery(filters.query);
  const selectedKind = normalizeBoardKind(filters.kind);
  const selectedStatus = normalizeBoardStatus(filters.status);
  if (!kind || !status || !project) return false;
  if (selectedKind && kind !== selectedKind) return false;
  if (selectedStatus && status !== selectedStatus) return false;
  if (!query) return true;
  const text = typeof card.text === 'string'
    ? card.text.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase()
    : '';
  rejectCredential(text);
  return text.includes(query);
}

export function boardResultLabel(visible, total, filters) {
  const safeVisible = boundedCount(visible);
  const safeTotal = boundedCount(total);
  const active = isRecord(filters) && Boolean(
    normalizeBoardQuery(filters.query)
    || normalizeBoardKind(filters.kind)
    || normalizeBoardStatus(filters.status)
  );
  if (active) return `${safeVisible} of ${safeTotal} items visible`;
  return `${safeTotal} ${safeTotal === 1 ? 'item' : 'items'} on board`;
}

export function boardEmptyMessage(visible, total, filters) {
  const safeVisible = boundedCount(visible);
  const safeTotal = boundedCount(total);
  if (safeTotal === 0) return 'No items are available in the selected project.';
  const active = isRecord(filters) && Boolean(
    normalizeBoardQuery(filters.query)
    || normalizeBoardKind(filters.kind)
    || normalizeBoardStatus(filters.status)
  );
  if (active && safeVisible === 0) return 'No items match the current board filters.';
  return '';
}

export function boardFilterKinds() {
  return [...ITEM_KINDS];
}

export function boardFilterStatuses() {
  return [...ITEM_STATUSES];
}

function boundedCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
}

function rejectCredential(value) {
  if (/stn\.tok_/i.test(value)) throw new TypeError('Credential-shaped values are not valid board searches.');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
