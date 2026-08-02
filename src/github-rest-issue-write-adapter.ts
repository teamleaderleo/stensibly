import type { GitHubIssueContextInput } from "./github-issue-context.js";
import type {
  GitHubIssueCommentInput,
  GitHubIssueProviderAdapter,
  GitHubIssueProviderPage,
} from "./github-provider-contracts.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import {
  canonicalBody,
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import {
  GitHubRestIssueProviderAdapter,
  type GitHubRestIssueProviderAdapterOptions,
} from "./github-rest-issue-adapter.js";

export interface GitHubRestIssueWriteAdapterOptions
  extends GitHubRestIssueProviderAdapterOptions {}

interface ProviderResponse<T> {
  value: T;
  requestId?: string;
}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;

/**
 * Adds the first bounded issue mutations to the existing strict read adapter.
 * Every mutation uses an exact issues:write installation token and leaves final
 * effect certainty to the service's independent readback plus durable receipt.
 */
export class GitHubRestIssueWriteAdapter implements GitHubIssueProviderAdapter {
  readonly #reads: GitHubRestIssueProviderAdapter;
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestIssueWriteAdapterOptions) {
    this.#reads = new GitHubRestIssueProviderAdapter(options);
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  listIssues(input: Parameters<GitHubIssueProviderAdapter["listIssues"]>[0]): Promise<GitHubIssueProviderPage> {
    return this.#reads.listIssues(input);
  }

  searchIssues(input: Parameters<GitHubIssueProviderAdapter["searchIssues"]>[0]): Promise<GitHubIssueProviderPage> {
    return this.#reads.searchIssues(input);
  }

  getIssue(input: Parameters<GitHubIssueProviderAdapter["getIssue"]>[0]): Promise<GitHubIssueContextInput> {
    return this.#reads.getIssue(input);
  }

  async createIssue(
    input: Parameters<GitHubIssueProviderAdapter["createIssue"]>[0],
  ) {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const url = issueCollectionUrl(this.#apiBaseUrl, repositoryFullName);
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      url,
      method: "POST",
      body: {
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        labels: input.labels,
        assignees: input.assignees,
      },
      operation: "create issue",
      permission: "write",
    });
    const issueNumber = positiveInteger(
      response.value.number,
      "Created GitHub issue number",
    );
    const issue = await this.#reads.getIssue({
      repositoryFullName,
      issueNumber,
    });
    return {
      issue,
      ...(response.requestId ? { providerRequestId: response.requestId } : {}),
    };
  }

  async updateIssue(
    input: Parameters<GitHubIssueProviderAdapter["updateIssue"]>[0],
  ) {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInteger(
      input.issueNumber,
      "GitHub issue number",
    );
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      url: issueUrl(this.#apiBaseUrl, repositoryFullName, issueNumber),
      method: "PATCH",
      body: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.stateReason === undefined
          ? {}
          : { state_reason: input.stateReason }),
      },
      operation: "update issue",
      permission: "write",
    });
    const returnedNumber = positiveInteger(
      response.value.number,
      "Updated GitHub issue number",
    );
    if (returnedNumber !== issueNumber) {
      throw invalidResponse("GitHub update response targeted another issue");
    }
    const issue = await this.#reads.getIssue({
      repositoryFullName,
      issueNumber,
    });
    return {
      issue,
      ...(response.requestId ? { providerRequestId: response.requestId } : {}),
    };
  }

  async addIssueComment(
    input: Parameters<GitHubIssueProviderAdapter["addIssueComment"]>[0],
  ) {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInteger(
      input.issueNumber,
      "GitHub issue number",
    );
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      url: issueCommentsUrl(
        this.#apiBaseUrl,
        repositoryFullName,
        issueNumber,
      ),
      method: "POST",
      body: { body: input.body },
      operation: "add issue comment",
      permission: "write",
    });
    return {
      comment: mapComment(
        response.value,
        repositoryFullName,
        issueNumber,
        this.#apiBaseUrl,
      ),
      ...(response.requestId ? { providerRequestId: response.requestId } : {}),
    };
  }

  async getIssueComment(
    input: Parameters<GitHubIssueProviderAdapter["getIssueComment"]>[0],
  ): Promise<GitHubIssueCommentInput> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInteger(
      input.issueNumber,
      "GitHub issue number",
    );
    const commentId = numericIdentifier(
      input.commentId,
      "GitHub issue comment ID",
    );
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      url: issueCommentUrl(
        this.#apiBaseUrl,
        repositoryFullName,
        commentId,
      ),
      method: "GET",
      operation: "get issue comment",
      permission: "read",
    });
    const comment = mapComment(
      response.value,
      repositoryFullName,
      issueNumber,
      this.#apiBaseUrl,
    );
    if (comment.id !== commentId) {
      throw invalidResponse("GitHub comment response identity changed");
    }
    return comment;
  }

  addIssueLabels: GitHubIssueProviderAdapter["addIssueLabels"] = async () => {
    throw unsupportedWrite();
  };

  removeIssueLabel: GitHubIssueProviderAdapter["removeIssueLabel"] = async () => {
    throw unsupportedWrite();
  };

  addIssueAssignees: GitHubIssueProviderAdapter["addIssueAssignees"] = async () => {
    throw unsupportedWrite();
  };

  removeIssueAssignees: GitHubIssueProviderAdapter["removeIssueAssignees"] = async () => {
    throw unsupportedWrite();
  };

  async #requestJson<T extends Record<string, unknown>>(input: {
    repositoryFullName: string;
    url: URL;
    method: "GET" | "POST" | "PATCH";
    body?: Record<string, unknown>;
    operation: string;
    permission: "read" | "write";
  }): Promise<ProviderResponse<T>> {
    const credential = await this.#tokens.getInstallationToken({
      repositoryFullName: input.repositoryFullName,
      issues: input.permission,
    });
    let response: Response;
    try {
      response = await this.#fetch(input.url, {
        method: input.method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential.token}`,
          ...(input.body ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": githubApiVersion,
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      });
    } catch {
      throw ambiguousTransportError(input.operation);
    }
    const text = await boundedResponseText(response, input.operation);
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw ambiguousTransportError(input.operation);
      }
      throw new GitHubProviderRejectedError(
        "github_provider_request_rejected",
        `GitHub rejected ${input.operation}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw invalidResponse(`GitHub ${input.operation} response was not valid JSON`);
    }
    if (!isRecord(value)) {
      throw invalidResponse(`GitHub ${input.operation} response was malformed`);
    }
    const requestId = response.headers.get("x-github-request-id")?.trim();
    return {
      value: value as T,
      ...(requestId ? { requestId } : {}),
    };
  }
}

