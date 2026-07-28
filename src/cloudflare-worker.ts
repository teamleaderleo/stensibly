import { createHostedAppFromEnv } from "./hosted-app.js";
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
const W01_GITHUB_TOKEN_EGRESS_CAPABILITY = "-YnH9yW8pN4yfuUKDSwjY1PvtG257gveyMeKKuNE0Y8";
const TOKEN_RESPONSE_REASONS = new Set([
  "incorrect_client_credentials",
  "redirect_uri_mismatch",
  "bad_verification_code",
  "unverified_user_email",
]);

interface ProbeResult {
  outcome: "response" | "exception";
  elapsed: "under_100ms" | "under_1s" | "under_5s" | "under_30s" | "at_least_30s";
  status?: number;
  providerReason?: string;
  errorName?: string;
}

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
  const requestUrl = new URL(request.url);
  const headerAuthorized = request.method === "POST"
    && request.headers.get("x-stensibly-diagnostic") === W01_GITHUB_TOKEN_EGRESS_CAPABILITY;
  const queryAuthorized = request.method === "GET"
    && requestUrl.searchParams.get("cap") === W01_GITHUB_TOKEN_EGRESS_CAPABILITY;
  if (!headerAuthorized && !queryAuthorized) {
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

  const githubRoot = await requestProbe("https://github.com/robots.txt");
  const githubApi = await requestProbe("https://api.github.com/zen", {
    headers: { "user-agent": "Stensibly" },
  });
  const tokenNoSignal = await tokenRequestProbe({
    clientId,
    clientSecret,
    authOrigin,
    userAgent: false,
    timeoutSignal: false,
  });
  const tokenWithUserAgent = await tokenRequestProbe({
    clientId,
    clientSecret,
    authOrigin,
    userAgent: true,
    timeoutSignal: false,
  });
  const tokenWithSignal = await tokenRequestProbe({
    clientId,
    clientSecret,
    authOrigin,
    userAgent: true,
    timeoutSignal: true,
  });
  const ok = [tokenNoSignal, tokenWithUserAgent, tokenWithSignal].some((result) =>
    result.outcome === "response" && result.providerReason === "bad_verification_code"
  );
  return diagnosticJson({
    ok,
    githubRoot,
    githubApi,
    tokenNoSignal,
    tokenWithUserAgent,
    tokenWithSignal,
  });
}

async function requestProbe(url: string, init?: RequestInit): Promise<ProbeResult> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, init);
    return {
      outcome: "response",
      elapsed: elapsedBucket(performance.now() - startedAt),
      status: response.status,
    };
  } catch (error) {
    return exceptionProbeResult(error, performance.now() - startedAt);
  }
}

async function tokenRequestProbe(options: {
  clientId: string;
  clientSecret: string;
  authOrigin: string;
  userAgent: boolean;
  timeoutSignal: boolean;
}): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (options.userAgent) headers["user-agent"] = "Stensibly";
  const startedAt = performance.now();
  try {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers,
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code: "w01-intentionally-invalid-authorization-code",
        redirect_uri: `${options.authOrigin}/auth/github/callback`,
        code_verifier: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
      ...(options.timeoutSignal ? { signal: AbortSignal.timeout(10_000) } : {}),
    });
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    const providerReason = typeof payload?.error === "string"
      && TOKEN_RESPONSE_REASONS.has(payload.error)
      ? payload.error
      : "other_response";
    return {
      outcome: "response",
      elapsed: elapsedBucket(performance.now() - startedAt),
      status: response.status,
      providerReason,
    };
  } catch (error) {
    return exceptionProbeResult(error, performance.now() - startedAt);
  }
}

function exceptionProbeResult(error: unknown, elapsed: number): ProbeResult {
  const rawName = typeof error === "object" && error !== null && "name" in error
    ? (error as { name?: unknown }).name
    : undefined;
  const errorName = typeof rawName === "string"
    && ["TypeError", "AbortError", "TimeoutError", "Error"].includes(rawName)
    ? rawName
    : "OtherError";
  return {
    outcome: "exception",
    elapsed: elapsedBucket(elapsed),
    errorName,
  };
}

function elapsedBucket(elapsed: number): ProbeResult["elapsed"] {
  if (elapsed < 100) return "under_100ms";
  if (elapsed < 1_000) return "under_1s";
  if (elapsed < 5_000) return "under_5s";
  if (elapsed < 30_000) return "under_30s";
  return "at_least_30s";
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
