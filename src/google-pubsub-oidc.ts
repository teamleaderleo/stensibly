import { receiverSafeFetch } from "./fetch-implementation.js";

export interface GooglePubSubOidcVerifierOptions {
  audience: string;
  serviceAccountEmail: string;
  fetch?: typeof fetch;
  now?: () => number;
  jwksUrl?: string;
}

export interface GooglePubSubIdentity {
  readonly issuer: "accounts.google.com" | "https://accounts.google.com";
  readonly audience: string;
  readonly email: string;
  readonly subject: string;
}

export class GooglePubSubAuthenticationError extends Error {
  readonly code = "google_pubsub_authentication_failed";

  constructor() {
    super("Google Pub/Sub authentication failed");
    this.name = "GooglePubSubAuthenticationError";
  }
}

interface GoogleJwk extends JsonWebKey {
  kid: string;
}

interface CachedJwks {
  keys: readonly GoogleJwk[];
  expiresAt: number;
}

const defaultJwksUrl = "https://www.googleapis.com/oauth2/v3/certs";
const maxJwtBytes = 16 * 1024;
const maxJwksBytes = 512 * 1024;
const maxClockSkewSeconds = 300;

export class GooglePubSubOidcVerifier {
  readonly #audience: string;
  readonly #serviceAccountEmail: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #jwksUrl: string;
  #cached: CachedJwks | null = null;

  constructor(options: GooglePubSubOidcVerifierOptions) {
    this.#audience = exactAudience(options.audience);
    this.#serviceAccountEmail = exactEmail(options.serviceAccountEmail);
    this.#fetch = receiverSafeFetch(options.fetch);
    this.#now = options.now ?? Date.now;
    this.#jwksUrl = httpsUrl(options.jwksUrl ?? defaultJwksUrl);
  }

  async verifyAuthorizationHeader(header: string | null): Promise<GooglePubSubIdentity> {
    if (!header?.startsWith("Bearer ")) throw new GooglePubSubAuthenticationError();
    const jwt = header.slice("Bearer ".length);
    if (jwt.length < 32 || Buffer.byteLength(jwt, "utf8") > maxJwtBytes) {
      throw new GooglePubSubAuthenticationError();
    }
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new GooglePubSubAuthenticationError();
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const protectedHeader = jsonRecord(base64Url(encodedHeader));
    if (protectedHeader.alg !== "RS256" || typeof protectedHeader.kid !== "string") {
      throw new GooglePubSubAuthenticationError();
    }
    const payload = jsonRecord(base64Url(encodedPayload));
    const issuer = payload.iss;
    if (issuer !== "accounts.google.com" && issuer !== "https://accounts.google.com") {
      throw new GooglePubSubAuthenticationError();
    }
    if (!audienceMatches(payload.aud, this.#audience)) throw new GooglePubSubAuthenticationError();
    if (exactEmail(payload.email) !== this.#serviceAccountEmail || payload.email_verified !== true) {
      throw new GooglePubSubAuthenticationError();
    }
    const subject = identity(payload.sub);
    const exp = numericDate(payload.exp);
    const iat = numericDate(payload.iat);
    const nowSeconds = Math.floor(this.#now() / 1_000);
    if (exp < nowSeconds - maxClockSkewSeconds || iat > nowSeconds + maxClockSkewSeconds) {
      throw new GooglePubSubAuthenticationError();
    }

    const key = await this.#key(protectedHeader.kid);
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await crypto.subtle.importKey(
        "jwk",
        key,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      throw new GooglePubSubAuthenticationError();
    }
    const signed = Uint8Array.from(
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    ).buffer;
    const signature = Uint8Array.from(base64Url(encodedSignature)).buffer;
    let verified = false;
    try {
      verified = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        signature,
        signed,
      );
    } catch {
      verified = false;
    }
    if (!verified) throw new GooglePubSubAuthenticationError();
    return Object.freeze({ issuer, audience: this.#audience, email: this.#serviceAccountEmail, subject });
  }

  async #key(kid: string): Promise<GoogleJwk> {
    const now = this.#now();
    if (!this.#cached || this.#cached.expiresAt <= now) this.#cached = await this.#loadJwks(now);
    let key = this.#cached.keys.find((candidate) => candidate.kid === kid);
    if (!key) {
      this.#cached = await this.#loadJwks(now);
      key = this.#cached.keys.find((candidate) => candidate.kid === kid);
    }
    if (!key || key.kty !== "RSA") throw new GooglePubSubAuthenticationError();
    return key;
  }

  async #loadJwks(now: number): Promise<CachedJwks> {
    let response: Response;
    try {
      response = await this.#fetch(this.#jwksUrl, { headers: { Accept: "application/json" } });
    } catch {
      throw new GooglePubSubAuthenticationError();
    }
    if (!response.ok) throw new GooglePubSubAuthenticationError();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxJwksBytes) throw new GooglePubSubAuthenticationError();
    const body = jsonRecord(bytes);
    if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 32) {
      throw new GooglePubSubAuthenticationError();
    }
    const keys = body.keys.map((key): GoogleJwk => {
      if (!key || typeof key !== "object" || Array.isArray(key)) throw new GooglePubSubAuthenticationError();
      const candidate = key as JsonWebKey & { kid?: unknown };
      if (typeof candidate.kid !== "string" || candidate.kid.length < 1 || candidate.kid.length > 512) {
        throw new GooglePubSubAuthenticationError();
      }
      return Object.freeze({ ...candidate, kid: candidate.kid });
    });
    const maxAge = cacheMaxAge(response.headers.get("cache-control"));
    return { keys: Object.freeze(keys), expiresAt: now + maxAge * 1_000 };
  }
}

function base64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new GooglePubSubAuthenticationError();
  try {
    return Uint8Array.from(Buffer.from(value, "base64url"));
  } catch {
    throw new GooglePubSubAuthenticationError();
  }
}

function jsonRecord(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new GooglePubSubAuthenticationError();
  }
}

function exactAudience(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 8 || value.length > 2048) {
    throw new GooglePubSubAuthenticationError();
  }
  return value;
}

function exactEmail(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length > 320 || !/^[^\s@]+@[^\s@]+$/u.test(value)) {
    throw new GooglePubSubAuthenticationError();
  }
  return value.toLowerCase();
}

function identity(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new GooglePubSubAuthenticationError();
  }
  return value;
}

function numericDate(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new GooglePubSubAuthenticationError();
  return value;
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.length <= 8 && value.every((entry) => typeof entry === "string") && value.includes(expected);
}

function httpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new GooglePubSubAuthenticationError();
  return url.toString();
}

function cacheMaxAge(value: string | null): number {
  const match = value?.match(/(?:^|,)\s*max-age=(\d+)/iu);
  if (!match) return 300;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 60 && parsed <= 86_400 ? parsed : 300;
}
