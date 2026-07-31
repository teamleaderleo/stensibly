import type {
  GitHubIssueContextInput,
} from "./github-issue-context.js";
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
  canonicalLogins,
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

export interface GitHubRestIssueProviderAdapterOptions {
  tokenProvider: GitHubInstallationTokenProvider;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
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

interface GitHubApiMilestone {
  number?: unknown;
  title?: unknown;
}

interface GitHubApiSearchResult {
  items?: unknown;
}

interface ProviderResponse<T> {
  value: T;
  requestId?: string;
  headers: Headers;
}

interface PageCursor {
  page: number;
  offset: number;
}

const githubApiVersion = "2022-11-28";
const upstreamPageSize = 100;
const cursorPrefix = "github-rest-v1";

/**
 * Direct GitHub REST implementation for the three typed issue reads.
 * Mutation methods fail closed until their durable receipt and reconciliation lane mounts.
 */
export class GitHubRestIssueProviderAdapter implements GitHubIssueProviderAdapter {
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestIssueProviderAdapterOptions) {
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async listIssues(input: {
    repositoryFullName: string;
    state?: "open" | "closed" | "all";
    labels?: string[];
    assignees?: string[];
    cursor?: string;
    limit: number;
  }): Promise<GitHubIssueProviderPage> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const [owner, repository] = repositoryParts(repositoryFullName);
    const cursor = parseCursor(input.cursor);
    const url = new URL(
      `${this.#apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`,
    );
    url.searchParams.set("state", input.state ?? "open");
    url.searchParams.set("per_page", String(upstreamPageSize));
    url.searchParams.set("page", String(cursor.page));
    if (input.labels?.length) {
      url.searchParams.set("labels", input.labels.join(","));
    }
    const response = await this.#requestJson<unknown>(
      repositoryFullName,
      url,
      "list issues",
    );
    if (!Array.isArray(response.value)) {
      throw invalidResponse("GitHub issue listing was not an array");
    }
    const requestedAssignees = canonicalLogins(input.assignees ?? []);
    const issues = response.value
      .filter((candidate): candidate is GitHubApiIssue => isRecord(candidate))
      .filter((candidate) => candidate.pull_request === undefined)
      .map((candidate) =>
        mapIssue(repositoryFullName, candidate, this.#apiBaseUrl)
      )
      .filter((candidate) => hasAllAssignees(candidate, requestedAssignees));
    const page = boundedSlice(issues, cursor, input.limit, response.headers);
    return {
      issues: page.values,
      nextCursor: page.nextCursor,
      ...(response.requestId ? { providerRequestId: response.requestId } : {}),
    };
  }

