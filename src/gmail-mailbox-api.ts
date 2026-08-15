import { receiverSafeFetch } from "./fetch-implementation.js";
import {
  GmailHistoryCursorExpiredError,
  type GmailHistoryClient,
  type GmailHistoryMessageRef,
  type GmailHistoryPage,
  type GmailHistoryRecord,
} from "./gmail-mailbox-intake.js";

export interface GmailAccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface GmailMailboxApiClientOptions {
  tokenProvider: GmailAccessTokenProvider;
  topicName: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

export class GmailMailboxProviderError extends Error {
  readonly operation: "history" | "watch" | "credential" | "transport" | "response";
  readonly status: number | null;

  constructor(input: {
    operation: GmailMailboxProviderError["operation"];
    status?: number | null;
  }) {
    const status = input.status ?? null;
    super(
      status === null
        ? `Gmail provider ${input.operation} failed`
        : `Gmail provider ${input.operation} failed with status ${status}`,
    );
    this.name = "GmailMailboxProviderError";
    this.operation = input.operation;
    this.status = status;
  }
}

const defaultApiBaseUrl = "https://gmail.googleapis.com";
const maximumProviderJsonBytes = 2 * 1024 * 1024;
const maximumHistoryRecords = 500;
const maximumChangeItems = 500;
const maximumLabels = 256;
const historyIdPattern = /^[1-9][0-9]{0,39}$/u;
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,1023}$/u;
const pageTokenPattern = /^[^\u0000-\u001f\u007f-\u009f]{1,4096}$/u;
const historyTypes = [
  "messageAdded",
  "messageDeleted",
  "labelAdded",
  "labelRemoved",
] as const;

export class GmailMailboxApiClient implements GmailHistoryClient {
  readonly #tokens: GmailAccessTokenProvider;
  readonly #topicName: string;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GmailMailboxApiClientOptions) {
    if (!options || typeof options !== "object") {
      throw new RangeError("Gmail mailbox API options are required");
    }
    if (
      !options.tokenProvider
      || typeof options.tokenProvider.getAccessToken !== "function"
    ) {
      throw new RangeError("Gmail access token provider is required");
    }
    this.#tokens = options.tokenProvider;
    this.#topicName = topicName(options.topicName);
    this.#apiBaseUrl = apiBaseUrl(options.apiBaseUrl ?? defaultApiBaseUrl);
    this.#fetch = receiverSafeFetch(options.fetch);
  }

  async listHistory(request: {
    startHistoryId: string;
    labelId: string;
    pageToken?: string;
  }): Promise<GmailHistoryPage> {
    const startHistoryId = gmailHistoryId(
      request.startHistoryId,
      "Gmail history start cursor",
    );
    const labelId = providerId(request.labelId, "Gmail history label ID");
    const url = new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/history`);
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("labelId", labelId);
    url.searchParams.set("maxResults", "500");
    for (const historyType of historyTypes) {
      url.searchParams.append("historyTypes", historyType);
    }
    if (request.pageToken !== undefined) {
      url.searchParams.set(
        "pageToken",
        pageToken(request.pageToken),
      );
    }

    const response = await this.#request(url, {
      method: "GET",
    }, "history");
    if (response.status === 404) {
      throw new GmailHistoryCursorExpiredError();
    }
    if (!response.ok) {
      throw new GmailMailboxProviderError({
        operation: "history",
        status: response.status,
      });
    }
    return mapHistoryPage(await readProviderJson(response));
  }

  async renewWatch(request: {
    labelIds: string[];
    labelFilterBehavior: "include";
  }): Promise<{ historyId: string; expiration: string }> {
    if (
      !Array.isArray(request.labelIds)
      || request.labelIds.length !== 1
    ) {
      throw new RangeError("Gmail watch requires exactly one mailbox label");
    }
    if (request.labelFilterBehavior !== "include") {
      throw new RangeError("Gmail watch must include the configured mailbox label");
    }
    const labelId = providerId(request.labelIds[0], "Gmail watch label ID");
    const response = await this.#request(
      new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/watch`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          topicName: this.#topicName,
          labelIds: [labelId],
          labelFilterBehavior: "include",
        }),
      },
      "watch",
    );
    if (!response.ok) {
      throw new GmailMailboxProviderError({
        operation: "watch",
        status: response.status,
      });
    }
    const value = record(await readProviderJson(response), "Gmail watch response");
    return Object.freeze({
      historyId: gmailHistoryId(value.historyId, "Gmail watch history ID"),
      expiration: epochMillis(value.expiration, "Gmail watch expiration"),
    });
  }

  async #request(
    url: URL,
    init: RequestInit,
    operation: "history" | "watch",
  ): Promise<Response> {
    let token: string;
    try {
      token = accessToken(await this.#tokens.getAccessToken());
    } catch {
      throw new GmailMailboxProviderError({ operation: "credential" });
    }

    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", "stensibly");
    try {
      return await this.#fetch(url, {
        ...init,
        headers,
      });
    } catch {
      throw new GmailMailboxProviderError({ operation: "transport" });
    }
  }
}

