import { ConvexHttpClient } from "convex/browser";
import { ConvexMailThreadStore } from "./convex-mail-thread-store.js";
import { GmailMailboxActionClient } from "./gmail-mailbox-actions.js";
import { GmailMailboxApiClient } from "./gmail-mailbox-api.js";
import {
  GmailUnattendedRuntime,
  type GmailOutboundProviderMessageDisposition,
} from "./gmail-unattended-runtime.js";
import {
  GoogleOAuthRefreshTokenProvider,
} from "./google-oauth-refresh-token.js";
import {
  GooglePubSubAuthenticationError,
  GooglePubSubOidcVerifier,
} from "./google-pubsub-oidc.js";
import type { HostedMailboxMaterialObservationDrain } from "./mailbox-material-observation-drain.js";
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
  CF_VERSION_METADATA?: { readonly id?: string };
}

export interface GmailUnattendedMountDependencies {
  readonly materialObservationDrain?: Pick<
    HostedMailboxMaterialObservationDrain,
    "drainObservationIds" | "drainRecent"
  >;
}

export interface GmailUnattendedMount {
  readonly runtime: GmailUnattendedRuntime;
  readonly verifier: GooglePubSubOidcVerifier;
  readonly pushBindingGeneration?: string;
}

export function gmailUnattendedConfigured(env: GmailUnattendedEnvironment): boolean {
  return gmailConfigNames.every((name) => Boolean(env[name]?.trim()));
}

export function createGmailUnattendedMountFromEnv(
  env: GmailUnattendedEnvironment,
  dependencies: GmailUnattendedMountDependencies = {},
): GmailUnattendedMount | null {
  if (!gmailUnattendedConfigured(env)) return null;
  const convexUrl = required(env.CONVEX_URL, "CONVEX_URL");
  const serviceSecret = required(env.STENSIBLY_SERVICE_SECRET, "STENSIBLY_SERVICE_SECRET");
  const workspace = env.STENSIBLY_WORKSPACE ?? "default";
  const mailboxBindingId = required(
    env.STENSIBLY_GMAIL_MAILBOX_BINDING_ID,
    "STENSIBLY_GMAIL_MAILBOX_BINDING_ID",
  );
  const pushBindingGeneration = requiredVersionGeneration(env.CF_VERSION_METADATA?.id);
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
    workspace,
  });
  const outboundStore = new ConvexMailThreadStore({
    client,
    serviceSecret,
    workspace,
  });
  const outboundProviderMessageLookup = async (
    providerMessageId: string,
  ): Promise<GmailOutboundProviderMessageDisposition> => {
    const effect = await outboundStore.getDeliveryEffectByProviderMessageId(
      "gmail",
      mailboxBindingId,
      providerMessageId,
    );
    if (effect === null) return "ordinary";
    if (effect.state !== "sent" && effect.state !== "reconciled") {
      throw new Error("Hosted Gmail outbound provider-message identity requires reconciliation");
    }
    const receipt = effect.receipt;
    if (
      effect.provider !== "gmail"
      || effect.accountBinding !== mailboxBindingId
      || receipt === null
      || receipt.provider !== "gmail"
      || receipt.accountBinding !== mailboxBindingId
      || receipt.providerMessageId !== providerMessageId
      || receipt.result !== effect.state
    ) {
      throw new Error("Hosted Gmail outbound provider-message identity is ambiguous");
    }
    return "self_echo";
  };
  const runtime = new GmailUnattendedRuntime({
    mailboxAddress: required(env.STENSIBLY_GMAIL_MAILBOX, "STENSIBLY_GMAIL_MAILBOX"),
    mailboxBindingId,
    labelId: required(env.STENSIBLY_GMAIL_WATCH_LABEL_ID, "STENSIBLY_GMAIL_WATCH_LABEL_ID"),
    pubsubSubscription: requiredResourceBinding(
      env.STENSIBLY_GMAIL_PUBSUB_SUBSCRIPTION,
      "STENSIBLY_GMAIL_PUBSUB_SUBSCRIPTION",
    ),
    gmail,
    actions,
    intake,
    pushBindingGeneration,
    outboundProviderMessageLookup,
    ...(dependencies.materialObservationDrain
      ? { materialObservationDrain: dependencies.materialObservationDrain }
      : {}),
  });
  const verifier = new GooglePubSubOidcVerifier({
    audience: required(env.STENSIBLY_GMAIL_PUBSUB_AUDIENCE, "STENSIBLY_GMAIL_PUBSUB_AUDIENCE"),
    serviceAccountEmail: required(
      env.STENSIBLY_GMAIL_PUBSUB_SERVICE_ACCOUNT,
      "STENSIBLY_GMAIL_PUBSUB_SERVICE_ACCOUNT",
    ),
  });
  return Object.freeze({ runtime, verifier, pushBindingGeneration });
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
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength);
      if (
        !Number.isSafeInteger(parsedLength)
        || parsedLength < 2
        || parsedLength > maximumPushBodyBytes
      ) {
        return new Response("Invalid push envelope", { status: 400 });
      }
    }
    const bytes = await readBoundedRequestBytes(request, maximumPushBodyBytes);
    if (bytes.byteLength < 2) {
      return new Response("Invalid push envelope", { status: 400 });
    }
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return new Response("Invalid push envelope", { status: 400 });
  }
  try {
    const result = await mount.runtime.receivePubSubEnvelope(
      envelope,
      mount.pushBindingGeneration,
    );
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

async function readBoundedRequestBytes(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (request.bodyUsed || !request.body) throw new Error("Invalid Gmail push body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        try {
          await reader.cancel("Gmail push envelope exceeds the configured bound");
        } catch {
          // The stream may already be closed or errored.
        }
        throw new Error("Invalid Gmail push body");
      }
      chunks.push(next.value.slice());
    }
  } catch (error) {
    try {
      await reader.cancel("Gmail push envelope could not be read");
    } catch {
      // The stream may already be closed or errored.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

function requiredVersionGeneration(value: unknown): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length < 1
    || value.length > 1024
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/u.test(value)
  ) {
    throw new Error("Gmail unattended configuration requires CF_VERSION_METADATA.id");
  }
  return value;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 64 * 1024) {
    throw new Error(`Gmail unattended configuration requires ${label}`);
  }
  return value;
}

function requiredResourceBinding(value: unknown, label: string): string {
  return required(typeof value === "string" ? value.trim() : value, label);
}
