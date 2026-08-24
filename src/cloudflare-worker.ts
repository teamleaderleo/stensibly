import { createHostedAppFromEnv } from "./hosted-app.js";
import { createHostedDeployGovernorRequestConsumerFromEnv } from "./hosted-deploy-governor-request.js";
import { createHostedGitHubMailConsumerFromEnv } from "./hosted-github-mail-worker.js";
import {
  runHostedGitHubPublicRepositoryReconciliation,
} from "./hosted-github-public-repository-worker.js";
import {
  enforceOAuthRegistrationAdmission,
  type OAuthRegistrationRateLimiter,
} from "./mcp-oauth-registration-admission.js";
import {
  createGmailUnattendedMountFromEnv,
  handleGmailPubSubRequest,
  runGmailScheduledReconciliation,
  type GmailUnattendedEnvironment,
} from "./gmail-unattended-worker.js";
import {
  handleOutlookNotificationRequest,
  requireOutlookGraphBindings,
  runOutlookScheduledReconciliation,
} from "./outlook-graph-runtime.js";
import {
  observeWorkerRequest,
  type WorkerVersionReceipt,
} from "./worker-observability.js";

export interface CloudflareWorkerVersionMetadata {
  id: string;
  tag?: string;
  timestamp?: string;
}

export interface CloudflareBindings extends GmailUnattendedEnvironment {
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
  STENSIBLY_GITHUB_APP_ID?: string;
  STENSIBLY_GITHUB_APP_PRIVATE_KEY?: string;
  STENSIBLY_GITHUB_INSTALLATION_ID?: string;
  STENSIBLY_GITHUB_PROVIDER_PROJECT?: string;
  STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN?: string;
  STENSIBLY_GITHUB_API_BASE_URL?: string;
  STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED?: string;
  STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED?: string;
  STENSIBLY_GITHUB_DELEGATED_READS_ENABLED?: string;
  STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED?: string;
  STENSIBLY_DEPLOY_GOVERNOR_ENABLED?: string;
  STENSIBLY_DEPLOY_GOVERNOR_REPOSITORY?: string;
  STENSIBLY_GMAIL_STENSIBLY_LABEL_ID?: string;
  STENSIBLY_GITHUB_MAIL_PROJECT?: string;
  STENSIBLY_GITHUB_MAIL_REPOSITORY?: string;
  STENSIBLY_GITHUB_MAIL_PROJECT_CODE?: string;
  STENSIBLY_GITHUB_PUBLIC_EVENTS_FALLBACK_ENABLED?: string;
  STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID?: string;
  STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN?: string;
  STENSIBLY_OUTLOOK_CLIENT_STATE?: string;
  STENSIBLY_OUTLOOK_FOLDER_ID?: string;
  STENSIBLY_OUTLOOK_MAILBOX?: string;
  STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID?: string;
  STENSIBLY_OUTLOOK_NOTIFICATION_URL?: string;
  OAUTH_REGISTRATION_RATE_LIMITER?: OAuthRegistrationRateLimiter;
  CF_VERSION_METADATA?: CloudflareWorkerVersionMetadata;
}

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const worker = {
  async fetch(
    request: Request,
    env: CloudflareBindings,
    context?: CloudflareExecutionContext,
  ): Promise<Response> {
    return await observeWorkerRequest(
      request,
      async (observedRequest) => {
        const pathname = new URL(observedRequest.url).pathname;
        if (pathname === "/internal/gmail/pubsub") {
          try {
            const gmailResponse = await handleGmailPubSubRequest(
              observedRequest,
              createGmailUnattendedMountFromEnv(env),
            );
            return gmailResponse ?? new Response("Not Found", { status: 404 });
          } catch {
            return new Response("Service Unavailable", { status: 503 });
          }
        }

        if (pathname === "/internal/outlook/notifications") {
          try {
            const bindings = requireOutlookGraphBindings(outlookEnvironment(env));
            return await handleOutlookNotificationRequest(observedRequest, bindings, {
              ...(context === undefined
                ? {}
                : { waitUntil: (promise) => context.waitUntil(promise) }),
            });
          } catch {
            return new Response("Service Unavailable", { status: 503 });
          }
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

        let githubMailConsumer;
        let deployGovernorConsumer;
        let deployGovernorRequest: Request | undefined;
        if (pathname === "/webhooks/github") {
          try {
            githubMailConsumer = createHostedGitHubMailConsumerFromEnv(env);
            deployGovernorConsumer = createHostedDeployGovernorRequestConsumerFromEnv(env);
            if (deployGovernorConsumer) deployGovernorRequest = observedRequest.clone();
          } catch {
            return new Response("Service Unavailable", { status: 503 });
          }
        }
        const response = await createHostedAppFromEnv(
          stringEnvironment(env),
          githubMailConsumer ? { githubMailConsumer } : {},
        ).fetch(observedRequest);

        if (deployGovernorConsumer && deployGovernorRequest && response.ok) {
          try {
            await deployGovernorConsumer.consume(deployGovernorRequest);
          } catch {
            return new Response("Service Unavailable", {
              status: 503,
              headers: { "Retry-After": "60" },
            });
          }
        }
        return response;
      },
      {
        allowedOrigins: splitList(env.STENSIBLY_ALLOWED_ORIGINS),
        workerVersion: workerVersionReceipt(env.CF_VERSION_METADATA),
      },
    );
  },

  async scheduled(
    _controller: unknown,
    env: CloudflareBindings,
    context: CloudflareExecutionContext,
  ): Promise<void> {
    context.waitUntil((async () => {
      const outlookBindings = requireOutlookGraphBindings(outlookEnvironment(env));
      const gmailMount = createGmailUnattendedMountFromEnv(env);
      const results = await Promise.allSettled([
        runOutlookScheduledReconciliation(outlookBindings),
        runGmailScheduledReconciliation(gmailMount),
        runHostedGitHubPublicRepositoryReconciliation(env),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("Scheduled reconciliation failed");
      }
    })());
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

export function stringEnvironment(env: CloudflareBindings): Record<string, string | undefined> {
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
    STENSIBLY_GITHUB_APP_ID: env.STENSIBLY_GITHUB_APP_ID,
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: env.STENSIBLY_GITHUB_APP_PRIVATE_KEY,
    STENSIBLY_GITHUB_INSTALLATION_ID: env.STENSIBLY_GITHUB_INSTALLATION_ID,
    STENSIBLY_GITHUB_PROVIDER_PROJECT: env.STENSIBLY_GITHUB_PROVIDER_PROJECT,
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: env.STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN,
    STENSIBLY_GITHUB_API_BASE_URL: env.STENSIBLY_GITHUB_API_BASE_URL,
    STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED: env.STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED,
    STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED:
      env.STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED,
    STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: env.STENSIBLY_GITHUB_DELEGATED_READS_ENABLED,
    STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED: env.STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED,
  };
}

function outlookEnvironment(env: CloudflareBindings): Record<string, string | undefined> {
  return {
    CONVEX_URL: env.CONVEX_URL,
    STENSIBLY_SERVICE_SECRET: env.STENSIBLY_SERVICE_SECRET,
    STENSIBLY_WORKSPACE: env.STENSIBLY_WORKSPACE,
    STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID: env.STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID,
    STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN: env.STENSIBLY_OUTLOOK_OAUTH_REFRESH_TOKEN,
    STENSIBLY_OUTLOOK_CLIENT_STATE: env.STENSIBLY_OUTLOOK_CLIENT_STATE,
    STENSIBLY_OUTLOOK_FOLDER_ID: env.STENSIBLY_OUTLOOK_FOLDER_ID,
    STENSIBLY_OUTLOOK_MAILBOX: env.STENSIBLY_OUTLOOK_MAILBOX,
    STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID: env.STENSIBLY_OUTLOOK_MAILBOX_BINDING_ID,
    STENSIBLY_OUTLOOK_NOTIFICATION_URL: env.STENSIBLY_OUTLOOK_NOTIFICATION_URL,
  };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