  async searchIssues(input: {
    repositoryFullName: string;
    query: string;
    state?: "open" | "closed" | "all";
    cursor?: string;
    limit: number;
  }): Promise<GitHubIssueProviderPage> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const cursor = parseCursor(input.cursor);
    const stateQualifier = input.state && input.state !== "all"
      ? ` is:${input.state}`
      : "";
    const url = new URL(`${this.#apiBaseUrl}/search/issues`);
    url.searchParams.set(
      "q",
      `repo:${repositoryFullName} is:issue${stateQualifier} ${input.query}`,
    );
    url.searchParams.set("per_page", String(upstreamPageSize));
    url.searchParams.set("page", String(cursor.page));
    const response = await this.#requestJson<GitHubApiSearchResult>(
      repositoryFullName,
      url,
      "search issues",
    );
    if (!isRecord(response.value) || !Array.isArray(response.value.items)) {
      throw invalidResponse("GitHub issue search result was malformed");
    }
    const issues = response.value.items
      .filter((candidate): candidate is GitHubApiIssue => isRecord(candidate))
      .filter((candidate) => candidate.pull_request === undefined)
      .map((candidate) =>
        mapIssue(repositoryFullName, candidate, this.#apiBaseUrl)
      );
    const page = boundedSlice(issues, cursor, input.limit, response.headers);
    return {
      issues: page.values,
      nextCursor: page.nextCursor,
      ...(response.requestId ? { providerRequestId: response.requestId } : {}),
    };
  }

  async getIssue(input: {
    repositoryFullName: string;
    issueNumber: number;
  }): Promise<GitHubIssueContextInput> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const [owner, repository] = repositoryParts(repositoryFullName);
    const issueNumber = positiveInteger(input.issueNumber, "GitHub issue number");
    const url = new URL(
      `${this.#apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}`,
    );
    const response = await this.#requestJson<GitHubApiIssue>(
      repositoryFullName,
      url,
      "get issue",
    );
    if (!isRecord(response.value)) {
      throw invalidResponse("GitHub issue response was malformed");
    }
    if (response.value.pull_request !== undefined) {
      throw new GitHubProviderRejectedError(
        "github_pull_request_is_not_issue",
        `${repositoryFullName}#${issueNumber} is a pull request`,
      );
    }
    return mapIssue(repositoryFullName, response.value, this.#apiBaseUrl);
  }

  createIssue: GitHubIssueProviderAdapter["createIssue"] = async () => {
    throw readOnlyError();
  };

  updateIssue: GitHubIssueProviderAdapter["updateIssue"] = async () => {
    throw readOnlyError();
  };

  addIssueComment: GitHubIssueProviderAdapter["addIssueComment"] = async () => {
    throw readOnlyError();
  };

  getIssueComment: GitHubIssueProviderAdapter["getIssueComment"] = async () => {
    throw readOnlyError();
  };

  addIssueLabels: GitHubIssueProviderAdapter["addIssueLabels"] = async () => {
    throw readOnlyError();
  };

  removeIssueLabel: GitHubIssueProviderAdapter["removeIssueLabel"] = async () => {
    throw readOnlyError();
  };

  addIssueAssignees: GitHubIssueProviderAdapter["addIssueAssignees"] = async () => {
    throw readOnlyError();
  };

  removeIssueAssignees: GitHubIssueProviderAdapter["removeIssueAssignees"] = async () => {
    throw readOnlyError();
  };

  async #requestJson<T>(
    repositoryFullName: string,
    url: URL,
    operation: string,
  ): Promise<ProviderResponse<T>> {
    const credential = await this.#tokens.getInstallationToken({
      repositoryFullName,
      issues: "read",
    });
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential.token}`,
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": githubApiVersion,
        },
      });
    } catch {
      throw providerTransportError("request");
    }
    const value = await readJson(response);
    if (!response.ok) {
      throw githubHttpError(response.status, operation);
    }
    const requestId = response.headers.get("x-github-request-id")?.trim();
    return {
      value: value as T,
      headers: response.headers,
      ...(requestId ? { requestId } : {}),
    };
  }
}

function mapIssue(
  repositoryFullName: string,
  value: GitHubApiIssue,
  apiBaseUrl: string,
): GitHubIssueContextInput {
  assertIssueRepository(value.repository_url, repositoryFullName, apiBaseUrl);
  const [owner, repository] = repositoryParts(repositoryFullName);
  const number = positiveInteger(value.number, "GitHub issue number");
  const nodeId = optionalString(value.node_id, "GitHub issue node ID", 256);
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
    nodeId,
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
    providerNodeId: nodeId,
    sourceRevision,
  };
}

function assertIssueRepository(
  value: unknown,
  expectedRepositoryFullName: string,
  apiBaseUrl: string,
): void {
  const repositoryUrl = requiredString(
    value,
    "GitHub issue repository URL",
    2_048,
  );
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw invalidResponse("GitHub issue repository URL was invalid");
  }
  const base = new URL(apiBaseUrl);
  if (
    url.origin !== base.origin
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw invalidResponse(
      "GitHub issue repository did not match the accepted repository",
    );
  }
  const basePath = base.pathname.replace(/\/$/, "");
  const prefix = `${basePath}/repos/`;
  if (!url.pathname.startsWith(prefix)) {
    throw invalidResponse(
      "GitHub issue repository did not match the accepted repository",
    );
  }
  const parts = url.pathname.slice(prefix.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw invalidResponse(
      "GitHub issue repository did not match the accepted repository",
    );
  }
  let providerRepositoryFullName: string;
  try {
    providerRepositoryFullName = normalizeGitHubRepository(
      `${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1])}`,
    ).toLowerCase();
  } catch {
    throw invalidResponse("GitHub issue repository URL was invalid");
  }
  if (providerRepositoryFullName !== expectedRepositoryFullName.toLowerCase()) {
    throw invalidResponse(
      "GitHub issue repository did not match the accepted repository",
    );
  }
}

function boundedSlice<T>(
  values: T[],
  cursor: PageCursor,
  limit: number,
  headers: Headers,
): { values: T[]; nextCursor: string | null } {
  const boundedLimit = positiveInteger(limit, "GitHub issue page limit");
  if (boundedLimit > 100) {
    throw new RangeError("GitHub issue page limit must not exceed 100");
  }
  if (cursor.offset > values.length) {
    throw new GitHubProviderRejectedError(
      "github_cursor_stale",
      "GitHub issue cursor no longer matches the provider page",
    );
  }
  const result = values.slice(cursor.offset, cursor.offset + boundedLimit);
  const nextOffset = cursor.offset + result.length;
  if (nextOffset < values.length) {
    return {
      values: result,
      nextCursor: renderCursor({ page: cursor.page, offset: nextOffset }),
    };
  }
  if (hasNextPage(headers)) {
    return {
      values: result,
      nextCursor: renderCursor({ page: cursor.page + 1, offset: 0 }),
    };
  }
  return { values: result, nextCursor: null };
}

function parseCursor(value: string | undefined): PageCursor {
  if (!value) return { page: 1, offset: 0 };
  const match = new RegExp(`^${cursorPrefix}:([1-9][0-9]{0,8}):([0-9]{1,3})$`).exec(
    value.trim(),
  );
  if (!match) {
    throw new GitHubProviderRejectedError(
      "github_cursor_invalid",
      "GitHub issue cursor is invalid",
    );
  }
  const page = Number(match[1]);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(offset) || offset > 100) {
    throw new GitHubProviderRejectedError(
      "github_cursor_invalid",
      "GitHub issue cursor is invalid",
    );
  }
  return { page, offset };
}

function renderCursor(cursor: PageCursor): string {
  return `${cursorPrefix}:${cursor.page}:${cursor.offset}`;
}

function hasNextPage(headers: Headers): boolean {
  const link = headers.get("link");
  return Boolean(link && /<[^>]+>;\s*rel="next"/.test(link));
}

function hasAllAssignees(
  issue: GitHubIssueContextInput,
  requested: string[],
): boolean {
  if (!requested.length) return true;
  const actual = new Set((issue.assignees ?? []).map((login) => login.toLowerCase()));
  return requested.every((login) => actual.has(login));
}

function githubLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels = value.map((entry) => {
    if (typeof entry === "string") return requiredString(entry, "GitHub label", 100);
    if (isRecord(entry)) return requiredString(entry.name, "GitHub label", 100);
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

function githubMilestone(value: unknown): GitHubIssueContextInput["milestone"] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw invalidResponse("GitHub issue milestone was malformed");
  }
  const milestone = value as GitHubApiMilestone;
  return {
    number: positiveInteger(milestone.number, "GitHub milestone number"),
    title: requiredString(milestone.title, "GitHub milestone title", 256),
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

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw invalidResponse(`${label} was absent`);
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized.trim() || [...normalized].length > maximum) {
    throw invalidResponse(`${label} was invalid`);
  }
  return normalized;
}

function optionalString(value: unknown, label: string, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, label, maximum);
}

function repositoryParts(repositoryFullName: string): [string, string] {
  const [owner, repository] = repositoryFullName.split("/");
  if (!owner || !repository) throw new RangeError("GitHub repository is invalid");
  return [owner, repository];
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidResponse(`${label} was invalid`);
  }
  return value;
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

async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw providerTransportError("response");
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse("GitHub returned a non-JSON response");
  }
}

function providerTransportError(
  stage: "request" | "response",
): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_provider_temporarily_unavailable",
    stage === "request"
      ? "GitHub provider request failed before a response was available"
      : "GitHub provider response could not be read",
  );
}

function githubHttpError(
  status: number,
  operation: string,
): GitHubProviderRejectedError {
  const message = `GitHub could not ${operation} (HTTP ${status})`;
  if (status === 401) {
    return new GitHubProviderRejectedError("github_credential_rejected", message);
  }
  if (status === 403) {
    return new GitHubProviderRejectedError("github_permission_denied", message);
  }
  if (status === 404) {
    return new GitHubProviderRejectedError("github_resource_not_found", message);
  }
  if (status === 422) {
    return new GitHubProviderRejectedError("github_request_rejected", message);
  }
  if (status === 429 || status >= 500) {
    return new GitHubProviderRejectedError("github_provider_temporarily_unavailable", message);
  }
  return new GitHubProviderRejectedError("github_provider_request_failed", message);
}

function invalidResponse(message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_provider_invalid_response",
    message,
  );
}

function readOnlyError(): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_provider_read_only",
    "GitHub issue mutations remain disabled until durable receipts and reconciliation are mounted",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
