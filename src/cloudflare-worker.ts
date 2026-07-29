import { createHostedAppFromEnv } from "./hosted-app.js";
import {
  enforceOAuthRegistrationAdmission,
  type OAuthRegistrationRateLimiter,
} from "./mcp-oauth-registration-admission.js";
import {
  observeWorkerRequest,
  type WorkerVersionReceipt,
} from "./worker-observability.js";

export interface CloudflareWorkerVersionMetadata {
  id: string;
  tag?: string;
  timestamp?: string;
}

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
  STENSIBLY_GITHUB_WEBHOOK_SECRET?: string;
  OAUTH_REGISTRATION_RATE_LIMITER?: OAuthRegistrationRateLimiter;
  CF_VERSION_METADATA?: CloudflareWorkerVersionMetadata;
}

const worker = {
  async fetch(request: Request, env: CloudflareBindings): Promise<Response> {
    return await observeWorkerRequest(
      request,
      async (observedRequest) => {
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
      {
        allowedOrigins: splitList(env.STENSIBLY_ALLOWED_ORIGINS),
        workerVersion: workerVersionReceipt(env.CF_VERSION_METADATA),
      },
    );
  },
};

export default worker;

function oauthConfigurationPresent(env: CloudflareBindings): boolean {
  return Boolean(
    env.STENSIBLY_OAUTH_SIGNING_SECRET?.trim()
    || env.STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS?.trim()
    || env.STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS?.trim()
    || env.STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS?.trim()
  );
}

function workerVersionReceipt(
  metadata: CloudflareWorkerVersionMetadata | undefined,
): WorkerVersionReceipt | undefined {
  const id = metadata?.id?.trim();
  if (!id) return undefined;
  const tag = metadata?.tag?.trim();
  const createdAt = metadata?.timestamp?.trim();
  return {
    id,
    ...(tag ? { tag } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
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
    STENSIBLY_GITHUB_WEBHOOK_SECRET: env.STENSIBLY_GITHUB_WEBHOOK_SECRET,
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
