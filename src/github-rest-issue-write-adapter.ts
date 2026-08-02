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
import { GitHubProviderPostEffectError } from "./github-provider-post-effect-error.js";
import {
  discardGitHubProviderResponse,
  readBoundedGitHubProviderResponseText,
} from "./github-provider-bounded-response.js";
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

interface MutationMarker {
  requestId: string;
  expectedFingerprint: string;
}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;

/**
 * Adds the first typed GitHub issue writes while preserving the strict read
 * adapter for all observations. A write never becomes a receipt until the
 * returned provider object passes the exact same issue/comment admission used
 * by the read path.
 */
export class GitHubRestIssueWriteAdapter implements GitHubIssueProviderAdapter {
  readonly #reads: GitHubRestIssueProviderAdapter;
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #pendingIssueVerification = new Map<string, MutationMarker>();
  readonly #pendingCommentVerification = new Map<string, MutationMarker>();

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

  getIssue(
    input: Parameters<GitHubIssueProviderAdapter["getIssue"]>[0],
  ): Promise<GitHubIssueContextInput> {
    return this.#reads.getIssue(input);
  }

  async getIssueComment(
    input: Parameters<GitHubIssueProviderAdapter["getIssueComment"]>[0],
  ): Promise<GitHubIssueCommentInput> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInteger(input.issueNumber, "GitHub issue number");
    const commentId = positiveInteger(input.commentId, "GitHub comment ID");
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      url: issueCommentUrl(this.#apiBaseUrl, repositoryFullName, commentId),
      method: "GET",
      operation: "read issue comment",
    });
    const comment = admitComment(response.value, repositoryFullName, issueNumber);
    const markerKey = commentMarkerKey(repositoryFullName, issueNumber, commentId);
    const marker = this.#pendingCommentVerification.get(markerKey);
    if (marker) {
      if (sha256(stableJson(comment)) !== marker.expectedFingerprint) {
        throw ambiguousMutationResult("add issue comment");
      }
      this.#pendingCommentVerification.delete(markerKey);
    }
    return comment;
  }

  async createIssue(
    input: Parameters<GitHubIssueProviderAdapter["createIssue"]>[0],
  ) {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const title = canonicalTitle(input.title);
    const body = canonicalBody(input.body);
    const labels = canonicalStringList(input.labels);
    const assignees = canonicalLogins(input.assignees);
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      url: issueCollectionUrl(this.#apiBaseUrl, repositoryFullName),
      method: "POST",
      body: {
        title,
        ...(body === null ? {} : { body }),
        ...(labels.length === 0 ? {} : { labels }),
        ...(assignees.length === 0 ? {} : { assignees }),
      },
      operation: "create issue",
    });
    const providerRequestId = requireMutationRequestId(
      response.requestId,
      "create issue",
    );
    const issue = admitMutationResult("create issue", providerRequestId, () =>
      admitIssue(response.value, repositoryFullName)
    );
    if (
      issue.title !== title
      || issue.body !== body
      || stableJson(issue.labels) !== stableJson(labels)
      || stableJson(issue.assignees) !== stableJson(assignees)
    ) {
      throw new GitHubProviderPostEffectError(providerRequestId);
    }
    this.#pendingIssueVerification.set(
      issueMarkerKey(repositoryFullName, issue.number),
      {
        requestId: providerRequestId,
        expectedFingerprint: sha256(stableJson(issue)),
      },
    );
    return { issue, providerRequestId };
  }

  async updateIssue(
    input: Parameters<GitHubIssueProviderAdapter["updateIssue"]>[0],
  ) {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInteger(input.issueNumber, "GitHub issue number");
    const title = input.title === undefined
      ? undefined
      : canonicalTitle(input.title);
    const body = input.body === undefined ? undefined : canonicalBody(input.body);
    const state = input.state === undefined ? undefined : canonicalState(input.state);
    if (title === undefined && body === undefined && state === undefined) {
      throw new RangeError("GitHub issue update requires at least one field");
    }
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      url: issueUrl(this.#apiBaseUrl, repositoryFullName, issueNumber),
      method: "PATCH",
      body: {
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
        ...(state === undefined ? {} : { state }),
      },
      operation: "update issue",
    });
    const providerRequestId = requireMutationRequestId(
      response.requestId,
      "update issue",
    );
    const issue = admitMutationResult("update issue", providerRequestId, () =>
      admitIssue(response.value, repositoryFullName, issueNumber)
    );
    if (
      (title !== undefined && issue.title !== title)
      || (body !== undefined && issue.body !== body)
      || (state !== undefined && issue.state !== state)
    ) {
      throw new GitHubProviderPostEffectError(providerRequestId);
    }
    this.#pendingIssueVerification.set(
      issueMarkerKey(repositoryFullName, issueNumber),
      {
        requestId: providerRequestId,
        expectedFingerprint: sha256(stableJson(issue)),
      },
    );
    return { issue, providerRequestId };
  }

  async addIssueComment(
    input: Parameters<GitHubIssueProviderAdapter["addIssueComment"]>[0],
  ) {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const issueNumber = positiveInteger(input.issueNumber, "GitHub issue number");
    const body = canonicalRequiredBody(input.body);
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      url: issueCommentsUrl(
        this.#apiBaseUrl,
        repositoryFullName,
        issueNumber,
      ),
      method: "POST",
      body: { body },
      operation: "add issue comment",
    });
    const providerRequestId = requireMutationRequestId(
      response.requestId,
      "add issue comment",
    );
    const comment = admitMutationResult(
      "add issue comment",
      providerRequestId,
      () => admitComment(response.value, repositoryFullName, issueNumber),
    );
    if (comment.body !== body) {
      throw new GitHubProviderPostEffectError(providerRequestId);
    }
    this.#pendingCommentVerification.set(
      commentMarkerKey(repositoryFullName, issueNumber, comment.id),
      {
        requestId: providerRequestId,
        expectedFingerprint: sha256(stableJson(comment)),
      },
    );
    return { comment, providerRequestId };
  }

  async #requestJson<T>(input: {
    repositoryFullName: string;
    url: URL;
    method: "GET" | "POST" | "PATCH";
    body?: Record<string, unknown>;
    operation: string;
  }): Promise<{ value: T; requestId?: string }> {
    const credential = await this.#tokens.getInstallationToken({
      repositoryFullName: input.repositoryFullName,
      issues: input.method === "GET" ? "read" : "write",
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
      await discardGitHubProviderResponse(response);
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        if (requestId && input.method !== "GET") {
          throw new GitHubProviderPostEffectError(requestId);
        }
        throw ambiguousTransportError(input.operation);
      }
      throw new GitHubProviderRejectedError(
        "github_provider_request_rejected",
        `GitHub rejected ${input.operation}`,
      );
    }

    let text: string;
    try {
      text = await readBoundedGitHubProviderResponseText(
        response,
        maximumResponseBytes,
      );
    } catch {
      if (requestId && input.method !== "GET") {
        throw new GitHubProviderPostEffectError(requestId);
      }
      throw ambiguousTransportError(input.operation);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      if (input.method !== "GET") {
        if (requestId) throw new GitHubProviderPostEffectError(requestId);
        throw ambiguousMutationResult(input.operation);
      }
      throw invalidResponse(`GitHub ${input.operation} response was not valid JSON`);
    }
    if (!isRecord(value)) {
      if (input.method !== "GET") {
        if (requestId) throw new GitHubProviderPostEffectError(requestId);
        throw ambiguousMutationResult(input.operation);
      }
      throw invalidResponse(`GitHub ${input.operation} response was malformed`);
    }
    return {
      value: value as T,
      ...(requestId ? { requestId } : {}),
    };
  }
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
  commentId: number,
): URL {
  const [owner, repository] = repositoryParts(repositoryFullName);
  return new URL(
    `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/comments/${commentId}`,
  );
}

