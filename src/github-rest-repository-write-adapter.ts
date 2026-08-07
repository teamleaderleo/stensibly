import type { GitHubInstallationToken } from "./github-app-installation-token.js";
import {
  discardGitHubProviderResponse,
  GitHubProviderResponseReadError,
  readBoundedGitHubProviderResponseText,
  withGitHubProviderResponseDeadline,
} from "./github-provider-bounded-response.js";
import type {
  GitHubRepositoryWritePayload,
  GitHubRepositoryWriteProviderAdapter,
} from "./github-repository-write-provider-service.js";
import {
  publishGitHubRepositoryWriteAtomically,
} from "./github-rest-repository-write-atomic-publication.js";
import {
  admitGitHubBranchRef,
  admitGitHubRepositoryFullName,
  admitGitHubRepositoryPath,
  admitGitObjectId,
  sameGitObjectFormat,
} from "./github-repository-write-admission.js";

export interface GitHubRepositoryWriteTokenProvider {
  getRepositoryContentsToken(input: {
    repositoryFullName: string;
    access: "read" | "write";
  }): Promise<GitHubInstallationToken>;
}

export interface GitHubRestRepositoryWriteAdapterOptions {
  tokenProvider: GitHubRepositoryWriteTokenProvider;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  responseDeadlineMs?: number;
}

interface ProviderWriteResult {
  commitSha: string;
  providerRequestId?: string;
  targetRef: string;
  parentSha?: string;
}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const credentialShapedPattern =
  /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

/**
 * Native transport for the durable repository-write provider service.
 *
 * This adapter constructs one direct-child commit from an immutable parent and
 * publishes it through a non-forced ref update. Every provider response uses
 * one total fetch/body deadline from the shared GitHub response boundary.
 */
export class GitHubRestRepositoryWriteAdapter
  implements GitHubRepositoryWriteProviderAdapter
{
  readonly #tokens: GitHubRepositoryWriteTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubRestRepositoryWriteAdapterOptions) {
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.#fetch = withGitHubProviderResponseDeadline(
      options.fetch ?? globalThis.fetch,
      options.responseDeadlineMs,
    );
  }

  async getRefHead(input: {
    repositoryFullName: string;
    targetRef: string;
  }): Promise<string | null> {
    const repositoryFullName = exactRepository(input.repositoryFullName);
    const targetRef = exactBranch(input.targetRef);
    const response = await this.#request({
      repositoryFullName,
      access: "read",
      method: "GET",
      url: refUrl(this.#apiBaseUrl, repositoryFullName, targetRef),
      operation: "read target ref",
    });
    if (response.status === 404) {
      discardGitHubProviderResponse(response);
      return null;
    }
    requireOk(response, "read target ref");
    const value = await readJson(response, "read target ref");
    const record = exactRecord(value, "GitHub ref response");
    const expectedRef = `refs/heads/${targetRef}`;
    if (record.ref !== expectedRef) {
      throw invalidResponse("GitHub ref response did not match the target ref");
    }
    const object = exactRecord(record.object, "GitHub ref object");
    if (object.type !== "commit") {
      throw invalidResponse("GitHub ref response did not name a commit");
    }
    const sha = responseObjectId(object.sha, "GitHub ref commit SHA");
    assertOptionalExactApiUrl(
      object.url,
      commitUrl(this.#apiBaseUrl, repositoryFullName, sha),
      "GitHub ref commit URL",
    );
    return sha;
  }

  async getCommitParents(input: {
    repositoryFullName: string;
    commitSha: string;
  }): Promise<readonly string[]> {
    const repositoryFullName = exactRepository(input.repositoryFullName);
    const commitSha = exactCommitSha(input.commitSha, "GitHub commit SHA");
    const response = await this.#request({
      repositoryFullName,
      access: "read",
      method: "GET",
      url: commitUrl(this.#apiBaseUrl, repositoryFullName, commitSha),
      operation: "read commit parents",
    });
    requireOk(response, "read commit parents");
    const value = await readJson(response, "read commit parents");
    const record = exactRecord(value, "GitHub commit response");
    if (responseObjectId(record.sha, "GitHub commit response SHA") !== commitSha) {
      throw invalidResponse("GitHub commit response identity changed");
    }
    const parents = exactParents(record.parents, "GitHub commit parents");
    if (!sameGitObjectFormat(commitSha, ...parents)) {
      throw invalidResponse("GitHub commit response mixed object formats");
    }
    assertOptionalExactApiUrl(
      record.url,
      commitUrl(this.#apiBaseUrl, repositoryFullName, commitSha),
      "GitHub commit URL",
    );
    return Object.freeze(parents);
  }

  async dispatchRepositoryWrite(input: {
    repositoryFullName: string;
    path: string;
    operation: "create_file" | "update_file" | "delete_file";
    targetRef: string;
    expectedParentSha: string;
    payload: GitHubRepositoryWritePayload;
    idempotencyKey: string;
  }): Promise<ProviderWriteResult> {
    const repositoryFullName = exactRepository(input.repositoryFullName);
    const path = exactPath(input.path);
    const targetRef = exactBranch(input.targetRef);
    const expectedParentSha = exactCommitSha(
      input.expectedParentSha,
      "Expected parent SHA",
    );
    if (input.operation !== input.payload.operation) {
      throw new TypeError("Repository write payload operation changed before dispatch");
    }
    if (
      input.payload.operation !== "create_file"
      && !sameGitObjectFormat(
        expectedParentSha,
        exactCommitSha(input.payload.contentSha, "GitHub content SHA"),
      )
    ) {
      throw new RangeError("GitHub repository write object formats changed");
    }
    return await publishGitHubRepositoryWriteAtomically({
      apiBaseUrl: this.#apiBaseUrl,
      repositoryFullName,
      path,
      targetRef,
      expectedParentSha,
      payload: input.payload,
      request: (request) => this.#request(request),
      readJson,
      discardResponse: discardGitHubProviderResponse,
      admitRequestId: admittedRequestId,
    });
  }

  async #request(input: {
    repositoryFullName: string;
    access: "read" | "write";
    method: "GET" | "POST" | "PATCH";
    url: URL;
    body?: Record<string, unknown>;
    operation: string;
  }): Promise<Response> {
    const credential = await this.#tokens.getRepositoryContentsToken({
      repositoryFullName: input.repositoryFullName,
      access: input.access,
    });
    const token = exactToken(credential.token);
    try {
      return await this.#fetch(input.url, {
        method: input.method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          ...(input.body ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "stensibly",
          "X-GitHub-Api-Version": githubApiVersion,
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      });
    } catch {
      throw new Error(`GitHub could not ${input.operation} before a response was available`);
    }
  }
}

