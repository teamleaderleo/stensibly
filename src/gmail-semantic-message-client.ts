import { receiverSafeFetch } from "./fetch-implementation.js";
import type { GmailAccessTokenProvider } from "./gmail-mailbox-api.js";

const defaultApiBaseUrl = "https://gmail.googleapis.com";
const maximumSemanticResponseBytes = 512 * 1024;
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,1023}$/u;

export interface GmailSemanticMessageClientOptions {
  readonly tokenProvider: GmailAccessTokenProvider;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
}

export interface GmailSemanticMessageSource {
  fetchAdmittedMessage(input: {
    accountBinding: string;
    providerMessageId: string;
    expectedProviderThreadId: string;
  }): Promise<unknown>;
}

/**
 * Consumer-side Gmail fetcher for #1521. It retrieves exactly one already-admitted
 * provider message and never enumerates mailbox content. The account binding is
 * an identity precondition for the caller/token provider; it is deliberately not
 * derived from message prose or recipient headers.
 */
export class GmailSemanticMessageClient implements GmailSemanticMessageSource {
  readonly #tokens: GmailAccessTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GmailSemanticMessageClientOptions) {
    if (!options || typeof options !== "object") {
      throw new RangeError("Gmail semantic message client options are required");
    }
    if (!options.tokenProvider || typeof options.tokenProvider.getAccessToken !== "function") {
      throw new RangeError("Gmail semantic message token provider is required");
    }
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = apiBaseUrl(options.apiBaseUrl ?? defaultApiBaseUrl);
    this.#fetch = receiverSafeFetch(options.fetch);
  }

  async fetchAdmittedMessage(input: {
    accountBinding: string;
    providerMessageId: string;
    expectedProviderThreadId: string;
  }): Promise<unknown> {
    exactIdentifier(input.accountBinding, "Gmail semantic account binding", 240);
    const providerMessageId = providerId(input.providerMessageId, "Gmail semantic provider message ID");
    providerId(input.expectedProviderThreadId, "Gmail semantic expected provider thread ID");
    const url = new URL(
      `${this.#apiBaseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(providerMessageId)}`,
    );
    url.searchParams.set("format", "full");
    url.searchParams.set("fields", "id,threadId,payload");

    let token: string;
    try {
      token = accessToken(await this.#tokens.getAccessToken());
    } catch {
      throw new GmailSemanticMessageProviderError("credential", null);
    }
    const headers = new Headers();
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", "stensibly");

    let response: Response;
    try {
      response = await this.#fetch(url, { method: "GET", headers });
    } catch {
      throw new GmailSemanticMessageProviderError("transport", null);
    }
    if (!response.ok) {
      throw new GmailSemanticMessageProviderError("message", response.status);
    }
    return await readBoundedJson(response);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maximumSemanticResponseBytes) {
      throw new GmailSemanticMessageProviderError("response", response.status);
    }
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new GmailSemanticMessageProviderError("response", response.status);
  }
  if (Buffer.byteLength(text, "utf8") > maximumSemanticResponseBytes) {
    throw new GmailSemanticMessageProviderError("response", response.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GmailSemanticMessageProviderError("response", response.status);
  }
}

function apiBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) {
    throw new RangeError("Gmail semantic API base URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("Gmail semantic API base URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new RangeError("Gmail semantic API base URL is invalid");
  }
  return url.origin;
}

function accessToken(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 8_192
    || value.trim() !== value
    || /[\u0000-\u0020\u007f-\u009f]/u.test(value)
  ) {
    throw new RangeError("Gmail semantic access token is invalid");
  }
  return value;
}

function providerId(value: unknown, label: string): string {
  const text = exactIdentifier(value, label, 1_024);
  if (!providerIdPattern.test(text)) throw new RangeError(`${label} is invalid`);
  return text;
}

function exactIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

export class GmailSemanticMessageProviderError extends Error {
  readonly name = "GmailSemanticMessageProviderError";
  constructor(
    readonly operation: "credential" | "transport" | "message" | "response",
    readonly status: number | null,
  ) {
    super(status === null
      ? `Gmail semantic provider ${operation} failed`
      : `Gmail semantic provider ${operation} failed with status ${status}`);
  }
}
