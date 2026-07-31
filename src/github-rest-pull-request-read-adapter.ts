import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  GitHubRestDelegatedReadAdapter,
  type GitHubRestDelegatedReadAdapterOptions,
} from "./github-rest-delegated-read-adapter.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";

export interface GitHubRestPullRequestReadAdapterOptions
  extends GitHubRestDelegatedReadAdapterOptions {}

interface AdmittedPullRequestCall {
  arguments: Readonly<{ pr_number: number }>;
  repositoryFullName: string;
}

interface ProviderResponse {
  payload: unknown;
  providerRequestId?: string;
}

const githubApiVersion = "2022-11-28";
const pullRequestResponseMaximumBytes = 128 * 1024;
const credentialShapedPublicIdentityPattern = /(?:^|[\s:./=,;'"()\[\]{}@#_-])(?:Bearer\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|stn\.tok_|xox[baprs]-|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;

/**
 * Additive native REST extension for exact pull-request metadata reads.
 * Existing repository metadata and immutable-file calls remain owned by the base adapter.
 */
export class GitHubRestPullRequestReadAdapter
  extends GitHubRestDelegatedReadAdapter
{
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #tokenProvider: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestPullRequestReadAdapterOptions) {
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

    if (envelope.tool !== "get_pr_info") {
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

    const admitted = this.#admitPullRequestCall(envelope);
    const token = await this.#tokenProvider.getInstallationToken({
      repositoryFullName: admitted.repositoryFullName,
      permission: { name: "pull_requests", access: "read" },
    });
    const provider = await this.#getJson(
      pullRequestPath(
        admitted.repositoryFullName,
        admitted.arguments.pr_number,
      ),
      token.token,
    );
    return Object.freeze({
      result: pullRequestResult(
        provider.payload,
        admitted.repositoryFullName,
        admitted.arguments.pr_number,
        this.#apiBaseUrl,
      ),
      ...(provider.providerRequestId
        ? { providerRequestId: provider.providerRequestId }
        : {}),
    });
  }

  #admitPullRequestCall(
    envelope: Record<string, unknown>,
  ): AdmittedPullRequestCall {
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
    const argumentsRecord = exactDataRecord(
      envelope.arguments,
      ["pr_number"],
      ["pr_number"],
      "GitHub delegated get_pr_info arguments",
    );
    return Object.freeze({
      repositoryFullName,
      arguments: Object.freeze({
        pr_number: positiveInputInteger(
          argumentsRecord.pr_number,
          "GitHub pull request number",
        ),
      }),
    });
  }

  async #getJson(
    relativePath: string,
    token: string,
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
    if (!response.ok) {
      await discardResponseBody(response);
      throw providerHttpError(response.status);
    }
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().includes("json")) {
      await discardResponseBody(response);
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated provider returned an unsupported content type",
      );
    }
    const payload = await readBoundedJson(
      response,
      pullRequestResponseMaximumBytes,
    );
    const providerRequestId = providerRequestIdentity(
      response.headers.get("x-github-request-id"),
    );
    return {
      payload,
      ...(providerRequestId ? { providerRequestId } : {}),
    };
  }
}

