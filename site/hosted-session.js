const API_PREFIX = '/api/v1';
const ITEMS_PATH = '/api/v1/items';
const SESSION_TOKEN_PARTS = ['stn.', 'tok_', '0'.repeat(32), '.', 's'.repeat(40)];

export function hostedSessionSentinel() {
  return SESSION_TOKEN_PARTS.join('');
}

export function isHostedSessionSentinel(value) {
  return String(value || '') === hostedSessionSentinel();
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
  if (!authorization) return { request, credentials: request.credentials };

  if (authorization !== `Bearer ${sentinel}`) {
    return { request, credentials: 'omit' };
  }

  const allowedOrigin = normalizeOrigin(sessionOrigin, 'Hosted session origin');
  const url = new URL(request.url);
  request.headers.delete('authorization');
  const hostedRestRequest = url.origin === allowedOrigin
    && (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`));
  return {
    request,
    credentials: hostedRestRequest ? 'include' : 'omit',
  };
}

export function describeHostedSessionRecovery(observation, sessionOrigin) {
  if (!observation || ![401, 403].includes(observation.status)) return null;
  if (String(observation.method || '').toUpperCase() !== 'GET') return null;

  let url;
  try {
    url = new URL(String(observation.url || ''));
  } catch {
    return null;
  }
  const allowedOrigin = normalizeOrigin(sessionOrigin, 'Hosted session origin');
  if (url.origin !== allowedOrigin || url.pathname !== ITEMS_PATH) return null;

  return {
    title: 'Hosted session needs attention',
    state: observation.status === 401 ? 'session expired' : 'access unavailable',
    summary: observation.status === 401
      ? 'The hosted session expired. Sign out to clear it and begin again.'
      : 'The hosted account cannot open this ledger. Sign out to clear the session.',
    disconnectedTitle: 'Hosted session is still active.',
    disconnectedMessage: 'Use sign out to clear the hosted cookie before trying another account or connection.',
  };
}

export function installHostedSessionFetchBridge({
  fetchImpl,
  sessionOrigin,
  sentinel = hostedSessionSentinel(),
  onHostedSessionResponse,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const allowedOrigin = normalizeOrigin(sessionOrigin, 'Hosted session origin');
  return async (input, init) => {
    const prepared = prepareHostedSessionRequest(input, init, allowedOrigin, sentinel);
    const response = await fetchImpl(prepared.request, { credentials: prepared.credentials });
    if (prepared.credentials === 'include' && typeof onHostedSessionResponse === 'function') {
      try {
        onHostedSessionResponse({
          status: response.status,
          method: prepared.request.method,
          url: prepared.request.url,
        });
      } catch {
        // Dashboard recovery UI must never alter the request result.
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
