import { receiverSafeFetch } from "./fetch-implementation.js";
import type { GmailAccessTokenProvider } from "./gmail-mailbox-api.js";
import type {
  GmailMailboxLabelClient,
  GmailMessageLabelSnapshot,
} from "./gmail-mailbox-disposition-effect.js";

export interface GmailMailboxDispositionApiClientOptions {
  tokenProvider: GmailAccessTokenProvider;
  accountBinding: string;
  mailboxAddress: string;
  stensiblyLabelId: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

export class GmailMailboxDispositionProviderError extends Error {
  readonly operation: "read" | "mutate" | "credential" | "transport" | "response";
  readonly status: number | null;

  constructor(input: {
    operation: GmailMailboxDispositionProviderError["operation"];
    status?: number | null;
  }) {
    const status = input.status ?? null;
    super(status === null
      ? `Gmail mailbox disposition ${input.operation} failed`
      : `Gmail mailbox disposition ${input.operation} failed with status ${status}`);
    this.name = "GmailMailboxDispositionProviderError";
    this.operation = input.operation;
    this.status = status;
  }
}

const defaultApiBaseUrl = "https://gmail.googleapis.com";
const maximumResponseBytes = 128 * 1024;
const maximumLabels = 256;
const systemInboxLabel = "INBOX";
const systemUnreadLabel = "UNREAD";
const systemDraftLabel = "DRAFT";

interface RefreshableTokenProvider extends GmailAccessTokenProvider {
  invalidateAccessToken?(rejectedToken: string): void;
}

export class GmailMailboxDispositionApiClient implements GmailMailboxLabelClient {
  readonly #tokens: RefreshableTokenProvider;
  readonly #accountBinding: string;
  readonly #mailboxAddress: string;
  readonly #stensiblyLabelId: string;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GmailMailboxDispositionApiClientOptions) {
    if (!options || typeof options !== "object") throw new TypeError("Gmail disposition API options are required");
    if (!options.tokenProvider || typeof options.tokenProvider.getAccessToken !== "function") {
      throw new TypeError("Gmail disposition access token provider is required");
    }
    this.#tokens = options.tokenProvider;
    this.#accountBinding = exact(options.accountBinding, "Gmail disposition account binding", 320);
    this.#mailboxAddress = exact(options.mailboxAddress, "Gmail disposition mailbox address", 320);
    this.#stensiblyLabelId = exact(options.stensiblyLabelId, "Stensibly label ID", 160);
    if ([systemInboxLabel, systemUnreadLabel, systemDraftLabel].includes(this.#stensiblyLabelId)) {
      throw new TypeError("Stensibly label ID must be an existing non-system label");
    }
    this.#apiBaseUrl = apiBaseUrl(options.apiBaseUrl ?? defaultApiBaseUrl);
    this.#fetch = receiverSafeFetch(options.fetch);
  }

