import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import {
  parseGitHubDelegatedReadArguments,
} from "./github-delegated-read-contracts.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  GitHubRestPullRequestReadAdapter,
  type GitHubRestPullRequestReadAdapterOptions,
} from "./github-rest-pull-request-read-adapter.js";
import {
  normalizeGitHubRepository,
  stableJson,
} from "./github-provider-validation.js";

export interface GitHubRestPullRequestDiffAdapterOptions
  extends GitHubRestPullRequestReadAdapterOptions {}

type PullRequestDiffFormat = "diff" | "patch";

interface AdmittedPullRequestDiffCall {
  arguments: Readonly<{
    pr_number: number;
    format: PullRequestDiffFormat;
  }>;
  repositoryFullName: string;
}

interface ProviderTextResponse {
  content: string;
  byteLength: number;
  providerRequestId?: string;
}

const githubApiVersion = "2022-11-28";
const pullRequestDiffMaximumBytes = 128 * 1024;
const delegatedResultMaximumBytes = 256 * 1024;
const rawMediaTypes = Object.freeze({
  diff: "application/vnd.github.v3.diff",
  patch: "application/vnd.github.v3.patch",
} as const);
const credentialShapedPublicIdentityPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+|gh[pousr]_|github_pat_|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_|xox[baprs]-|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;
const credentialShapedRetainedContentPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+[A-Za-z0-9._~+\/-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?=$|[\s:./=,;'"()\[\]{}@#_-])/imu;
const unsafeRawTextPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/**
 * Additive native REST extension for bounded pull-request diff and patch reads.
 * Existing repository, immutable-file, and pull-request metadata calls remain owned
 * by the inherited adapters.
 */
export class GitHubRestPullRequestDiffAdapter
  extends GitHubRestPullRequestReadAdapter
{
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestPullRequestDiffAdapterOptions) {
    super(options);
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
  }

  override async callReadTool(
    input: Parameters<GitHubDelegatedReadAdapter["callReadTool"]>[0],
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const envelope = exactDataRecord(
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

    if (envelope.tool !== "get_pr_diff") {
      return super.callReadTool({
        tool: envelope.tool as string,
        arguments: envelope.arguments as Record<string, unknown>,
        repositoryFullName: envelope.repositoryFullName as string,
        connectionId: envelope.connectionId as string,
        installationId: envelope.installationId as string,
        credentialRef: envelope.credentialRef as string,
        catalogueFingerprint: envelope.catalogueFingerprint as string,
      });
    }

    const admitted = this.#admitPullRequestDiffCall(envelope);
    const token = await this.#tokenProvider.getInstallationToken({
      repositoryFullName: admitted.repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    });
    const provider = await this.#getText(
      pullRequestPath(
        admitted.repositoryFullName,
        admitted.arguments.pr_number,
      ),
      token.token,
      admitted.arguments.format,
    );
    const result = Object.freeze({
      repositoryFullName: admitted.repositoryFullName,
      number: admitted.arguments.pr_number,
      format: admitted.arguments.format,
      byteLength: provider.byteLength,
      content: provider.content,
    });
    if (Buffer.byteLength(stableJson(result), "utf8") > delegatedResultMaximumBytes) {
      throw rejected(
        "github_delegated_provider_result_too_large",
        `GitHub delegated pull request ${admitted.arguments.format} exceeds the retained result budget`,
      );
    }
    return Object.freeze({
      result,
      ...(provider.providerRequestId
        ? { providerRequestId: provider.providerRequestId }
        : {}),
    });
  }

  #admitPullRequestDiffCall(
    envelope: Record<string, unknown>,
  ): AdmittedPullRequestDiffCall {
    if (
      envelope.connectionId !== this.#connectionId
      || envelope.installationId !== this.#installationId
      || envelope.credentialRef !== this.#credentialRef
    ) {
      throw rejected(
        "github_delegated_adapter_binding_mismatch",
        "GitHub delegated adapter call did not match its admitted connection binding",
      );
    }
    const repositoryFullName = exactRepository(envelope.repositoryFullName);
    exactFingerprint(envelope.catalogueFingerprint);

    let parsed: Record<string, unknown>;
    try {
      parsed = parseGitHubDelegatedReadArguments(
        "get_pr_diff",
        envelope.arguments,
      );
    } catch {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        "GitHub delegated get_pr_diff arguments were invalid",
      );
    }
    const pullRequestNumber = positiveInputInteger(
      parsed.pr_number,
      "GitHub pull request number",
    );
    const format = parsed.format === undefined
      ? "diff"
      : pullRequestDiffFormat(parsed.format);
    return Object.freeze({
      repositoryFullName,
      arguments: Object.freeze({
        pr_number: pullRequestNumber,
        format,
      }),
    });
  }

  async #getText(
    relativePath: string,
    token: string,
    format: PullRequestDiffFormat,
  ): Promise<ProviderTextResponse> {
    const url = `${this.#apiBaseUrl}/${relativePath}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: rawMediaTypes[format],
          Authorization: `Bearer ${token}`,
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": githubApiVersion,
        },
        redirect: "error",
      });
    } catch {
      throw rejected(
        "github_delegated_provider_request_failed",
        "GitHub delegated provider request failed before a response was available",
      );
    }
    if (response.status !== 200) {
      await discardResponseBody(response);
      if (!response.ok) {
        throw providerHttpError(response.status);
      }
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated provider did not return an exact complete response",
      );
    }
    if (response.redirected || response.url !== url) {
      await discardResponseBody(response);
      throw rejected(
        "github_delegated_provider_identity_mismatch",
        "GitHub delegated provider response did not match the requested pull request",
      );
    }
    if (!rawContentTypeMatches(response.headers.get("content-type"), format)) {
      await discardResponseBody(response);
      throw rejected(
        "github_delegated_provider_invalid_response",
        `GitHub delegated provider returned an unsupported ${format} content type`,
      );
    }

    let providerRequestId: string | undefined;
    try {
      providerRequestId = providerRequestIdentity(
        response.headers.get("x-github-request-id"),
      );
    } catch (error) {
      await discardResponseBody(response);
      throw error;
    }

    const body = await readBoundedText(
      response,
      pullRequestDiffMaximumBytes,
      format,
    );
    return Object.freeze({
      content: body.content,
      byteLength: body.byteLength,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
  }
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  format: PullRequestDiffFormat,
): Promise<Readonly<{ content: string; byteLength: number }>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      await discardResponseBody(response);
      throw rejected(
        "github_delegated_provider_invalid_response",
        `GitHub delegated ${format} response length was invalid`,
      );
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      await discardResponseBody(response);
      throw responseTooLarge(maximumBytes, format);
    }
  }
  if (!response.body) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `GitHub delegated provider returned an empty ${format} response`,
    );
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw rejected(
      "github_delegated_provider_response_failed",
      "GitHub delegated provider response could not be read",
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let failure: GitHubProviderRejectedError | undefined;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      if (!(read.value instanceof Uint8Array)) {
        throw rejected(
          "github_delegated_provider_invalid_response",
          `GitHub delegated ${format} response body was invalid`,
        );
      }
      total += read.value.byteLength;
      if (total > maximumBytes) {
        throw responseTooLarge(maximumBytes, format);
      }
      chunks.push(read.value);
    }
  } catch (error) {
    failure = error instanceof GitHubProviderRejectedError
      ? error
      : rejected(
        "github_delegated_provider_response_failed",
        "GitHub delegated provider response could not be read",
      );
    try {
      await reader.cancel();
    } catch {
      // The original fixed read or admission failure remains authoritative.
    }
  }

  try {
    reader.releaseLock();
  } catch {
    failure ??= rejected(
      "github_delegated_provider_response_failed",
      "GitHub delegated provider response could not be read",
    );
  }
  if (failure) throw failure;

  const bytes = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `GitHub delegated ${format} response was not valid UTF-8`,
    );
  }
  if (unsafeRawTextPattern.test(content)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `GitHub delegated ${format} response contained unsafe control text`,
    );
  }
  if (credentialShapedRetainedContentPattern.test(content)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `GitHub delegated ${format} response contained credential-shaped content`,
    );
  }
  return Object.freeze({ content, byteLength: total });
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the fixed status/content/size diagnostic as the authoritative result.
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
  const allowed = new Set(allowedFields);
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

function positiveInputInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function pullRequestDiffFormat(value: unknown): PullRequestDiffFormat {
  if (value !== "diff" && value !== "patch") {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated pull request diff format must be diff or patch",
    );
  }
  return value;
}

function rawContentTypeMatches(
  value: string | null,
  format: PullRequestDiffFormat,
): boolean {
  if (value === null) return false;
  const parts = value.split(";");
  if (parts.shift()?.trim().toLowerCase() !== rawMediaTypes[format]) {
    return false;
  }
  return parts.every((part) => part.trim().toLowerCase() === "charset=utf-8");
}

function providerRequestIdentity(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (
    !value
    || value.length > 240
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
    || credentialShapedPublicIdentityPattern.test(value)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub provider request identity was invalid",
    );
  }
  return value;
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

function pullRequestPath(
  repositoryFullName: string,
  pullRequestNumber: number,
): string {
  return `${repositoryPath(repositoryFullName)}/pulls/${pullRequestNumber}`;
}

function responseTooLarge(
  maximumBytes: number,
  format: PullRequestDiffFormat,
): GitHubProviderRejectedError {
  return rejected(
    "github_delegated_provider_result_too_large",
    `GitHub delegated ${format} response exceeds ${maximumBytes} bytes`,
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
