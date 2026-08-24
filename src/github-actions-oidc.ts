import { receiverSafeFetch } from "./fetch-implementation.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export interface GitHubActionsOidcVerifierOptions {
  audience: string;
  fetch?: typeof fetch;
  now?: () => number;
  jwksUrl?: string;
}

export interface GitHubActionsIdentity {
  readonly issuer: "https://token.actions.githubusercontent.com";
  readonly audience: string;
  readonly repository: string;
  readonly repositoryOwner: string;
  readonly ref: string;
  readonly branch: string;
  readonly sha: string;
  readonly workflowRef: string;
  readonly eventName: "push";
  readonly jti: string;
}

export class GitHubActionsAuthenticationError extends Error {
  readonly code = "github_actions_authentication_failed";

  constructor() {
    super("GitHub Actions authentication failed");
    this.name = "GitHubActionsAuthenticationError";
  }
}

interface GitHubJwk extends JsonWebKey {
  kid: string;
}

interface CachedJwks {
  keys: readonly GitHubJwk[];
  expiresAt: number;
}

const issuer = "https://token.actions.githubusercontent.com";
const defaultJwksUrl = "https://token.actions.githubusercontent.com/.well-known/jwks";
const deploySignalWorkflowPath = ".github/workflows/deploy-signal.yml";
const maxJwtBytes = 16 * 1024;
const maxJwksBytes = 512 * 1024;
const maxClockSkewSeconds = 300;
const fullRevisionPattern = /^[a-f0-9]{40}$/u;

export class GitHubActionsOidcVerifier {
  readonly #audience: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #jwksUrl: string;
  #cached: CachedJwks | null = null;

  constructor(options: GitHubActionsOidcVerifierOptions) {
    this.#audience = exactAudience(options.audience);
    this.#fetch = receiverSafeFetch(options.fetch);
    this.#now = options.now ?? Date.now;
    this.#jwksUrl = httpsUrl(options.jwksUrl ?? defaultJwksUrl);
  }

