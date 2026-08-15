import { receiverSafeFetch } from "./fetch-implementation.js";
import type { GitHubInstallationTokenProvider } from "./github-app-installation-token.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  githubPullRequestReviewTargetSourceRevision,
  type GitHubPullRequestReviewAction,
  type GitHubPullRequestReviewAdapter,
  type GitHubPullRequestReviewProviderReview,
  type GitHubPullRequestReviewState,
  type GitHubPullRequestReviewTarget,
} from "./github-pull-request-review-provider.js";
import {
  canonicalBody,
  normalizeGitHubRepository,
} from "./github-provider-validation.js";

export interface GitHubRestPullRequestReviewWriteAdapterOptions {
  readonly tokenProvider: GitHubInstallationTokenProvider;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
}

interface ProviderResponse<T> {
  readonly value: T;
  readonly requestId?: string;
}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;
const maximumReviewPages = 10;
const reviewsPerPage = 100;

/**
 * Native first-party REST adapter for formal submitted PR reviews. It requests
 * only repository-narrowed pull_requests read/write installation permissions.
 * Mutation transport / malformed-success uncertainty is surfaced as ambiguous
 * so the caller can reconcile by the embedded effect marker before any retry.
 */
export class GitHubRestPullRequestReviewWriteAdapter
  implements GitHubPullRequestReviewAdapter
{
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestPullRequestReviewWriteAdapterOptions) {
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = receiverSafeFetch(options.fetch);
  }

  async getPullRequest(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestReviewTarget> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      path: `/repos/${repositoryFullName}/pulls/${pullRequestNumber}`,
      method: "GET",
      permission: "read",
      operation: "read pull request for formal review",
    });
    return mapPullRequest(
      response.value,
      repositoryFullName,
      pullRequestNumber,
      this.#apiBaseUrl,
    );
  }

  async createReview(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    commitSha: string;
    action: GitHubPullRequestReviewAction;
    body: string;
  }): Promise<{
    review: GitHubPullRequestReviewProviderReview;
    providerRequestId?: string;
  }> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    const commitSha = fullRevision(
      input.commitSha,
      "GitHub formal review commit revision",
    );
    const action = reviewAction(input.action);
    const body = exactBody(input.body);
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      path: `/repos/${repositoryFullName}/pulls/${pullRequestNumber}/reviews`,
      method: "POST",
      permission: "write",
      operation: "submit formal pull request review",
      body: {
        commit_id: commitSha,
        event: action,
        body,
      },
    });
    let review: GitHubPullRequestReviewProviderReview;
    try {
      review = mapReview(
        response.value,
        repositoryFullName,
        pullRequestNumber,
        this.#apiBaseUrl,
      );
    } catch {
      throw new GitHubPullRequestReviewAmbiguousOutcomeError(
        "GitHub formal review mutation returned an ambiguous review object",
      );
    }
    return {
      review,
      ...(response.requestId ? { providerRequestId: response.requestId } : {}),
    };
  }

  async getReview(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    reviewId: string;
  }): Promise<GitHubPullRequestReviewProviderReview> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    const reviewId = providerId(input.reviewId, "GitHub review ID");
    const response = await this.#requestJson<Record<string, unknown>>({
      repositoryFullName,
      path:
        `/repos/${repositoryFullName}/pulls/${pullRequestNumber}/reviews/${reviewId}`,
      method: "GET",
      permission: "read",
      operation: "read formal pull request review",
    });
    const review = mapReview(
      response.value,
      repositoryFullName,
      pullRequestNumber,
      this.#apiBaseUrl,
    );
    if (review.id !== reviewId) {
      throw providerInvalidResponse("GitHub formal review readback identity changed");
    }
    return review;
  }

  async listReviews(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
  }): Promise<readonly GitHubPullRequestReviewProviderReview[]> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    const reviews: GitHubPullRequestReviewProviderReview[] = [];
    for (let page = 1; page <= maximumReviewPages; page += 1) {
      const response = await this.#requestJson<unknown[]>({
        repositoryFullName,
        path:
          `/repos/${repositoryFullName}/pulls/${pullRequestNumber}/reviews?per_page=${reviewsPerPage}&page=${page}`,
        method: "GET",
        permission: "read",
        operation: "list formal pull request reviews",
      });
      for (const value of response.value) {
        reviews.push(mapReview(
          record(value, "GitHub formal review list entry"),
          repositoryFullName,
          pullRequestNumber,
          this.#apiBaseUrl,
        ));
      }
      if (response.value.length < reviewsPerPage) break;
      if (page === maximumReviewPages) {
        throw providerInvalidResponse(
          "GitHub formal review list exceeded the bounded reconciliation horizon",
        );
      }
    }
    return Object.freeze(reviews);
  }

  async #requestJson<T>(input: {
    repositoryFullName: string;
    path: string;
    method: "GET" | "POST";
    permission: "read" | "write";
    operation: string;
    body?: Record<string, unknown>;
  }): Promise<ProviderResponse<T>> {
    const credential = await this.#tokens.getInstallationToken({
      repositoryFullName: input.repositoryFullName,
      permission: { name: "pull_requests", access: input.permission },
    });
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}${input.path}`, {
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
      if (input.method === "POST") {
        throw new GitHubPullRequestReviewAmbiguousOutcomeError(
          `GitHub ${input.operation} transport outcome is unknown`,
        );
      }
      throw providerUnavailable(input.operation);
    }
    const text = await boundedResponseText(response, input.operation);
    if (!response.ok) {
      if (
        response.status >= 500
        || response.status === 408
        || response.status === 429
      ) {
        if (input.method === "POST") {
          throw new GitHubPullRequestReviewAmbiguousOutcomeError(
            `GitHub ${input.operation} outcome requires reconciliation`,
          );
        }
        throw providerUnavailable(input.operation);
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
      if (input.method === "POST") {
        throw new GitHubPullRequestReviewAmbiguousOutcomeError(
          `GitHub ${input.operation} returned an ambiguous success body`,
        );
      }
      throw providerInvalidResponse(`GitHub ${input.operation} returned invalid JSON`);
    }
    const requestId = providerRequestIdentity(
      response.headers.get("x-github-request-id"),
    );
    return {
      value: value as T,
      ...(requestId ? { requestId } : {}),
    };
  }
}

export class GitHubPullRequestReviewAmbiguousOutcomeError extends Error {
  readonly name = "GitHubPullRequestReviewAmbiguousOutcomeError";
}

function mapPullRequest(
  value: Record<string, unknown>,
  repositoryFullName: string,
  pullRequestNumber: number,
  apiBaseUrl: string,
): GitHubPullRequestReviewTarget {
  const number = positiveInteger(value.number, "GitHub pull request number");
  if (number !== pullRequestNumber) {
    throw providerInvalidResponse("GitHub pull request response identity changed");
  }
  const base = record(value.base, "GitHub pull request base");
  const baseRepo = record(base.repo, "GitHub pull request base repository");
  if (normalizeGitHubRepository(text(baseRepo.full_name, "GitHub base repository", 140)) !== repositoryFullName) {
    throw providerInvalidResponse("GitHub pull request repository identity changed");
  }
  verifyApiUrl(
    value.url,
    apiBaseUrl,
    `/repos/${repositoryFullName}/pulls/${pullRequestNumber}`,
  );
  const head = record(value.head, "GitHub pull request head");
  const state = value.state === "open"
    ? "open" as const
    : value.state === "closed"
    ? "closed" as const
    : (() => { throw providerInvalidResponse("GitHub pull request state is invalid"); })();
  const draft = booleanValue(value.draft, "GitHub pull request draft flag");
  const updatedAt = timestamp(value.updated_at, "GitHub pull request update time");
  const target = {
    repositoryFullName,
    pullRequestNumber,
    headSha: fullRevision(text(head.sha, "GitHub pull request head revision", 40), "GitHub pull request head revision"),
    state,
    draft,
    updatedAt,
  };
  return Object.freeze({
    ...target,
    sourceRevision: githubPullRequestReviewTargetSourceRevision(target),
  });
}

function mapReview(
  value: Record<string, unknown>,
  repositoryFullName: string,
  pullRequestNumber: number,
  apiBaseUrl: string,
): GitHubPullRequestReviewProviderReview {
  const id = providerId(value.id, "GitHub pull request review ID");
  verifyApiUrl(
    value.url,
    apiBaseUrl,
    `/repos/${repositoryFullName}/pulls/${pullRequestNumber}/reviews/${id}`,
  );
  const user = record(value.user, "GitHub pull request review author");
  return Object.freeze({
    id,
    repositoryFullName,
    pullRequestNumber,
    commitSha: fullRevision(
      text(value.commit_id, "GitHub review commit revision", 40),
      "GitHub review commit revision",
    ),
    state: reviewState(value.state),
    body: canonicalBody(value.body === null ? "" : text(value.body, "GitHub review body", 64 * 1024)),
    authorLogin: login(user.login),
    submittedAt: timestamp(
      value.submitted_at,
      "GitHub pull request review submission time",
    ),
  });
}

function reviewAction(value: unknown): GitHubPullRequestReviewAction {
  if (value === "APPROVE" || value === "REQUEST_CHANGES" || value === "COMMENT") {
    return value;
  }
  throw new RangeError("GitHub pull request review action is invalid");
}

function reviewState(value: unknown): GitHubPullRequestReviewState {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (normalized === "approved") return "approved";
  if (normalized === "changes_requested") return "changes_requested";
  if (normalized === "commented") return "commented";
  throw providerInvalidResponse("GitHub formal review state is unsupported");
}

function exactBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("GitHub pull request review body must be text");
  }
  if (new TextEncoder().encode(value).byteLength > 64 * 1024) {
    throw new RangeError("GitHub pull request review body is too large");
  }
  return canonicalBody(value);
}

function verifyApiUrl(
  value: unknown,
  apiBaseUrl: string,
  expectedPath: string,
): void {
  const raw = text(value, "GitHub provider API URL", 2_048);
  let actual: URL;
  let base: URL;
  try {
    actual = new URL(raw);
    base = new URL(apiBaseUrl);
  } catch {
    throw providerInvalidResponse("GitHub provider returned an invalid API URL");
  }
  if (
    actual.protocol !== base.protocol
    || actual.host !== base.host
    || actual.pathname !== `${base.pathname.replace(/\/$/u, "")}${expectedPath}`
    || actual.search
    || actual.hash
  ) {
    throw providerInvalidResponse("GitHub provider API URL did not match the requested review object");
  }
}

async function boundedResponseText(
  response: Response,
  operation: string,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximumResponseBytes) {
      await discardBody(response);
      throw providerInvalidResponse(`GitHub ${operation} response was oversized`);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let textValue = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumResponseBytes) {
        await reader.cancel();
        throw providerInvalidResponse(`GitHub ${operation} response was oversized`);
      }
      textValue += decoder.decode(value, { stream: true });
    }
    textValue += decoder.decode();
    return textValue;
  } catch (error) {
    if (error instanceof GitHubProviderRejectedError) throw error;
    throw providerInvalidResponse(`GitHub ${operation} response could not be decoded`);
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup only.
  }
}

function providerRequestIdentity(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,240}$/u.test(trimmed) ? trimmed : null;
}

function providerId(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]{0,39}$/u.test(value)) {
    return value;
  }
  throw providerInvalidResponse(`${label} is invalid`);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function fullRevision(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new RangeError(`${label} must be a full Git revision`);
  }
  return normalized;
}

function timestamp(value: unknown, label: string): string {
  const raw = text(value, label, 64);
  const milliseconds = Date.parse(raw);
  if (!Number.isSafeInteger(milliseconds)) {
    throw providerInvalidResponse(`${label} is invalid`);
  }
  return new Date(milliseconds).toISOString();
}

function login(value: unknown): string {
  const raw = text(value, "GitHub review author login", 120).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\[bot\])?$/u.test(raw)) {
    throw providerInvalidResponse("GitHub review author login is invalid");
  }
  return raw;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw providerInvalidResponse(`${label} is invalid`);
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw providerInvalidResponse(`${label} is invalid`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerInvalidResponse(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizedApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("GitHub API base URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new RangeError("GitHub API base URL must be a clean HTTPS origin/path");
  }
  return url.toString().replace(/\/$/u, "");
}

function providerUnavailable(operation: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_provider_temporarily_unavailable",
    `GitHub ${operation} could not be verified`,
  );
}

function providerInvalidResponse(message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(
    "github_provider_invalid_response",
    message,
  );
}
