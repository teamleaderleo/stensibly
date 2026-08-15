import { receiverSafeFetch } from "./fetch-implementation.js";
import type { GmailAccessTokenProvider } from "./gmail-mailbox-api.js";
import type {
  GmailLocatedMessage,
  GmailOutboundClient,
  GmailSendRawResult,
} from "./gmail-mail-provider.js";
import {
  exactRfcMessageId,
} from "./mail-provider.js";
import {
  exactMailDisplayText,
  exactMailThreadIdentifier,
} from "./mail-thread-contract.js";

export interface GmailOutboundApiClientOptions {
  tokenProvider: GmailAccessTokenProvider;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GmailOutboundApiError extends Error {
  readonly operation: "send" | "search" | "metadata" | "credential" | "transport" | "response";
  readonly status: number | null;

  constructor(input: {
    operation: GmailOutboundApiError["operation"];
    status?: number | null;
  }) {
    const status = input.status ?? null;
    super(status === null
      ? `Gmail outbound ${input.operation} failed`
      : `Gmail outbound ${input.operation} failed with status ${status}`);
    this.name = "GmailOutboundApiError";
    this.operation = input.operation;
    this.status = status;
  }
}

const defaultApiBaseUrl = "https://gmail.googleapis.com";
const maximumJsonBytes = 512 * 1024;
const maximumCandidates = 64;
const maximumReferences = 32;

export class GmailOutboundApiClient implements GmailOutboundClient {
  readonly #tokens: GmailAccessTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: GmailOutboundApiClientOptions) {
    if (!options || typeof options !== "object") throw new TypeError("Gmail outbound API options are required");
    if (!options.tokenProvider || typeof options.tokenProvider.getAccessToken !== "function") {
      throw new TypeError("Gmail outbound access token provider is required");
    }
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = apiBaseUrl(options.apiBaseUrl ?? defaultApiBaseUrl);
    this.#fetch = receiverSafeFetch(options.fetch);
    this.#now = options.now ?? Date.now;
  }

  async sendRaw(input: { raw: string; threadId?: string }): Promise<GmailSendRawResult> {
    const raw = rawPayload(input.raw);
    const threadId = input.threadId === undefined
      ? undefined
      : providerId(input.threadId, "Gmail outbound thread ID");
    const response = await this.#request(
      new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/messages/send`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw, ...(threadId === undefined ? {} : { threadId }) }),
      },
      "send",
    );
    if (!response.ok) throw new GmailOutboundApiError({ operation: "send", status: response.status });
    const value = record(await boundedJson(response), "Gmail send response");
    return Object.freeze({
      id: providerId(value.id, "Gmail sent message ID"),
      threadId: providerId(value.threadId, "Gmail sent thread ID"),
      acceptedAt: new Date(this.#now()).toISOString(),
    });
  }

  async findMessagesByRfcMessageId(input: { rfcMessageId: string }): Promise<readonly GmailLocatedMessage[]> {
    const rfcMessageId = exactRfcMessageId(input.rfcMessageId);
    const listUrl = new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/messages`);
    listUrl.searchParams.set("q", `rfc822msgid:${rfcMessageId}`);
    listUrl.searchParams.set("maxResults", String(maximumCandidates));
    const listResponse = await this.#request(listUrl, { method: "GET" }, "search");
    if (!listResponse.ok) throw new GmailOutboundApiError({ operation: "search", status: listResponse.status });
    const list = record(await boundedJson(listResponse), "Gmail message search response");
    if (list.nextPageToken !== undefined) {
      throw new GmailOutboundApiError({ operation: "search" });
    }
    const entries = list.messages === undefined
      ? []
      : boundedArray(list.messages, maximumCandidates, "Gmail outbound search candidates");
    const candidates: GmailLocatedMessage[] = [];
    for (const entry of entries) {
      const source = record(entry, "Gmail outbound search candidate");
      const id = providerId(source.id, "Gmail outbound candidate ID");
      candidates.push(await this.#readMetadata(id, rfcMessageId));
    }
    return Object.freeze(candidates);
  }

