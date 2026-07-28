#!/usr/bin/env python3
from pathlib import Path


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, before: str, after: str) -> None:
    target = Path(path)
    content = target.read_text(encoding="utf-8")
    if content.count(before) != 1:
        raise SystemExit(f"Expected one match in {path}, found {content.count(before)}")
    target.write_text(content.replace(before, after, 1), encoding="utf-8")


write("site/provider-capacity.js", r'''const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const commentIdPattern = /^\d{1,30}$/;
const unknownReasons = new Set(['not_observed', 'observation_stale', 'refill_window_elapsed']);
const unavailableReasons = new Set(['quota_exhausted', 'provider_reported_unavailable']);

export function validateProviderCapacityScope(value) {
  if (!isRecord(value)) throw new TypeError('CodeRabbit capacity scope must be an object.');
  const repository = boundedText(value.repository, 'Repository', 200, repositoryPattern);
  const subjectLogin = boundedText(value.subjectLogin, 'Subject login', 120, loginPattern);
  return { repository, subjectLogin };
}

export function readProviderCapacity(payload, expectedScope) {
  const scope = validateProviderCapacityScope(expectedScope);
  if (!isRecord(payload) || !isRecord(payload.capacity)) {
    throw new TypeError('The endpoint returned an incompatible CodeRabbit capacity response.');
  }
  const value = payload.capacity;
  if (value.provider !== 'coderabbit') throw new TypeError('Capacity provider must be coderabbit.');
  const repository = boundedText(value.repository, 'Capacity repository', 200, repositoryPattern);
  const subjectLogin = boundedText(value.subjectLogin, 'Capacity subject', 120, loginPattern);
  if (repository !== scope.repository || subjectLogin !== scope.subjectLogin) {
    throw new TypeError('The capacity response does not match the requested repository and subject.');
  }
  if (value.subjectBasis !== 'pull_request_author_proxy') {
    throw new TypeError('Capacity subject attribution is unsupported.');
  }
  if (!['available', 'unavailable', 'unknown'].includes(value.state)) {
    throw new TypeError('Capacity state is unsupported.');
  }

  const remaining = nullableInteger(value.remaining, 'Remaining reviews', 0, 1_000);
  const limit = nullableInteger(value.limit, 'Review limit', 1, 1_000);
  if ((remaining === null) !== (limit === null)) {
    throw new TypeError('Remaining reviews and review limit must be supplied together.');
  }
  if (remaining !== null && limit !== null && remaining > limit) {
    throw new TypeError('Remaining reviews cannot exceed the review limit.');
  }

  const observedAt = nullableTimestamp(value.observedAt, 'Observation time');
  const receivedAt = nullableTimestamp(value.receivedAt, 'Receipt time');
  const staleAt = nullableTimestamp(value.staleAt, 'Stale time');
  const refillAt = nullableTimestamp(value.refillAt, 'Refill time');
  const nextAvailableAt = nullableTimestamp(value.nextAvailableAt, 'Next available time');
  const source = readSource(value.source);

  if (value.state === 'available') {
    if (value.reason !== null || observedAt === null || receivedAt === null || staleAt === null || source === null) {
      throw new TypeError('Available capacity requires fresh observation evidence.');
    }
    if (remaining === 0) throw new TypeError('Available capacity cannot report zero remaining reviews.');
  } else if (value.state === 'unavailable') {
    if (!unavailableReasons.has(value.reason) || observedAt === null || receivedAt === null || staleAt === null || refillAt === null || nextAvailableAt === null || source === null) {
      throw new TypeError('Unavailable capacity requires bounded refill evidence.');
    }
    if (remaining !== null && remaining !== 0) {
      throw new TypeError('Unavailable counted capacity must report zero remaining reviews.');
    }
  } else {
    if (!unknownReasons.has(value.reason)) throw new TypeError('Unknown capacity requires a supported reason.');
    if (value.reason === 'not_observed') {
      if ([observedAt, receivedAt, staleAt, refillAt, nextAvailableAt, source].some((entry) => entry !== null)) {
        throw new TypeError('Unobserved capacity must not claim provider evidence.');
      }
    } else if (observedAt === null || receivedAt === null || staleAt === null || source === null) {
      throw new TypeError('Expired capacity requires the prior bounded observation evidence.');
    }
  }

  return {
    provider: 'coderabbit',
    repository,
    subjectLogin,
    subjectBasis: 'pull_request_author_proxy',
    state: value.state,
    reason: value.reason,
    remaining,
    limit,
    observedAt,
    receivedAt,
    staleAt,
    refillAt,
    nextAvailableAt,
    source,
  };
}

export function describeProviderCapacity(capacity, now = Date.now()) {
  if (!Number.isFinite(now)) throw new TypeError('Display time must be finite.');
  const quota = capacity.remaining === null
    ? 'Provider did not supply a remaining count.'
    : `${capacity.remaining} of ${capacity.limit} review${capacity.limit === 1 ? '' : 's'} remaining.`;
  const evidenceAge = capacity.observedAt === null
    ? 'No provider observation has been recorded.'
    : `Observed ${ageLabel(now - Date.parse(capacity.observedAt))}.`;
  let timing;
  if (capacity.state === 'available') {
    timing = `Fresh until ${formatTime(capacity.staleAt)} unless another review consumes capacity first.`;
  } else if (capacity.state === 'unavailable') {
    timing = `Provider-reported refill ${formatTime(capacity.nextAvailableAt)}.`;
  } else if (capacity.reason === 'observation_stale') {
    timing = `Last availability evidence expired ${formatTime(capacity.staleAt)}.`;
  } else if (capacity.reason === 'refill_window_elapsed') {
    timing = `The reported refill boundary passed; a fresh provider observation is required.`;
  } else {
    timing = 'Run a separate quota-status check only when fresh visibility is needed.';
  }
  return {
    statusLabel: capacity.state,
    quota,
    evidenceAge,
    timing,
    scope: `${capacity.repository} · ${capacity.subjectLogin} · PR-author proxy`,
    sourceLabel: capacity.source
      ? `PR #${capacity.source.pullRequestNumber} · comment ${capacity.source.commentId}`
      : 'No source observation',
    sourceHref: capacity.source
      ? `https://github.com/${capacity.repository}/pull/${capacity.source.pullRequestNumber}#issuecomment-${capacity.source.commentId}`
      : null,
  };
}

function readSource(value) {
  if (value === null) return null;
  if (!isRecord(value) || !Number.isInteger(value.pullRequestNumber) || value.pullRequestNumber < 1) {
    throw new TypeError('Capacity source pull request is invalid.');
  }
  if (typeof value.commentId !== 'string' || !commentIdPattern.test(value.commentId)) {
    throw new TypeError('Capacity source comment is invalid.');
  }
  return { pullRequestNumber: value.pullRequestNumber, commentId: value.commentId };
}

function boundedText(value, label, maximum, pattern) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || unsafeTextPattern.test(normalized) || !pattern.test(normalized)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
}

function nullableInteger(value, label, minimum, maximum) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function nullableTimestamp(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function ageLabel(elapsed) {
  const safe = Math.max(0, elapsed);
  if (safe < 60_000) return `${Math.floor(safe / 1_000)}s ago`;
  if (safe < 3_600_000) return `${Math.floor(safe / 60_000)}m ago`;
  return `${Math.floor(safe / 3_600_000)}h ago`;
}

function formatTime(value) {
  if (value === null) return 'not supplied';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
''')