  async readMessageLabels(input: {
    accountBinding: string;
    mailboxAddress: string;
    providerThreadId: string;
    providerMessageId: string;
  }): Promise<GmailMessageLabelSnapshot | null> {
    const target = this.#target(input);
    const url = new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(target.providerMessageId)}`);
    url.searchParams.set("format", "minimal");
    url.searchParams.set("fields", "id,threadId,labelIds");
    const response = await this.#request(url, { method: "GET" }, "read");
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new GmailMailboxDispositionProviderError({ operation: "read", status: response.status });
    }
    const value = record(await boundedJson(response), "Gmail disposition message response");
    const providerMessageId = exact(value.id, "Gmail message ID", 320);
    const providerThreadId = exact(value.threadId, "Gmail thread ID", 320);
    const labelIds = labelArray(value.labelIds);
    return Object.freeze({
      source: "gmail_message_label_snapshot",
      provider: "gmail",
      accountBinding: this.#accountBinding,
      mailboxAddress: this.#mailboxAddress,
      providerThreadId,
      providerMessageId,
      labelIds,
      isDraft: labelIds.includes(systemDraftLabel),
    });
  }

  async mutateMessageLabels(input: {
    accountBinding: string;
    mailboxAddress: string;
    providerThreadId: string;
    providerMessageId: string;
    dispositionEffectId: string;
    addLabelIds: readonly string[];
    removeLabelIds: readonly string[];
  }): Promise<void> {
    const target = this.#target(input);
    exact(input.dispositionEffectId, "Gmail disposition effect ID", 4096);
    const addLabelIds = this.#mutationLabels(input.addLabelIds);
    const removeLabelIds = this.#mutationLabels(input.removeLabelIds);
    const overlap = addLabelIds.find((label) => removeLabelIds.includes(label));
    if (overlap) throw new TypeError("Gmail disposition label cannot be added and removed together");
    const url = new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(target.providerMessageId)}/modify`);
    const response = await this.#request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    }, "mutate");
    if (!response.ok) {
      throw new GmailMailboxDispositionProviderError({ operation: "mutate", status: response.status });
    }
    await discardBoundedBody(response);
  }

  #target(input: {
    accountBinding: string;
    mailboxAddress: string;
    providerThreadId: string;
    providerMessageId: string;
  }) {
    const accountBinding = exact(input.accountBinding, "Gmail disposition account binding", 320);
    const mailboxAddress = exact(input.mailboxAddress, "Gmail disposition mailbox address", 320);
    if (accountBinding !== this.#accountBinding || mailboxAddress !== this.#mailboxAddress) {
      throw new TypeError("Gmail disposition target is outside the configured mailbox binding");
    }
    return Object.freeze({
      accountBinding,
      mailboxAddress,
      providerThreadId: exact(input.providerThreadId, "Gmail thread ID", 320),
      providerMessageId: exact(input.providerMessageId, "Gmail message ID", 320),
    });
  }

  #mutationLabels(values: readonly string[]): readonly string[] {
    if (!Array.isArray(values) || values.length > 3) throw new TypeError("Gmail disposition label mutation is invalid");
    const labels = [...new Set(values.map((value) => exact(value, "Gmail label ID", 160)))];
    const allowed = new Set([this.#stensiblyLabelId, systemInboxLabel, systemUnreadLabel]);
    if (labels.some((label) => !allowed.has(label))) {
      throw new TypeError("Gmail disposition attempted a label outside the bounded policy");
    }
    return Object.freeze(labels);
  }

  async #request(
    url: URL,
    init: RequestInit,
    operation: "read" | "mutate",
  ): Promise<Response> {
    const firstToken = await this.#token();
    const first = await this.#fetchWithToken(url, init, firstToken);
    if (first.status !== 401 || typeof this.#tokens.invalidateAccessToken !== "function") return first;
    this.#tokens.invalidateAccessToken(firstToken);
    const secondToken = await this.#token();
    return await this.#fetchWithToken(url, init, secondToken, operation);
  }

  async #fetchWithToken(
    url: URL,
    init: RequestInit,
    token: string,
    operation: "read" | "mutate" = "read",
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", "stensibly");
    try {
      return await this.#fetch(url, { ...init, headers });
    } catch {
      throw new GmailMailboxDispositionProviderError({ operation: "transport" });
    }
  }

  async #token(): Promise<string> {
    try {
      return accessToken(await this.#tokens.getAccessToken());
    } catch {
      throw new GmailMailboxDispositionProviderError({ operation: "credential" });
    }
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumResponseBytes) {
    throw new GmailMailboxDispositionProviderError({ operation: "response" });
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GmailMailboxDispositionProviderError({ operation: "response" });
  }
}

async function discardBoundedBody(response: Response): Promise<void> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumResponseBytes) {
    throw new GmailMailboxDispositionProviderError({ operation: "response" });
  }
}

function labelArray(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > maximumLabels) {
    throw new GmailMailboxDispositionProviderError({ operation: "response" });
  }
  return Object.freeze([...new Set(value.map((item) => exact(item, "Gmail label ID", 160)))]);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GmailMailboxDispositionProviderError({ operation: "response" });
  }
  return value as Record<string, unknown>;
}

function apiBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) throw new TypeError("Gmail disposition API base URL is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Gmail disposition API base URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError("Gmail disposition API base URL is invalid");
  }
  return url.origin;
}

function accessToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16 * 1024 || value !== value.trim() || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) {
    throw new TypeError("Gmail disposition access token is invalid");
  }
  return value;
}

function exact(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value !== value.trim() || /[\r\n\u0000]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
