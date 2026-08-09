import { receiverSafeFetch } from "./fetch-implementation.js";
import type {
  GitHubBranchResult,
  GitHubPublicationProviderAdapter,
  GitHubPullRequestResult,
} from "./github-provider-contracts.js";
import {
  GitHubProviderRejectedError,
  githubPublicationProviderRejectionCode,
} from "./github-provider-contracts.js";
import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import {
  canonicalBody,
  githubPullRequestSourceRevision,
  normalizeGitHubRepository,
  sha256,
} from "./github-provider-validation.js";

export interface GitHubRestPublicationWriteAdapterOptions {
  tokenProvider: GitHubInstallationTokenProvider;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

interface ProviderResponse {
  value: Record<string, unknown>;
  requestId?: string;
}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;

/** Strict GitHub REST transport for branch and pull-request publication. */
export class GitHubRestPublicationWriteAdapter
  implements GitHubPublicationProviderAdapter
{
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestPublicationWriteAdapterOptions) {
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = receiverSafeFetch(options.fetch);
  }

  async getBranch(input: {
    repositoryFullName: string;
    branch: string;
  }): Promise<GitHubBranchResult | null> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const branch = branchName(input.branch);
    const response = await this.#request({
      repositoryFullName,
      url: `${this.#apiBaseUrl}/repos/${repositoryFullName}/git/ref/heads/${encodeURIComponent(branch)}`,
      method: "GET",
      permission: { name: "contents", access: "read" },
      operation: "get branch",
      allowNotFound: true,
    });
    return response === null
      ? null
      : mapBranch(repositoryFullName, branch, response.value);
  }

  async createBranch(input: {
    repositoryFullName: string;
    branch: string;
    fromCommitSha: string;
    idempotencyKey: string;
  }): Promise<{ branch: GitHubBranchResult; providerRequestId?: string }> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const branch = branchName(input.branch);
    const fromCommitSha = commitSha(input.fromCommitSha);
    const response = await this.#request({
      repositoryFullName,
      url: `${this.#apiBaseUrl}/repos/${repositoryFullName}/git/refs`,
      method: "POST",
      permission: { name: "contents", access: "write" },
      operation: "create branch",
      body: { ref: `refs/heads/${branch}`, sha: fromCommitSha },
    });
    if (!response) throw new Error("GitHub branch mutation response was absent");
    const result = mapBranch(repositoryFullName, branch, response.value);
    if (result.commitSha !== fromCommitSha) {
      throw new Error("GitHub branch mutation returned another source commit");
    }
    const providerRequestId = mutationRequestId(
      response.requestId,
      "create branch",
    );
    return { branch: result, providerRequestId };
  }

  async getPullRequest(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestResult> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    const response = await this.#request({
      repositoryFullName,
      url: `${this.#apiBaseUrl}/repos/${repositoryFullName}/pulls/${pullRequestNumber}`,
      method: "GET",
      permission: { name: "pull_requests", access: "read" },
      operation: "get pull request",
    });
    if (!response) throw new Error("GitHub pull request response was absent");
    const result = mapPullRequest(repositoryFullName, response.value);
    if (result.number !== pullRequestNumber) {
      throw new Error("GitHub pull request response identity changed");
    }
    return result;
  }

  async createPullRequest(input: {
    repositoryFullName: string;
    title: string;
    body?: string;
    head: string;
    base: string;
    draft: boolean;
    idempotencyKey: string;
  }): Promise<{
    pullRequest: GitHubPullRequestResult;
    providerRequestId?: string;
  }> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const head = branchName(input.head);
    const base = branchName(input.base);
    const response = await this.#request({
      repositoryFullName,
      url: `${this.#apiBaseUrl}/repos/${repositoryFullName}/pulls`,
      method: "POST",
      permission: { name: "pull_requests", access: "write" },
      operation: "create pull request",
      body: {
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        head,
        base,
        draft: input.draft,
      },
    });
    if (!response) {
      throw new Error("GitHub pull request mutation response was absent");
    }
    const pullRequest = mapPullRequest(repositoryFullName, response.value);
    if (
      pullRequest.title !== input.title
      || pullRequest.head !== head
      || pullRequest.base !== base
      || pullRequest.draft !== input.draft
      || pullRequest.bodyRevision.sha256
        !== sha256(canonicalBody(input.body ?? ""))
    ) {
      throw new Error("GitHub pull request mutation response changed requested fields");
    }
    const providerRequestId = mutationRequestId(
      response.requestId,
      "create pull request",
    );
    return { pullRequest, providerRequestId };
  }

  async #request(input: {
    repositoryFullName: string;
    url: string;
    method: "GET" | "POST";
    permission: {
      name: "contents" | "pull_requests";
      access: "read" | "write";
    };
    operation: string;
    body?: Record<string, unknown>;
    allowNotFound?: boolean;
  }): Promise<ProviderResponse | null> {
    const credential = await this.#tokens.getInstallationToken({
      repositoryFullName: input.repositoryFullName,
      permission: input.permission,
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
      throw new Error(`GitHub ${input.operation} transport outcome is ambiguous`);
    }
    const text = await boundedResponseText(response, input.operation);
    if (input.allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      if (
        input.method !== "GET"
        && (response.status >= 500 || response.status === 408 || response.status === 429)
      ) {
        throw new Error(`GitHub ${input.operation} outcome is ambiguous`);
      }
      throw new GitHubProviderRejectedError(
        githubPublicationProviderRejectionCode.providerRequestRejected,
        `GitHub rejected ${input.operation}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`GitHub ${input.operation} response was not valid JSON`);
    }
    if (!isRecord(value)) {
      throw new Error(`GitHub ${input.operation} response was malformed`);
    }
    const requestId = admittedRequestId(
      response.headers.get("x-github-request-id"),
    );
    return {
      value,
      ...(requestId ? { requestId } : {}),
    };
  }
}

function mapBranch(
  repositoryFullName: string,
  expectedBranch: string,
  value: Record<string, unknown>,
): GitHubBranchResult {
  const ref = requiredString(value.ref, "GitHub branch ref", 256);
  const object = exactRecord(value.object, "GitHub branch object");
  if (object.type !== "commit") {
    throw new Error("GitHub branch ref did not resolve to a commit");
  }
  const sha = commitSha(object.sha);
  if (ref !== `refs/heads/${expectedBranch}`) {
    throw new Error("GitHub branch response identity changed");
  }
  return Object.freeze({
    kind: "branch",
    name: expectedBranch,
    ref,
    commitSha: sha,
    canonicalUrl:
      `https://github.com/${repositoryFullName}/tree/${encodeURIComponent(expectedBranch)}`,
    sourceRevision: sha,
  });
}

