import { ConvexHttpClient } from "convex/browser";
import { GmailMailboxActionClient } from "./gmail-mailbox-actions.js";
import { GmailMailboxApiClient } from "./gmail-mailbox-api.js";
import { GmailUnattendedRuntime } from "./gmail-unattended-runtime.js";
import {
  GoogleOAuthRefreshTokenProvider,
} from "./google-oauth-refresh-token.js";
import {
  GooglePubSubAuthenticationError,
  GooglePubSubOidcVerifier,
} from "./google-pubsub-oidc.js";
import { HostedMailboxIntakeService } from "./mailbox-intake-convex-service.js";

export const GMAIL_PUBSUB_PATH = "/internal/gmail/pubsub" as const;
const maximumPushBodyBytes = 64 * 1024;

export interface GmailUnattendedEnvironment {
  CONVEX_URL?: string;
  STENSIBLY_SERVICE_SECRET?: string;
  STENSIBLY_WORKSPACE?: string;
  STENSIBLY_GMAIL_OAUTH_CLIENT_ID?: string;
  STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET?: string;
  STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN?: string;
  STENSIBLY_GMAIL_MAILBOX?: string;
  STENSIBLY_GMAIL_MAILBOX_BINDING_ID?: string;
  STENSIBLY_GMAIL_WATCH_LABEL_ID?: string;
  STENSIBLY_GMAIL_PUBSUB_TOPIC?: string;
  STENSIBLY_GMAIL_PUBSUB_SUBSCRIPTION?: string;
  STENSIBLY_GMAIL_PUBSUB_AUDIENCE?: string;
  STENSIBLY_GMAIL_PUBSUB_SERVICE_ACCOUNT?: string;
}

export interface GmailUnattendedMount {
  readonly runtime: GmailUnattendedRuntime;
  readonly verifier: GooglePubSubOidcVerifier;
}

export function gmailUnattendedConfigured(env: GmailUnattendedEnvironment): boolean {
  return gmailConfigNames.every((name) => Boolean(env[name]?.trim()));
}

export function createGmailUnattendedMountFromEnv(
  env: GmailUnattendedEnvironment,
): GmailUnattendedMount | null {
  if (!gmailUnattendedConfigured(env)) return null;
  const convexUrl = required(env.CONVEX_URL, "CONVEX_URL");
  const serviceSecret = required(env.STENSIBLY_SERVICE_SECRET, "STENSIBLY_SERVICE_SECRET");
  const tokenProvider = new GoogleOAuthRefreshTokenProvider({
    clientId: required(env.STENSIBLY_GMAIL_OAUTH_CLIENT_ID, "STENSIBLY_GMAIL_OAUTH_CLIENT_ID"),
    clientSecret: required(env.STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET, "STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET"),
    refreshToken: required(env.STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN, "STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN"),
  });
  const gmail = new GmailMailboxApiClient({
    tokenProvider,
    topicName: required(env.STENSIBLY_GMAIL_PUBSUB_TOPIC, "STENSIBLY_GMAIL_PUBSUB_TOPIC"),
  });
  const actions = new GmailMailboxActionClient({ tokenProvider });
  const client = new ConvexHttpClient(convexUrl);
  const intake = new HostedMailboxIntakeService({
    client,
    serviceSecret,
    workspace: env.STENSIBLY_WORKSPACE ?? "default",
  });
  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: required(env.STENSIBLY_GMAIL_MAILBOX, "STENSIBLY_GMAIL_MAILBOX"),
    mailboxBindingId: required(
      env.STENSIBLY_GMAIL_MAILBOX_BINDING_ID,
      "STENSIBLY_GMAIL_MAILBOX_BINDING_ID",
    ),
    labelId: required(env.STENSIBLY_GMAIL_WATCH_LABEL_ID, "STENSIBLY_GMAIL_WATCH_LABEL_ID"),
    pubsubSubscription: required(
      env.STENSIBLY_GMAIL_PUBSUB_SUBSCRIPTION,
      "STENSIBLY_GMAIL_PUBSUB_SUBSCRIPTION",
    ),
    gmail,
    actions,
    intake,
  });
  const verifier = new GooglePubSubOidcVerifier({
    audience: required(env.STENSIBLY_GMAIL_PUBSUB_AUDIENCE, "STENSIBLY_GMAIL_PUBSUB_AUDIENCE"),
    serviceAccountEmail: required(
      env.STENSIBLY_GMAIL_PUBSUB_SERVICE_ACCOUNT,
      "STENSIBLY_GMAIL_PUBSUB_SERVICE_ACCOUNT",
    ),
  });
  return Object.freeze({ runtime, verifier });
}

export async function handleGmailPubSubRequest(
  request: Request,
  mount: GmailUnattendedMount | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== GMAIL_PUBSUB_PATH) return null;
  if (!mount) return new Response("Gmail intake unavailable", { status: 503 });
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  try {
    await mount.verifier.verifyAuthorizationHeader(request.headers.get("authorization"));
  } catch (error) {
    if (error instanceof GooglePubSubAuthenticationError) {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response("Unauthorized", { status: 401 });
  }
  let envelope: unknown;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength < 2 || bytes.byteLength > maximumPushBodyBytes) {
      return new Response("Invalid push envelope", { status: 400 });
    }
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return new Response("Invalid push envelope", { status: 400 });
  }
  try {
    const result = await mount.runtime.receivePubSubEnvelope(envelope);
    return new Response(null, {
      status: 204,
      headers: {
        "X-Stensibly-Mailbox-Revision": String(result.revision),
        "X-Stensibly-Mailbox-Observations": String(result.admittedObservations),
      },
    });
  } catch {
    return new Response("Mailbox reconciliation failed", {
      status: 503,
      headers: { "Retry-After": "60" },
    });
  }
}

export async function runGmailScheduledReconciliation(
  mount: GmailUnattendedMount | null,
): Promise<void> {
  if (!mount) return;
  await mount.runtime.bootstrapOrCatchUp();
}

const gmailConfigNames = [
  "CONVEX_URL",
  "STENSIBLY_SERVICE_SECRET",
  "STENSIBLY_GMAIL_OAUTH_CLIENT_ID",
  "STENSIBLY_GMAIL_OAUTH_CLIENT_SECRET",
  "STENSIBLY_GMAIL_OAUTH_REFRESH_TOKEN",
  "STENSIBLY_GMAIL_MAILBOX",
  "STENSIBLY_GMAIL_MAILBOX_BINDING_ID",
  "STENSIBLY_GMAIL_WATCH_LABEL_ID",
  "STENSIBLY_GMAIL_PUBSUB_TOPIC",
  "STENSIBLY_GMAIL_PUBSUB_SUBSCRIPTION",
  "STENSIBLY_GMAIL_PUBSUB_AUDIENCE",
  "STENSIBLY_GMAIL_PUBSUB_SERVICE_ACCOUNT",
] as const satisfies readonly (keyof GmailUnattendedEnvironment)[];

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 64 * 1024) {
    throw new Error(`Gmail unattended configuration requires ${label}`);
  }
  return value;
}
