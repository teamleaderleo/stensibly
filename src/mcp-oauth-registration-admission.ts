import {
  MAX_REGISTRATION_BODY_BYTES,
  parseClientRegistration,
} from "./mcp-oauth-protocol.js";
import { FAILURE_CATEGORY_HEADER } from "./worker-observability.js";

const REGISTRATION_PATH = "/oauth/register";
const RATE_LIMIT_KEY = "oauth-register";
const RETRY_AFTER_SECONDS = 60;

export interface OAuthRegistrationRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface OAuthRegistrationAdmissionOptions {
  enabled: boolean;
  rateLimiter?: OAuthRegistrationRateLimiter;
  allowedRedirectOrigins?: string;
}

type RegistrationInspection =
  | { kind: "valid"; redirectUris: string[] }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function enforceOAuthRegistrationAdmission(
  request: Request,
  options: OAuthRegistrationAdmissionOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !options.enabled
    || request.method.toUpperCase() !== "POST"
    || url.pathname !== REGISTRATION_PATH
  ) {
    return null;
  }

  const allowedOrigins = parseAllowedOrigins(options.allowedRedirectOrigins);
  if (!options.rateLimiter || !allowedOrigins) {
    return oauthError(
      503,
      "temporarily_unavailable",
      "OAuth client registration is unavailable",
    );
  }

  let limitResult: { success: boolean };
  try {
    limitResult = await options.rateLimiter.limit({ key: RATE_LIMIT_KEY });
  } catch {
    return oauthError(
      503,
      "temporarily_unavailable",
      "OAuth client registration is unavailable",
    );
  }
  if (!limitResult.success) {
    return oauthError(
      429,
      "temporarily_unavailable",
      "OAuth client registration is temporarily rate limited",
      RETRY_AFTER_SECONDS,
    );
  }

  const inspection = await inspectRegistration(request);
  if (inspection.kind === "unavailable") {
    return oauthError(
      503,
      "temporarily_unavailable",
      "OAuth client registration is unavailable",
    );
  }
  if (inspection.kind === "invalid") return null;

  if (inspection.redirectUris.some((redirectUri) => !redirectOriginAllowed(
    redirectUri,
    allowedOrigins,
  ))) {
    return oauthError(
      400,
      "invalid_client_metadata",
      "A redirect_uri origin is not allowed",
    );
  }
  return null;
}

async function inspectRegistration(request: Request): Promise<RegistrationInspection> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REGISTRATION_BODY_BYTES) {
    return { kind: "invalid" };
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { kind: "invalid" };
  }

  let copy: Request;
  try {
    copy = request.clone();
  } catch {
    return { kind: "unavailable" };
  }
  const raw = await readBoundedText(copy, MAX_REGISTRATION_BODY_BYTES);
  if (raw.kind !== "ok") return raw.kind === "too_large"
    ? { kind: "invalid" }
    : { kind: "unavailable" };

  try {
    const input = parseClientRegistration(JSON.parse(raw.value));
    return { kind: "valid", redirectUris: input.redirectUris };
  } catch {
    return { kind: "invalid" };
  }
}

async function readBoundedText(
  request: Request,
  maximumBytes: number,
): Promise<
  | { kind: "ok"; value: string }
  | { kind: "too_large" }
  | { kind: "unavailable" }
> {
  if (!request.body) return { kind: "ok", value: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        return { kind: "too_large" };
      }
      chunks.push(next.value);
    }
  } catch {
    return { kind: "unavailable" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", value: new TextDecoder().decode(bytes) };
}

function parseAllowedOrigins(value: string | undefined): Set<string> | null {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries?.length) return null;

  const origins = new Set<string>();
  try {
    for (const entry of entries) {
      if (entry.includes("*")) return null;
      const parsed = new URL(entry);
      if (
        parsed.protocol !== "https:"
        || parsed.username
        || parsed.password
        || parsed.pathname !== "/"
        || parsed.search
        || parsed.hash
      ) {
        return null;
      }
      origins.add(parsed.origin);
    }
  } catch {
    return null;
  }
  return origins.size ? origins : null;
}

function redirectOriginAllowed(redirectUri: string, allowedOrigins: Set<string>): boolean {
  try {
    const parsed = new URL(redirectUri);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

function oauthError(
  status: 400 | 429 | 503,
  error: "invalid_client_metadata" | "temporarily_unavailable",
  description: string,
  retryAfterSeconds?: number,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    [FAILURE_CATEGORY_HEADER]: "auth_failure",
    "x-content-type-options": "nosniff",
  });
  if (retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(retryAfterSeconds));
  }
  return new Response(JSON.stringify({
    error,
    error_description: description,
  }), { status, headers });
}
