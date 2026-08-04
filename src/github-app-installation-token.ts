import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export const githubInstallationPermissionNames = [
  "issues",
  "metadata",
  "contents",
  "pull_requests",
  "statuses",
  "actions",
] as const;

export type GitHubInstallationPermissionName =
  typeof githubInstallationPermissionNames[number];

type GitHubWriteInstallationPermissionName = "issues" | "contents";
type GitHubReadInstallationPermissionName = Exclude<
  GitHubInstallationPermissionName,
  GitHubWriteInstallationPermissionName
>;

export type GitHubInstallationPermissionInput =
  | {
    name: GitHubWriteInstallationPermissionName;
    access: "read" | "write";
  }
  | {
    name: GitHubReadInstallationPermissionName;
    access: "read";
  };

export type GitHubInstallationTokenRequest =
  | {
    repositoryFullName: string;
    issues: "read" | "write";
  }
  | {
    repositoryFullName: string;
    permission: GitHubInstallationPermissionInput;
  };

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
  responseTimeoutMs?: number;
}

interface AdmittedInstallationTokenRequest {
  repositoryFullName: string;
  permission: Readonly<GitHubInstallationPermissionInput>;
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

interface InstallationTokenResponseLifetime {
  readonly signal: AbortSignal;
  race<T>(operation: Promise<T>): Promise<T>;
  dispose(): void;
}

interface AdmittedStreamReadResult {
  done: boolean;
  value: Uint8Array | null;
}

const githubApiVersion = "2022-11-28";
const installationTokenResponseMaximumBytes = 64 * 1024;
const installationTokenResponseMaximumChunks = 4_096;
const defaultInstallationTokenResponseTimeoutMs = 10_000;
const decimalByteLengthPattern = /^(?:0|[1-9][0-9]*)$/;
const permissionNames = new Set<string>(githubInstallationPermissionNames);

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
  readonly #responseTimeoutMs: number;
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
    const responseTimeoutMs = options.responseTimeoutMs
      ?? defaultInstallationTokenResponseTimeoutMs;
    if (
      !Number.isSafeInteger(responseTimeoutMs)
      || responseTimeoutMs < 1
      || responseTimeoutMs > 60_000
    ) {
      throw new RangeError(
        "GitHub installation token response timeout must be between 1 and 60000 milliseconds",
      );
    }
    this.#responseTimeoutMs = responseTimeoutMs;
  }

  async getInstallationToken(
    input: GitHubInstallationTokenRequest,
  ): Promise<GitHubInstallationToken> {
    const admitted = admitInstallationTokenRequest(input);
    const repositoryFullName = admitted.repositoryFullName;
    if (!this.#repositories.has(repositoryFullName)) {
      throw new GitHubProviderRejectedError(
        "github_repository_outside_installation",
        `GitHub App installation is not configured for ${repositoryFullName}`,
      );
    }
    const permission = admitted.permission;
    const cacheKey =
      `${repositoryFullName}:${permission.name}:${permission.access}`;
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
    const lifetime = responseLifetime(this.#responseTimeoutMs);
    let response: Response;
    try {
      response = await lifetime.race(this.#fetch(
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
            permissions: { [permission.name]: permission.access },
          }),
          signal: lifetime.signal,
        },
      ));
    } catch {
      lifetime.dispose();
      throw credentialTransportError("request");
    }
    if (!response.ok) {
      discardResponseBody(response);
      lifetime.dispose();
      throw githubHttpError(response.status, "mint installation token");
    }
    let payload: unknown;
    try {
      payload = await readBoundedJson(response, lifetime);
    } finally {
      lifetime.dispose();
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
    if (!hasExactPermissionScope(tokenResponse.permissions, permission)) {
      throw new GitHubProviderRejectedError(
        "github_installation_permission_insufficient",
        `GitHub App installation did not grant exact ${permission.name}:${permission.access} permission scope`,
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

function admitInstallationTokenRequest(
  input: unknown,
): AdmittedInstallationTokenRequest {
  const record = exactDataRecord(
    input,
    ["repositoryFullName", "issues", "permission"],
    ["repositoryFullName"],
    "GitHub installation token request",
  );
  const repositoryFullName = exactRepository(record.repositoryFullName);
  const hasIssues = Object.hasOwn(record, "issues");
  const hasPermission = Object.hasOwn(record, "permission");
  if (hasIssues === hasPermission) {
    throw new RangeError(
      "GitHub installation token request requires exactly one permission profile",
    );
  }
  if (hasIssues) {
    const issues = record.issues;
    if (issues !== "read" && issues !== "write") {
      throw new RangeError("GitHub App issues permission must be read or write");
    }
    return Object.freeze({
      repositoryFullName,
      permission: Object.freeze({ name: "issues", access: issues }),
    });
  }
  return Object.freeze({
    repositoryFullName,
    permission: admitPermission(record.permission),
  });
}

function admitPermission(value: unknown): Readonly<GitHubInstallationPermissionInput> {
  const record = exactDataRecord(
    value,
    ["name", "access"],
    ["name", "access"],
    "GitHub installation permission profile",
  );
  const name = record.name;
  if (typeof name !== "string" || !permissionNames.has(name)) {
    throw new RangeError("GitHub installation permission name is unsupported");
  }
  const access = record.access;
  if (access !== "read" && access !== "write") {
    throw new RangeError("GitHub installation permission access is invalid");
  }
  if (name !== "issues" && name !== "contents" && access !== "read") {
    throw new RangeError(
      `GitHub installation permission ${name} supports read access only`,
    );
  }
  return Object.freeze({
    name: name as GitHubInstallationPermissionName,
    access,
  } as GitHubInstallationPermissionInput);
}

function exactDataRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must use a plain or null prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const allowed = new Set<string>(allowedFields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) {
      throw new RangeError(`${label} has an unknown field`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RangeError(
        `${label} field ${key} must be an enumerable data property`,
      );
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(result, key)) {
      throw new RangeError(`${label} is missing field ${key}`);
    }
  }
  return result;
}

function exactRepository(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("GitHub installation token repository must be a string");
  }
  if (
    !value
    || value.length > 4_096
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new RangeError(
      "GitHub installation token repository must use exact printable ASCII without surrounding whitespace",
    );
  }
  return normalizeGitHubRepository(value).toLowerCase();
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

function responseLifetime(timeoutMs: number): InstallationTokenResponseLifetime {
  const controller = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(credentialTransportError("response"));
    }, timeoutMs);
  });
  return Object.freeze({
    signal: controller.signal,
    race<T>(operation: Promise<T>): Promise<T> {
      if (disposed) {
        return Promise.reject(credentialTransportError("response"));
      }
      return Promise.race([operation, timeout]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  });
}

function discardResponseBody(response: Response): void {
  try {
    suppressCancellation(response.body?.cancel());
  } catch {
    // Provider body disposal never changes the fixed status-derived diagnostic.
  }
}

async function readBoundedJson(
  response: Response,
  lifetime: InstallationTokenResponseLifetime,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!decimalByteLengthPattern.test(declaredLength)) {
      discardResponseBody(response);
      throw invalidCredentialResponse(
        "GitHub installation token response declared an invalid content length",
      );
    }
    const declaredBytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(declaredBytes)
      || declaredBytes > installationTokenResponseMaximumBytes
    ) {
      discardResponseBody(response);
      throw credentialResponseTooLarge();
    }
  }

  if (!("body" in response)) {
    throw credentialTransportError("response");
  }
  const body = response.body;
  if (body === null) return {};
  const bytes = await readBoundedBody(body, lifetime);
  if (bytes.byteLength === 0) return {};

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidCredentialResponse(
      "GitHub installation token response was not valid UTF-8",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidCredentialResponse("GitHub returned a non-JSON response");
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  lifetime: InstallationTokenResponseLifetime,
): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    throw credentialTransportError("response");
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let chunkCount = 0;
  let failure: GitHubProviderRejectedError | undefined;
  try {
    while (true) {
      const next = admitStreamReadResult(
        await lifetime.race(reader.read()),
      );
      if (next.done) break;
      chunkCount += 1;
      if (chunkCount > installationTokenResponseMaximumChunks) {
        throw invalidCredentialResponse(
          "GitHub installation token response exceeded its work limit",
        );
      }
      const value = next.value;
      if (!(value instanceof Uint8Array)) {
        throw invalidCredentialResponse(
          "GitHub installation token response body was invalid",
        );
      }
      const nextLength = byteLength + value.byteLength;
      if (
        !Number.isSafeInteger(nextLength)
        || nextLength > installationTokenResponseMaximumBytes
      ) {
        throw credentialResponseTooLarge();
      }
      byteLength = nextLength;
      if (value.byteLength === 0) continue;
      const copy = new Uint8Array(value.byteLength);
      Uint8Array.prototype.set.call(copy, value);
      chunks.push(copy);
    }
  } catch (error) {
    failure = error instanceof GitHubProviderRejectedError
      ? error
      : credentialTransportError("response");
    cancelReader(reader);
  }

  try {
    reader.releaseLock();
  } catch {
    failure ??= credentialTransportError("response");
  }
  if (failure) throw failure;

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function admitStreamReadResult(value: unknown): AdmittedStreamReadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCredentialResponse(
      "GitHub installation token response body was invalid",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidCredentialResponse(
      "GitHub installation token response body was invalid",
    );
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw invalidCredentialResponse(
      "GitHub installation token response body was invalid",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["done", "value"]);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !allowed.has(key)
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw invalidCredentialResponse(
        "GitHub installation token response body was invalid",
      );
    }
  }
  const done = descriptors.done;
  if (!done || !("value" in done) || typeof done.value !== "boolean") {
    throw invalidCredentialResponse(
      "GitHub installation token response body was invalid",
    );
  }
  if (done.value) {
    const terminalValue = descriptors.value;
    if (
      terminalValue
      && (!("value" in terminalValue) || terminalValue.value !== undefined)
    ) {
      throw invalidCredentialResponse(
        "GitHub installation token response body was invalid",
      );
    }
    return { done: true, value: null };
  }
  const chunk = descriptors.value;
  if (!chunk || !("value" in chunk) || !(chunk.value instanceof Uint8Array)) {
    throw invalidCredentialResponse(
      "GitHub installation token response body was invalid",
    );
  }
  return { done: false, value: chunk.value };
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    suppressCancellation(reader.cancel());
  } catch {
    // The fixed response failure remains authoritative.
  }
}

function suppressCancellation(value: unknown): void {
  if (
    value !== null
    && (typeof value === "object" || typeof value === "function")
    && "then" in value
  ) {
    void Promise.resolve(value).catch(() => undefined);
  }
}

function credentialResponseTooLarge(): GitHubProviderRejectedError {
  return invalidCredentialResponse(
    `GitHub installation token response exceeded ${installationTokenResponseMaximumBytes} bytes`,
  );
}

function invalidCredentialResponse(message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_provider_invalid_response",
    message,
  );
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
  requested: Readonly<GitHubInstallationPermissionInput>,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set<string>([requested.name]);
  if (requested.name !== "metadata") allowed.add("metadata");
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key) || !descriptor.enumerable || !("value" in descriptor)) {
      return false;
    }
  }
  const requestedDescriptor = descriptors[requested.name];
  if (
    !requestedDescriptor
    || !("value" in requestedDescriptor)
    || requestedDescriptor.value !== requested.access
  ) return false;
  const metadata = descriptors.metadata;
  return !metadata || ("value" in metadata && metadata.value === "read");
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
