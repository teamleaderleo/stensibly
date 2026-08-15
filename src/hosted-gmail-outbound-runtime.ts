import {
  ConvexGmailMailboxDispositionStore,
} from "./convex-gmail-mailbox-disposition-store.js";
import {
  ConvexMailThreadStore,
  type MailOutboundConvexCaller,
} from "./convex-mail-thread-store.js";
import type { GmailAccessTokenProvider } from "./gmail-mailbox-api.js";
import {
  createHostedGmailOutboundService,
  type HostedGmailOutboundBinding,
  type HostedGmailOutboundService,
} from "./hosted-gmail-outbound-service.js";

export interface HostedGmailOutboundRuntimeOptions {
  convexClient: MailOutboundConvexCaller;
  convexServiceSecret: string;
  binding: HostedGmailOutboundBinding;
  tokenProvider: GmailAccessTokenProvider;
  gmailApiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => string;
}

export function createHostedGmailOutboundRuntime(
  options: HostedGmailOutboundRuntimeOptions,
): HostedGmailOutboundService {
  if (!options || typeof options !== "object") {
    throw new TypeError("Hosted Gmail outbound runtime options are required");
  }
  const store = new ConvexMailThreadStore({
    client: options.convexClient,
    serviceSecret: options.convexServiceSecret,
    workspace: options.binding.workspace,
  });
  const mailboxDispositionStore = new ConvexGmailMailboxDispositionStore({
    client: options.convexClient,
    serviceSecret: options.convexServiceSecret,
    workspace: options.binding.workspace,
  });
  return createHostedGmailOutboundService({
    store,
    mailboxDispositionStore,
    tokenProvider: options.tokenProvider,
    gmailApiBaseUrl: options.gmailApiBaseUrl,
    fetch: options.fetch,
    binding: options.binding,
    now: options.now,
  });
}