write("site/provider-capacity-controller.js", r'''import { describeHttpFailure } from './connection.js';
import { createRequestGate, redactCredentialText } from './item-detail.js';
import {
  describeProviderCapacity,
  readProviderCapacity,
  validateProviderCapacityScope,
} from './provider-capacity.js';

const STORAGE_KEY = 'stensiblyProviderCapacityScope';

export function createProviderCapacityController({ getConnection, reportConnectionIssue }) {
  const panel = document.querySelector('#provider-capacity-panel');
  const status = document.querySelector('#provider-capacity-status');
  const form = document.querySelector('#provider-capacity-form');
  const clearButton = document.querySelector('#provider-capacity-clear');
  const scopeLabel = document.querySelector('#provider-capacity-scope');
  const details = document.querySelector('#provider-capacity-details');
  const quota = document.querySelector('#provider-capacity-quota');
  const timing = document.querySelector('#provider-capacity-timing');
  const observed = document.querySelector('#provider-capacity-observed');
  const source = document.querySelector('#provider-capacity-source');
  const error = document.querySelector('#provider-capacity-error');
  const gate = createRequestGate();
  let scope = loadScope();

  form.addEventListener('submit', saveScope);
  clearButton.addEventListener('click', clearScope);
  populateForm();
  renderIdle();

  async function refresh() {
    const { endpoint, token, connected } = getConnection();
    if (!connected || !endpoint || !token) {
      reset();
      return;
    }
    if (!scope) {
      renderNeedsScope();
      return;
    }

    const requestId = gate.begin();
    panel.dataset.state = 'unknown';
    status.textContent = 'checking';
    clearError();
    let response;
    try {
      const query = new URLSearchParams({
        repository: scope.repository,
        subject: scope.subjectLogin,
      });
      response = await fetch(`${endpoint}/api/v1/provider-capacities/coderabbit?${query}`, {
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
    } catch {
      if (!gate.isCurrent(requestId)) return;
      renderUnknown('Capacity preflight could not reach the API.');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!gate.isCurrent(requestId)) return;
    if (response.status === 404) {
      renderUnknown('This endpoint does not expose provider-capacity preflight.');
      return;
    }
    if (!response.ok) {
      const failure = describeHttpFailure(response.status, payload);
      const message = redactCredentialText(failure.message, token);
      renderUnknown(message);
      if (response.status === 401 || response.status === 403) reportConnectionIssue(message);
      return;
    }

    try {
      renderCapacity(readProviderCapacity(payload, scope));
    } catch (cause) {
      renderUnknown(cause instanceof Error ? cause.message : 'Capacity response validation failed.');
    }
  }

  function reset() {
    gate.invalidate();
    clearError();
    renderIdle();
  }

  function saveScope(event) {
    event.preventDefault();
    try {
      scope = validateProviderCapacityScope({
        repository: form.elements.repository.value,
        subjectLogin: form.elements.subject.value,
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
      populateForm();
      clearError();
      void refresh();
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : 'Capacity scope is invalid.');
    }
  }

  function clearScope() {
    gate.invalidate();
    scope = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // The in-memory scope is still cleared when browser storage is unavailable.
    }
    populateForm();
    renderNeedsScope();
  }

  function renderCapacity(capacity) {
    const view = describeProviderCapacity(capacity);
    panel.dataset.state = capacity.state;
    status.textContent = view.statusLabel;
    scopeLabel.textContent = view.scope;
    quota.textContent = view.quota;
    timing.textContent = view.timing;
    observed.textContent = view.evidenceAge;
    source.textContent = view.sourceLabel;
    if (view.sourceHref) {
      source.href = view.sourceHref;
      source.hidden = false;
    } else {
      source.removeAttribute('href');
      source.hidden = true;
    }
    details.hidden = false;
    clearButton.hidden = false;
    clearError();
  }

  function renderUnknown(message) {
    panel.dataset.state = 'unknown';
    status.textContent = 'unknown';
    scopeLabel.textContent = scope
      ? `${scope.repository} · ${scope.subjectLogin} · PR-author proxy`
      : 'No repository and subject selected';
    details.hidden = true;
    clearButton.hidden = !scope;
    showError(message);
  }

  function renderNeedsScope() {
    panel.dataset.state = 'unknown';
    status.textContent = 'scope needed';
    scopeLabel.textContent = 'Choose the repository and developer subject whose quota observation should be shown.';
    details.hidden = true;
    clearButton.hidden = true;
    clearError();
  }

  function renderIdle() {
    panel.dataset.state = 'unknown';
    status.textContent = scope ? 'waiting for connection' : 'scope needed';
    scopeLabel.textContent = scope
      ? `${scope.repository} · ${scope.subjectLogin} · PR-author proxy`
      : 'Choose the repository and developer subject whose quota observation should be shown.';
    details.hidden = true;
    clearButton.hidden = !scope;
  }

  function populateForm() {
    form.elements.repository.value = scope?.repository ?? '';
    form.elements.subject.value = scope?.subjectLogin ?? '';
  }

  function loadScope() {
    let raw = '';
    try {
      raw = localStorage.getItem(STORAGE_KEY) || '';
      if (!raw) return null;
      return validateProviderCapacityScope(JSON.parse(raw));
    } catch {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Invalid storage remains inert when removal is denied.
      }
      return null;
    }
  }

  function showError(message) {
    error.textContent = redactCredentialText(message);
    error.hidden = false;
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }

  return { refresh, reset };
}
''')

