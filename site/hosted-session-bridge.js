import { isPlausibleToken, normalizeEndpoint } from './connection.js';
import {
  createGithubSignInUrl,
  hostedSessionSentinel,
  installHostedSessionFetchBridge,
  isDefaultHostedEndpoint,
  isHostedSessionSentinel,
  revokeHostedSession,
} from './hosted-session.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const STORAGE_KEY = 'stensiblyToken';
const sentinel = hostedSessionSentinel();
const originalFetch = window.fetch.bind(window);
const savedEndpoint = readSavedEndpoint();

installSessionMarker(savedEndpoint);
window.fetch = installHostedSessionFetchBridge({
  fetchImpl: originalFetch,
  sessionOrigin: DEFAULT_ENDPOINT,
  sentinel,
});

const signInButton = document.querySelector('#github-sign-in');
const signInState = document.querySelector('#hosted-sign-in-state');
const connectionError = document.querySelector('#connection-error');
const endpointInput = document.querySelector('#connect-form [name="endpoint"]');
const disconnectButton = document.querySelector('#disconnect-connection');

signInButton?.addEventListener('click', beginGithubSignIn);
disconnectButton?.addEventListener('click', signOutHostedSession, { capture: true });

function installSessionMarker(endpoint) {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY) || '';
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

function selectedEndpoint() {
  const candidate = endpointInput?.value || localStorage.getItem('stensiblyEndpoint') || DEFAULT_ENDPOINT;
  return normalizeEndpoint(candidate);
}

function beginGithubSignIn() {
  clearError();
  try {
    const endpoint = selectedEndpoint();
    if (!isDefaultHostedEndpoint(endpoint, DEFAULT_ENDPOINT)) {
      throw new TypeError('GitHub sign-in is available for api.stensibly.com. Use an API token for a custom endpoint.');
    }
    localStorage.setItem('stensiblyEndpoint', endpoint);
    if (signInButton) signInButton.disabled = true;
    if (signInState) signInState.textContent = 'Opening GitHub…';
    const returnTo = new URL(window.location.pathname || '/', window.location.origin).toString();
    window.location.assign(createGithubSignInUrl(endpoint, returnTo));
  } catch (cause) {
    if (signInButton) signInButton.disabled = false;
    if (signInState) signInState.textContent = 'Sign in with the GitHub account authorised for this workspace.';
    showError(cause instanceof Error ? cause.message : 'GitHub sign-in could not start.');
  }
}

async function signOutHostedSession(event) {
  let stored = '';
  try {
    stored = sessionStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return;
  }
  if (!isHostedSessionSentinel(stored)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  disconnectButton.disabled = true;
  clearError();

  try {
    await revokeHostedSession(originalFetch, DEFAULT_ENDPOINT);
    sessionStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  } catch (cause) {
    disconnectButton.disabled = false;
    showError(cause instanceof Error ? cause.message : 'Hosted sign out failed.');
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
