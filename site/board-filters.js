export const BOARD_FILTER_KINDS = [
  'task',
  'finding',
  'question',
  'decision',
  'tip',
  'handoff',
  'note',
];

export const BOARD_FILTER_STATUSES = ['ready', 'active', 'blocked', 'done'];

export function normalizeBoardQuery(value) {
  const query = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (/stn\.tok_/i.test(query)) {
    throw new TypeError('Credential-shaped values are not valid board search terms.');
  }
  if (query.length > 200) {
    throw new TypeError('Board search may contain at most 200 characters.');
  }
  return query.toLocaleLowerCase('en-US');
}

export function normalizeBoardFilter(value, allowed, label) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output) return '';
  if (!Array.isArray(allowed) || !allowed.includes(output)) {
    throw new TypeError(`Choose a supported ${label}.`);
  }
  return output;
}

export function buildBoardSearchText(values) {
  const source = Array.isArray(values) ? values : [];
  return source
    .map((value) => value === null || value === undefined ? '' : String(value).trim())
    .filter((value) => value && !/stn\.tok_/i.test(value))
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US')
    .slice(0, 30_000);
}

export function matchesBoardRecord(record, filters) {
  if (!record || typeof record !== 'object' || !filters || typeof filters !== 'object') return false;
  const kind = typeof record.kind === 'string' ? record.kind : '';
  const status = typeof record.status === 'string' ? record.status : '';
  const search = typeof record.search === 'string' ? record.search : '';
  if (filters.kind && kind !== filters.kind) return false;
  if (filters.status && status !== filters.status) return false;
  if (filters.query && !search.includes(filters.query)) return false;
  return true;
}

export function boardResultLabel(visible, total) {
  if (!Number.isInteger(visible) || visible < 0 || !Number.isInteger(total) || total < 0 || visible > total) {
    throw new TypeError('Board result counts must be valid non-negative integers.');
  }
  return `${visible} of ${total} visible`;
}