write("site/provider-capacity.css", r'''.provider-capacity {
  margin-bottom: 1rem;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--panel);
}

.provider-capacity-head,
.provider-capacity-form,
.provider-capacity-details {
  display: flex;
  align-items: end;
  gap: .75rem;
}

.provider-capacity-head {
  justify-content: space-between;
  align-items: center;
  margin-bottom: .8rem;
}

.provider-capacity-head h3 { margin: .15rem 0 0; }

#provider-capacity-status {
  padding: .3rem .6rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: .75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .05em;
}

.provider-capacity[data-state="available"] #provider-capacity-status {
  border-color: var(--success);
  color: var(--success);
}

.provider-capacity[data-state="unavailable"] #provider-capacity-status {
  border-color: var(--danger);
  color: var(--danger);
}

.provider-capacity-form { flex-wrap: wrap; }
.provider-capacity-form label { flex: 1 1 14rem; }
.provider-capacity-form input { width: 100%; }
.provider-capacity-form button { flex: 0 0 auto; }

#provider-capacity-scope,
.provider-capacity-note,
.provider-capacity-error {
  margin: .7rem 0 0;
  color: var(--muted);
  font-size: .82rem;
}

.provider-capacity-details {
  align-items: stretch;
  flex-wrap: wrap;
  margin-top: .85rem;
}

.provider-capacity-details > div {
  flex: 1 1 13rem;
  padding: .7rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel-soft);
}

.provider-capacity-details span {
  display: block;
  margin-bottom: .25rem;
  color: var(--muted);
  font-size: .7rem;
  text-transform: uppercase;
  letter-spacing: .06em;
}

.provider-capacity-details strong,
.provider-capacity-details a {
  font-size: .84rem;
  line-height: 1.4;
}

.provider-capacity-error { color: var(--danger); }

@media (max-width: 640px) {
  .provider-capacity-form { align-items: stretch; }
  .provider-capacity-form button { width: 100%; }
}
''')

