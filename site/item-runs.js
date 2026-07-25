import { redactCredentialText, runIsActive, runStatusLabel } from './item-detail.js';

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
  const list = element('ol', 'detail-runs');
  for (const run of runs) {
    const row = element('li', runIsActive(run) ? 'detail-run detail-run-active' : 'detail-run');
    const title = element('strong');
    title.textContent = text(run.harness, 'unknown harness');
    const status = element('span', 'detail-run-status');
    status.textContent = runStatusLabel(run);
    row.append(title, status);
    list.append(row);
  }
  section.append(list);
  return section;
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
