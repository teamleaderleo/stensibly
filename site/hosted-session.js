import { isPlausibleToken } from './connection.js';

const API_PREFIX = '/api/v1';
const SESSION_TOKEN_PARTS = ['stn.', 'tok_', '0'.repeat(32), '.', 's'.repeat(40)];

export function hostedSessionSentinel() {
  return SESSION_TOKEN_PARTS.join('');
}

export function isHostedSessionSentinel(value) {
  return String(value || '') === hostedSessionSentinel();
}

export function classifyHostedSessionDisconnect(storedToken, hostedAuthorizationDenied) {
  const stored = String(storedToken || '');
  if (isPlausibleToken(stored) && !isHostedSessionSentinel(stored)) return 'bearer';
  if (isHostedSessionSentinel(stored) || hostedAuthorizationDenied === true) return 'hosted';
  return 'ordinary';
}

export function isDefaultHostedEndpoint(endpoint, defaultEndpoint) {
  return normalizeOrigin(endpoint, 'API endpoint')
    === normalizeOrigin(defaultEndpoint, 'Default hosted endpoint');
}

export function createGithubSignInUrl(endpoint, returnTo) {
  const origin = normalizeOrigin(endpoint, 'API endpoint');
  const destination = normalizeReturnTo(returnTo);
  const url = new URL('/auth/github/start', origin);
  url.searchParams.set('returnTo', destination);
  return url.toString();
}

export function createHostedLogoutUrl(endpoint) {
  return new URL('/auth/logout', normalizeOrigin(endpoint, 'API endpoint')).toString();
}

export async function revokeHostedSession(fetchImpl, endpoint) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const response = await fetchImpl(createHostedLogoutUrl(endpoint), {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok && response.status !== 204) {
    throw new Error(`Sign out returned HTTP ${response.status}.`);
  }
}

export function prepareHostedSessionRequest(
  input,
  init = {},
  sessionOrigin,
  sentinel = hostedSessionSentinel(),
) {
  const request = new Request(input, init);
  const authorization = request.headers.get('authorization');
  if (!authorization) {
    return { request, credentials: request.credentials, hostedSession: false };
  }

  if (authorization !== `Bearer ${sentinel}`) {
    return { request, credentials: 'omit', hostedSession: false };
  }

  const allowedOrigin = normalizeOrigin(sessionOrigin, 'Hosted session origin');
  const url = new URL(request.url);
  request.headers.delete('authorization');
  const hostedRestRequest = url.origin === allowedOrigin
    && (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`));
  return {
    request,
    credentials: hostedRestRequest ? 'include' : 'omit',
    hostedSession: hostedRestRequest,
  };
}

export function installHostedSessionFetchBridge({
  fetchImpl,
  sessionOrigin,
  sentinel = hostedSessionSentinel(),
  onHostedAccessDenied,
  onHostedSessionRejected,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (onHostedAccessDenied !== undefined && typeof onHostedAccessDenied !== 'function') {
    throw new TypeError('Hosted access-denied callback must be a function.');
  }
  if (onHostedSessionRejected !== undefined && typeof onHostedSessionRejected !== 'function') {
    throw new TypeError('Hosted session-rejected callback must be a function.');
  }
  const allowedOrigin = normalizeOrigin(sessionOrigin, 'Hosted session origin');
  return async (input, init) => {
    const prepared = prepareHostedSessionRequest(input, init, allowedOrigin, sentinel);
    const response = await fetchImpl(prepared.request, { credentials: prepared.credentials });
    if (
      prepared.hostedSession
      && (response.status === 401 || response.status === 403)
    ) {
      try {
        onHostedSessionRejected?.(response.status);
      } catch {
        // UI notification must not replace the authenticated HTTP response.
      }
    }
    if (prepared.hostedSession && response.status === 403) {
      try {
        onHostedAccessDenied?.();
      } catch {
        // Compatibility notification must not replace the authenticated HTTP response.
      }
    }
    return response;
  };
}

function normalizeOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new TypeError(`${label} is invalid.`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new TypeError(`${label} must be an HTTP or HTTPS origin.`);
  }
  return parsed.origin;
}

function normalizeReturnTo(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new TypeError('Return destination is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError('Return destination must use HTTP or HTTPS without credentials.');
  }
  return parsed.toString();
}
