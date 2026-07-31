import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export interface GitHubInstallationTokenRequest {
  repositoryFullName: string;
  issues: "read" | "write";
}

export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
}

export interface GitHubInstallationTokenProvider {
  getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<GitHubInstallationToken>;
}

export interface GitHubAppInstallationTokenMinterOptions {
  appId: string;
  installationId: string;
  accountLogin: string;
  privateKeyPem: string;
  repositoryFullNames: string[];
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  refreshSkewSeconds?: number;
}

interface CachedToken extends GitHubInstallationToken {
  expiresAtMs: number;
}

interface InstallationTokenResponse {
  token?: unknown;
  expires_at?: unknown;
  permissions?: unknown;
  repository_selection?: unknown;
  repositories?: unknown;
}

const githubApiVersion = "2022-11-28";

/**
 * Mints short-lived, repository-narrowed GitHub App installation tokens.
 * Token material remains in process memory and never enters provider receipts.
 */
export class GitHubAppInstallationTokenMinter
  implements GitHubInstallationTokenProvider
{
  readonly #appId: string;
  readonly #installationId: string;
  readonly #accountLogin: string;
  readonly #privateKey: KeyObject;
  readonly #repositories: Set<string>;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #refreshSkewMs: number;
  readonly #cache = new Map<string, CachedToken>();

  constructor(options: GitHubAppInstallationTokenMinterOptions) {
    this.#appId = numericIdentifier(options.appId, "GitHub App ID");
    this.#installationId = numericIdentifier(
      options.installationId,
      "GitHub App installation ID",
    );
    this.#accountLogin = githubLogin(options.accountLogin);
    this.#repositories = new Set(
      options.repositoryFullNames.map((repository) =>
        normalizeGitHubRepository(repository).toLowerCase()
      ),
    );
    if (!this.#repositories.size) {
      throw new Error("GitHub App token minter requires at least one repository");
    }
    for (const repository of this.#repositories) {
      const [owner] = repository.split("/");
      if (owner !== this.#accountLogin) {
        throw new Error(
          `GitHub App repository ${repository} is outside installation account ${this.#accountLogin}`,
        );
      }
    }
    this.#privateKey = createPrivateKey(normalizePrivateKey(options.privateKeyPem));
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    const refreshSkewSeconds = options.refreshSkewSeconds ?? 60;
    if (
      !Number.isFinite(refreshSkewSeconds)
      || refreshSkewSeconds < 0
      || refreshSkewSeconds > 600
    ) {
      throw new RangeError(
        "GitHub installation token refresh skew must be between 0 and 600 seconds",
      );
    }
    this.#refreshSkewMs = refreshSkewSeconds * 1_000;
  }

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<GitHubInstallationToken> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    if (!this.#repositories.has(repositoryFullName)) {
      throw new GitHubProviderRejectedError(
        "github_repository_outside_installation",
        `GitHub App installation is not configured for ${repositoryFullName}`,
      );
    }
    const issues = input.issues;
    if (issues !== "read" && issues !== "write") {
      throw new RangeError("GitHub App issues permission must be read or write");
    }
    const cacheKey = `${repositoryFullName}:${issues}`;
    const cached = this.#cache.get(cacheKey);
    const now = this.#now();
    if (!Number.isFinite(now)) {
      throw new GitHubProviderRejectedError(
        "github_credential_mint_failed",
        "GitHub installation token mint requires a valid current time",
      );
    }
    if (cached && cached.expiresAtMs - this.#refreshSkewMs > now) {
      return { token: cached.token, expiresAt: cached.expiresAt };
    }

    const [, repository] = repositoryFullName.split("/");
    const appJwt = this.#createAppJwt(now);
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#apiBaseUrl}/app/installations/${this.#installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${appJwt}`,
            "Content-Type": "application/json",
            "User-Agent": "stensibly",
            "X-GitHub-Api-Version": githubApiVersion,
          },
          body: JSON.stringify({
            repositories: [repository],
            permissions: { issues },
          }),
        },
      );
    } catch {
      throw credentialTransportError("request");
    }
    const payload = await readJson(response);
    if (!response.ok) {
      throw githubHttpError(response.status, "mint installation token");
    }
    const tokenResponse = payload as InstallationTokenResponse;
    const token = secretString(tokenResponse.token, "GitHub installation token");
    const expiresAt = timestamp(tokenResponse.expires_at, "GitHub installation token expiry");
    const expiresAtMs = Date.parse(expiresAt);
    if (expiresAtMs <= now + this.#refreshSkewMs) {
      throw new GitHubProviderRejectedError(
        "github_credential_mint_failed",
        "GitHub returned an installation token without a usable lifetime",
      );
    }
    if (!hasExactPermissionScope(tokenResponse.permissions, issues)) {
      throw new GitHubProviderRejectedError(
        "github_installation_permission_insufficient",
        `GitHub App installation did not grant exact issues:${issues} permission scope`,
      );
    }
    if (!hasExactRepositoryScope(tokenResponse, repositoryFullName)) {
      throw new GitHubProviderRejectedError(
        "github_installation_permission_insufficient",
        `GitHub App installation did not grant exact repository ${repositoryFullName}`,
      );
    }

    this.#cache.set(cacheKey, { token, expiresAt, expiresAtMs });
    return { token, expiresAt };
  }

  #createAppJwt(nowMs: number): string {
    const issuedAt = Math.floor(nowMs / 1_000) - 60;
    const expiresAt = issuedAt + 9 * 60;
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(JSON.stringify({
      iat: issuedAt,
      exp: expiresAt,
      iss: this.#appId,
    }));
    const unsigned = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(unsigned), this.#privateKey);
    return `${unsigned}.${base64Url(signature)}`;
  }
}