function pullRequestResult(
  value: unknown,
  repositoryFullName: string,
  requestedNumber: number,
  apiBaseUrl: string,
): Readonly<Record<string, unknown>> {
  const record = jsonRecord(value, "GitHub pull request response");
  const number = positiveProviderInteger(
    record.number,
    "GitHub pull request number",
  );
  if (number !== requestedNumber) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated pull request response did not match the requested pull request",
    );
  }

  const base = jsonRecord(record.base, "GitHub pull request base");
  const baseRepository = jsonRecord(
    base.repo,
    "GitHub pull request base repository",
  );
  if (exactRepository(baseRepository.full_name) !== repositoryFullName) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "GitHub delegated pull request response did not match the accepted repository",
    );
  }
  verifyProviderApiUrl(
    record.url,
    apiBaseUrl,
    pullRequestPath(repositoryFullName, requestedNumber),
    "GitHub pull request API URL",
  );

  const head = jsonRecord(record.head, "GitHub pull request head");
  const headRepositoryFullName = head.repo === null
    ? null
    : exactRepository(
      jsonRecord(
        head.repo,
        "GitHub pull request head repository",
      ).full_name,
    );
  const user = jsonRecord(record.user, "GitHub pull request author");
  const state = pullRequestState(record.state);
  const merged = booleanValue(record.merged, "GitHub pull request merged flag");
  const mergeCommitSha = nullableCommitSha(record.merge_commit_sha);
  const createdAt = exactTimestamp(
    record.created_at,
    "GitHub pull request created timestamp",
  );
  const updatedAt = exactTimestamp(
    record.updated_at,
    "GitHub pull request updated timestamp",
  );
  const closedAt = nullableTimestamp(
    record.closed_at,
    "GitHub pull request closed timestamp",
  );
  const mergedAt = nullableTimestamp(
    record.merged_at,
    "GitHub pull request merged timestamp",
  );
  const createdMs = Date.parse(createdAt);
  const updatedMs = Date.parse(updatedAt);
  const closedMs = closedAt === null ? null : Date.parse(closedAt);
  const mergedMs = mergedAt === null ? null : Date.parse(mergedAt);
  if (
    updatedMs < createdMs
    || (closedMs !== null && (closedMs < createdMs || closedMs > updatedMs))
    || (mergedMs !== null && (mergedMs < createdMs || mergedMs > updatedMs))
    || (merged && closedMs !== null && mergedMs !== null && mergedMs > closedMs)
    || (state === "open" && closedAt !== null)
    || (state === "closed" && closedAt === null)
    || (merged && (
      state !== "closed"
      || mergedAt === null
      || mergeCommitSha === null
    ))
    || (!merged && mergedAt !== null)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub pull request lifecycle fields were inconsistent",
    );
  }

  return Object.freeze({
    repositoryFullName,
    number,
    id: positiveProviderInteger(record.id, "GitHub pull request ID"),
    nodeId: exactText(record.node_id, "GitHub pull request node ID", 160),
    state,
    draft: booleanValue(record.draft, "GitHub pull request draft flag"),
    locked: booleanValue(record.locked, "GitHub pull request locked flag"),
    merged,
    title: exactText(record.title, "GitHub pull request title", 1_024),
    authorLogin: exactText(
      user.login,
      "GitHub pull request author login",
      120,
    ),
    headRepositoryFullName,
    headSha: commitSha(head.sha),
    headRef: exactText(head.ref, "GitHub pull request head ref", 512),
    baseSha: commitSha(base.sha),
    baseRef: exactText(base.ref, "GitHub pull request base ref", 512),
    mergeCommitSha,
    createdAt,
    updatedAt,
    closedAt,
    mergedAt,
    additions: nonNegativeProviderInteger(
      record.additions,
      "GitHub pull request additions",
    ),
    deletions: nonNegativeProviderInteger(
      record.deletions,
      "GitHub pull request deletions",
    ),
    changedFiles: nonNegativeProviderInteger(
      record.changed_files,
      "GitHub pull request changed file count",
    ),
    commits: nonNegativeProviderInteger(
      record.commits,
      "GitHub pull request commit count",
    ),
    reviewComments: nonNegativeProviderInteger(
      record.review_comments,
      "GitHub pull request review comment count",
    ),
    comments: nonNegativeProviderInteger(
      record.comments,
      "GitHub pull request comment count",
    ),
  });
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      await discardResponseBody(response);
      throw rejected(
        "github_delegated_provider_invalid_response",
        "GitHub delegated provider response length was invalid",
      );
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      await discardResponseBody(response);
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

function positiveProviderInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      `${label} was invalid`,
    );
  }
  return value;
}

function nonNegativeProviderInteger(value: unknown, label: string): number {
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

function pullRequestState(value: unknown): "open" | "closed" {
  if (value !== "open" && value !== "closed") {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub pull request state was invalid",
    );
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

function commitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "GitHub pull request commit SHA was invalid",
    );
  }
  return value;
}

function nullableCommitSha(value: unknown): string | null {
  return value === null ? null : commitSha(value);
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

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : exactTimestamp(value, label);
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
    || credentialShapedPublicIdentityPattern.test(value)
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
    actual.username
    || actual.password
    || actual.search
    || actual.hash
    || actual.protocol !== expected.protocol
    || actual.host !== expected.host
    || !providerPathMatches(actual.pathname, expected.pathname, expectedPath)
  ) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      `${label} did not match the accepted repository`,
    );
  }
}

function providerPathMatches(
  actualPathname: string,
  expectedPathname: string,
  expectedRelativePath: string,
): boolean {
  const actual = actualPathname.split("/");
  const expected = expectedPathname.split("/");
  const relative = expectedRelativePath.split("/");
  if (
    actual.length !== expected.length
    || relative[0] !== "repos"
    || expected.length < relative.length
  ) {
    return false;
  }
  const offset = expected.length - relative.length;
  for (let index = 0; index < expected.length; index += 1) {
    const caseInsensitiveRepositorySegment =
      index === offset + 1 || index === offset + 2;
    if (caseInsensitiveRepositorySegment) {
      if (actual[index]?.toLowerCase() !== expected[index]?.toLowerCase()) {
        return false;
      }
    } else if (actual[index] !== expected[index]) {
      return false;
    }
  }
  return true;
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
