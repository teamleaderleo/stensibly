import type { GitHubInstallationTokenProvider } from "./github-app-installation-token.js";
import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export interface GitHubRestDelegatedReadAdapterOptions {
  connectionId: string;
  installationId: string;
  credentialRef: string;
  tokenProvider: GitHubInstallationTokenProvider;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  maximumFileBytes?: number;
}

interface AdmittedCall {
  tool: "get_repo" | "fetch_file";
  arguments: Record<string, unknown>;
  repositoryFullName: string;
  catalogueFingerprint: string;
}

interface ProviderResponse {
  payload: unknown;
  providerRequestId?: string;
}

const githubApiVersion = "2022-11-28";
const repositoryResponseMaximumBytes = 128 * 1024;
const defaultMaximumFileBytes = 128 * 1024;
const secretIdentityPattern =
  /(?:^|[/:._-])(?:(?:env|secret):\/\/|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-)/i;

/**
 * Native REST implementation for the first guarded delegated-read vertical slice.
 * The adapter is bound to one admitted connection identity at construction time.
 */
export class GitHubRestDelegatedReadAdapter
  implements GitHubDelegatedReadAdapter
{
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maximumFileBytes: number;

  constructor(options: GitHubRestDelegatedReadAdapterOptions) {
    this.#connectionId = exactIdentity(
      options.connectionId,
      "GitHub delegated connection ID",
      240,
    );
    this.#installationId = exactIdentity(
      options.installationId,
      "GitHub delegated installation ID",
      64,
    );
    this.#credentialRef = exactCredentialReference(options.credentialRef);
    this.#tokenProvider = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    const maximumFileBytes = options.maximumFileBytes
      ?? defaultMaximumFileBytes;
    if (
      !Number.isSafeInteger(maximumFileBytes)
      || maximumFileBytes < 1
      || maximumFileBytes > defaultMaximumFileBytes
    ) {
      throw new RangeError(
        "GitHub delegated maximum file bytes must be between 1 and 131072",
      );
    }
    this.#maximumFileBytes = maximumFileBytes;
  }

  async callReadTool(
    input: Parameters<GitHubDelegatedReadAdapter["callReadTool"]>[0],
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const admitted = this.#admitCall(input);
    if (admitted.tool === "get_repo") {
      const token = await this.#tokenProvider.getInstallationToken({
        repositoryFullName: admitted.repositoryFullName,
        permission: { name: "metadata", access: "read" },
      });
      const provider = await this.#getJson(
        repositoryPath(admitted.repositoryFullName),
        token.token,
        repositoryResponseMaximumBytes,
      );
      return Object.freeze({
        result: repositoryResult(
          provider.payload,
          admitted.repositoryFullName,
        ),
        ...(provider.providerRequestId
          ? { providerRequestId: provider.providerRequestId }
          : {}),
      });
    }

    const path = repositoryFilePath(admitted.arguments.path);
    const ref = commitSha(admitted.arguments.ref);
    const token = await this.#tokenProvider.getInstallationToken({
      repositoryFullName: admitted.repositoryFullName,
      permission: { name: "contents", access: "read" },
    });
    const requestPath = contentPath(
      admitted.repositoryFullName,
      path,
      ref,
    );
    const provider = await this.#getJson(
      requestPath,
      token.token,
      maximumFileResponseBytes(this.#maximumFileBytes),
    );
    return Object.freeze({
      result: fileResult(
        provider.payload,
        admitted.repositoryFullName,
        path,
        ref,
        this.#maximumFileBytes,
        this.#apiBaseUrl,
      ),
      ...(provider.providerRequestId
        ? { providerRequestId: provider.providerRequestId }
        : {}),
    });
  }

  #admitCall(
    input: Parameters<GitHubDelegatedReadAdapter["callReadTool"]>[0],
  ): AdmittedCall {
    const record = exactDataRecord(
      input,
      [
        "tool",
        "arguments",
        "repositoryFullName",
        "connectionId",
        "installationId",
        "credentialRef",
        "catalogueFingerprint",
      ],
      [
        "tool",
        "arguments",
        "repositoryFullName",
        "connectionId",
        "installationId",
        "credentialRef",
        "catalogueFingerprint",
      ],
      "GitHub delegated adapter call",
    );
    if (
      record.connectionId !== this.#connectionId
      || record.installationId !== this.#installationId
      || record.credentialRef !== this.#credentialRef
    ) {
      throw rejected(
        "github_delegated_adapter_binding_mismatch",
        "GitHub delegated adapter call did not match its admitted connection binding",
      );
    }
    const repositoryFullName = exactRepository(record.repositoryFullName);
    const catalogueFingerprint = exactFingerprint(record.catalogueFingerprint);
    const tool = record.tool;
    if (tool !== "get_repo" && tool !== "fetch_file") {
      throw rejected(
        "github_delegated_tool_unsupported",
        "GitHub delegated adapter tool is outside the enabled native subset",
      );
    }
    const argumentsRecord = exactDataRecord(
      record.arguments,
      tool === "get_repo" ? [] : ["path", "ref"],
      tool === "get_repo" ? [] : ["path", "ref"],
      `GitHub delegated ${tool} arguments`,
    );
    return Object.freeze({
      tool,
      arguments: Object.freeze(argumentsRecord),
      repositoryFullName,
      catalogueFingerprint,
    });
  }

  async #getJson(
    relativePath: string,
    token: string,
    maximumBytes: number,
  ): Promise<ProviderResponse> {
    const url = `${this.#apiBaseUrl}/${relativePath}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": githubApiVersion,
        },
      });
    } catch {
      throw rejected(
        "github_delegated_provider_request_failed",
        "GitHub delegated provider request failed before a response was available",
      );
    }
    if (!response.ok) throw providerHttpError(response.status);
    const contentType = response.headers.get("content-type");
    if (
      contentType
      && !contentType.toLowerCase().includes("json")
    ) {
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated provider returned an unsupported content type",
      );
    }
    const payload = await readBoundedJson(response, maximumBytes);
    const providerRequestId = providerRequestIdentity(
      response.headers.get("x-github-request-id"),
    );
    return {
      payload,
      ...(providerRequestId ? { providerRequestId } : {}),
    };
  }
}

function repositoryResult(
  value: unknown,
  repositoryFullName: string,
): Readonly<Record<string, unknown>> {
  const record = jsonRecord(value, "GitHub repository response");
  const fullName = exactRepository(record.full_name);
  if (fullName !== repositoryFullName) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated repository response did not match the accepted repository",
    );
  }
  const pushedAt = record.pushed_at === null
    ? null
    : exactTimestamp(record.pushed_at, "GitHub repository pushed timestamp");
  return Object.freeze({
    repositoryFullName,
    id: positiveSafeInteger(record.id, "GitHub repository ID"),
    nodeId: exactText(record.node_id, "GitHub repository node ID", 160),
    private: booleanValue(record.private, "GitHub repository private flag"),
    archived: booleanValue(record.archived, "GitHub repository archived flag"),
    disabled: booleanValue(record.disabled, "GitHub repository disabled flag"),
    visibility: visibilityValue(record.visibility),
    defaultBranch: exactText(
      record.default_branch,
      "GitHub repository default branch",
      512,
    ),
    updatedAt: exactTimestamp(
      record.updated_at,
      "GitHub repository updated timestamp",
    ),
    pushedAt,
  });
}

function fileResult(
  value: unknown,
  repositoryFullName: string,
  requestedPath: string,
  ref: string,
  maximumFileBytes: number,
  apiBaseUrl: string,
): Readonly<Record<string, unknown>> {
  const record = jsonRecord(value, "GitHub file response");
  if (record.type !== "file") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated file response was not a file",
    );
  }
  const path = repositoryFilePath(record.path);
  if (path !== requestedPath) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated file response path did not match the requested file",
    );
  }
  const blobSha = commitSha(record.sha);
  const size = nonNegativeSafeInteger(record.size, "GitHub file size");
  if (size > maximumFileBytes) {
    throw rejected(
      "github_delegated_provider_result_too_large",
      `GitHub delegated file exceeds ${maximumFileBytes} bytes`,
    );
  }
  if (record.encoding !== "base64" || typeof record.content !== "string") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated file response requires base64 content",
    );
  }
  if (Buffer.byteLength(record.content, "utf8") > maximumFileResponseBytes(maximumFileBytes)) {
    throw rejected(
      "github_delegated_provider_result_too_large",
      "GitHub delegated file encoding exceeds the response budget",
    );
  }
  const compactContent = record.content.replace(/\r?\n/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compactContent)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated file response contained invalid base64",
    );
  }
  const content = Buffer.from(compactContent, "base64");
  if (content.byteLength !== size || content.byteLength > maximumFileBytes) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated file size did not match its decoded content",
    );
  }
  verifyProviderApiUrl(
    record.url,
    apiBaseUrl,
    contentResourcePath(repositoryFullName, path),
    "GitHub file content URL",
  );
  verifyProviderApiUrl(
    record.git_url,
    apiBaseUrl,
    blobResourcePath(repositoryFullName, blobSha),
    "GitHub file blob URL",
  );
  return Object.freeze({
    repositoryFullName,
    path,
    ref,
    blobSha,
    size,
    encoding: "base64",
    contentBase64: content.toString("base64"),
  });
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      throw rejected(
        "github_delegated_provider_result_too_large",
        `GitHub delegated provider response exceeds ${maximumBytes} bytes`,
      );
    }
  }
  if (!response.body) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider returned an empty response",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw rejected(
          "github_delegated_provider_result_too_large",
          `GitHub delegated provider response exceeds ${maximumBytes} bytes`,
        );
      }
      chunks.push(read.value);
    }
  } catch (error) {
    if (error instanceof GitHubProviderRejectedError) throw error;
    throw rejected(
      "github_delegated_provider_response_failed",
      "GitHub delegated provider response could not be read",
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider response was not valid UTF-8",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub delegated provider returned invalid JSON",
    );
  }
}

function exactDataRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} must use a plain or null prototype`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} contains a symbol field`,
    );
  }
  const allowed = new Set<string>(allowedFields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        `${label} has an unknown field`,
      );
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        `${label} fields must be enumerable data properties`,
      );
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(result, key)) {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        `${label} is missing a required field`,
      );
    }
  }
  return result;
}

function exactRepository(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > 4_096
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated repository must use exact printable ASCII",
    );
  }
  try {
    return normalizeGitHubRepository(value).toLowerCase();
  } catch {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated repository identity is invalid",
    );
  }
}

function exactFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated catalogue fingerprint is invalid",
    );
  }
  return value;
}

function repositoryFilePath(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > 4_096
    || Buffer.byteLength(value, "utf8") > 4_096
    || value !== value.replace(/\\/g, "/")
    || value.startsWith("/")
    || value.endsWith("/")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated file path is invalid",
    );
  }
  return value;
}

function commitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated commit/blob SHA must be 40 lowercase hexadecimal characters",
    );
  }
  return value;
}

function exactCredentialReference(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}$/.test(value)
  ) {
    throw new RangeError(
      "GitHub delegated credential reference must use env:// or secret://",
    );
  }
  return value;
}

function exactIdentity(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was absent`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return date.toISOString();
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function visibilityValue(value: unknown): "public" | "private" | "internal" {
  if (value !== "public" && value !== "private" && value !== "internal") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub repository visibility was invalid",
    );
  }
  return value;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was not an object`,
    );
  }
  return value as Record<string, unknown>;
}

function providerRequestIdentity(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (
    !value
    || value.length > 240
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
    || secretIdentityPattern.test(value)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub provider request identity was invalid",
    );
  }
  return value;
}

function verifyProviderApiUrl(
  value: unknown,
  apiBaseUrl: string,
  expectedPath: string,
  label: string,
): void {
  if (typeof value !== "string") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was absent`,
    );
  }
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(value);
    expected = new URL(`${apiBaseUrl}/${expectedPath}`);
  } catch {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  if (
    actual.protocol !== expected.protocol
    || actual.host !== expected.host
    || !providerApiPathMatches(actual.pathname, expected.pathname)
  ) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      `${label} did not match the accepted repository`,
    );
  }
}

