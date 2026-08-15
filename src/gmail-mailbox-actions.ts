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
const maximumListResponseBytes = 256 * 1024;
const maximumArchiveRounds = 10;

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
    const token = await this.#accessToken();
    await this.#modifyMessage(messageId, token);
  }

  async archiveMessagesWithLabels(labelIdsInput: readonly string[]): Promise<number> {
    const labelIds = labelIdsInput.map((value) => providerId(value));
    if (labelIds.length < 1 || labelIds.length > 8 || new Set(labelIds).size !== labelIds.length) {
      throw new RangeError("Gmail archive label set is invalid");
    }
    let archived = 0;
    const token = await this.#accessToken();
    for (let round = 0; round < maximumArchiveRounds; round += 1) {
      const messageIds = await this.#listMessageIds(labelIds, token);
      if (messageIds.length === 0) return archived;
      for (const messageId of messageIds) {
        await this.#modifyMessage(messageId, token);
        archived += 1;
      }
    }
    const remaining = await this.#listMessageIds(labelIds, token);
    if (remaining.length > 0) throw new GmailMailboxActionError();
    return archived;
  }

  async #accessToken(): Promise<string> {
    try {
      return accessToken(await this.#tokens.getAccessToken());
    } catch {
      throw new GmailMailboxActionError();
    }
  }

  async #listMessageIds(labelIds: readonly string[], token: string): Promise<readonly string[]> {
    const url = new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/messages`);
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("includeSpamTrash", "false");
    for (const labelId of labelIds) url.searchParams.append("labelIds", labelId);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw new GmailMailboxActionError();
    }
    if (!response.ok) throw new GmailMailboxActionError();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumListResponseBytes) throw new GmailMailboxActionError();
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new GmailMailboxActionError();
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new GmailMailboxActionError();
    const record = value as Record<string, unknown>;
    if (record.messages === undefined) return Object.freeze([]);
    if (!Array.isArray(record.messages) || record.messages.length > 100) throw new GmailMailboxActionError();
    const ids = record.messages.map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new GmailMailboxActionError();
      return providerId((message as Record<string, unknown>).id);
    });
    return Object.freeze(ids);
  }

  async #modifyMessage(messageId: string, token: string): Promise<void> {
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
    throw new RangeError("Gmail provider ID is invalid");
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
