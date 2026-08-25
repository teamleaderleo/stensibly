/**
 * Decision-tray batch resolution semantics (#1632 monitor polish).
 *
 * The tray batch action resolves exactly the blocked items that were rendered
 * in the current visible view. It never reaches into hidden projects or
 * filter results, it reports complete-versus-unblock outcomes per item, and
 * it never presents partial failure or untouched items as aggregate success.
 */

export const BATCH_OUTCOMES = ['completed', 'unblocked', 'failed'];

export function collectRenderedBlockedIds(visibleItems) {
  if (!Array.isArray(visibleItems)) {
    throw new TypeError('Visible tray items must be an array.');
  }
  const ids = [];
  for (const item of visibleItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('Visible tray items must be item records.');
    }
    if (item.status === 'blocked') {
      if (typeof item.id !== 'string' || !item.id) {
        throw new TypeError('A blocked tray item is missing its id.');
      }
      ids.push(item.id);
    }
  }
  return ids;
}

export function reconcileBatchTargets(renderedIds, isStillVisibleBlockedItem) {
  if (!Array.isArray(renderedIds)) {
    throw new TypeError('Rendered tray ids must be an array.');
  }
  if (typeof isStillVisibleBlockedItem !== 'function') {
    throw new TypeError('Batch reconciliation needs a current visibility check.');
  }
  const targets = [];
  const stale = [];
  for (const id of renderedIds) {
    if (typeof id !== 'string' || !id) throw new TypeError('Rendered tray ids must be non-empty strings.');
    if (isStillVisibleBlockedItem(id)) targets.push(id);
    else stale.push(id);
  }
  return { targets, stale };
}

export function summarizeBatchResults(results, { staleCount = 0 } = {}) {
  if (!Array.isArray(results)) throw new TypeError('Batch results must be an array.');
  if (!Number.isInteger(staleCount) || staleCount < 0) {
    throw new TypeError('Stale count must be a non-negative integer.');
  }

  let completed = 0;
  let unblocked = 0;
  let failed = 0;
  for (const result of results) {
    if (!result || typeof result !== 'object' || !BATCH_OUTCOMES.includes(result.outcome)) {
      throw new TypeError('Each batch result needs a completed/unblocked/failed outcome.');
    }
    if (typeof result.id !== 'string' || !result.id) {
      throw new TypeError('Each batch result needs its item id.');
    }
    if (result.outcome === 'completed') completed += 1;
    else if (result.outcome === 'unblocked') unblocked += 1;
    else failed += 1;
  }

  const attempted = results.length;
  const resolved = completed + unblocked;
  const allResolved = attempted > 0 && failed === 0 && staleCount === 0 && resolved === attempted;
  return {
    attempted,
    completed,
    unblocked,
    failed,
    staleCount,
    resolved,
    allResolved,
    summaryLine: buildSummaryLine({ attempted, completed, unblocked, failed, staleCount }),
  };
}

function buildSummaryLine({ attempted, completed, unblocked, failed, staleCount }) {
  const resolved = completed + unblocked;
  if (attempted === 0 && staleCount === 0) return 'No blocked items in this view.';
  if (failed === 0 && staleCount === 0) {
    return unblocked === 0
      ? `Completed ${completed} of ${attempted} blocked item${attempted === 1 ? '' : 's'}.`
      : `Resolved ${resolved} of ${attempted}: ${completed} completed, ${unblocked} unblocked.`;
  }
  const parts = [`${completed} completed`, `${unblocked} unblocked`, `${failed} failed`];
  if (staleCount) parts.push(`${staleCount} no longer blocked here`);
  return `Partial clear (${resolved}/${attempted} changed): ${parts.join(', ')}.`;
}