function providerApiPathMatches(actualPath: string, expectedPath: string): boolean {
  const actualSegments = actualPath.split("/");
  const expectedSegments = expectedPath.split("/");
  if (actualSegments.length !== expectedSegments.length) return false;
  const repositoriesIndex = expectedSegments.indexOf("repos");
  if (
    repositoriesIndex < 0
    || repositoriesIndex + 2 >= expectedSegments.length
  ) {
    return actualPath === expectedPath;
  }
  return expectedSegments.every((segment, index) => {
    const actual = actualSegments[index];
    if (index === repositoriesIndex + 1 || index === repositoriesIndex + 2) {
      return actual?.toLowerCase() === segment.toLowerCase();
    }
    return actual === segment;
  });
}

function normalizedApiBaseUrl(value: string): string {
  const url = new URL(value);
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && url.hostname === "localhost";
  if (!secure && !localHttp) {
    throw new RangeError("GitHub delegated API base URL must use HTTPS");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function repositoryPath(repositoryFullName: string): string {
  const [owner, repository] = repositoryFullName.split("/");
  return `repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}`;
}

function contentPath(
  repositoryFullName: string,
  path: string,
  ref: string,
): string {
  return `${contentResourcePath(repositoryFullName, path)}?ref=${encodeURIComponent(ref)}`;
}

function contentResourcePath(repositoryFullName: string, path: string): string {
  return `${repositoryPath(repositoryFullName)}/contents/${path.split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function blobResourcePath(repositoryFullName: string, blobSha: string): string {
  return `${repositoryPath(repositoryFullName)}/git/blobs/${blobSha}`;
}

function maximumFileResponseBytes(maximumFileBytes: number): number {
  return Math.min(
    2 * 1024 * 1024,
    Math.ceil(maximumFileBytes * 4 / 3) + 64 * 1024,
  );
}

function providerHttpError(status: number): GitHubProviderRejectedError {
  const message = `GitHub delegated provider request failed (HTTP ${status})`;
  if (status === 401) {
    return rejected("github_delegated_credential_rejected", message);
  }
  if (status === 403) {
    return rejected("github_delegated_permission_denied", message);
  }
  if (status === 404) {
    return rejected("github_delegated_resource_absent", message);
  }
  if (status === 409 || status === 422) {
    return rejected("github_delegated_request_rejected", message);
  }
  if (status === 429 || status >= 500) {
    return rejected("github_delegated_provider_temporarily_unavailable", message);
  }
  return rejected("github_delegated_provider_rejected", message);
}

function rejected(code: string, message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(code, message);
}
