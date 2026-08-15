import { receiverSafeFetch } from "./fetch-implementation.js";
import type {
  GitHubInstallationTokenProvider,
} from "./github-app-installation-token.js";
import {
  type GitHubPullRequestCompensationAdapter,
  type GitHubPullRequestCompensationObservation,
  GitHubPullRequestCompensationProviderRejectedError,
} from "./github-pull-request-compensation-contracts.js";
import {
  canonicalBody,
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

export interface GitHubRestPullRequestCompensationAdapterOptions {
  tokenProvider: GitHubInstallationTokenProvider;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

interface ProviderResponse {
  value: Record<string, unknown>;
  requestId: string | null;
}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;

/** Narrow REST adapter for exact pull-request readback and close compensation. */
export class GitHubRestPullRequestCompensationAdapter
  implements GitHubPullRequestCompensationAdapter
{
  readonly #tokens: GitHubInstallationTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestPullRequestCompensationAdapterOptions) {
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = receiverSafeFetch(options.fetch);
  }

  async getPullRequestForCompensation(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestCompensationObservation> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    const response = await this.#request({
      repositoryFullName,
      pullRequestNumber,
      method: "GET",
      permission: "read",
      operation: "read pull request for compensation",
    });
    const result = mapPullRequest(repositoryFullName, response.value);
    if (result.number !== pullRequestNumber) {
      throw new Error("GitHub pull request compensation readback identity changed");
    }
    return result;
  }

  async closePullRequest(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    idempotencyKey: string;
  }): Promise<{
    pullRequest: GitHubPullRequestCompensationObservation;
    providerRequestId: string;
  }> {
    const repositoryFullName = normalizeGitHubRepository(
      input.repositoryFullName,
    ).toLowerCase();
    const pullRequestNumber = positiveInteger(
      input.pullRequestNumber,
      "GitHub pull request number",
    );
    exactIdentifier(
      input.idempotencyKey,
      "GitHub pull-request compensation idempotency key",
      240,
    );
    const response = await this.#request({
      repositoryFullName,
      pullRequestNumber,
      method: "PATCH",
      permission: "write",
      operation: "close pull request",
      body: { state: "closed" },
    });
    const pullRequest = mapPullRequest(repositoryFullName, response.value);
    if (pullRequest.number !== pullRequestNumber || pullRequest.state !== "closed") {
      throw new Error("GitHub pull request close response changed target state or identity");
    }
    if (response.requestId === null) {
      throw new Error("GitHub pull request close response omitted request identity");
    }
    return {
      pullRequest,
      providerRequestId: response.requestId,
    };
  }

  async #request(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    method: "GET" | "PATCH";
    permission: "read" | "write";
    operation: string;
    body?: Record<string, unknown>;
  }): Promise<ProviderResponse> {
    const credential = await this.#tokens.getInstallationToken({
      repositoryFullName: input.repositoryFullName,
      permission: { name: "pull_requests", access: input.permission },
    });
    const url = `${this.#apiBaseUrl}/repos/${input.repositoryFullName}/pulls/${input.pullRequestNumber}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
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
    if (!response.ok) {
      if (
        input.method === "PATCH"
        && (response.status >= 500 || response.status === 408 || response.status === 429)
      ) {
        throw new Error(`GitHub ${input.operation} outcome is ambiguous`);
      }
      throw new GitHubPullRequestCompensationProviderRejectedError();
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
    return {
      value,
      requestId: admittedRequestId(response.headers.get("x-github-request-id")),
    };
  }
}

function mapPullRequest(
  repositoryFullName: string,
  value: Record<string, unknown>,
): GitHubPullRequestCompensationObservation {
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
    state: pullRequestState(value.state),
    canonicalUrl: `https://github.com/${repositoryFullName}/pull/${number}`,
    createdAt,
    updatedAt,
    bodyRevision: {
      byteLength: new TextEncoder().encode(canonicalBody(body)).byteLength,
      sha256: sha256(canonicalBody(body)),
    },
    containsBody: false as const,
  };
  return Object.freeze({
    ...retained,
    bodyRevision: Object.freeze(retained.bodyRevision),
    sourceRevision: sha256(stableJson(retained)),
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
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`GitHub ${operation} response exceeded the byte limit`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function normalizedApiBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new RangeError("GitHub API base URL is invalid");
  }
  return url.toString().replace(/\/$/u, "");
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
    || /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(`${label} was invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} was invalid`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} was invalid`);
  return value;
}

function pullRequestState(value: unknown): "open" | "closed" {
  if (value !== "open" && value !== "closed") {
    throw new Error("GitHub pull request state was invalid");
  }
  return value;
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
  ) {
    throw new Error("GitHub branch was invalid");
  }
  return branch;
}

function commitSha(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
  ) {
    throw new Error("GitHub commit SHA was invalid");
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} was invalid`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} was invalid`);
  return new Date(time).toISOString();
}

function admittedRequestId(value: string | null): string | null {
  if (value === null || value.length < 1 || value.length > 240) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(value)) return null;
  return value;
}

function exactIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}