function admitIssue(
  value: Record<string, unknown>,
  repositoryFullName: string,
  expectedIssueNumber?: number,
): GitHubIssueContextInput {
  if (value.pull_request !== undefined) {
    throw invalidResponse("GitHub issue mutation returned a pull request");
  }
  const number = positiveInteger(value.number, "GitHub issue number");
  if (expectedIssueNumber !== undefined && number !== expectedIssueNumber) {
    throw invalidResponse("GitHub issue mutation returned the wrong issue");
  }
  assertIssueRepository(
    value.repository_url,
    repositoryFullName,
    "GitHub issue mutation repository",
  );
  const user = requiredRecord(value.user, "GitHub issue mutation author");
  return Object.freeze({
    kind: "issue" as const,
    id: positiveInteger(value.id, "GitHub issue ID"),
    nodeId: boundedIdentifier(value.node_id, "GitHub issue node ID", 256),
    repositoryFullName,
    number,
    title: canonicalTitle(value.title),
    body: canonicalBody(value.body ?? null),
    state: canonicalState(value.state),
    stateReason: canonicalStateReason(value.state_reason ?? null),
    locked: booleanValue(value.locked, "GitHub issue locked flag"),
    authorLogin: boundedLogin(user.login, "GitHub issue author login"),
    labels: canonicalLabels(value.labels),
    assignees: canonicalAssignees(value.assignees),
    milestone: canonicalMilestone(value.milestone),
    commentCount: nonNegativeInteger(value.comments, "GitHub issue comment count"),
    createdAt: timestamp(value.created_at, "GitHub issue creation timestamp"),
    updatedAt: timestamp(value.updated_at, "GitHub issue update timestamp"),
    closedAt: optionalTimestamp(value.closed_at, "GitHub issue close timestamp"),
  });
}

