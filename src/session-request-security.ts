export type HttpAuthenticationMode = "anonymous" | "bearer" | "session";

export interface SessionRequestSecurityInput {
  method: string;
  authenticationMode: HttpAuthenticationMode;
  origin?: string | null;
  allowedOrigins: readonly string[];
}

export interface SessionRequestSecurityRejection {
  status: 403;
  code: "forbidden_origin";
  error: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Browser-session writes rely on an exact approved Origin check as their CSRF
 * boundary. Explicit bearer-token clients retain their current origin-agnostic
 * behavior, and read-only session requests remain usable for same-site
 * navigation and session restoration. Rejections use fixed messages rather
 * than reflecting an untrusted Origin value into the response.
 */
export function evaluateSessionRequestSecurity(
  input: SessionRequestSecurityInput,
): SessionRequestSecurityRejection | null {
  if (!requiresSessionOriginCheck(input.method, input.authenticationMode)) {
    return null;
  }

  const origin = normalizeOrigin(input.origin);
  if (!origin) {
    return rejection("A valid Origin header is required for browser-session writes");
  }

  const allowed = normalizedOriginSet(input.allowedOrigins);
  if (!allowed.has(origin)) {
    return rejection("Origin is not allowed for browser-session writes");
  }

  return null;
}

export function requiresSessionOriginCheck(
  method: string,
  authenticationMode: HttpAuthenticationMode,
): boolean {
  return authenticationMode === "session"
    && !SAFE_METHODS.has(method.trim().toUpperCase());
}

/** Returns the canonical approved origin for credentialed CORS, or null. */
export function resolveCredentialedCorsOrigin(
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): string | null {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return null;
  return normalizedOriginSet(allowedOrigins).has(normalized) ? normalized : null;
}

function normalizedOriginSet(values: readonly string[]): Set<string> {
  const origins = new Set<string>();
  for (const value of values) {
    const origin = normalizeOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized || normalized === "null") return null;

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function rejection(error: string): SessionRequestSecurityRejection {
  return { status: 403, code: "forbidden_origin", error };
}
