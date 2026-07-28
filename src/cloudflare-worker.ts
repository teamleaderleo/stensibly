import { createHostedAppFromEnv } from "./hosted-app.js";
import { HttpGitHubOAuthClient } from "./hosted-auth.js";
import {
  enforceOAuthRegistrationAdmission,
  type OAuthRegistrationRateLimiter,
} from "./mcp-oauth-registration-admission.js";
import { observeWorkerRequest } from "./worker-observability.js";

export interface CloudflareBindings {
  CONVEX_URL: string;
  STENSIBLY_SERVICE_SECRET: string;
  STENSIBLY_WORKSPACE?: string;
  STENSIBLY_ALLOWED_ORIGINS?: string;
  STENSIBLY_ALLOWED_HOSTS?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  STENSIBLY_AUTH_ORIGIN?: string;
  STENSIBLY_AUTH_RETURN_ORIGINS?: string;
  STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS?: string;
  STENSIBLY_AUTH_BOOTSTRAP_ROLE?: string;
  STENSIBLY_AUTH_BOOTSTRAP_PROJECTS?: string;
  STENSIBLY_SESSION_MAX_AGE_SECONDS?: string;
  STENSIBLY_OAUTH_SIGNING_SECRET?: string;
  STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS?: string;
  STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS?: string;
  STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS?: string;
  STENSIBLY_OAUTH_REGISTRATION_REDIRECT_ORIGINS?: string;
  OAUTH_REGISTRATION_RATE_LIMITER?: OAuthRegistrationRateLimiter;
}

const W01_GITHUB_TOKEN_EGRESS_PROBE = "/__w01/github-token-egress";
const PROVIDER_STAGES = new Set([
  "token_exchange",
  "unexpected_scope",
  "identity_request",
  "identity_payload",
]);
const PROVIDER_REASONS = new Set([
  "incorrect_client_credentials",
  "redirect_uri_mismatch",
  "bad_verification_code",
  "unverified_user_email",
  "network_timeout",
  "network_exception",
  "provider_rejection",
  "malformed_response",
  "missing_access_token",
]);

const worker = {
  async fetch(request: Request, env: CloudflareBindings): Promise<Response> {
    return await observeWorkerRequest(
      request,
      async (observedRequest) => {
        if (new URL(observedRequest.url).pathname === W01_GITHUB_TOKEN_EGRESS_PROBE) {
          return await githubTokenEgressProbe(observedRequest, env);
        }
        const admissionRejection = await enforceOAuthRegistrationAdmission(
          observedRequest,
          {
            enabled: oauthConfigurationPresent(env),
            rateLimiter: env.OAUTH_REGISTRATION_RATE_LIMITER,
            allowedRedirectOrigins: env.STENSIBLY_OAUTH_REGISTRATION_REDIRECT_ORIGINS,
          },
        );
        if (admissionRejection) return admissionRejection;
        return await createHostedAppFromEnv(stringEnvironment(env)).fetch(observedRequest);
      },
      { allowedOrigins: splitList(env.STENSIBLY_ALLOWED_ORIGINS) },
    );
  },
};

export default worker;

async function githubTokenEgressProbe(
  request: Request,
  env: CloudflareBindings,
): Promise<Response> {
  if (
    request.method !== "POST"
    || !env.STENSIBLY_SERVICE_SECRET
    || request.headers.get("authorization") !== `Bearer ${env.STENSIBLY_SERVICE_SECRET}`
  ) {
    return diagnosticJson({ error: "Not found" }, 404);
  }
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  const authOrigin = env.STENSIBLY_AUTH_ORIGIN?.trim();
  if (!clientId || !clientSecret || !authOrigin) {
    return diagnosticJson({
      ok: false,
      stage: "configuration",
      reason: "missing_binding",
    });
  }

  const client = new HttpGitHubOAuthClient({ clientId, clientSecret });
  try {
    await client.exchangeCode({
      code: "w01-intentionally-invalid-authorization-code",
      redirectUri: `${authOrigin}/auth/github/callback`,
      codeVerifier: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    return diagnosticJson({
      ok: false,
      stage: "token_exchange",
      reason: "unexpected_success",
    });
  } catch (error) {
    const failure = boundedProviderFailure(error);
    return diagnosticJson({
      ok: failure.stage === "token_exchange" && failure.reason === "bad_verification_code",
      ...failure,
    });
  }
}

function boundedProviderFailure(error: unknown): { stage: string; reason: string } {
  if (typeof error !== "object" || error === null) {
    return { stage: "token_exchange", reason: "unknown_exception" };
  }
  const candidate = error as { stage?: unknown; reason?: unknown };
  const stage = typeof candidate.stage === "string" && PROVIDER_STAGES.has(candidate.stage)
    ? candidate.stage
    : "token_exchange";
  const reason = typeof candidate.reason === "string" && PROVIDER_REASONS.has(candidate.reason)
    ? candidate.reason
    : "unknown_exception";
  return { stage, reason };
}

function diagnosticJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function oauthConfigurationPresent(env: CloudflareBindings): boolean {
  return Boolean(
    env.STENSIBLY_OAUTH_SIGNING_SECRET?.trim()
    || env.STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS?.trim()
    || env.STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS?.trim()
    || env.STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS?.trim()
  );
}

function stringEnvironment(env: CloudflareBindings): Record<string, string | undefined> {
  return {
    CONVEX_URL: env.CONVEX_URL,
    STENSIBLY_SERVICE_SECRET: env.STENSIBLY_SERVICE_SECRET,
    STENSIBLY_WORKSPACE: env.STENSIBLY_WORKSPACE,
    STENSIBLY_ALLOWED_ORIGINS: env.STENSIBLY_ALLOWED_ORIGINS,
    STENSIBLY_ALLOWED_HOSTS: env.STENSIBLY_ALLOWED_HOSTS,
    GITHUB_OAUTH_CLIENT_ID: env.GITHUB_OAUTH_CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET: env.GITHUB_OAUTH_CLIENT_SECRET,
    STENSIBLY_AUTH_ORIGIN: env.STENSIBLY_AUTH_ORIGIN,
    STENSIBLY_AUTH_RETURN_ORIGINS: env.STENSIBLY_AUTH_RETURN_ORIGINS,
    STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS: env.STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS,
    STENSIBLY_AUTH_BOOTSTRAP_ROLE: env.STENSIBLY_AUTH_BOOTSTRAP_ROLE,
    STENSIBLY_AUTH_BOOTSTRAP_PROJECTS: env.STENSIBLY_AUTH_BOOTSTRAP_PROJECTS,
    STENSIBLY_SESSION_MAX_AGE_SECONDS: env.STENSIBLY_SESSION_MAX_AGE_SECONDS,
    STENSIBLY_OAUTH_SIGNING_SECRET: env.STENSIBLY_OAUTH_SIGNING_SECRET,
    STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS: env.STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS,
    STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS: env.STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS,
    STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS: env.STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS,
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