function requireOk(response: Response, operation: string): void {
  if (response.ok) return;
  discardGitHubProviderResponse(response);
  throw new Error(`GitHub could not ${operation} (HTTP ${response.status})`);
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      discardGitHubProviderResponse(response);
      throw invalidResponse(`GitHub ${operation} response length was invalid`);
    }
    const declaredBytes = Number(declared);
    if (
      !Number.isSafeInteger(declaredBytes)
      || declaredBytes > maximumResponseBytes
    ) {
      discardGitHubProviderResponse(response);
      throw invalidResponse(
        `GitHub ${operation} response exceeded its byte limit`,
      );
    }
  }
  let text: string;
  try {
    text = await readBoundedGitHubProviderResponseText(
      response,
      maximumResponseBytes,
    );
  } catch (error) {
    if (error instanceof GitHubProviderResponseReadError) {
      throw invalidResponse(
        `GitHub ${operation} response could not be read within its bounds`,
      );
    }
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(`GitHub ${operation} response was not valid JSON`);
  }
}

function refUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  targetRef: string,
): URL {
  return new URL(
    `${repositoryUrl(apiBaseUrl, repositoryFullName)}/git/ref/heads/${encodePath(targetRef)}`,
  );
}

function commitUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  commitSha: string,
): URL {
  return new URL(
    `${repositoryUrl(apiBaseUrl, repositoryFullName)}/git/commits/${commitSha}`,
  );
}

function repositoryUrl(apiBaseUrl: string, repositoryFullName: string): string {
  const [owner, repository] = repositoryParts(repositoryFullName);
  return `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function encodePath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function repositoryParts(repositoryFullName: string): [string, string] {
  const [owner, repository] = repositoryFullName.split("/");
  if (!owner || !repository) {
    throw new RangeError("Use a GitHub owner/repository identifier");
  }
  return [owner, repository];
}

function exactRepository(value: unknown): string {
  try {
    return admitGitHubRepositoryFullName(value);
  } catch {
    throw new RangeError("GitHub repository identity is invalid");
  }
}

function exactBranch(value: unknown): string {
  try {
    return admitGitHubBranchRef(value);
  } catch {
    throw new RangeError("GitHub target branch is invalid");
  }
}

function exactPath(value: unknown): string {
  try {
    return admitGitHubRepositoryPath(value);
  } catch {
    throw new RangeError("GitHub repository path is invalid");
  }
}

function exactCommitSha(value: unknown, label: string): string {
  try {
    return admitGitObjectId(value);
  } catch {
    throw invalidResponse(`${label} was invalid`);
  }
}

function responseObjectId(value: unknown, label: string): string {
  return exactCommitSha(value, label);
}

function exactParents(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw invalidResponse(`${label} were invalid`);
  }
  return value.map((entry) => {
    const parent = exactRecord(entry, "GitHub commit parent");
    return responseObjectId(parent.sha, "GitHub commit parent SHA");
  });
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(`${label} was malformed`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidResponse(`${label} was malformed`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw invalidResponse(`${label} was malformed`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw invalidResponse(`${label} was malformed`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function assertOptionalExactApiUrl(
  value: unknown,
  expected: URL,
  label: string,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value !== expected.href) {
    throw invalidResponse(`${label} was invalid`);
  }
  let actual: URL;
  try {
    actual = new URL(value);
  } catch {
    throw invalidResponse(`${label} was invalid`);
  }
  if (
    actual.protocol !== "https:"
    || actual.username
    || actual.password
    || actual.search
    || actual.hash
    || actual.origin !== expected.origin
    || actual.pathname !== expected.pathname
  ) {
    throw invalidResponse(`${label} was invalid`);
  }
}

function admittedRequestId(value: unknown): string | null {
  return typeof value === "string"
      && requestIdPattern.test(value)
      && !credentialShapedPattern.test(value)
    ? value
    : null;
}

function exactToken(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 8_192) {
    throw new Error("GitHub repository write token was unavailable");
  }
  return value;
}

function normalizedApiBaseUrl(value: string): string {
  const url = new URL(value);
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && url.hostname === "localhost";
  if (
    (!secure && !localHttp)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("GitHub API base URL must use an exact secure origin");
  }
  return url.toString().replace(/\/$/, "");
}

function invalidResponse(message: string): Error {
  return new Error(message);
}
