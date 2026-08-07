import type { GitHubInstallationToken } from "./github-app-installation-token.js";
import type {
  GitHubRepositoryWritePayload,
  GitHubRepositoryWriteProviderAdapter,
} from "./github-repository-write-provider-service.js";
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
}

interface ProviderWriteResult {
  commitSha: string;
  providerRequestId?: string;
  targetRef: string;
  parentSha?: string;
}

const githubApiVersion = "2022-11-28";
const maximumResponseBytes = 512 * 1024;
const maximumResponseChunks = 4_096;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const credentialShapedPattern =
  /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.(?:tok|svc)_[A-Za-z0-9._-]{12,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

/**
 * Native transport for the durable repository-write provider service.
 *
 * This adapter performs only exact file create/update/delete operations. It
 * does not choose authority, reserve idempotency, retry ambiguous writes, or
 * release the repository/ref lane; those semantics remain service-owned.
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
    this.#fetch = options.fetch ?? globalThis.fetch;
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
      discardResponse(response);
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

    const request = mutationRequest(input.payload, targetRef);
    const response = await this.#request({
      repositoryFullName,
      access: "write",
      method: request.method,
      url: contentUrl(this.#apiBaseUrl, repositoryFullName, path),
      body: request.body,
      operation: repositoryWriteOperationLabel(input.operation),
    });
    requireOk(response, repositoryWriteOperationLabel(input.operation));
    const value = await readJson(
      response,
      repositoryWriteOperationLabel(input.operation),
    );
    const record = exactRecord(value, "GitHub repository write response");
    const commit = exactRecord(record.commit, "GitHub repository write commit");
    const commitSha = responseObjectId(
      commit.sha,
      "GitHub repository write commit SHA",
    );
    assertOptionalExactApiUrl(
      commit.url,
      commitUrl(this.#apiBaseUrl, repositoryFullName, commitSha),
      "GitHub repository write commit URL",
    );
    const parents = commit.parents === undefined
      ? []
      : exactParents(commit.parents, "GitHub repository write commit parents");
    if (parents.length > 1) {
      throw invalidResponse(
        "GitHub repository write response returned a multi-parent commit",
      );
    }
    if (!sameGitObjectFormat(expectedParentSha, commitSha, ...parents)) {
      throw invalidResponse("GitHub repository write response mixed object formats");
    }
    const providerRequestId = admittedRequestId(
      response.headers.get("x-github-request-id"),
    );
    return Object.freeze({
      commitSha,
      ...(providerRequestId ? { providerRequestId } : {}),
      targetRef,
      ...(parents[0] ? { parentSha: parents[0] } : {}),
    });
  }

  async #request(input: {
    repositoryFullName: string;
    access: "read" | "write";
    method: "GET" | "PUT" | "DELETE";
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

function mutationRequest(
  payload: GitHubRepositoryWritePayload,
  targetRef: string,
): {
  method: "PUT" | "DELETE";
  body: Record<string, unknown>;
} {
  if (payload.operation === "create_file") {
    return {
      method: "PUT",
      body: {
        message: payload.message,
        content: Buffer.from(payload.content, "utf8").toString("base64"),
        branch: targetRef,
      },
    };
  }
  if (payload.operation === "update_file") {
    return {
      method: "PUT",
      body: {
        message: payload.message,
        content: Buffer.from(payload.content, "utf8").toString("base64"),
        sha: payload.contentSha,
        branch: targetRef,
      },
    };
  }
  return {
    method: "DELETE",
    body: {
      message: payload.message,
      sha: payload.contentSha,
      branch: targetRef,
    },
  };
}

function requireOk(response: Response, operation: string): void {
  if (response.ok) return;
  discardResponse(response);
  throw new Error(`GitHub could not ${operation} (HTTP ${response.status})`);
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  const text = await readBoundedText(response, operation);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(`GitHub ${operation} response was not valid JSON`);
  }
}

async function readBoundedText(
  response: Response,
  operation: string,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      discardResponse(response);
      throw invalidResponse(`GitHub ${operation} response length was invalid`);
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumResponseBytes) {
      discardResponse(response);
      throw invalidResponse(`GitHub ${operation} response exceeded its byte limit`);
    }
  }
  if (response.body === null) return "";

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    discardResponse(response);
    throw invalidResponse(`GitHub ${operation} response could not be read`);
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let totalChunks = 0;
  let failed = false;
  try {
    while (true) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch {
        failed = true;
        cancelReader(reader);
        throw invalidResponse(`GitHub ${operation} response could not be read`);
      }
      if (next.done) break;
      totalChunks += 1;
      if (totalChunks > maximumResponseChunks || !(next.value instanceof Uint8Array)) {
        failed = true;
        cancelReader(reader);
        throw invalidResponse(`GitHub ${operation} response exceeded its work limit`);
      }
      const nextTotal = totalBytes + next.value.byteLength;
      if (!Number.isSafeInteger(nextTotal) || nextTotal > maximumResponseBytes) {
        failed = true;
        cancelReader(reader);
        throw invalidResponse(`GitHub ${operation} response exceeded its byte limit`);
      }
      const copy = new Uint8Array(next.value.byteLength);
      Uint8Array.prototype.set.call(copy, next.value);
      chunks.push(copy);
      totalBytes = nextTotal;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      if (!failed) {
        throw invalidResponse(`GitHub ${operation} response could not be released`);
      }
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidResponse(`GitHub ${operation} response was not valid UTF-8`);
  }
}

function discardResponse(response: Response): void {
  try {
    suppressCancellation(response.body?.cancel());
  } catch {
    // The fixed status/admission error remains authoritative.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    suppressCancellation(reader.cancel());
  } catch {
    // The fixed bounded-reader error remains authoritative.
  }
}

function suppressCancellation(value: unknown): void {
  if (
    value !== null
    && (typeof value === "object" || typeof value === "function")
    && "then" in value
  ) {
    void Promise.resolve(value).catch(() => undefined);
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

function contentUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  path: string,
): URL {
  return new URL(
    `${repositoryUrl(apiBaseUrl, repositoryFullName)}/contents/${encodePath(path)}`,
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
  return value as Record<string, unknown>;
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

function repositoryWriteOperationLabel(
  operation: "create_file" | "update_file" | "delete_file",
): string {
  if (operation === "create_file") return "create repository file";
  if (operation === "update_file") return "update repository file";
  return "delete repository file";
}

function invalidResponse(message: string): Error {
  return new Error(message);
}