function mapPullRequest(
  repositoryFullName: string,
  value: Record<string, unknown>,
): GitHubPullRequestResult {
  const number = positiveInteger(value.number, "GitHub pull request number");
  const head = exactRecord(value.head, "GitHub pull request head");
  const base = exactRecord(value.base, "GitHub pull request base");
  assertPullRequestRepository(head.repo, repositoryFullName, "head");
  assertPullRequestRepository(base.repo, repositoryFullName, "base");
  const body = value.body === null || value.body === undefined
    ? ""
    : requiredString(value.body, "GitHub pull request body", 128 * 1024);
  const createdAt = timestamp(value.created_at, "GitHub pull request created time");
  const updatedAt = timestamp(value.updated_at, "GitHub pull request updated time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("GitHub pull request update preceded creation");
  }
  const retained = {
    kind: "pull_request" as const,
    number,
    providerNodeId: value.node_id === null || value.node_id === undefined
      ? null
      : requiredString(value.node_id, "GitHub pull request node ID", 256),
    title: requiredString(value.title, "GitHub pull request title", 256),
    head: branchName(head.ref),
    headSha: commitSha(head.sha),
    base: branchName(base.ref),
    baseSha: commitSha(base.sha),
    draft: booleanValue(value.draft, "GitHub pull request draft flag"),
    state: exactOpenState(value.state),
    canonicalUrl: `https://github.com/${repositoryFullName}/pull/${number}`,
    createdAt,
    updatedAt,
    bodyRevision: {
      byteLength: new TextEncoder().encode(canonicalBody(body)).byteLength,
      sha256: sha256(canonicalBody(body)),
    },
    containsBody: false as const,
  } satisfies Omit<GitHubPullRequestResult, "sourceRevision">;
  const result: GitHubPullRequestResult = {
    ...retained,
    sourceRevision: githubPullRequestSourceRevision(retained),
  };
  return Object.freeze({
    ...result,
    bodyRevision: Object.freeze(result.bodyRevision),
  });
}

