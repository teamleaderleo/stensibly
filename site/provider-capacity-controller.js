import { describeHttpFailure } from './connection.js';
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