function mapHistoryPage(value: unknown): GmailHistoryPage {
  const page = record(value, "Gmail history response");
  const history = page.history === undefined
    ? undefined
    : boundedArray(page.history, maximumHistoryRecords, "Gmail history records")
      .map(mapHistoryRecord);
  const nextPageToken = page.nextPageToken === undefined
    ? undefined
    : pageToken(page.nextPageToken);
  return Object.freeze({
    ...(history === undefined ? {} : { history }),
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
    historyId: gmailHistoryId(page.historyId, "Gmail history response cursor"),
  });
}

function mapHistoryRecord(value: unknown): GmailHistoryRecord {
  const source = record(value, "Gmail history record");
  return Object.freeze({
    id: gmailHistoryId(source.id, "Gmail history record ID"),
    ...mapChangeArray(source.messagesAdded, "messagesAdded", (entry) => {
      const item = record(entry, "Gmail message-added record");
      return Object.freeze({
        message: mapMessageRef(item.message),
      });
    }),
    ...mapChangeArray(source.messagesDeleted, "messagesDeleted", (entry) => {
      const item = record(entry, "Gmail message-deleted record");
      return Object.freeze({
        message: mapMessageRef(item.message),
      });
    }),
    ...mapChangeArray(source.labelsAdded, "labelsAdded", (entry) => {
      const item = record(entry, "Gmail labels-added record");
      return Object.freeze({
        message: mapMessageRef(item.message),
        labelIds: mapLabelIds(item.labelIds),
      });
    }),
    ...mapChangeArray(source.labelsRemoved, "labelsRemoved", (entry) => {
      const item = record(entry, "Gmail labels-removed record");
      return Object.freeze({
        message: mapMessageRef(item.message),
        labelIds: mapLabelIds(item.labelIds),
      });
    }),
  });
}

function mapMessageRef(value: unknown): GmailHistoryMessageRef {
  const source = record(value, "Gmail history message reference");
  const threadId = source.threadId === undefined
    ? undefined
    : providerId(source.threadId, "Gmail thread ID");
  const labelIds = source.labelIds === undefined
    ? undefined
    : mapLabelIds(source.labelIds);
  return Object.freeze({
    id: providerId(source.id, "Gmail message ID"),
    ...(threadId === undefined ? {} : { threadId }),
    ...(labelIds === undefined ? {} : { labelIds }),
  });
}

function mapLabelIds(value: unknown): string[] {
  return boundedArray(value, maximumLabels, "Gmail label IDs")
    .map((label) => providerId(label, "Gmail label ID"));
}

function mapChangeArray<T>(
  value: unknown,
  key: string,
  mapper: (entry: unknown) => T,
): Record<string, T[]> {
  if (value === undefined) return {};
  return {
    [key]: boundedArray(value, maximumChangeItems, `Gmail ${key} records`)
      .map(mapper),
  };
}

async function readProviderJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (
      Number.isFinite(parsed)
      && parsed > maximumProviderJsonBytes
    ) {
      throw new GmailMailboxProviderError({ operation: "response" });
    }
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new GmailMailboxProviderError({ operation: "response" });
  }
  if (
    new TextEncoder().encode(text).byteLength > maximumProviderJsonBytes
  ) {
    throw new GmailMailboxProviderError({ operation: "response" });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GmailMailboxProviderError({ operation: "response" });
  }
}

function apiBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError("Gmail API base URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("Gmail API base URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new RangeError("Gmail API base URL is invalid");
  }
  return url.origin;
}

function topicName(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError("Gmail Pub/Sub topic name is invalid");
  }
  if (
    value.length < 1
    || value.length > 1_024
    || /[\u0000-\u0020\u007f-\u009f]/u.test(value)
  ) {
    throw new RangeError("Gmail Pub/Sub topic name is invalid");
  }
  const parts = value.split("/");
  if (
    parts.length !== 4
    || parts[0] !== "projects"
    || !parts[1]
    || parts[2] !== "topics"
    || !parts[3]
  ) {
    throw new RangeError("Gmail Pub/Sub topic name is invalid");
  }
  return value;
}

function accessToken(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 8_192
    || value !== value.trim()
    || /[\u0000-\u0020\u007f-\u009f]/u.test(value)
  ) {
    throw new RangeError("Gmail access token is invalid");
  }
  return value;
}

function gmailHistoryId(value: unknown, label: string): string {
  return exactText(value, label, 40, historyIdPattern);
}

function providerId(value: unknown, label: string): string {
  return exactText(value, label, 1_024, providerIdPattern);
}

function pageToken(value: unknown): string {
  return exactText(value, "Gmail history page token", 4_096, pageTokenPattern);
}

function epochMillis(value: unknown, label: string): string {
  return exactText(value, label, 16, /^\d{1,16}$/u);
}

function exactText(
  value: unknown,
  label: string,
  maximumLength: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || (pattern && !pattern.test(value))
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedArray(
  value: unknown,
  maximumLength: number,
  label: string,
): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new RangeError(`${label} are invalid`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}