function assertPullRequestRepository(
  value: unknown,
  repositoryFullName: string,
  side: string,
): void {
  const repo = exactRecord(value, `GitHub pull request ${side} repository`);
  const fullName = normalizeGitHubRepository(
    requiredString(repo.full_name, `GitHub pull request ${side} repository`, 200),
  ).toLowerCase();
  if (fullName !== repositoryFullName) {
    throw new Error(`GitHub pull request ${side} is outside the bound repository`);
  }
}

async function boundedResponseText(
  response: Response,
  operation: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub ${operation} response length was invalid`);
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maximumResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub ${operation} response exceeded the byte limit`);
    }
  }
  if (!response.body) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new Error(`GitHub ${operation} response could not be read`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejected = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        rejected = true;
        await reader.cancel().catch(() => undefined);
        throw new Error(`GitHub ${operation} response was not a byte stream`);
      }
      total += item.value.byteLength;
      if (total > maximumResponseBytes) {
        rejected = true;
        await reader.cancel().catch(() => undefined);
        throw new Error(`GitHub ${operation} response exceeded the byte limit`);
      }
      chunks.push(item.value.slice());
    }
  } catch (error) {
    if (rejected) throw error;
    throw new Error(`GitHub ${operation} response could not be read`);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      if (!rejected) {
        throw new Error(`GitHub ${operation} response could not be read`);
      }
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`GitHub ${operation} response was not valid UTF-8`);
  }
}

function normalizedApiBaseUrl(value: string): string {
  const url = new URL(value);
  const localhostHttp = url.protocol === "http:" && url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !localhostHttp)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("GitHub API base URL must use HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}

function mutationRequestId(value: string | undefined, operation: string): string {
  if (!value) {
    throw new Error(`GitHub ${operation} response omitted a provider request ID`);
  }
  return value;
}

function admittedRequestId(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1
      && trimmed.length <= 240
      && /^[A-Za-z0-9:_-]+$/u.test(trimmed)
    ? trimmed
    : undefined;
}

function branchName(value: unknown): string {
  const branch = requiredString(value, "GitHub branch", 240);
  if (
    branch === "@"
    || branch === "HEAD"
    || branch.startsWith("refs/heads/")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.startsWith("-")
    || branch.includes("//")
    || branch.includes("..")
    || branch.includes("@{")
    || /[~^:?*\[\\\s]/u.test(branch)
  ) throw new RangeError("GitHub branch is invalid");
  const segments = branch.split("/");
  if (segments.some((segment) =>
    !segment
    || segment === "."
    || segment === ".."
    || segment.startsWith(".")
    || segment.endsWith(".")
    || segment.endsWith(".lock")
  )) throw new RangeError("GitHub branch is invalid");
  return branch;
}

function commitSha(value: unknown): string {
  const result = requiredString(value, "GitHub commit SHA", 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result)) {
    throw new RangeError("GitHub commit SHA is invalid");
  }
  return result;
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was malformed`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
  ) throw new RangeError(`${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return Number(value);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RangeError(`${label} is invalid`);
  return value;
}

function exactOpenState(value: unknown): "open" {
  if (value !== "open") throw new Error("GitHub pull request is not open");
  return "open";
}

function timestamp(value: unknown, label: string): string {
  const result = requiredString(value, label, 32);
  const date = new Date(result);
  const canonical = result.includes(".") ? result : result.replace("Z", ".000Z");
  if (Number.isNaN(date.getTime()) || date.toISOString() !== canonical) {
    throw new RangeError(`${label} is invalid`);
  }
  return date.toISOString();
}
