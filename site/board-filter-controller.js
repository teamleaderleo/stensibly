import {
  boardEmptyMessage,
  boardFilterKinds,
  boardFilterStatuses,
  boardResultLabel,
  matchesBoardCard,
  normalizeBoardKind,
  normalizeBoardProject,
  normalizeBoardQuery,
  normalizeBoardStatus,
} from './board-filter.js';

export function installBoardFilterController() {
  const dashboard = document.querySelector('#dashboard');
  const dashboardHead = dashboard?.querySelector('.dashboard-head');
  const board = document.querySelector('#board');
  if (!dashboard || !dashboardHead || !board) return null;
  if (document.querySelector('#board-filter-panel')) return null;

  ensureStyles('stensibly-board-filter-styles', '/board-filter.css');

  const panel = element('section', 'board-filter-panel');
  panel.id = 'board-filter-panel';
  panel.setAttribute('aria-label', 'Board search and filters');

  const controls = element('div', 'board-filter-controls');
  const searchLabel = element('label', 'board-filter-search');
  const searchCopy = element('span');
  searchCopy.textContent = 'Search board';
  const search = element('input');
  search.id = 'board-filter-query';
  search.type = 'search';
  search.maxLength = 200;
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.placeholder = 'title, summary, next action, holder…';
  search.setAttribute('aria-controls', 'board');
  searchLabel.append(searchCopy, search);

  const kindLabel = element('label');
  const kindCopy = element('span');
  kindCopy.textContent = 'Kind';
  const kind = element('select');
  kind.id = 'board-filter-kind';
  kind.setAttribute('aria-controls', 'board');
  kind.append(option('', 'all kinds'));
  for (const value of boardFilterKinds()) kind.append(option(value, value));
  kindLabel.append(kindCopy, kind);

  const statusLabel = element('label');
  const statusCopy = element('span');
  statusCopy.textContent = 'Status';
  const status = element('select');
  status.id = 'board-filter-status';
  status.setAttribute('aria-controls', 'board');
  status.append(option('', 'all statuses'));
  for (const value of boardFilterStatuses()) status.append(option(value, value));
  statusLabel.append(statusCopy, status);

  const clearButton = element('button');
  clearButton.type = 'button';
  clearButton.className = 'secondary';
  clearButton.textContent = 'clear board filters';
  clearButton.disabled = true;

  controls.append(searchLabel, kindLabel, statusLabel, clearButton);

  const feedback = element('div', 'board-filter-feedback');
  const result = element('span');
  result.id = 'board-filter-result';
  result.setAttribute('role', 'status');
  result.setAttribute('aria-live', 'polite');
  result.textContent = '0 items on board';
  const error = element('p', 'board-filter-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const empty = element('p', 'board-filter-overall-empty');
  empty.setAttribute('role', 'status');
  empty.hidden = true;
  feedback.append(result, error, empty);
  panel.append(controls, feedback);
  dashboardHead.after(panel);

  const filters = { query: '', kind: '', status: '' };
  let applyQueued = false;

  search.addEventListener('input', () => {
    try {
      filters.query = normalizeBoardQuery(search.value);
      clearError();
    } catch (cause) {
      search.value = '';
      filters.query = '';
      showError(cause instanceof Error ? cause.message : 'Board search is invalid.');
    }
    scheduleApply();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !search.value) return;
    event.preventDefault();
    search.value = '';
    filters.query = '';
    clearError();
    scheduleApply();
  });
  kind.addEventListener('change', () => {
    filters.kind = normalizeBoardKind(kind.value);
    clearError();
    scheduleApply();
  });
  status.addEventListener('change', () => {
    filters.status = normalizeBoardStatus(status.value);
    clearError();
    scheduleApply();
  });
  clearButton.addEventListener('click', () => {
    resetFilters();
    search.focus();
  });

  const boardObserver = new MutationObserver(() => scheduleApply());
  boardObserver.observe(board, { childList: true, subtree: true });
  const dashboardObserver = new MutationObserver(() => {
    if (dashboard.hidden) resetFilters();
    else scheduleApply();
  });
  dashboardObserver.observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });

  scheduleApply();

  function scheduleApply() {
    if (applyQueued) return;
    applyQueued = true;
    queueMicrotask(() => {
      applyQueued = false;
      applyFilters();
    });
  }

  function applyFilters() {
    const columns = [...board.querySelectorAll('section.column')];
    let total = 0;
    let visible = 0;
    const active = Boolean(filters.query || filters.kind || filters.status);

    for (const column of columns) {
      const columnStatus = statusFromColumn(column);
      if (!columnStatus) continue;
      const statusVisible = !filters.status || filters.status === columnStatus;
      column.hidden = !statusVisible;
      const cards = [...column.querySelectorAll('button.card[data-item-id]')];
      let columnVisible = 0;

      for (const card of cards) {
        total += 1;
        const metadata = annotateCard(card, columnStatus);
        let matches = false;
        try {
          matches = statusVisible && matchesBoardCard(metadata, filters);
        } catch {
          matches = false;
        }
        card.hidden = !matches;
        if (matches) {
          visible += 1;
          columnVisible += 1;
        }
      }

      const count = column.querySelector('.column-head .count');
      const countText = String(columnVisible);
      if (count && count.textContent !== countText) count.textContent = countText;
      updateColumnEmpty(column, cards.length, columnVisible, statusVisible && active);
    }

    result.textContent = boardResultLabel(visible, total, filters);
    const message = boardEmptyMessage(visible, total, filters);
    empty.textContent = message;
    empty.hidden = !message;
    clearButton.disabled = !active;
  }

  function resetFilters() {
    filters.query = '';
    filters.kind = '';
    filters.status = '';
    search.value = '';
    kind.value = '';
    status.value = '';
    clearError();
    scheduleApply();
  }

  function showError(message) {
    error.textContent = String(message).slice(0, 300);
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
      panel.remove();
      for (const column of board.querySelectorAll('section.column')) column.hidden = false;
      for (const card of board.querySelectorAll('button.card[data-item-id]')) card.hidden = false;
      for (const filteredEmpty of board.querySelectorAll('.board-filter-column-empty')) filteredEmpty.remove();
    },
  };
}

