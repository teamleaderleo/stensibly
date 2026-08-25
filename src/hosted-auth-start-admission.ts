import { FAILURE_CATEGORY_HEADER } from "./worker-observability.js";

const AUTH_START_PATH = "/auth/github/start";
const RATE_LIMIT_KEY_PREFIX = "github-auth-start";
const RETRY_AFTER_SECONDS = 60;
const MAX_CLIENT_ADDRESS_LENGTH = 64;

export interface EdgeRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface HostedAuthStartAdmissionOptions {
  enabled: boolean;
  rateLimiter?: EdgeRateLimiter;
}

export async function enforceHostedAuthStartAdmission(
  request: Request,
  options: HostedAuthStartAdmissionOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !options.enabled
    || request.method.toUpperCase() !== "GET"
    || !isAuthStartPath(url.pathname)
  ) {
    return null;
  }

  if (!options.rateLimiter) return authUnavailable();
  const clientAddress = request.headers.get("CF-Connecting-IP")?.trim();
  if (!clientAddress || clientAddress.length > MAX_CLIENT_ADDRESS_LENGTH) {
    return authUnavailable();
  }

  try {
    const result = await options.rateLimiter.limit({
      key: `${RATE_LIMIT_KEY_PREFIX}:${clientAddress}`,
    });
    if (result.success) return null;
  } catch {
    return authUnavailable();
  }

  return authError(429, "GitHub sign-in is temporarily rate limited", RETRY_AFTER_SECONDS);
}

function isAuthStartPath(pathname: string): boolean {
  try {
    return decodeURI(pathname) === AUTH_START_PATH;
  } catch {
    return false;
  }
}

function authUnavailable(): Response {
  return authError(503, "GitHub sign-in is temporarily unavailable");
}

function authError(status: 429 | 503, error: string, retryAfter?: number): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    [FAILURE_CATEGORY_HEADER]: "auth_failure",
    "x-content-type-options": "nosniff",
  });
  if (retryAfter !== undefined) headers.set("retry-after", String(retryAfter));
  return new Response(JSON.stringify({ error, code: "auth_failure" }), { status, headers });
}
