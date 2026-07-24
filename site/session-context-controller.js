import { describeHttpFailure } from './connection.js';
import { createRequestGate, redactCredentialText } from './item-detail.js';
import {
  actorKinds,
  readPrincipal,
  readStoredActor,
  serializeActor,
  validateActor,
} from './session-context.js';

const ACTOR_STORAGE_KEY = 'stensiblyActor';

export function createSessionContextController({ getConnection, reportConnectionIssue }) {
  const panel = document.querySelector('#session-context-panel');
  const capabilityState = document.querySelector('#capability-state');
  const principalSummary = document.querySelector('#principal-summary');
  const principalName = document.querySelector('#principal-name');
  const principalBoundary = document.querySelector('#principal-boundary');
  const principalScopes = document.querySelector('#principal-scopes');
  const capabilityBadges = document.querySelector('#capability-badges');
  const actorSummary = document.querySelector('#actor-summary');
  const actorDisplay = document.querySelector('#actor-display');
  const actorUnavailable = document.querySelector('#actor-unavailable');
  const actorForm = document.querySelector('#actor-form');
  const actorError = document.querySelector('#actor-error');
  const changeActorButton = document.querySelector('#change-actor');
  const clearActorButton = document.querySelector('#clear-actor');
  const cancelActorButton = document.querySelector('#cancel-actor');
  const contextError = document.querySelector('#session-context-error');
  const gate = createRequestGate();

  let principalContext = null;
  let actor = loadActor();

  populateActorKinds();
  actorForm.addEventListener('submit', saveActor);
  changeActorButton.addEventListener('click', () => showActorForm());
  clearActorButton.addEventListener('click', clearActor);
  cancelActorButton.addEventListener('click', () => renderActor());
  renderUnavailable('Connect a ledger to inspect token capability.');

  async function refresh() {
    const { endpoint, token, connected } = getConnection();
    if (!connected || !endpoint || !token) {
      reset();
      return;
    }

    const requestId = gate.begin();
    capabilityState.textContent = 'checking';
    clearContextError();

    let response;
    try {
      response = await fetch(`${endpoint}/api/v1/principal`, {
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
    } catch {
      if (!gate.isCurrent(requestId)) return;
      principalContext = null;
      renderUnavailable('Capability discovery could not reach the API. Board inspection remains available.');
      showContextError('The capability request failed. Check the connection before enabling write controls.');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!gate.isCurrent(requestId)) return;

    if (response.status === 404) {
      principalContext = null;
      renderUnavailable('This API version supports board inspection but does not advertise write capability.');
      return;
    }

    if (!response.ok) {
      principalContext = null;
      const failure = describeHttpFailure(response.status, payload);
      const message = redactCredentialText(failure.message, token);
      renderUnavailable('Write capability is unavailable for the current connection.');
      showContextError(message);
      if (response.status === 401 || response.status === 403) reportConnectionIssue(message);
      return;
    }

    try {
      principalContext = readPrincipal(payload);
    } catch (cause) {
      principalContext = null;
      renderUnavailable('This endpoint returned an incompatible capability response. Board inspection remains available.');
      showContextError(cause instanceof Error ? cause.message : 'Capability response validation failed.');
      return;
    }

    if (!gate.isCurrent(requestId)) return;
    renderPrincipal();
  }

  function reset() {
    gate.invalidate();
    principalContext = null;
    clearContextError();
    renderUnavailable('Connect a ledger to inspect token capability.');
  }

  function renderPrincipal() {
    if (!principalContext) return;
    panel.dataset.mode = principalContext.capabilities.write ? 'write' : 'read';
    capabilityState.textContent = principalContext.capabilities.write ? 'write capable' : 'read only';
    principalSummary.hidden = false;
    principalName.textContent = redactCredentialText(principalContext.principal.name);
    principalBoundary.textContent = redactCredentialText(boundaryLabel(principalContext.principal));
    principalScopes.textContent = principalContext.principal.scopes.length
      ? redactCredentialText(principalContext.principal.scopes.join(', '))
      : 'no declared scopes';
    capabilityBadges.replaceChildren(...capabilityNodes(principalContext.capabilities));
    clearContextError();
    renderActor();
  }

  function renderUnavailable(message) {
    panel.dataset.mode = 'unavailable';
    capabilityState.textContent = 'unavailable';
    principalSummary.hidden = true;
    principalName.textContent = '';
    principalBoundary.textContent = '';
    principalScopes.textContent = '';
    capabilityBadges.replaceChildren();
    actorForm.hidden = true;
    actorSummary.hidden = true;
    actorUnavailable.hidden = false;
    actorUnavailable.textContent = message;
    clearActorError();
  }

  function renderActor() {
    actorForm.hidden = true;
    clearActorError();
    if (!principalContext?.capabilities.write) {
      actorSummary.hidden = true;
      actorUnavailable.hidden = false;
      actorUnavailable.textContent = 'A write-capable token is required before an actor can become active.';
      return;
    }

    actorUnavailable.hidden = true;
    if (!actor) {
      actorSummary.hidden = true;
      showActorForm();
      return;
    }

    actorSummary.hidden = false;
    actorDisplay.textContent = redactCredentialText(`${actor.name} · ${actor.kind} · ${actor.id}`);
  }

  function showActorForm() {
    if (!principalContext?.capabilities.write) return;
    actorSummary.hidden = true;
    actorUnavailable.hidden = true;
    actorForm.hidden = false;
    actorForm.elements.actorId.value = actor?.id ?? '';
    actorForm.elements.actorName.value = actor?.name ?? '';
    actorForm.elements.actorKind.value = actor?.kind ?? 'human';
    cancelActorButton.hidden = !actor;
    clearActorError();
    actorForm.elements.actorId.focus();
  }

  function saveActor(event) {
    event.preventDefault();
    if (!principalContext?.capabilities.write) return;
    try {
      actor = validateActor({
        id: actorForm.elements.actorId.value,
        name: actorForm.elements.actorName.value,
        kind: actorForm.elements.actorKind.value,
      });
      storeActor(actor);
      renderActor();
    } catch (cause) {
      showActorError(cause instanceof Error ? cause.message : 'Actor validation failed.');
    }
  }

  function clearActor() {
    actor = null;
    try {
      sessionStorage.removeItem(ACTOR_STORAGE_KEY);
    } catch {
      // The in-memory actor is still cleared when browser storage is unavailable.
    }
    renderActor();
  }

  function getActor() {
    return actor ? { ...actor } : null;
  }

  function getPrincipal() {
    return principalContext
      ? {
          principal: {
            ...principalContext.principal,
            scopes: [...principalContext.principal.scopes],
            projects: principalContext.principal.projects === null
              ? null
              : [...principalContext.principal.projects],
          },
          capabilities: { ...principalContext.capabilities },
        }
      : null;
  }

  function populateActorKinds() {
    actorForm.elements.actorKind.replaceChildren(...actorKinds().map((kind) => {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = kind;
      return option;
    }));
  }

  function loadActor() {
    let stored = '';
    try {
      stored = sessionStorage.getItem(ACTOR_STORAGE_KEY) || '';
    } catch {
      return null;
    }
    const parsed = readStoredActor(stored);
    if (!parsed && stored) {
      try {
        sessionStorage.removeItem(ACTOR_STORAGE_KEY);
      } catch {
        // Invalid storage remains inert even if removal is denied.
      }
    }
    return parsed;
  }

  function storeActor(value) {
    try {
      sessionStorage.setItem(ACTOR_STORAGE_KEY, serializeActor(value));
    } catch {
      throw new TypeError('The actor is valid, but this browser session could not store it.');
    }
  }

  function showContextError(message) {
    contextError.textContent = redactCredentialText(message);
    contextError.hidden = false;
  }

  function clearContextError() {
    contextError.textContent = '';
    contextError.hidden = true;
  }

  function showActorError(message) {
    actorError.textContent = redactCredentialText(message);
    actorError.hidden = false;
  }

  function clearActorError() {
    actorError.textContent = '';
    actorError.hidden = true;
  }

  return { refresh, reset, getActor, getPrincipal };
}

function boundaryLabel(principal) {
  const workspace = principal.workspace ? `workspace ${principal.workspace}` : 'local workspace';
  if (principal.projects === null) return `${workspace} · all projects`;
  if (!principal.projects.length) return `${workspace} · no projects`;
  return `${workspace} · ${principal.projects.join(', ')}`;
}

function capabilityNodes(capabilities) {
  return ['read', 'write', 'admin'].map((name) => {
    const badge = document.createElement('span');
    badge.className = capabilities[name] ? 'capability-on' : 'capability-off';
    badge.textContent = `${name} ${capabilities[name] ? 'yes' : 'no'}`;
    return badge;
  });
}