write("test/dashboard-provider-capacity.test.ts", r'''import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  describeProviderCapacity,
  readProviderCapacity,
  validateProviderCapacityScope,
} from "../site/provider-capacity.js";

const scope = {
  repository: "teamleaderleo/stensibly",
  subjectLogin: "teamleaderleo",
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    capacity: {
      provider: "coderabbit",
      repository: scope.repository,
      subjectLogin: scope.subjectLogin,
      subjectBasis: "pull_request_author_proxy",
      state: "available",
      reason: null,
      remaining: null,
      limit: null,
      observedAt: "2026-07-28T13:00:00.000Z",
      receivedAt: "2026-07-28T13:00:01.000Z",
      staleAt: "2026-07-28T13:05:00.000Z",
      refillAt: null,
      nextAvailableAt: null,
      source: { pullRequestNumber: 421, commentId: "5104466293" },
      ...overrides,
    },
  };
}

describe("dashboard provider capacity reader", () => {
  test("preserves status-only availability and its explicit scope", () => {
    const value = readProviderCapacity(response(), scope);
    expect(value).toMatchObject({
      state: "available",
      remaining: null,
      subjectBasis: "pull_request_author_proxy",
    });
    expect(describeProviderCapacity(value, Date.parse("2026-07-28T13:02:00.000Z")))
      .toMatchObject({
        statusLabel: "available",
        scope: "teamleaderleo/stensibly · teamleaderleo · PR-author proxy",
        sourceHref: "https://github.com/teamleaderleo/stensibly/pull/421#issuecomment-5104466293",
      });
  });

  test("renders counted exhaustion and stale observations without upgrading them", () => {
    const unavailable = readProviderCapacity(response({
      state: "unavailable",
      reason: "quota_exhausted",
      remaining: 0,
      limit: 1,
      staleAt: "2026-07-28T14:00:00.000Z",
      refillAt: "2026-07-28T14:00:00.000Z",
      nextAvailableAt: "2026-07-28T14:00:00.000Z",
    }), scope);
    expect(describeProviderCapacity(unavailable).quota).toBe("0 of 1 review remaining.");

    const unknown = readProviderCapacity(response({
      state: "unknown",
      reason: "observation_stale",
    }), scope);
    expect(unknown.state).toBe("unknown");
    expect(describeProviderCapacity(unknown).timing).toContain("expired");
  });

  test("rejects mismatched scope, unsafe identifiers, and contradictory evidence", () => {
    expect(() => validateProviderCapacityScope({
      repository: "teamleaderleo/stensibly\u202e",
      subjectLogin: "teamleaderleo",
    })).toThrow("Repository is invalid");
    expect(() => readProviderCapacity(response({ repository: "other/repo" }), scope))
      .toThrow("does not match");
    expect(() => readProviderCapacity(response({ remaining: 0, limit: 1 }), scope))
      .toThrow("Available capacity cannot report zero");
    expect(() => readProviderCapacity(response({
      state: "unknown",
      reason: "not_observed",
    }), scope)).toThrow("must not claim provider evidence");
  });
});

describe("dashboard provider capacity wiring", () => {
  test("renders one scoped read-only card and refreshes it with the dashboard", async () => {
    const [html, app, controller, css] = await Promise.all([
      readFile("site/index.html", "utf8"),
      readFile("site/app.js", "utf8"),
      readFile("site/provider-capacity-controller.js", "utf8"),
      readFile("site/provider-capacity.css", "utf8"),
    ]);
    expect(html).toContain('id="provider-capacity-panel"');
    expect(html).toContain('name="repository"');
    expect(html).toContain('name="subject"');
    expect(html).toContain('/provider-capacity.css');
    expect(app).toContain("createProviderCapacityController");
    expect(app).toContain("void providerCapacity.refresh()");
    expect(controller).toContain("/api/v1/provider-capacities/coderabbit?");
    expect(controller).toContain("localStorage.setItem(STORAGE_KEY");
    expect(controller).not.toContain("@coderabbitai");
    expect(css).toContain('.provider-capacity[data-state="unavailable"]');
  });
});
''')

