import {
  redactCredentialText,
  runIsActive,
  runStatusLabel,
} from './item-detail.js';

export function runSection(runs) {
  const section = element('section', 'detail-section');
  const heading = element('h3');
  heading.textContent = `Agent runs · ${runs.length}`;
  section.append(heading);

  if (!runs.length) {
    const empty = element('p', 'detail-empty');
    empty.textContent = 'No agent runs are recorded for this item.';
    section.append(empty);
    return section;
  }

  const active = runs.filter(runIsActive);
  if (active.length) {
    const summary = element('p', 'detail-run-summary');
    summary.textContent = `${active.length} ${active.length === 1 ? 'run is' : 'runs are'} currently running or waiting.`;
    section.append(summary);
  }

  const list = element('ol', 'detail-runs');
  for (const run of runs) {
    const classes = ['detail-run'];
    if (runIsActive(run)) classes.push('detail-run-active');
    if (run.status === 'failed') classes.push('detail-run-failed');
    const row = element('li', classes.join(' '));

    const head = element('div', 'detail-run-head');
    const execution = element('strong');
    execution.textContent = [text(run.harness, 'unknown harness'), text(run.model)].filter(Boolean).join(' · ');
    const status = element('span', 'detail-run-status');
    status.textContent = runStatusLabel(run);
    head.append(execution, status);

    const owner = element('p', 'detail-run-owner');
    owner.textContent = `Agent · ${text(run.actorId, 'unknown actor')}`;

    const activity = element('p', 'detail-run-activity');
    activity.textContent = [
      `started ${formatTimestamp(run.startedAt) || 'at an unknown time'}`,
      `heartbeat ${formatTimestamp(run.lastHeartbeatAt) || 'unknown'}`,
      run.endedAt ? `ended ${formatTimestamp(run.endedAt) || 'at an unknown time'}` : '',
    ].filter(Boolean).join(' · ');

    const metrics = element('p', 'detail-run-metrics');
    const metricValues = [];
    if (Number.isInteger(run.childAgentCount)) metricValues.push(`${run.childAgentCount} child agents`);
    if (Number.isInteger(run.toolCallCount)) metricValues.push(`${run.toolCallCount} tool calls`);
    metrics.textContent = metricValues.length ? metricValues.join(' · ') : 'Execution counts not reported';

    row.append(head, owner, activity, metrics);

    const context = [text(run.repository), text(run.branch)].filter(Boolean);
    if (context.length) {
      const repository = element('p', 'detail-run-context');
      repository.textContent = context.join(' · ');
      row.append(repository);
    }
    if (run.worktree) row.append(codeBlock('Worktree', run.worktree));
    if (run.externalRunId) row.append(codeBlock('External run', run.externalRunId));
    row.append(codeBlock('Run', run.id));
    if (run.outcome) {
      const outcome = element('p', 'detail-run-outcome');
      outcome.textContent = text(run.outcome);
      row.append(outcome);
    }
    list.append(row);
  }
  section.append(list);
  return section;
}

function codeBlock(label, value) {
  const block = element('div', 'detail-run-code');
  const heading = element('span');
  heading.textContent = label;
  const code = element('code');
  code.textContent = text(value);
  block.append(heading, code);
  return block;
}

function formatTimestamp(value) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? redactCredentialText(value) : date.toLocaleString();
}

function text(value, fallback = '') {
  const output = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return redactCredentialText(output);
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}