function admitComment(
  value: Record<string, unknown>,
  repositoryFullName: string,
  issueNumber: number,
): GitHubIssueCommentInput {
  const issueUrlValue = boundedIdentifier(
    value.issue_url,
    "GitHub comment issue URL",
    4_096,
  );
  const expectedIssueUrl = issueUrl(
    "https://api.github.com",
    repositoryFullName,
    issueNumber,
  );
  const actualIssueUrl = new URL(issueUrlValue);
  if (
    actualIssueUrl.origin !== expectedIssueUrl.origin
    || actualIssueUrl.pathname.toLowerCase()
      !== expectedIssueUrl.pathname.toLowerCase()
  ) {
    throw invalidResponse("GitHub comment returned for the wrong issue");
  }
  const user = requiredRecord(value.user, "GitHub comment author");
  return Object.freeze({
    id: positiveInteger(value.id, "GitHub comment ID"),
    nodeId: boundedIdentifier(value.node_id, "GitHub comment node ID", 256),
    repositoryFullName,
    issueNumber,
    body: canonicalRequiredBody(value.body),
    authorLogin: boundedLogin(user.login, "GitHub comment author login"),
    authorAssociation: boundedIdentifier(
      value.author_association,
      "GitHub comment author association",
      128,
    ),
    createdAt: timestamp(value.created_at, "GitHub comment creation timestamp"),
    updatedAt: timestamp(value.updated_at, "GitHub comment update timestamp"),
  });
}

function issueMarkerKey(
  repositoryFullName: string,
  issueNumber: number,
): string {
  return `${repositoryFullName}#${issueNumber}`;
}

function commentMarkerKey(
  repositoryFullName: string,
  issueNumber: number,
  commentId: number,
): string {
  return `${repositoryFullName}#${issueNumber}:comment:${commentId}`;
}

function requireMutationRequestId(
  value: string | undefined,
  operation: string,
): string {
  if (!value) throw ambiguousMutationResult(operation);
  return value;
}

function admittedRequestId(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
    ? normalized
    : null;
}

function canonicalTitle(value: unknown): string {
  return canonicalRequiredText(value, "GitHub issue title", 256);
}

function canonicalRequiredBody(value: unknown): string {
  const body = canonicalBody(value);
  if (body === null) throw new RangeError("GitHub body is required");
  return body;
}

function canonicalRequiredText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function canonicalState(value: unknown): "open" | "closed" {
  if (value !== "open" && value !== "closed") {
    throw new RangeError("GitHub issue state is invalid");
  }
  return value;
}

function canonicalStateReason(
  value: unknown,
): "completed" | "not_planned" | "reopened" | null {
  if (value === null) return null;
  if (value === "completed" || value === "not_planned" || value === "reopened") {
    return value;
  }
  throw invalidResponse("GitHub issue state reason was invalid");
}

function canonicalLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw invalidResponse("GitHub issue labels were invalid");
  }
  return canonicalStringList(value.map((entry) => {
    if (typeof entry === "string") return entry;
    const record = requiredRecord(entry, "GitHub issue label");
    return canonicalRequiredText(record.name, "GitHub issue label", 100);
  }));
}

function canonicalAssignees(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw invalidResponse("GitHub issue assignees were invalid");
  }
  return canonicalLogins(value.map((entry) => {
    const record = requiredRecord(entry, "GitHub issue assignee");
    return boundedLogin(record.login, "GitHub issue assignee login");
  }));
}

function canonicalMilestone(value: unknown): GitHubIssueContextInput["milestone"] {
  if (value === null) return null;
  const record = requiredRecord(value, "GitHub issue milestone");
  return Object.freeze({
    number: positiveInteger(record.number, "GitHub milestone number"),
    title: canonicalRequiredText(record.title, "GitHub milestone title", 256),
  });
}

function assertIssueRepository(
  value: unknown,
  repositoryFullName: string,
  label: string,
): void {
  const url = boundedIdentifier(value, label, 4_096);
  const actual = new URL(url);
  const expected = issueCollectionUrl("https://api.github.com", repositoryFullName);
  const expectedRepositoryPath = expected.pathname.replace(/\/issues$/, "");
  if (
    actual.origin !== expected.origin
    || actual.pathname.toLowerCase() !== expectedRepositoryPath.toLowerCase()
  ) {
    throw invalidResponse(`${label} was invalid`);
  }
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse(`${label} was invalid`);
  return value;
}

function boundedLogin(value: unknown, label: string): string {
  const login = boundedIdentifier(value, label, 39).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login)) {
    throw invalidResponse(`${label} was invalid`);
  }
  return login;
}

function boundedIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw invalidResponse(`${label} was invalid`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalidResponse(`${label} was invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < 0
  ) {
    throw invalidResponse(`${label} was invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedIdentifier(value, label, 64);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw invalidResponse(`${label} was invalid`);
  return new Date(milliseconds).toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function canonicalStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new RangeError("GitHub string list is invalid");
  }
  return [...new Set(value.map((entry) =>
    canonicalRequiredText(entry, "GitHub string value", 100)
  ))].sort((left, right) => left.localeCompare(right));
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

function admitMutationResult<T>(
  _operation: string,
  providerRequestId: string,
  admit: () => T,
): T {
  try {
    return admit();
  } catch {
    throw new GitHubProviderPostEffectError(providerRequestId);
  }
}

function ambiguousTransportError(operation: string): Error {
  return new Error(`GitHub ${operation} outcome requires reconciliation`);
}

function ambiguousMutationResult(operation: string): Error {
  return new Error(
    `GitHub ${operation} succeeded without an admissible exact response; reconcile before retry`,
  );
}

function invalidResponse(message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_provider_invalid_response",
    message,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
