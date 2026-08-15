import { receiverSafeFetch } from "./fetch-implementation.js";
import type { GmailAccessTokenProvider } from "./gmail-mailbox-api.js";

export interface GmailMailboxActionClientOptions {
  tokenProvider: GmailAccessTokenProvider;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

export class GmailMailboxActionError extends Error {
  readonly code = "gmail_mailbox_action_failed";

  constructor() {
    super("Gmail mailbox action failed");
    this.name = "GmailMailboxActionError";
  }
}

const defaultApiBaseUrl = "https://gmail.googleapis.com";
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,1023}$/u;

export class GmailMailboxActionClient {
  readonly #tokens: GmailAccessTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GmailMailboxActionClientOptions) {
    if (!options.tokenProvider || typeof options.tokenProvider.getAccessToken !== "function") {
      throw new RangeError("Gmail action token provider is required");
    }
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = apiBaseUrl(options.apiBaseUrl ?? defaultApiBaseUrl);
    this.#fetch = receiverSafeFetch(options.fetch);
  }

  async archiveMessage(messageIdInput: string): Promise<void> {
    const messageId = providerId(messageIdInput);
    let token: string;
    try {
      token = accessToken(await this.#tokens.getAccessToken());
    } catch {
      throw new GmailMailboxActionError();
    }
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#apiBaseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ removeLabelIds: ["INBOX", "UNREAD"] }),
        },
      );
    } catch {
      throw new GmailMailboxActionError();
    }
    if (!response.ok) throw new GmailMailboxActionError();
  }
}

function apiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new RangeError("Gmail action API base URL must be credential-free HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}

function providerId(value: unknown): string {
  if (typeof value !== "string" || !providerIdPattern.test(value)) {
    throw new RangeError("Gmail message ID is invalid");
  }
  return value;
}

function accessToken(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 16
    || value.length > 16 * 1024
    || /[\u0000-\u0020\u007f-\u009f]/u.test(value)
  ) throw new GmailMailboxActionError();
  return value;
}