function numericIdentifier(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^[1-9][0-9]{0,19}$/.test(normalized)) {
    throw new Error(`${label} must be a positive decimal identifier`);
  }
  return normalized;
}

function githubLogin(value: string): string {
  const normalized = value?.trim().toLowerCase();
  if (
    !normalized
    || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(normalized)
    || normalized.includes("--")
  ) {
    throw new Error("GitHub App installation account login is invalid");
  }
  return normalized;
}

function normalizePrivateKey(value: string): string {
  const normalized = value?.trim().replace(/\\n/g, "\n");
  if (!normalized || !normalized.includes("PRIVATE KEY")) {
    throw new Error("GitHub App private key is missing or invalid");
  }
  return normalized;
}

function normalizedApiBaseUrl(value: string): string {
  const url = new URL(value);
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && url.hostname === "localhost";
  if (!secure && !localHttp) {
    throw new Error("GitHub API base URL must use HTTPS");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw credentialTransportError("response");
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubProviderRejectedError(
      "github_provider_invalid_response",
      "GitHub returned a non-JSON response",
    );
  }
}

function credentialTransportError(
  stage: "request" | "response",
): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_credential_mint_failed",
    stage === "request"
      ? "GitHub installation token request failed before a response was available"
      : "GitHub installation token response could not be read",
  );
}

function secretString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 8_192) {
    throw new GitHubProviderRejectedError(
      "github_credential_mint_failed",
      `${label} was absent from the provider response`,
    );
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new GitHubProviderRejectedError(
      "github_credential_mint_failed",
      `${label} was absent from the provider response`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new GitHubProviderRejectedError(
      "github_credential_mint_failed",
      `${label} was invalid`,
    );
  }
  return parsed.toISOString();
}

function hasExactPermissionScope(
  value: unknown,
  issues: GitHubInstallationTokenRequest["issues"],
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const permissions = value as Record<string, unknown>;
  const keys = Object.keys(permissions);
  if (keys.some((key) => key !== "issues" && key !== "metadata")) return false;
  if (permissions.issues !== issues) return false;
  return !Object.hasOwn(permissions, "metadata") || permissions.metadata === "read";
}

function hasExactRepositoryScope(
  response: InstallationTokenResponse,
  repositoryFullName: string,
): boolean {
  if (response.repository_selection !== "selected") return false;
  const repositories = response.repositories;
  if (
    !Array.isArray(repositories)
    || repositories.length !== 1
    || Object.keys(repositories).some((key) => key !== "0")
  ) return false;
  const repository = repositories[0];
  if (
    !repository
    || typeof repository !== "object"
    || Array.isArray(repository)
    || !Object.hasOwn(repository, "full_name")
  ) return false;
  const fullName = (repository as Record<string, unknown>).full_name;
  if (typeof fullName !== "string") return false;
  try {
    return normalizeGitHubRepository(fullName).toLowerCase() === repositoryFullName;
  } catch {
    return false;
  }
}

function githubHttpError(
  status: number,
  operation: string,
): GitHubProviderRejectedError {
  const message = `GitHub could not ${operation} (HTTP ${status})`;
  if (status === 401) {
    return new GitHubProviderRejectedError("github_app_credential_rejected", message);
  }
  if (status === 403) {
    return new GitHubProviderRejectedError("github_installation_permission_denied", message);
  }
  if (status === 404) {
    return new GitHubProviderRejectedError("github_installation_absent", message);
  }
  if (status === 422) {
    return new GitHubProviderRejectedError("github_installation_request_rejected", message);
  }
  if (status === 429 || status >= 500) {
    return new GitHubProviderRejectedError("github_provider_temporarily_unavailable", message);
  }
  return new GitHubProviderRejectedError("github_credential_mint_failed", message);
}
