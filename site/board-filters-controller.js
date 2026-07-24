import {
  BOARD_FILTER_KINDS,
  BOARD_FILTER_STATUSES,
  boardResultLabel,
  buildBoardSearchText,
  matchesBoardRecord,
  normalizeBoardFilter,
  normalizeBoardQuery,
} from './board-filters.js';

const PROJECT_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export function installBoardFilterController() {
  const dashboard = document.querySelector('#dashboard');
  const dashboardHead = document.querySelector('.dashboard-head');
  const projectFilter = document.querySelector('#project-filter');
  const board = document.querySelector('#board');
  if (!dashboard || !dashboardHead || !projectFilter || !board) return null;
  if (document.querySelector('#board-filter-panel')) return null;

  ensureStyles('stensibly-board-filter-styles', '/board-filters.css');

  const panel = element('section', 'board-filter-panel');
  panel.id = 'board-filter-panel';
  panel.setAttribute('aria-label', 'Board filters');

  const queryLabel = element('label');
  queryLabel.textContent = 'Search visible work';
  const queryInput = element('input');
  queryInput.id = 'board-filter-query';
  queryInput.type = 'search';
  queryInput.maxLength = 200;
  queryInput.autocomplete = 'off';
  queryInput.spellcheck = false;
  queryInput.placeholder = 'title, summary, next action, holder…';
  queryInput.setAttribute('aria-controls', 'board');
  queryLabel.append(queryInput);

  const kindLabel = element('label');
  kindLabel.textContent = 'Kind';
  const kindSelect = element('select');
  kindSelect.id = 'board-filter-kind';
  kindSelect.setAttribute('aria-controls', 'board');
  kindSelect.append(option('', 'all kinds'), ...BOARD_FILTER_KINDS.map((kind) => option(kind, kind)));
  kindLabel.append(kindSelect);

  const statusLabel = element('label');
  statusLabel.textContent = 'Status';
  const statusSelect = element('select');
  statusSelect.id = 'board-filter-status';
  statusSelect.setAttribute('aria-controls', 'board');
  statusSelect.append(option('', 'all statuses'), ...BOARD_FILTER_STATUSES.map((status) => option(status, status)));
  statusLabel.append(statusSelect);

  const resetButton = element('button', 'board-filter-reset');
  resetButton.type = 'button';
  resetButton.textContent = 'clear board filters';

  const summary = element('div', 'board-filter-summary');
  const result = element('span', 'board-filter-result');
  result.id = 'board-filter-result';
  result.setAttribute('role', 'status');
  result.setAttribute('aria-live', 'polite');
  const error = element('p', 'board-filter-error');
  error.id = 'board-filter-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const overallEmpty = element('p', 'board-filter-overall-empty');
  overallEmpty.id = 'board-filter-empty';
  overallEmpty.hidden = true;
  summary.append(result, error, overallEmpty);

  panel.append(queryLabel, kindLabel, statusLabel, resetButton, summary);
  dashboardHead.after(panel);

  let applyQueued = false;

  queryInput.addEventListener('input', () => applyFilters());
  queryInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !queryInput.value) return;
    event.preventDefault();
    queryInput.value = '';
    applyFilters();
  });
  kindSelect.addEventListener('change', () => applyFilters());
  statusSelect.addEventListener('change', () => applyFilters());
  resetButton.addEventListener('click', () => resetFilters({ focus: true }));
  projectFilter.addEventListener('change', () => scheduleApply());

  const boardObserver = new MutationObserver(() => scheduleApply());
  boardObserver.observe(board, { childList: true });
  const dashboardObserver = new MutationObserver(() => {
    if (dashboard.hidden) resetFilters();
    else scheduleApply();
  });
  dashboardObserver.observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });

  applyFilters();

  function scheduleApply() {
    if (applyQueued) return;
    applyQueued = true;
    queueMicrotask(() => {
      applyQueued = false;
      applyFilters();
    });
  }

  function applyFilters() {
    let query = '';
    let kind = '';
    let status = '';
    clearError();
    try {
      query = normalizeBoardQuery(queryInput.value);
      kind = normalizeBoardFilter(kindSelect.value, BOARD_FILTER_KINDS, 'item kind');
      status = normalizeBoardFilter(statusSelect.value, BOARD_FILTER_STATUSES, 'item status');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Board filters are invalid.';
      if (/credential-shaped/i.test(message)) queryInput.value = '';
      showError(message);
      query = '';
      kind = BOARD_FILTER_KINDS.includes(kindSelect.value) ? kindSelect.value : '';
      status = BOARD_FILTER_STATUSES.includes(statusSelect.value) ? statusSelect.value : '';
    }

    prepareBoardMetadata(board);
    const filters = { query, kind, status };
    const active = Boolean(query || kind || status);
    const cards = [...board.querySelectorAll('button.card[data-item-id]')];
    let visible = 0;

    for (const card of cards) {
      const matched = matchesBoardRecord({
        kind: card.dataset.kind || '',
        status: card.dataset.status || '',
        search: card.dataset.search || '',
      }, filters);
      card.hidden = !matched;
      if (matched) visible += 1;
    }

    for (const column of board.querySelectorAll('section.column[data-status]')) {
      const columnStatus = column.dataset.status || '';
      const selectedColumn = !status || columnStatus === status;
      column.hidden = !selectedColumn;
      const columnCards = [...column.querySelectorAll('button.card[data-item-id]')];
      const visibleCards = selectedColumn ? columnCards.filter((card) => !card.hidden) : [];
      const count = column.querySelector('.column-head .count');
      if (count) count.textContent = String(visibleCards.length);

      const cardsContainer = column.querySelector('.cards');
      if (!cardsContainer) continue;
      cardsContainer.querySelector('.board-filter-empty')?.remove();
      const baselineEmpty = cardsContainer.querySelector('.empty:not(.board-filter-empty)');
      if (baselineEmpty) baselineEmpty.hidden = active;
      if (selectedColumn && active && visibleCards.length === 0) {
        const empty = element('p', 'board-filter-empty');
        empty.textContent = 'No items in this column match the board filters.';
        cardsContainer.append(empty);
      }
    }

    result.textContent = boardResultLabel(visible, cards.length);
    overallEmpty.hidden = !(cards.length === 0 || (active && visible === 0));
    overallEmpty.textContent = cards.length === 0
      ? 'No items are available in the selected project.'
      : 'No board items match these filters.';
    resetButton.disabled = !active;
  }

  function resetFilters({ focus = false } = {}) {
    queryInput.value = '';
    kindSelect.value = '';
    statusSelect.value = '';
    clearError();
    applyFilters();
    if (focus && queryInput.isConnected) queryInput.focus();
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }

  return {
    reset: resetFilters,
    destroy() {
      boardObserver.disconnect();
      dashboardObserver.disconnect();
      resetFilters();
      panel.remove();
    },
  };
}

function prepareBoardMetadata(board) {
  for (const column of board.querySelectorAll('section.column')) {
    const status = BOARD_FILTER_STATUSES.find((candidate) => column.classList.contains(`status-${candidate}`)) || '';
    column.dataset.status = status;
    for (const card of column.querySelectorAll('button.card[data-item-id]')) {
      card.dataset.status = status;
      const identity = card.querySelector('.card-top span')?.textContent || '';
      const [rawKind = '', rawProject = ''] = identity.split('·', 2).map((value) => value.trim());
      card.dataset.kind = BOARD_FILTER_KINDS.includes(rawKind) ? rawKind : '';
      card.dataset.project = PROJECT_PATTERN.test(rawProject) && rawProject.length <= 80 && !/stn\.tok_/i.test(rawProject)
        ? rawProject
        : '';
      card.dataset.search = buildBoardSearchText(
        [...card.querySelectorAll('.card-top span, h4, p, .card-meta span')]
          .map((node) => node.textContent || ''),
      );
    }
  }
}

function option(value, label) {
  const node = element('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function ensureStyles(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

if (typeof document !== 'undefined') installBoardFilterController();
