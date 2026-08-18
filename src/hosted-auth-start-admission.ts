import type { OAuthRegistrationRateLimiter } from "./mcp-oauth-registration-admission.js";
import { FAILURE_CATEGORY_HEADER } from "./worker-observability.js";

const AUTH_START_PATH = "/auth/github/start";
const RATE_LIMIT_KEY_PREFIX = "github-auth-start";
const RETRY_AFTER_SECONDS = 60;

export async function enforceHostedAuthStartAdmission(
  request: Request,
  options: {
    enabled: boolean;
    rateLimiter?: OAuthRegistrationRateLimiter;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !options.enabled
    || request.method.toUpperCase() !== "GET"
    || url.pathname !== AUTH_START_PATH
  ) {
    return null;
  }

  if (!options.rateLimiter) return authUnavailable();
  try {
    const clientAddress = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
    const result = await options.rateLimiter.limit({
      key: `${RATE_LIMIT_KEY_PREFIX}:${clientAddress}`,
    });
    if (result.success) return null;
  } catch {
    return authUnavailable();
  }

  return authError(429, "GitHub sign-in is temporarily rate limited", RETRY_AFTER_SECONDS);
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