  async #readMetadata(id: string, expectedRfcMessageId: string): Promise<GmailLocatedMessage> {
    const url = new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "metadata");
    for (const header of ["Message-ID", "X-Stensibly-Effect", "Subject", "References"]) {
      url.searchParams.append("metadataHeaders", header);
    }
    const response = await this.#request(url, { method: "GET" }, "metadata");
    if (!response.ok) throw new GmailOutboundApiError({ operation: "metadata", status: response.status });
    const value = record(await boundedJson(response), "Gmail metadata response");
    const payload = record(value.payload, "Gmail metadata payload");
    const headers = boundedArray(payload.headers, 64, "Gmail metadata headers");
    const headerMap = new Map<string, string>();
    for (const raw of headers) {
      const header = record(raw, "Gmail metadata header");
      const name = headerName(header.name);
      const text = headerValue(header.value);
      if (headerMap.has(name)) throw new GmailOutboundApiError({ operation: "metadata" });
      headerMap.set(name, text);
    }
    const rfcMessageId = exactRfcMessageId(requiredHeader(headerMap, "message-id"));
    if (rfcMessageId !== expectedRfcMessageId) throw new GmailOutboundApiError({ operation: "metadata" });
    const references = parseReferences(headerMap.get("references"));
    const internalDate = optionalEpochMillis(value.internalDate);
    return Object.freeze({
      id: providerId(value.id, "Gmail metadata message ID"),
      threadId: providerId(value.threadId, "Gmail metadata thread ID"),
      rfcMessageId,
      outboundEffectId: exactMailThreadIdentifier(
        requiredHeader(headerMap, "x-stensibly-effect"),
        "Gmail outbound effect ID",
        240,
      ),
      subject: exactMailDisplayText(requiredHeader(headerMap, "subject"), "Gmail outbound subject", 320),
      references,
      ...(internalDate === null ? {} : { acceptedAt: new Date(internalDate).toISOString() }),
    });
  }

  async #request(
    url: URL,
    init: RequestInit,
    operation: GmailOutboundApiError["operation"],
  ): Promise<Response> {
    let token: string;
    try {
      token = accessToken(await this.#tokens.getAccessToken());
    } catch {
      throw new GmailOutboundApiError({ operation: "credential" });
    }
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", "stensibly");
    try {
      return await this.#fetch(url, { ...init, headers });
    } catch {
      throw new GmailOutboundApiError({ operation: operation === "send" ? "transport" : operation });
    }
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new GmailOutboundApiError({ operation: "response" });
  }
  if (bytes.byteLength > maximumJsonBytes) throw new GmailOutboundApiError({ operation: "response" });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GmailOutboundApiError({ operation: "response" });
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${label} is invalid`);
  return value;
}

function requiredHeader(headers: ReadonlyMap<string, string>, name: string): string {
  const value = headers.get(name);
  if (value === undefined) throw new GmailOutboundApiError({ operation: "metadata" });
  return value;
}

function parseReferences(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return Object.freeze([]);
  const values = value.trim().split(/\s+/u);
  if (values.length > maximumReferences) throw new GmailOutboundApiError({ operation: "metadata" });
  return Object.freeze(values.map((entry) => exactRfcMessageId(entry)));
}

function headerName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,80}$/u.test(value)) {
    throw new GmailOutboundApiError({ operation: "metadata" });
  }
  return value.toLowerCase();
}

function headerValue(value: unknown): string {
  if (typeof value !== "string" || value.length > 16 * 1024 || /[\r\n\u0000]/u.test(value)) {
    throw new GmailOutboundApiError({ operation: "metadata" });
  }
  return value;
}

function providerId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1024
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,1023}$/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function rawPayload(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 * 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Gmail raw outbound payload is invalid");
  }
  return value;
}

function accessToken(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 16
    || value.length > 16 * 1024
    || /[\u0000-\u0020\u007f-\u009f]/u.test(value)
  ) throw new TypeError("Gmail access token is invalid");
  return value;
}

function optionalEpochMillis(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[0-9]{1,16}$/u.test(value)) {
    throw new GmailOutboundApiError({ operation: "metadata" });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GmailOutboundApiError({ operation: "metadata" });
  return parsed;
}

function apiBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("Gmail outbound API base URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new TypeError("Gmail outbound API base URL must be a credential-free HTTPS URL");
  }
  return url.toString().replace(/\/$/u, "");
}
