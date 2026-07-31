import { isPlausibleToken, normalizeEndpoint } from './connection.js';
import { installFrontendLabsEntry } from './frontend-labs-entry.js';
import {
  classifyHostedSessionDisconnect,
  createGithubSignInUrl,
  hostedSessionSentinel,
  installHostedSessionFetchBridge,
  isDefaultHostedEndpoint,
  isHostedSessionSentinel,
  revokeHostedSession,
} from './hosted-session.js';
import { installProviderCapacityCard } from './provider-capacity-entry.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const STORAGE_KEY = 'stensiblyToken';
const sentinel = hostedSessionSentinel();
const originalFetch = window.fetch.bind(window);
const savedEndpoint = readSavedEndpoint();

const root = document.documentElement;
const connectForm = document.querySelector('#connect-form');
const dashboard = document.querySelector('#dashboard');
const signInButton = document.querySelector('#github-sign-in');
const hostedSignOutButton = document.querySelector('#hosted-sign-out');
const signInState = document.querySelector('#hosted-sign-in-state');
const connectionError = document.querySelector('#connection-error');
const endpointInput = document.querySelector('#connect-form [name="endpoint"]');
const disconnectButton = document.querySelector('#disconnect-connection');
let hostedAuthorizationDenied = false;
let hostedSessionRejectedStatus = 0;

installFrontendLabsEntry();
persistEndpoint(savedEndpoint);
installSessionMarker(savedEndpoint);
installRootModeObserver();
window.fetch = installHostedSessionFetchBridge({
  fetchImpl: originalFetch,
  sessionOrigin: DEFAULT_ENDPOINT,
  sentinel,
  onHostedSessionRejected: preserveHostedSessionRecovery,
});
installProviderCapacityCard();

signInButton?.addEventListener('click', beginGithubSignIn);
hostedSignOutButton?.addEventListener('click', signOutHostedSession, { capture: true });
disconnectButton?.addEventListener('click', signOutHostedSession, { capture: true });

function installRootModeObserver() {
  const savedMarker = readSessionMarker();
  root.dataset.appMode = isPlausibleToken(savedMarker) ? 'connecting' : 'signed-out';
  root.dataset.rootReady = 'true';

  const sync = () => {
    const formVisible = Boolean(connectForm && !connectForm.hidden);
    const dashboardVisible = Boolean(dashboard && !dashboard.hidden);
    const errorVisible = Boolean(connectionError && !connectionError.hidden);

    if (dashboardVisible && formVisible) {
      root.dataset.appMode = 'editing';
      return;
    }
    if (dashboardVisible) {
      root.dataset.appMode = errorVisible ? 'degraded' : 'connected';
      return;
    }
    root.dataset.appMode = formVisible ? 'signed-out' : 'connecting';
  };

  try {
    if (typeof globalThis.MutationObserver !== 'function') {
      root.dataset.appMode = 'signed-out';
      return;
    }
    const observer = new globalThis.MutationObserver(sync);
    for (const element of [connectForm, dashboard, connectionError]) {
      if (element) observer.observe(element, { attributes: true, attributeFilter: ['hidden'] });
    }
  } catch {
    root.dataset.appMode = 'signed-out';
  }
}

function readSessionMarker() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function installSessionMarker(endpoint) {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY) || '';
    if (isHostedSessionSentinel(stored)) {
      if (isDefaultHostedEndpoint(endpoint, DEFAULT_ENDPOINT)) return;
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    if (isPlausibleToken(stored)) return;
    if (isDefaultHostedEndpoint(endpoint, DEFAULT_ENDPOINT)) {
      sessionStorage.setItem(STORAGE_KEY, sentinel);
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // The dashboard will fall back to its ordinary connection form.
  }
}

function activateHostedSession() {
  try {
    sessionStorage.setItem(STORAGE_KEY, sentinel);
  } catch {
    // The OAuth redirect can still proceed when browser storage is unavailable.
  }
}

