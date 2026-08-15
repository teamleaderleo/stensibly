import type { GmailAccessTokenProvider } from "./gmail-mailbox-api.js";
import {
  GmailMailProvider,
  type GmailOutboundClient,
} from "./gmail-mail-provider.js";
import {
  GmailOutboundApiClient,
} from "./gmail-outbound-api.js";
import {
  MailOutboundService,
  type MailPublishResult,
  type PublishMailThreadCommand,
} from "./mail-outbound-service.js";
import {
  freezeMailboxBinding,
  type MailOutboundEffectRecord,
} from "./mail-provider.js";
import type { MailThreadStore } from "./mail-thread-store.js";

export type HostedGmailOutboundMaterial = Omit<
  PublishMailThreadCommand,
  "workspace" | "project" | "mailbox" | "continuationRoute"
>;

export interface HostedGmailOutboundBinding {
  workspace: string;
  project: string;
  accountBinding: string;
  mailboxAddress: string;
  sourceSystem?: string;
}

export interface HostedGmailOutboundServiceOptions {
  store: MailThreadStore;
  gmailClient: GmailOutboundClient;
  binding: HostedGmailOutboundBinding;
  now?: () => string;
}

export interface CreateHostedGmailOutboundServiceOptions
  extends Omit<HostedGmailOutboundServiceOptions, "gmailClient"> {
  tokenProvider: GmailAccessTokenProvider;
  gmailApiBaseUrl?: string;
  fetch?: typeof fetch;
}

export class HostedGmailOutboundService {
  readonly #store: MailThreadStore;
  readonly #service: MailOutboundService;
  readonly #workspace: string;
  readonly #project: string;
  readonly #mailbox: Readonly<{
    provider: "gmail";
    accountBinding: string;
    mailboxAddress: string;
  }>;
  readonly #sourceSystem: string;

  constructor(options: HostedGmailOutboundServiceOptions) {
    if (!options || typeof options !== "object") throw new TypeError("Hosted Gmail outbound options are required");
    this.#store = options.store;
    this.#workspace = workspaceSlug(options.binding.workspace);
    this.#project = identifier(options.binding.project, "Hosted Gmail project", 120);
    const mailbox = freezeMailboxBinding({
      provider: "gmail",
      accountBinding: options.binding.accountBinding,
      mailboxAddress: options.binding.mailboxAddress,
    });
    this.#mailbox = Object.freeze({
      provider: "gmail",
      accountBinding: mailbox.accountBinding,
      mailboxAddress: mailbox.mailboxAddress,
    });
    this.#sourceSystem = presentationName(options.binding.sourceSystem ?? "GitHub", "Hosted Gmail source system");
    this.#service = new MailOutboundService({
      store: options.store,
      provider: new GmailMailProvider(options.gmailClient, { now: options.now }),
      now: options.now,
    });
  }

  async publish(material: HostedGmailOutboundMaterial): Promise<MailPublishResult> {
    return await this.#service.publish({
      ...material,
      workspace: this.#workspace,
      project: this.#project,
      mailbox: this.#mailbox,
      continuationRoute: {
        mailProvider: "Gmail",
        sourceSystem: this.#sourceSystem,
      },
    });
  }

  async reconcile(outboundEffectId: string): Promise<MailPublishResult | null> {
    return await this.#service.reconcile({
      outboundEffectId: identifier(outboundEffectId, "Hosted Gmail outbound effect ID", 240),
      mailbox: this.#mailbox,
    });
  }

  async getThreadByHandle(handle: string) {
    return await this.#service.getThreadByHandle(handle);
  }

  async getKnownOutboundProviderMessage(
    providerMessageId: string,
  ): Promise<MailOutboundEffectRecord | null> {
    return await this.#store.getDeliveryEffectByProviderMessageId(
      "gmail",
      this.#mailbox.accountBinding,
      identifier(providerMessageId, "Hosted Gmail provider message ID", 320),
    );
  }
}

export function createHostedGmailOutboundService(
  options: CreateHostedGmailOutboundServiceOptions,
): HostedGmailOutboundService {
  const gmailClient = new GmailOutboundApiClient({
    tokenProvider: options.tokenProvider,
    apiBaseUrl: options.gmailApiBaseUrl,
    fetch: options.fetch,
  });
  return new HostedGmailOutboundService({
    store: options.store,
    gmailClient,
    binding: options.binding,
    now: options.now,
  });
}

function workspaceSlug(value: string): string {
  if (typeof value !== "string") throw new TypeError("Hosted Gmail workspace is invalid");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/u.test(normalized) || normalized.length > 80) {
    throw new TypeError("Hosted Gmail workspace is invalid");
  }
  return normalized;
}

function identifier(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@+-]*$/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function presentationName(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 80
    || value !== value.trim()
    || /[\r\n\u0000]/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}
