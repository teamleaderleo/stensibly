import { ConvexHttpClient } from "convex/browser";
import { ConvexMailThreadStore } from "./convex-mail-thread-store.js";
import { GitHubMailWebhookConsumer } from "./github-mail-webhook-consumer.js";
import { GoogleOAuthRefreshTokenProvider } from "./google-oauth-refresh-token.js";
import { createHostedGmailOutboundRuntime } from "./hosted-gmail-outbound-runtime.js";
import type { HostedGmailOutboundService } from "./hosted-gmail-outbound-service.js";
import type { HostedGitHubMailWebhookConsumer } from "./hosted-provider-capacity-api.js";

export interface HostedGitHubMailWorkerEnvironment {
  CONVEX_URL?: string;
  STENSIBLY_SERVICE_SECRET?: string;
  STENSIBLY_WORKSPACE?: string;
  STENSIBLY_GMAIL_OAUTH_CLIENT_ID?: string;
  STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET?: string;
  STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN?: string;
  STENSIBLY_GMAIL_MAILBOX?: string;
  STENSIBLY_GMAIL_MAILBOX_BINDING_ID?: string;
  STENSIBLY_GMAIL_STENSIBLY_LABEL_ID?: string;
  STENSIBLY_GITHUB_MAIL_PROJECT?: string;
  STENSIBLY_GITHUB_MAIL_REPOSITORY?: string;
  STENSIBLY_GITHUB_MAIL_PROJECT_CODE?: string;
}

export interface HostedGitHubMailRuntime {
  readonly client: ConvexHttpClient;
  readonly serviceSecret: string;
  readonly workspace: string;
  readonly project: string;
  readonly repository: string;
  readonly publicProjectCode: string;
  readonly store: ConvexMailThreadStore;
  readonly publisher: HostedGmailOutboundService;
}

const activationNames = [
  "STENSIBLY_GMAIL_STENSIBLY_LABEL_ID",
  "STENSIBLY_GITHUB_MAIL_PROJECT",
  "STENSIBLY_GITHUB_MAIL_REPOSITORY",
  "STENSIBLY_GITHUB_MAIL_PROJECT_CODE",
] as const satisfies readonly (keyof HostedGitHubMailWorkerEnvironment)[];

export function hostedGitHubMailWorkerConfigured(
  env: HostedGitHubMailWorkerEnvironment,
): boolean {
  return activationNames.some((name) => Boolean(env[name]?.trim()));
}

export function createHostedGitHubMailRuntimeFromEnv(
  env: HostedGitHubMailWorkerEnvironment,
): HostedGitHubMailRuntime | undefined {
  if (!hostedGitHubMailWorkerConfigured(env)) return undefined;

  const convexUrl = required(env.CONVEX_URL, "CONVEX_URL");
  const serviceSecret = required(
    env.STENSIBLY_SERVICE_SECRET,
    "STENSIBLY_SERVICE_SECRET",
  );
  const workspace = optional(env.STENSIBLY_WORKSPACE) ?? "default";
  const project = required(
    env.STENSIBLY_GITHUB_MAIL_PROJECT,
    "STENSIBLY_GITHUB_MAIL_PROJECT",
  );
  const repository = required(
    env.STENSIBLY_GITHUB_MAIL_REPOSITORY,
    "STENSIBLY_GITHUB_MAIL_REPOSITORY",
  );
  const publicProjectCode = required(
    env.STENSIBLY_GITHUB_MAIL_PROJECT_CODE,
    "STENSIBLY_GITHUB_MAIL_PROJECT_CODE",
  );
  const accountBinding = required(
    env.STENSIBLY_GMAIL_MAILBOX_BINDING_ID,
    "STENSIBLY_GMAIL_MAILBOX_BINDING_ID",
  );
  const mailboxAddress = required(
    env.STENSIBLY_GMAIL_MAILBOX,
    "STENSIBLY_GMAIL_MAILBOX",
  );
  const stensiblyLabelId = required(
    env.STENSIBLY_GMAIL_STENSIBLY_LABEL_ID,
    "STENSIBLY_GMAIL_STENSIBLY_LABEL_ID",
  );

  const tokenProvider = new GoogleOAuthRefreshTokenProvider({
    clientId: required(
      env.STENSIBLY_GMAIL_OAUTH_CLIENT_ID,
      "STENSIBLY_GMAIL_OAUTH_CLIENT_ID",
    ),
    clientSecret: required(
      env.STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET,
      "STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET",
    ),
    refreshToken: required(
      env.STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN,
      "STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN",
    ),
  });
  const client = new ConvexHttpClient(convexUrl);
  const binding = Object.freeze({
    workspace,
    project,
    accountBinding,
    mailboxAddress,
    stensiblyLabelId,
    sourceSystem: "GitHub",
  });
  const publisher = createHostedGmailOutboundRuntime({
    convexClient: client,
    convexServiceSecret: serviceSecret,
    binding,
    tokenProvider,
  });
  const store = new ConvexMailThreadStore({
    client,
    serviceSecret,
    workspace,
  });
  return Object.freeze({
    client,
    serviceSecret,
    workspace,
    project,
    repository,
    publicProjectCode,
    store,
    publisher,
  });
}

export function createHostedGitHubMailConsumerFromEnv(
  env: HostedGitHubMailWorkerEnvironment,
): HostedGitHubMailWebhookConsumer | undefined {
  const runtime = createHostedGitHubMailRuntimeFromEnv(env);
  if (!runtime) return undefined;
  return new GitHubMailWebhookConsumer({
    store: runtime.store,
    publisher: runtime.publisher,
    workspace: runtime.workspace,
    project: runtime.project,
    repository: runtime.repository,
    publicProjectCode: runtime.publicProjectCode,
  });
}

function optional(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() !== value || value.length < 1) {
    throw new Error("Hosted GitHub mail configuration contains an invalid optional value");
  }
  return value;
}

function required(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length < 1
    || value.length > 64 * 1024
  ) {
    throw new Error(`Hosted GitHub mail configuration requires ${label}`);
  }
  return value;
}