function annotateCard(card, status) {
  const identity = card.querySelector('.card-top span')?.textContent?.trim() || '';
  const separator = identity.indexOf(' · ');
  const rawKind = separator >= 0 ? identity.slice(0, separator) : '';
  const rawProject = separator >= 0 ? identity.slice(separator + 3) : '';
  const kind = normalizeBoardKind(rawKind);
  const project = normalizeBoardProject(rawProject);
  card.dataset.filterKind = kind;
  card.dataset.filterStatus = status;
  card.dataset.filterProject = project;
  return {
    kind,
    status,
    project,
    text: card.textContent || '',
  };
}

function statusFromColumn(column) {
  for (const status of boardFilterStatuses()) {
    if (column.classList.contains(`status-${status}`)) return status;
  }
  return '';
}

function updateColumnEmpty(column, total, visible, filtered) {
  const cards = column.querySelector('.cards');
  if (!cards) return;
  const baseline = cards.querySelector('.empty:not(.board-filter-column-empty)');
  if (baseline) {
    const baselineText = filtered ? 'No items exist in this status.' : 'nothing here';
    if (baseline.textContent !== baselineText) baseline.textContent = baselineText;
  }
  const existing = cards.querySelector('.board-filter-column-empty');
  const shouldShow = filtered && total > 0 && visible === 0;
  if (!shouldShow) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const message = element('p', 'empty board-filter-column-empty');
  message.textContent = 'No matching items in this status.';
  cards.append(message);
}

function ensureStyles(id, href) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

function option(value, label) {
  const node = element('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

if (typeof document !== 'undefined') installBoardFilterController();
