import { describeHttpFailure } from './connection.js';
import {
  createIdempotencyTracker,
  formatValidationIssues,
  itemKinds,
  readCreatedItem,
  validateCreateItem,
} from './item-create.js';
import { createRequestGate, redactCredentialText, safeRequestId } from './item-detail.js';

export function createItemCreateController({
  getConnection,
  getContext,
  getSelectedProject,
  onCreated,
  reportConnectionIssue,
}) {
  const openButton = document.querySelector('#create-item');
  const dialog = document.querySelector('#create-item-dialog');
  const closeButton = document.querySelector('#create-item-close');
  const form = document.querySelector('#create-item-form');
  const submitButton = document.querySelector('#create-item-submit');
  const cancelButton = document.querySelector('#cancel-create-item');
  const error = document.querySelector('#create-item-error');
  const state = document.querySelector('#create-item-state');
  const announcer = document.querySelector('#create-item-announcer');
  const gate = createRequestGate();
  const idempotency = createIdempotencyTracker();
  let restoreFocus = true;

  populateKinds();
  openButton.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  cancelButton.addEventListener('click', close);
  form.addEventListener('submit', submit);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    gate.invalidate();
    submitButton.disabled = false;
    state.textContent = 'ready';
    clearError();
    if (restoreFocus && !openButton.hidden) {
      openButton.focus();
    } else {
      const fallback = document.querySelector('#dashboard:not([hidden]) #refresh')
        || document.querySelector('#connect-form input[name="endpoint"]');
      fallback?.focus();
    }
    restoreFocus = true;
  });

  function sync() {
    const available = hasWriteContext();
    openButton.hidden = !available;
    if (!available && dialog.open) {
      reset({ announce: 'Item creation closed because write context is unavailable.' });
    }
  }

  function open() {
    if (!hasWriteContext()) return;
    idempotency.reset();
    form.reset();
    form.elements.kind.value = 'task';
    form.elements.priority.value = '50';
    form.elements.project.value = defaultProject();
    state.textContent = 'ready';
    clearError();
    restoreFocus = true;
    if (!dialog.open) dialog.showModal();
    form.elements.title.focus();
  }

  async function submit(event) {
    event.preventDefault();
    const { principal, actor } = getContext();
    const { endpoint, token, connected } = getConnection();
    if (!connected || !endpoint || !token || !principal?.capabilities.write || !actor) {
      sync();
      return;
    }

    let input;
    try {
      input = validateCreateItem({
        project: form.elements.project.value,
        kind: form.elements.kind.value,
        title: form.elements.title.value,
        summary: form.elements.summary.value,
        nextAction: form.elements.nextAction.value,
        priority: form.elements.priority.value,
      }, actor);
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : 'Item validation failed.');
      return;
    }

    let idempotencyKey;
    try {
      idempotencyKey = idempotency.keyFor(input);
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : 'Could not generate an idempotency key.');
      return;
    }

    const requestId = gate.begin();
    submitButton.disabled = true;
    state.textContent = 'creating';
    clearError();

    let response;
    try {
      response = await fetch(`${endpoint}/api/v1/items`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(input),
      });
    } catch {
      if (!gate.isCurrent(requestId)) return;
      showError('The create request could not reach the API. Retry the unchanged form to reuse the same idempotency key.');
      state.textContent = 'retry available';
      submitButton.disabled = false;
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!gate.isCurrent(requestId)) return;
    if (!response.ok) {
      const failure = describeHttpFailure(response.status, payload);
      const validation = formatValidationIssues(payload);
      const serverRequestId = safeRequestId(response.headers.get('x-request-id'), token);
      const message = [failure.message, validation, serverRequestId ? `Request ID: ${serverRequestId}` : '']
        .filter(Boolean)
        .join(' ');
      showError(message);
      state.textContent = failure.kind === 'conflict' ? 'conflict' : 'retry available';
      submitButton.disabled = false;
      if (response.status === 401 || response.status === 403) reportConnectionIssue(message);
      return;
    }

    let item;
    try {
      item = readCreatedItem(payload);
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : 'The endpoint returned an incompatible created item.');
      state.textContent = 'retry available';
      submitButton.disabled = false;
      return;
    }

    idempotency.reset();
    announcer.textContent = `Created ${redactCredentialText(item.title)}.`;
    dialog.close();
    try {
      await onCreated(item);
    } catch {
      announcer.textContent = `Created ${redactCredentialText(item.title)}, but the board did not refresh. Use refresh to load the new item.`;
    }
  }

  function close() {
    idempotency.reset();
    if (dialog.open) dialog.close();
  }

  function reset({ announce = '' } = {}) {
    gate.invalidate();
    restoreFocus = false;
    idempotency.reset();
    if (dialog.open) dialog.close();
    if (announce) announcer.textContent = announce;
    sync();
  }

  function hasWriteContext() {
    const { principal, actor } = getContext();
    const { connected } = getConnection();
    return Boolean(connected && principal?.capabilities.write && actor);
  }

  function defaultProject() {
    const selected = getSelectedProject();
    if (selected) return selected;
    const projects = getContext().principal?.principal.projects;
    return Array.isArray(projects) && projects.length === 1 ? projects[0] : '';
  }

  function populateKinds() {
    form.elements.kind.replaceChildren(...itemKinds().map((kind) => {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = kind;
      return option;
    }));
  }

  function showError(message) {
    error.textContent = redactCredentialText(message);
    error.hidden = false;
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
  }

  return { sync, reset };
}
