import { receiverSafeFetch } from "./fetch-implementation.js";
import type { GmailAccessTokenProvider } from "./gmail-mailbox-api.js";

export interface GoogleOAuthRefreshTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenEndpoint?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GoogleOAuthRefreshError extends Error {
  readonly code = "google_oauth_refresh_failed";

  constructor() {
    super("Google OAuth credential refresh failed");
    this.name = "GoogleOAuthRefreshError";
  }
}

interface CachedAccessToken {
  readonly value: string;
  readonly expiresAt: number;
}

const defaultTokenEndpoint = "https://oauth2.googleapis.com/token";
const maximumResponseBytes = 128 * 1024;
const refreshSkewMs = 60_000;

export class GoogleOAuthRefreshTokenProvider implements GmailAccessTokenProvider {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #refreshToken: string;
  readonly #tokenEndpoint: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #cached: CachedAccessToken | null = null;
  #pending: Promise<string> | null = null;

  constructor(options: GoogleOAuthRefreshTokenProviderOptions) {
    this.#clientId = secret(options.clientId, "Google OAuth client ID");
    this.#clientSecret = secret(options.clientSecret, "Google OAuth client secret");
    this.#refreshToken = secret(options.refreshToken, "Google OAuth refresh token");
    this.#tokenEndpoint = httpsUrl(options.tokenEndpoint ?? defaultTokenEndpoint);
    this.#fetch = receiverSafeFetch(options.fetch);
    this.#now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const now = this.#now();
    if (this.#cached && this.#cached.expiresAt - refreshSkewMs > now) {
      return this.#cached.value;
    }
    if (this.#pending) return await this.#pending;
    this.#pending = this.#refresh();
    try {
      return await this.#pending;
    } finally {
      this.#pending = null;
    }
  }

  async #refresh(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      refresh_token: this.#refreshToken,
      grant_type: "refresh_token",
    });
    let response: Response;
    try {
      response = await this.#fetch(this.#tokenEndpoint, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch {
      throw new GoogleOAuthRefreshError();
    }
    if (!response.ok) throw new GoogleOAuthRefreshError();
    const value = await boundedJson(response);
    const token = accessToken(data(value, "access_token"));
    const expiresIn = positiveInteger(data(value, "expires_in"), "Google OAuth token lifetime");
    this.#cached = Object.freeze({
      value: token,
      expiresAt: this.#now() + expiresIn * 1_000,
    });
    return token;
  }
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumResponseBytes) throw new GoogleOAuthRefreshError();
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new GoogleOAuthRefreshError();
  }
}

function data(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new GoogleOAuthRefreshError();
  return descriptor.value;
}

function accessToken(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 16
    || value.length > 16 * 1024
    || /[\u0000-\u0020\u007f-\u009f]/u.test(value)
  ) throw new GoogleOAuthRefreshError();
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 86_400) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function secret(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 64 * 1024) {
    throw new RangeError(`${label} is required`);
  }
  return value;
}

function httpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("Google OAuth token endpoint is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new RangeError("Google OAuth token endpoint must be a credential-free HTTPS URL");
  }
  return url.toString();
}