function mapComment(
  value: Record<string, unknown>,
  repositoryFullName: string,
  issueNumber: number,
  apiBaseUrl: string,
): GitHubIssueCommentInput {
  const id = numericIdentifier(value.id, "GitHub issue comment ID");
  assertCommentIssueUrl(
    value.issue_url,
    repositoryFullName,
    issueNumber,
    apiBaseUrl,
  );
  const body = requiredString(value.body, "GitHub issue comment body", 64 * 1024);
  const canonicalUrl = canonicalCommentUrl(
    value.html_url,
    repositoryFullName,
    issueNumber,
    id,
  );
  const createdAt = timestamp(
    value.created_at,
    "GitHub issue comment created time",
  );
  const updatedAt = timestamp(
    value.updated_at,
    "GitHub issue comment updated time",
  );
  return {
    id,
    issueNumber,
    body,
    canonicalUrl,
    createdAt,
    updatedAt,
    sourceRevision: sha256(stableJson({
      id,
      issueNumber,
      body: canonicalBody(body),
      canonicalUrl,
      createdAt,
      updatedAt,
    })),
  };
}

function issueCollectionUrl(apiBaseUrl: string, repositoryFullName: string): URL {
  const [owner, repository] = repositoryParts(repositoryFullName);
  return new URL(
    `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`,
  );
}

function issueUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  issueNumber: number,
): URL {
  return new URL(`${issueCollectionUrl(apiBaseUrl, repositoryFullName)}/${issueNumber}`);
}

function issueCommentsUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  issueNumber: number,
): URL {
  return new URL(`${issueUrl(apiBaseUrl, repositoryFullName, issueNumber)}/comments`);
}

function issueCommentUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  commentId: string,
): URL {
  const [owner, repository] = repositoryParts(repositoryFullName);
  return new URL(
    `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/comments/${commentId}`,
  );
}

function assertCommentIssueUrl(
  value: unknown,
  repositoryFullName: string,
  issueNumber: number,
  apiBaseUrl: string,
): void {
  const url = exactUrl(value, "GitHub issue comment issue URL");
  const base = new URL(apiBaseUrl);
  const [owner, repository] = repositoryParts(repositoryFullName);
  const expectedPath = `${base.pathname.replace(/\/$/, "")}/repos/${owner}/${repository}/issues/${issueNumber}`;
  if (
    url.origin !== base.origin
    || url.pathname.toLowerCase() !== expectedPath.toLowerCase()
    || url.search
    || url.hash
  ) {
    throw invalidResponse("GitHub issue comment belonged to another issue");
  }
}

function canonicalCommentUrl(
  value: unknown,
  repositoryFullName: string,
  issueNumber: number,
  commentId: string,
): string {
  const url = exactUrl(value, "GitHub issue comment canonical URL");
  const [owner, repository] = repositoryParts(repositoryFullName);
  if (
    url.pathname.toLowerCase()
      !== `/${owner}/${repository}/issues/${issueNumber}`.toLowerCase()
    || url.search
    || url.hash !== `#issuecomment-${commentId}`
  ) {
    throw invalidResponse("GitHub issue comment canonical URL was invalid");
  }
  return url.toString();
}

async function boundedResponseText(
  response: Response,
  operation: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maximumResponseBytes) {
      throw ambiguousTransportError(operation);
    }
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw ambiguousTransportError(operation);
  }
  if (Buffer.byteLength(text, "utf8") > maximumResponseBytes) {
    throw ambiguousTransportError(operation);
  }
  return text;
}

function exactUrl(value: unknown, label: string): URL {
  const text = requiredString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalidResponse(`${label} was invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw invalidResponse(`${label} was invalid`);
  }
  return url;
}

function normalizedApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub API base URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("GitHub API base URL is invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function repositoryParts(repositoryFullName: string): [string, string] {
  const [owner, repository] = repositoryFullName.split("/");
  if (!owner || !repository) {
    throw new RangeError("Use a GitHub owner/repository identifier");
  }
  return [owner, repository];
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidResponse(`${label} was invalid`);
  }
  return value;
}

function numericIdentifier(value: unknown, label: string): string {
  if (
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    && (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value))
  ) {
    throw invalidResponse(`${label} was invalid`);
  }
  return String(value);
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw invalidResponse(`${label} was absent`);
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized.trim() || Buffer.byteLength(normalized, "utf8") > maximum) {
    throw invalidResponse(`${label} was invalid`);
  }
  return normalized;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalidResponse(`${label} was absent`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalidResponse(`${label} was invalid`);
  return parsed.toISOString();
}

function invalidResponse(message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_provider_response_invalid",
    message,
  );
}

function unsupportedWrite(): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_provider_operation_unavailable",
    "Hosted GitHub label and assignee writes are not mounted",
  );
}

function ambiguousTransportError(operation: string): Error {
  return new Error(`GitHub ${operation} outcome requires reconciliation`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
