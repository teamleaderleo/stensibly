import type { GitHubInstallationToken } from "./github-app-installation-token.js";
import { sha256 } from "./canonical-json.js";
import { receiverSafeFetch } from "./fetch-implementation.js";
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
import type {
  RepositoryWriteCommitTreeSnapshot,
  RepositoryWriteTreeEntry,
} from "./repository-write-fence.js";

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
 * This adapter constructs one direct-child commit from an immutable parent and
 * publishes it through a non-forced ref update. It does not choose authority,
 * reserve idempotency, retry ambiguous writes, or release the repository/ref
 * lane; those semantics remain service-owned.
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
    this.#fetch = receiverSafeFetch(options.fetch);
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

  async getCommitTreeSnapshot(input: {
    repositoryFullName: string;
    commitSha: string;
  }): Promise<RepositoryWriteCommitTreeSnapshot> {
    const repositoryFullName = exactRepository(input.repositoryFullName);
    const commitSha = exactCommitSha(input.commitSha, "GitHub commit SHA");
    const commitResponse = await this.#request({
      repositoryFullName,
      access: "read",
      method: "GET",
      url: commitUrl(this.#apiBaseUrl, repositoryFullName, commitSha),
      operation: "read commit tree identity",
    });
    requireOk(commitResponse, "read commit tree identity");
    const commit = exactRecord(
      await readJson(commitResponse, "read commit tree identity"),
      "GitHub commit tree response",
    );
    if (responseObjectId(commit.sha, "GitHub commit response SHA") !== commitSha) {
      throw invalidResponse("GitHub commit tree response identity changed");
    }
    const parents = exactParents(commit.parents, "GitHub commit parents");
    const tree = exactRecord(commit.tree, "GitHub commit tree identity");
    const treeSha = responseObjectId(tree.sha, "GitHub commit tree SHA");
    if (!sameGitObjectFormat(commitSha, treeSha, ...parents)) {
      throw invalidResponse("GitHub commit tree response mixed object formats");
    }
    assertOptionalExactApiUrl(
      tree.url,
      treeUrl(this.#apiBaseUrl, repositoryFullName, treeSha),
      "GitHub commit tree URL",
    );
    const message = boundedCommitMessage(commit.message);

    const treeResponse = await this.#request({
      repositoryFullName,
      access: "read",
      method: "GET",
      url: recursiveTreeUrl(this.#apiBaseUrl, repositoryFullName, treeSha),
      operation: "read complete commit tree",
    });
    requireOk(treeResponse, "read complete commit tree");
    const treeRecord = exactRecord(
      await readJson(treeResponse, "read complete commit tree"),
      "GitHub complete tree response",
    );
    if (
      responseObjectId(treeRecord.sha, "GitHub complete tree SHA") !== treeSha
      || treeRecord.truncated !== false
    ) {
      throw invalidResponse("GitHub complete tree response was incomplete");
    }
    assertOptionalExactApiUrl(
      treeRecord.url,
      treeUrl(this.#apiBaseUrl, repositoryFullName, treeSha),
      "GitHub complete tree URL",
    );
    const entries = exactTreeEntries(
      treeRecord.tree,
      this.#apiBaseUrl,
      repositoryFullName,
      commitSha,
    );
    return Object.freeze({
      version: 1,
      repositoryFullName,
      commitSha,
      parentShas: Object.freeze(parents),
      messageSha256: sha256(message),
      treeSha,
      entries,
    });
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
      discardResponse,
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

function treeUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  treeSha: string,
): URL {
  return new URL(
    `${repositoryUrl(apiBaseUrl, repositoryFullName)}/git/trees/${treeSha}`,
  );
}

function recursiveTreeUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  treeSha: string,
): URL {
  const url = treeUrl(apiBaseUrl, repositoryFullName, treeSha);
  url.searchParams.set("recursive", "1");
  return url;
}

function blobUrl(
  apiBaseUrl: string,
  repositoryFullName: string,
  blobSha: string,
): URL {
  return new URL(
    `${repositoryUrl(apiBaseUrl, repositoryFullName)}/git/blobs/${blobSha}`,
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

function exactTreeEntries(
  value: unknown,
  apiBaseUrl: string,
  repositoryFullName: string,
  commitSha: string,
): readonly RepositoryWriteTreeEntry[] {
  const values = exactArray(value, "GitHub complete tree entries", 100_000);
  const paths = new Set<string>();
  const entries: RepositoryWriteTreeEntry[] = [];
  for (const value of values) {
    const record = exactRecord(value, "GitHub complete tree entry");
    const path = exactPath(record.path);
    if (paths.has(path)) {
      throw invalidResponse("GitHub complete tree contained a duplicate path");
    }
    paths.add(path);
    const type = record.type;
    const mode = record.mode;
    const sha = responseObjectId(record.sha, "GitHub complete tree entry SHA");
    if (!sameGitObjectFormat(commitSha, sha)) {
      throw invalidResponse("GitHub complete tree entry mixed object formats");
    }
    if (type === "tree") {
      if (mode !== "040000") {
        throw invalidResponse("GitHub complete tree entry mode was invalid");
      }
      assertOptionalExactApiUrl(
        record.url,
        treeUrl(apiBaseUrl, repositoryFullName, sha),
        "GitHub subtree URL",
      );
      continue;
    }
    if (
      (type !== "blob" && type !== "commit")
      || (type === "blob"
        ? mode !== "100644" && mode !== "100755" && mode !== "120000"
        : mode !== "160000")
    ) {
      throw invalidResponse("GitHub complete tree entry type was invalid");
    }
    assertOptionalExactApiUrl(
      record.url,
      type === "blob"
        ? blobUrl(apiBaseUrl, repositoryFullName, sha)
        : commitUrl(apiBaseUrl, repositoryFullName, sha),
      "GitHub complete tree entry URL",
    );
    entries.push({ path, mode, type, sha } as RepositoryWriteTreeEntry);
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function exactArray(value: unknown, label: string, maximumLength: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalidResponse(`${label} were malformed`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : null;
  if (
    typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > maximumLength
  ) throw invalidResponse(`${label} were malformed`);
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
      throw invalidResponse(`${label} were malformed`);
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw invalidResponse(`${label} were malformed`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function boundedCommitMessage(value: unknown): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximumResponseBytes
  ) throw invalidResponse("GitHub commit message was invalid");
  return value;
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