  async verifyAuthorizationHeader(header: string | null): Promise<GitHubActionsIdentity> {
    if (!header?.startsWith("Bearer ")) throw new GitHubActionsAuthenticationError();
    const jwt = header.slice("Bearer ".length);
    if (jwt.length < 32 || Buffer.byteLength(jwt, "utf8") > maxJwtBytes) {
      throw new GitHubActionsAuthenticationError();
    }
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new GitHubActionsAuthenticationError();
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const protectedHeader = jsonRecord(base64Url(encodedHeader));
    if (protectedHeader.alg !== "RS256" || typeof protectedHeader.kid !== "string") {
      throw new GitHubActionsAuthenticationError();
    }
    const payload = jsonRecord(base64Url(encodedPayload));
    if (payload.iss !== issuer) throw new GitHubActionsAuthenticationError();
    if (!audienceMatches(payload.aud, this.#audience)) throw new GitHubActionsAuthenticationError();

    const repository = exactRepository(payload.repository);
    const [repositoryOwner] = repository.split("/") as [string, string];
    if (exactText(payload.repository_owner, 128).toLowerCase() !== repositoryOwner) {
      throw new GitHubActionsAuthenticationError();
    }
    const ref = exactRef(payload.ref);
    const branch = ref.slice("refs/heads/".length);
    const sha = exactRevision(payload.sha);
    const workflowRef = exactText(payload.workflow_ref, 4096);
    const expectedWorkflowRef = `${repository}/${deploySignalWorkflowPath}@${ref}`;
    if (workflowRef.toLowerCase() !== expectedWorkflowRef.toLowerCase()) {
      throw new GitHubActionsAuthenticationError();
    }
    if (payload.event_name !== "push") throw new GitHubActionsAuthenticationError();
    if (payload.ref_type !== undefined && payload.ref_type !== "branch") {
      throw new GitHubActionsAuthenticationError();
    }
    const jti = exactText(payload.jti, 1024);

    const exp = numericDate(payload.exp);
    const iat = numericDate(payload.iat);
    const nbf = payload.nbf === undefined ? iat : numericDate(payload.nbf);
    const nowSeconds = Math.floor(this.#now() / 1_000);
    if (
      exp < nowSeconds - maxClockSkewSeconds
      || iat > nowSeconds + maxClockSkewSeconds
      || nbf > nowSeconds + maxClockSkewSeconds
    ) {
      throw new GitHubActionsAuthenticationError();
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
      throw new GitHubActionsAuthenticationError();
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
    if (!verified) throw new GitHubActionsAuthenticationError();

    return Object.freeze({
      issuer,
      audience: this.#audience,
      repository,
      repositoryOwner,
      ref,
      branch,
      sha,
      workflowRef,
      eventName: "push" as const,
      jti,
    });
  }

  async #key(kid: string): Promise<GitHubJwk> {
    const now = this.#now();
    if (!this.#cached || this.#cached.expiresAt <= now) this.#cached = await this.#loadJwks(now);
    let key = this.#cached.keys.find((candidate) => candidate.kid === kid);
    if (!key) {
      this.#cached = await this.#loadJwks(now);
      key = this.#cached.keys.find((candidate) => candidate.kid === kid);
    }
    if (!key || key.kty !== "RSA") throw new GitHubActionsAuthenticationError();
    return key;
  }

  async #loadJwks(now: number): Promise<CachedJwks> {
    let response: Response;
    try {
      response = await this.#fetch(this.#jwksUrl, { headers: { Accept: "application/json" } });
    } catch {
      throw new GitHubActionsAuthenticationError();
    }
    if (!response.ok) throw new GitHubActionsAuthenticationError();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxJwksBytes) throw new GitHubActionsAuthenticationError();
    const body = jsonRecord(bytes);
    if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 32) {
      throw new GitHubActionsAuthenticationError();
    }
    const keys = body.keys.map((key): GitHubJwk => {
      if (!key || typeof key !== "object" || Array.isArray(key)) {
        throw new GitHubActionsAuthenticationError();
      }
      const candidate = key as JsonWebKey & { kid?: unknown };
      if (typeof candidate.kid !== "string" || candidate.kid.length < 1 || candidate.kid.length > 512) {
        throw new GitHubActionsAuthenticationError();
      }
      return Object.freeze({ ...candidate, kid: candidate.kid });
    });
    const maxAge = cacheMaxAge(response.headers.get("cache-control"));
    return { keys: Object.freeze(keys), expiresAt: now + maxAge * 1_000 };
  }
}

function base64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new GitHubActionsAuthenticationError();
  try {
    return Uint8Array.from(Buffer.from(value, "base64url"));
  } catch {
    throw new GitHubActionsAuthenticationError();
  }
}

function jsonRecord(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new GitHubActionsAuthenticationError();
  }
}

function exactAudience(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 8 || value.length > 2048) {
    throw new GitHubActionsAuthenticationError();
  }
  return value;
}

function exactRepository(value: unknown): string {
  if (typeof value !== "string") throw new GitHubActionsAuthenticationError();
  try {
    return normalizeGitHubRepository(value).toLowerCase();
  } catch {
    throw new GitHubActionsAuthenticationError();
  }
}

function exactRef(value: unknown): string {
  const ref = exactText(value, 4096);
  if (!ref.startsWith("refs/heads/")) throw new GitHubActionsAuthenticationError();
  const branch = ref.slice("refs/heads/".length);
  if (!branch || branch.length > 255 || branch.includes("|")) {
    throw new GitHubActionsAuthenticationError();
  }
  return ref;
}

function exactRevision(value: unknown): string {
  if (typeof value !== "string" || !fullRevisionPattern.test(value)) {
    throw new GitHubActionsAuthenticationError();
  }
  return value;
}

function exactText(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxLength
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new GitHubActionsAuthenticationError();
  }
  return value;
}

function numericDate(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GitHubActionsAuthenticationError();
  }
  return value;
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value)
    && value.length <= 8
    && value.every((entry) => typeof entry === "string")
    && value.includes(expected);
}

function httpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new GitHubActionsAuthenticationError();
  }
  return url.toString();
}

function cacheMaxAge(value: string | null): number {
  const match = value?.match(/(?:^|,)\s*max-age=(\d+)/iu);
  if (!match) return 300;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 60 && parsed <= 86_400 ? parsed : 300;
}