function readSavedEndpoint() {
  try {
    return normalizeEndpoint(localStorage.getItem('stensiblyEndpoint') || DEFAULT_ENDPOINT);
  } catch {
    try {
      localStorage.removeItem('stensiblyEndpoint');
    } catch {
      // The default remains usable when browser storage is unavailable.
    }
    return DEFAULT_ENDPOINT;
  }
}

function persistEndpoint(endpoint) {
  try {
    localStorage.setItem('stensiblyEndpoint', endpoint);
  } catch {
    // The in-memory endpoint still works when browser storage is unavailable.
  }
}

function beginGithubSignIn() {
  clearError();
  try {
    const endpoint = DEFAULT_ENDPOINT;
    persistEndpoint(endpoint);
    activateHostedSession();
    if (endpointInput) endpointInput.value = endpoint;
    if (signInButton) signInButton.disabled = true;
    if (signInState) signInState.textContent = 'Opening GitHub…';
    const returnTo = new URL(window.location.pathname || '/', window.location.origin).toString();
    window.location.assign(createGithubSignInUrl(endpoint, returnTo));
  } catch (cause) {
    if (signInButton) signInButton.disabled = false;
    if (signInState) signInState.textContent = 'Use your GitHub account.';
    showError(cause instanceof Error ? cause.message : 'Could not start GitHub sign-in.');
  }
}

function preserveHostedSessionRecovery(status) {
  if (status !== 401 && status !== 403) return;
  hostedSessionRejectedStatus = status;
  hostedAuthorizationDenied = true;
  if (hostedSignOutButton) {
    hostedSignOutButton.hidden = false;
    hostedSignOutButton.textContent = status === 401 ? 'Reset sign-in' : 'Sign out';
  }
  if (signInState) {
    signInState.textContent = status === 401
      ? 'This browser session expired. Reset sign-in to continue.'
      : 'This account cannot access this workspace.';
  }
}

async function signOutHostedSession(event) {
  let stored = '';
  try {
    stored = sessionStorage.getItem(STORAGE_KEY) || '';
  } catch {
    if (!hostedAuthorizationDenied) return;
  }

  const mode = classifyHostedSessionDisconnect(stored, hostedAuthorizationDenied);
  if (mode === 'bearer') {
    clearHostedDenialRecovery();
    return;
  }
  if (mode !== 'hosted') return;

  event.preventDefault();
  event.stopImmediatePropagation();
  if (disconnectButton) disconnectButton.disabled = true;
  if (hostedSignOutButton) hostedSignOutButton.disabled = true;
  clearError();
  const restartGithubSignIn = hostedSessionRejectedStatus === 401;

  try {
    await revokeHostedSession(originalFetch, DEFAULT_ENDPOINT);
  } catch (cause) {
    if (disconnectButton) disconnectButton.disabled = false;
    if (hostedSignOutButton) {
      hostedSignOutButton.disabled = false;
      hostedSignOutButton.hidden = false;
    }
    showError(cause instanceof Error ? cause.message : 'Sign out failed.');
    return;
  }

  clearHostedDenialRecovery();
  clearHostedMarker();
  if (restartGithubSignIn) {
    beginGithubSignIn();
    return;
  }
  window.location.reload();
}

function clearHostedDenialRecovery() {
  hostedAuthorizationDenied = false;
  hostedSessionRejectedStatus = 0;
  if (hostedSignOutButton) {
    hostedSignOutButton.disabled = false;
    hostedSignOutButton.hidden = true;
    hostedSignOutButton.textContent = 'Sign out';
  }
  if (signInState) {
    signInState.textContent = 'Use your GitHub account.';
  }
}

function clearHostedMarker() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // The server session is already revoked; reload without treating local cleanup as logout failure.
  }
}

function showError(message) {
  if (!connectionError) return;
  connectionError.textContent = message;
  connectionError.hidden = false;
}

function clearError() {
  if (!connectionError) return;
  connectionError.textContent = '';
  connectionError.hidden = true;
}
