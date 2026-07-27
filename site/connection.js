const TOKEN_PATTERN = /^stn\.tok_[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}$/;

export function isPlausibleToken(value) {
  return TOKEN_PATTERN.test(String(value).trim());
}

export function normalizeEndpoint(value) {
  const normalized = String(value).trim().replace(/\/+$/, '');
  if (!normalized) throw new TypeError('Enter an API URL.');

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError('Enter a valid API URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('The API URL must use HTTP or HTTPS.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('Enter the API origin without a path, query, or fragment.');
  }
  return parsed.origin;
}

export function describeHttpFailure(status, payload) {
  const apiMessage = readApiMessage(payload);

  if (status === 401) {
    return {
      kind: 'invalid_token',
      message: 'Sign in with GitHub, or enter a current API token and try again.',
    };
  }

  if (status === 403 && /origin is not allowed/i.test(apiMessage)) {
    return {
      kind: 'forbidden_origin',
      message: 'This dashboard origin is forbidden by the API CORS allowlist.',
    };
  }

  if (status === 403) {
    return {
      kind: 'forbidden',
      message: apiMessage || 'The authenticated account or token lacks access for this ledger.',
    };
  }

  if (status === 404) {
    return {
      kind: 'incompatible_api',
      message: 'This endpoint does not expose Stensibly REST v1 at /api/v1/items.',
    };
  }

  if (status === 409) {
    return {
      kind: 'conflict',
      message: `The API reported a conflict: ${apiMessage || 'request conflict'}`,
    };
  }

  if (status === 400 || status === 422) {
    return {
      kind: 'invalid_request',
      message: `The API rejected the request: ${apiMessage || `HTTP ${status}`}`,
    };
  }

  if (status >= 500) {
    return {
      kind: 'api_failure',
      message: `The API is reachable but failed: ${apiMessage || `HTTP ${status}`}`,
    };
  }

  return {
    kind: 'http_error',
    message: apiMessage || `The API returned HTTP ${status}.`,
  };
}

export function readItems(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
    throw new TypeError('The endpoint returned an incompatible items response.');
  }
  return payload.items;
}

function readApiMessage(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return typeof payload.error === 'string' ? payload.error.trim() : '';
}
