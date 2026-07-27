import { isPlausibleToken, normalizeEndpoint } from './connection.js';
import {
  createGithubSignInUrl,
  describeHostedSessionRecovery,
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
let hostedSessionActive = installSessionMarker(savedEndpoint);

window.fetch = installHostedSessionFetchBridge({
  fetchImpl: originalFetch,
  sessionOrigin: DEFAULT_ENDPOINT,
  sentinel,
  onHostedSessionResponse: scheduleHostedSessionRecovery,
});

const signInButton = document.querySelector('#github-sign-in');
const signInState = document.querySelector('#hosted-sign-in-state');
const connectionPanel = document.querySelector('#connection-panel');
const connectionTitle = document.querySelector('#connection-title');
const connectionState = document.querySelector('#connection-state');
const connectionError = document.querySelector('#connection-error');
const connectForm = document.querySelector('#connect-form');
const endpointInput = document.querySelector('#connect-form [name="endpoint"]');
const connectedSummary = document.querySelector('#connected-summary');
const connectedEndpoint = document.querySelector('#connected-endpoint');
const changeConnectionButton = document.querySelector('#change-connection');
const disconnectButton = document.querySelector('#disconnect-connection');
const dashboard = document.querySelector('#dashboard');
const disconnected = document.querySelector('#disconnected-state');

signInButton?.addEventListener('click', beginGithubSignIn);
disconnectButton?.addEventListener('click', signOutHostedSession, { capture: true });

function installSessionMarker(endpoint) {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY) || '';
    if (isHostedSessionSentinel(stored)) {
      if (isDefaultHostedEndpoint(endpoint, DEFAULT_ENDPOINT)) return true;
      sessionStorage.removeItem(STORAGE_KEY);
      return false;
    }
    if (isPlausibleToken(stored)) return false;
    if (isDefaultHostedEndpoint(endpoint, DEFAULT_ENDPOINT)) {
      sessionStorage.setItem(STORAGE_KEY, sentinel);
      return true;
    }
    sessionStorage.removeItem(STORAGE_KEY);
    return false;
  } catch {
    // The dashboard will fall back to its ordinary connection form.
    return false;
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

function scheduleHostedSessionRecovery(observation) {
  if (!hostedSessionActive) return;
  const recovery = describeHostedSessionRecovery(observation, DEFAULT_ENDPOINT);
  if (!recovery) return;
  window.setTimeout(() => applyHostedSessionRecovery(recovery), 0);
}

function applyHostedSessionRecovery(recovery) {
  if (!hostedSessionActive) return;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY) || '';
    if (isPlausibleToken(stored) && !isHostedSessionSentinel(stored)) {
      hostedSessionActive = false;
      return;
    }
  } catch {
    // The in-memory hosted-session mode still permits explicit sign-out.
  }

  if (connectionPanel) connectionPanel.hidden = false;
  if (connectionTitle) connectionTitle.textContent = recovery.title;
  if (connectionState) {
    connectionState.textContent = recovery.state;
    connectionState.classList.add('error');
  }
  if (connectForm) connectForm.hidden = true;
  if (connectedSummary) connectedSummary.hidden = false;
  if (connectedEndpoint) connectedEndpoint.textContent = DEFAULT_ENDPOINT;
  if (changeConnectionButton) changeConnectionButton.hidden = true;
  if (disconnectButton) {
    disconnectButton.hidden = false;
    disconnectButton.disabled = false;
    disconnectButton.textContent = 'sign out';
  }
  if (dashboard) dashboard.hidden = true;
  if (disconnected) {
    disconnected.hidden = false;
    const title = disconnected.querySelector('p');
    const message = disconnected.querySelector('span');
    if (title) title.textContent = recovery.disconnectedTitle;
    if (message) message.textContent = recovery.disconnectedMessage;
  }
  if (connectionError?.hidden) showError(recovery.summary);
}

async function signOutHostedSession(event) {
  if (!disconnectButton) return;
  let stored = '';
  try {
    stored = sessionStorage.getItem(STORAGE_KEY) || '';
  } catch {
    // Continue from the in-memory mode when storage is unavailable.
  }
  if (isPlausibleToken(stored) && !isHostedSessionSentinel(stored)) {
    hostedSessionActive = false;
    return;
  }
  if (!hostedSessionActive && !isHostedSessionSentinel(stored)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  disconnectButton.disabled = true;
  clearError();

  try {
    await revokeHostedSession(originalFetch, DEFAULT_ENDPOINT);
    hostedSessionActive = false;
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