replace_once(
    "site/index.html",
    '    <link rel="stylesheet" href="/hosted-session.css" />\n',
    '    <link rel="stylesheet" href="/hosted-session.css" />\n    <link rel="stylesheet" href="/provider-capacity.css" />\n',
)

capacity_section = r'''
        <section class="provider-capacity" id="provider-capacity-panel" data-state="unknown" aria-labelledby="provider-capacity-title">
          <div class="provider-capacity-head">
            <div>
              <p class="eyebrow">Review capacity</p>
              <h3 id="provider-capacity-title">CodeRabbit preflight</h3>
            </div>
            <span id="provider-capacity-status" role="status">scope needed</span>
          </div>
          <form class="provider-capacity-form" id="provider-capacity-form">
            <label>
              Repository
              <input name="repository" required maxlength="200" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="owner/repository" />
            </label>
            <label>
              Developer subject
              <input name="subject" required maxlength="120" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="GitHub login" />
            </label>
            <button type="submit">read capacity</button>
            <button class="secondary" id="provider-capacity-clear" type="button" hidden>clear scope</button>
          </form>
          <p id="provider-capacity-scope">Choose the repository and developer subject whose quota observation should be shown.</p>
          <div class="provider-capacity-details" id="provider-capacity-details" hidden>
            <div><span>Quota</span><strong id="provider-capacity-quota"></strong></div>
            <div><span>Timing</span><strong id="provider-capacity-timing"></strong></div>
            <div><span>Observation</span><strong id="provider-capacity-observed"></strong></div>
            <div><span>Source</span><a id="provider-capacity-source" target="_blank" rel="noreferrer"></a></div>
          </div>
          <p class="provider-capacity-error" id="provider-capacity-error" role="alert" hidden></p>
          <p class="provider-capacity-note">Read-only. This card never posts a quota query or requests a review. Automatic reviews may consume capacity after the last observation.</p>
        </section>
'''
replace_once(
    "site/index.html",
    '        <section class="metrics" aria-label="Status totals">',
    capacity_section + '\n        <section class="metrics" aria-label="Status totals">',
)

replace_once(
    "site/app.js",
    "import { createSessionContextController } from './session-context-controller.js';\n",
    "import { createSessionContextController } from './session-context-controller.js';\nimport { createProviderCapacityController } from './provider-capacity-controller.js';\n",
)
replace_once(
    "site/app.js",
    "});\nitemDetail = createItemDetailController({",
    "});\nconst providerCapacity = createProviderCapacityController({\n  getConnection: () => ({ endpoint, token, connected }),\n  reportConnectionIssue: (message) => showConnectedIssue(message),\n});\nitemDetail = createItemDetailController({",
)
app_path = Path("site/app.js")
app_content = app_path.read_text(encoding="utf-8")
app_content = app_content.replace(
    "    sessionContext.reset();\n",
    "    sessionContext.reset();\n    providerCapacity.reset();\n",
)
if "providerCapacity.reset();" not in app_content:
    raise SystemExit("Provider capacity reset wiring was not added")
app_path.write_text(app_content, encoding="utf-8")
replace_once(
    "site/app.js",
    "function updateDashboard() {\n  populateProjects();\n  render();\n",
    "function updateDashboard() {\n  populateProjects();\n  render();\n  void providerCapacity.refresh();\n",
)
''')
