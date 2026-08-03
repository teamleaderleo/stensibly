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
  discardGitHubProviderResponse,
  readBoundedGitHubProviderResponseText,
} from "./github-provider-bounded-response.js";
import { GitHubProviderPostEffectError } from "./github-provider-post-effect-error.js";
import {
  canonicalBody,
  canonicalLogins,
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

interface GitHubApiIssue {
  number?: unknown;
  node_id?: unknown;
  repository_url?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  state_reason?: unknown;
  labels?: unknown;
  assignees?: unknown;
  milestone?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  pull_request?: unknown;
}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;

/**
 * Adds the first bounded issue mutations to the existing strict read adapter.
 * Every mutation uses an exact issues:write installation token. A successful
 * mutation marks its next verification read so any later uncertainty remains
 * pending reconciliation instead of being misreported as a clean rejection.
 */
export class GitHubRestIssueWriteAdapter implements GitHubIssueProviderAdapter {
  readonly #reads: GitHubRestIssueProviderAdapter;
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #pendingIssueReadbacks = new Map<string, number>();
  readonly #pendingCommentReadbacks = new Map<string, number>();

  constructor(options: GitHubRestIssueWriteAdapterOptions) {
    this.#reads = new GitHubRestIssueProviderAdapter(options);
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  listIssues(
    input: Parameters<GitHubIssueProviderAdapter["listIssues"]>[0],
  ): Promise<GitHubIssueProviderPage> {
    return this.#reads.listIssues(input);
  }

  searchIssues(
    input: Parameters<GitHubIssueProviderAdapter["searchIssues"]>[0],
  ): Promise<GitHubIssueProviderPage> {
    return this.#reads.searchIssues(input);
  }

  async getIssue(
    input: Parameters<GitHubIssueProviderAdapter["getIssue"]>[0],
  ): Promise<GitHubIssueContextInput> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInputInteger(
      input.issueNumber,
      "GitHub issue number",
    );
    const postMutation = consumePending(
      this.#pendingIssueReadbacks,
      issueReadbackKey(repositoryFullName, issueNumber),
    );
    try {
      return await this.#reads.getIssue({
        repositoryFullName,
        issueNumber,
      });
    } catch (error) {
      if (postMutation) throw ambiguousVerificationError("issue");
      throw error;
    }
  }

  async createIssue(
    input: Parameters<GitHubIssueProviderAdapter["createIssue"]>[0],
  ) {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      url: issueCollectionUrl(this.#apiBaseUrl, repositoryFullName),
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
    const providerRequestId = mutationRequestId(
      response.requestId,
      "create issue",
    );
    const issue = admitMutationResult("create issue", providerRequestId, () =>
      mapIssue(repositoryFullName, response.value, this.#apiBaseUrl)
    );
    markPending(
      this.#pendingIssueReadbacks,
      issueReadbackKey(repositoryFullName, issue.number),
    );
    return { issue, providerRequestId };
  }

  async updateIssue(
    input: Parameters<GitHubIssueProviderAdapter["updateIssue"]>[0],
  ) {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInputInteger(
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
    const providerRequestId = mutationRequestId(
      response.requestId,
      "update issue",
    );
    const issue = admitMutationResult("update issue", providerRequestId, () =>
      mapIssue(repositoryFullName, response.value, this.#apiBaseUrl)
    );
    if (issue.number !== issueNumber) {
      throw new GitHubProviderPostEffectError(providerRequestId);
    }
    markPending(
      this.#pendingIssueReadbacks,
      issueReadbackKey(repositoryFullName, issueNumber),
    );
    return { issue, providerRequestId };
  }

  async addIssueComment(
    input: Parameters<GitHubIssueProviderAdapter["addIssueComment"]>[0],
  ) {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInputInteger(
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
    const providerRequestId = mutationRequestId(
      response.requestId,
      "add issue comment",
    );
    const comment = admitMutationResult(
      "add issue comment",
      providerRequestId,
      () => mapComment(
        response.value,
        repositoryFullName,
        issueNumber,
        this.#apiBaseUrl,
      ),
    );
    markPending(
      this.#pendingCommentReadbacks,
      commentReadbackKey(repositoryFullName, issueNumber, comment.id),
    );
    return { comment, providerRequestId };
  }

  async getIssueComment(
    input: Parameters<GitHubIssueProviderAdapter["getIssueComment"]>[0],
  ): Promise<GitHubIssueCommentInput> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInputInteger(
      input.issueNumber,
      "GitHub issue number",
    );
    const commentId = numericIdentifier(
      input.commentId,
      "GitHub issue comment ID",
    );
    const postMutation = consumePending(
      this.#pendingCommentReadbacks,
      commentReadbackKey(repositoryFullName, issueNumber, commentId),
    );
    try {
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
    } catch (error) {
      if (postMutation) throw ambiguousVerificationError("issue comment");
      throw error;
    }
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

    const requestId = admittedRequestId(
      response.headers.get("x-github-request-id"),
    );
    if (!response.ok) {
      discardGitHubProviderResponse(response);
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        if (input.method !== "GET" && requestId) {
          throw new GitHubProviderPostEffectError(requestId);
        }
        throw ambiguousTransportError(input.operation);
      }
      throw new GitHubProviderRejectedError(
        "github_provider_request_rejected",
        `GitHub rejected ${input.operation}`,
      );
    }
    if (input.method !== "GET" && !requestId) {
      discardGitHubProviderResponse(response);
      throw ambiguousMutationResult(input.operation);
    }

    let text: string;
    try {
      text = await readBoundedGitHubProviderResponseText(
        response,
        maximumResponseBytes,
      );
    } catch {
      if (input.method !== "GET" && requestId) {
        throw new GitHubProviderPostEffectError(requestId);
      }
      throw invalidResponse(`GitHub ${input.operation} response was unreadable`);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      if (input.method !== "GET" && requestId) {
        throw new GitHubProviderPostEffectError(requestId);
      }
      throw invalidResponse(`GitHub ${input.operation} response was not valid JSON`);
    }
    if (!isRecord(value)) {
      if (input.method !== "GET" && requestId) {
        throw new GitHubProviderPostEffectError(requestId);
      }
      throw invalidResponse(`GitHub ${input.operation} response was malformed`);
    }
    return {
      value: value as T,
      ...(requestId ? { requestId } : {}),
    };
  }
}

function mapIssue(
  repositoryFullName: string,
  value: Record<string, unknown>,
  apiBaseUrl: string,
): GitHubIssueContextInput {
  if (value.pull_request !== undefined) {
    throw invalidResponse("GitHub issue mutation returned a pull request");
  }
  assertIssueRepository(value.repository_url, repositoryFullName, apiBaseUrl);
  const [owner, repository] = repositoryParts(repositoryFullName);
  const number = positiveResponseInteger(
    value.number,
    "GitHub issue number",
  );
  const providerNodeId = optionalString(
    value.node_id,
    "GitHub issue node ID",
    256,
  );
  const title = requiredString(value.title, "GitHub issue title", 256);
  const body = value.body === null || value.body === undefined
    ? null
    : requiredString(value.body, "GitHub issue body", 128 * 1024);
  const state = exactState(value.state);
  const stateReason = exactStateReason(value.state_reason);
  const labels = githubLabels(value.labels);
  const assignees = githubAssignees(value.assignees);
  const milestone = githubMilestone(value.milestone);
  const createdAt = timestamp(value.created_at, "GitHub issue created time");
  const updatedAt = timestamp(value.updated_at, "GitHub issue updated time");
  const sourceRevision = sha256(stableJson({
    nodeId: providerNodeId,
    number,
    title,
    body,
    state,
    stateReason,
    labels,
    assignees,
    milestone,
    createdAt,
    updatedAt,
  }));
  return {
    owner,
    repository,
    number,
    title,
    body,
    state,
    stateReason,
    labels,
    assignees,
    milestone,
    relationships: [],
    createdAt,
    updatedAt,
    providerNodeId,
    sourceRevision,
  };
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
    apiBaseUrl,
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

function assertIssueRepository(
  value: unknown,
  repositoryFullName: string,
  apiBaseUrl: string,
): void {
  const url = exactUrl(value, "GitHub issue repository URL");
  const base = new URL(apiBaseUrl);
  const [owner, repository] = repositoryParts(repositoryFullName);
  const expectedPath = `${base.pathname.replace(/\/$/, "")}/repos/${owner}/${repository}`;
  if (
    url.origin !== base.origin
    || url.pathname.toLowerCase() !== expectedPath.toLowerCase()
    || url.search
    || url.hash
  ) {
    throw invalidResponse(
      "GitHub issue response did not match the accepted repository",
    );
  }
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
  apiBaseUrl: string,
): string {
  const url = exactUrl(value, "GitHub issue comment canonical URL");
  const [owner, repository] = repositoryParts(repositoryFullName);
  if (
    url.origin !== expectedWebOrigin(apiBaseUrl)
    || url.pathname.toLowerCase()
      !== `/${owner}/${repository}/issues/${issueNumber}`.toLowerCase()
    || url.search
    || url.hash !== `#issuecomment-${commentId}`
  ) {
    throw invalidResponse("GitHub issue comment canonical URL was invalid");
  }
  return url.toString();
}

function expectedWebOrigin(apiBaseUrl: string): string {
  const api = new URL(apiBaseUrl);
  if (api.hostname === "api.github.com") return "https://github.com";
  if (api.hostname.startsWith("api.")) {
    const hostname = api.hostname.slice("api.".length);
    return `${api.protocol}//${hostname}${api.port ? `:${api.port}` : ""}`;
  }
  return api.origin;
}

function admittedRequestId(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
    ? normalized
    : null;
}

function mutationRequestId(
  value: string | undefined,
  operation: string,
): string {
  if (!value) throw ambiguousMutationResult(operation);
  return value;
}

function admitMutationResult<T>(
  operation: string,
  requestId: string,
  admit: () => T,
): T {
  try {
    return admit();
  } catch {
    throw new GitHubProviderPostEffectError(requestId);
  }
}

function markPending(store: Map<string, number>, key: string): void {
  store.set(key, (store.get(key) ?? 0) + 1);
}

function consumePending(store: Map<string, number>, key: string): boolean {
  const count = store.get(key) ?? 0;
  if (count === 0) return false;
  if (count === 1) store.delete(key);
  else store.set(key, count - 1);
  return true;
}

function issueReadbackKey(
  repositoryFullName: string,
  issueNumber: number,
): string {
  return `${repositoryFullName}#${issueNumber}`;
}

function commentReadbackKey(
  repositoryFullName: string,
  issueNumber: number,
  commentId: string,
): string {
  return `${repositoryFullName}#${issueNumber}:comment:${commentId}`;
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

function positiveInputInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function positiveResponseInteger(value: unknown, label: string): number {
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

function optionalString(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, label, maximum);
}

function githubLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels = value.map((entry) => {
    if (typeof entry === "string") {
      return requiredString(entry, "GitHub label", 100);
    }
    if (isRecord(entry)) {
      return requiredString(entry.name, "GitHub label", 100);
    }
    throw invalidResponse("GitHub issue label was malformed");
  });
  return [...new Set(labels)].sort(codeUnitCompare);
}

function githubAssignees(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const assignees = value.map((entry) => {
    if (!isRecord(entry)) {
      throw invalidResponse("GitHub issue assignee was malformed");
    }
    return requiredString(entry.login, "GitHub assignee", 39).toLowerCase();
  });
  return canonicalLogins([...new Set(assignees)]);
}

function githubMilestone(
  value: unknown,
): GitHubIssueContextInput["milestone"] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw invalidResponse("GitHub issue milestone was malformed");
  }
  return {
    number: positiveResponseInteger(
      value.number,
      "GitHub milestone number",
    ),
    title: requiredString(
      value.title,
      "GitHub milestone title",
      256,
    ),
  };
}

function exactState(value: unknown): "open" | "closed" {
  if (value === "open" || value === "closed") return value;
  throw invalidResponse("GitHub issue state was invalid");
}

function exactStateReason(
  value: unknown,
): "completed" | "not_planned" | "reopened" | null {
  if (value === null || value === undefined) return null;
  if (value === "completed" || value === "not_planned" || value === "reopened") {
    return value;
  }
  throw invalidResponse("GitHub issue state reason was invalid");
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

function ambiguousMutationResult(operation: string): Error {
  return new Error(
    `GitHub ${operation} succeeded without an admissible exact response; reconcile before retry`,
  );
}

function ambiguousVerificationError(target: string): Error {
  return new Error(
    `GitHub ${target} readback could not confirm the mutation; reconcile before retry`,
  );
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
