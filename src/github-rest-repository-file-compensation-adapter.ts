import { createHash } from "node:crypto";
import { receiverSafeFetch } from "./fetch-implementation.js";
import {
  GitHubRestRepositoryWriteAdapter,
  type GitHubRepositoryWriteTokenProvider,
} from "./github-rest-repository-write-adapter.js";
import {
  type GitHubRepositoryFileCompensationAdapter,
  type RepositoryFileCompensationBlob,
  type RepositoryFileCompensationMutationResult,
  type RepositoryFileCompensationPathState,
} from "./github-repository-file-compensation.js";
import {
  admitGitHubBranchRef,
  admitGitHubRepositoryFullName,
  admitGitHubRepositoryPath,
  admitGitObjectId,
  sameGitObjectFormat,
} from "./github-repository-write-admission.js";
import {
  admitGitHubRepositoryNodeIdResponse,
  admitGitHubUpdateRefsCasResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
} from "./github-update-refs-cas.js";

export interface GitHubRestRepositoryFileCompensationAdapterOptions {
  readonly tokenProvider: GitHubRepositoryWriteTokenProvider;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
}

const githubApiVersion = "2022-11-28";
const defaultResponseBytes = 512 * 1024;
const maximumResponseChunks = 65_536;
const maximumPreimageBytes = 10 * 1024 * 1024;
const providerRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * Exact-preimage native adapter for #1556.
 *
 * It deliberately exposes no general revert/reset primitive. The only mutation
 * constructs one direct-child commit from the already-verified source commit,
 * requires that commit's path to match the admitted source postimage, requires
 * the new full tree to equal the immutable original-parent tree, and publishes
 * through the same non-forced updateRefs CAS used by repository writes.
 */
export class GitHubRestRepositoryFileCompensationAdapter
  implements GitHubRepositoryFileCompensationAdapter
{
  readonly #tokens: GitHubRepositoryWriteTokenProvider;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #reads: GitHubRestRepositoryWriteAdapter;

  constructor(options: GitHubRestRepositoryFileCompensationAdapterOptions) {
    this.#tokens = options.tokenProvider;
    this.#apiBaseUrl = normalizedApiBaseUrl(options.apiBaseUrl ?? "https://api.github.com");
    this.#fetch = receiverSafeFetch(options.fetch);
    this.#reads = new GitHubRestRepositoryWriteAdapter({
      tokenProvider: options.tokenProvider,
      apiBaseUrl: this.#apiBaseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async getRefHead(input: {
    repositoryFullName: string;
    targetRef: string;
  }): Promise<string | null> {
    return await this.#reads.getRefHead(input);
  }

  async getCommitTreeSnapshot(input: {
    repositoryFullName: string;
    commitSha: string;
  }): Promise<unknown> {
    return await this.#reads.getCommitTreeSnapshot(input);
  }

  async getBlobBytes(input: {
    repositoryFullName: string;
    blobSha: string;
    maximumBytes: number;
  }): Promise<RepositoryFileCompensationBlob> {
    const repositoryFullName = admitGitHubRepositoryFullName(input.repositoryFullName);
    const blobSha = admitGitObjectId(input.blobSha);
    const maximumBytes = exactMaximumBytes(input.maximumBytes);
    const response = await this.#request({
      repositoryFullName,
      access: "read",
      method: "GET",
      url: blobUrl(this.#apiBaseUrl, repositoryFullName, blobSha),
      operation: "read immutable repository-file preimage blob",
    });
    requireStatus(response, 200, "read immutable repository-file preimage blob");
    const value = await readJson(
      response,
      "read immutable repository-file preimage blob",
      maximumBlobResponseBytes(maximumBytes),
    );
    const record = jsonRecord(value, "GitHub blob response");
    const returnedSha = admitGitObjectId(record.sha);
    if (returnedSha !== blobSha) {
      throw invalidResponse("GitHub preimage blob identity changed");
    }
    const size = nonNegativeSafeInteger(record.size, "GitHub preimage blob size");
    if (size > maximumBytes) {
      throw invalidResponse("GitHub preimage blob exceeded its byte limit");
    }
    if (record.encoding !== "base64" || typeof record.content !== "string") {
      throw invalidResponse("GitHub preimage blob encoding is invalid");
    }
    if (record.url !== undefined) {
      assertExactUrl(
        record.url,
        blobUrl(this.#apiBaseUrl, repositoryFullName, blobSha),
        "GitHub preimage blob URL",
      );
    }
    const compact = record.content.replace(/\r?\n/gu, "");
    if (!base64Pattern.test(compact)) {
      throw invalidResponse("GitHub preimage blob base64 is invalid");
    }
    const bytes = Buffer.from(compact, "base64");
    if (bytes.byteLength !== size || bytes.byteLength > maximumBytes) {
      throw invalidResponse("GitHub preimage blob decoded size is invalid");
    }
    if (gitBlobObjectId(bytes, blobSha.length) !== blobSha) {
      throw invalidResponse("GitHub preimage blob bytes do not match the admitted object ID");
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return Object.freeze({
      repositoryFullName,
      blobSha,
      byteLength: copy.byteLength,
      contentSha256: `sha256:${createHash("sha256").update(copy).digest("hex")}`,
      bytes: copy,
    });
  }

  async dispatchRepositoryFileCompensation(input: {
    repositoryFullName: string;
    path: string;
    targetRef: string;
    expectedParentSha: string;
    expectedCurrent: RepositoryFileCompensationPathState;
    restored: RepositoryFileCompensationPathState;
    expectedRestoredTreeSha: string;
    message: string;
    idempotencyKey: string;
  }): Promise<RepositoryFileCompensationMutationResult> {
    const repositoryFullName = admitGitHubRepositoryFullName(input.repositoryFullName);
    const path = admitGitHubRepositoryPath(input.path);
    const targetRef = admitGitHubBranchRef(input.targetRef);
    const expectedParentSha = admitGitObjectId(input.expectedParentSha);
    const expectedRestoredTreeSha = admitGitObjectId(input.expectedRestoredTreeSha);
    const expectedCurrent = admitPathState(input.expectedCurrent, expectedParentSha);
    const restored = admitPathState(input.restored, expectedParentSha);
    const message = exactCommitMessage(input.message);
    exactIdentifier(input.idempotencyKey, "Repository-file compensation idempotency key", 240);
    if (!sameGitObjectFormat(expectedParentSha, expectedRestoredTreeSha)) {
      throw new RangeError("Repository-file compensation object formats changed");
    }

    const currentTreeSha = await this.#readExpectedParentTree({
      repositoryFullName,
      expectedParentSha,
    });
    await this.#requireExpectedCurrentPath({
      repositoryFullName,
      path,
      expectedParentSha,
      treeSha: currentTreeSha,
      expectedCurrent,
    });
    const repository = await this.#readRepositoryNodeIdentity(repositoryFullName);
    const nextTreeSha = await this.#createExactRestoredTree({
      repositoryFullName,
      path,
      expectedParentSha,
      currentTreeSha,
      expectedCurrent,
      restored,
      expectedRestoredTreeSha,
    });
    const nextCommitSha = await this.#createCompensationCommit({
      repositoryFullName,
      expectedParentSha,
      treeSha: nextTreeSha,
      message,
    });
    return await this.#publishExactRef({
      repositoryFullName,
      targetRef,
      expectedParentSha,
      nextCommitSha,
      restoredTreeSha: nextTreeSha,
      repository,
    });
  }

  async #readExpectedParentTree(input: {
    repositoryFullName: string;
    expectedParentSha: string;
  }): Promise<string> {
    const response = await this.#request({
      repositoryFullName: input.repositoryFullName,
      access: "read",
      method: "GET",
      url: commitUrl(this.#apiBaseUrl, input.repositoryFullName, input.expectedParentSha),
      operation: "read compensation parent commit",
    });
    requireStatus(response, 200, "read compensation parent commit");
    const record = jsonRecord(
      await readJson(response, "read compensation parent commit"),
      "GitHub compensation parent commit",
    );
    if (admitGitObjectId(record.sha) !== input.expectedParentSha) {
      throw invalidResponse("GitHub compensation parent commit identity changed");
    }
    if (record.url !== undefined) {
      assertExactUrl(
        record.url,
        commitUrl(this.#apiBaseUrl, input.repositoryFullName, input.expectedParentSha),
        "GitHub compensation parent commit URL",
      );
    }
    const tree = jsonRecord(record.tree, "GitHub compensation parent tree");
    const treeSha = admitGitObjectId(tree.sha);
    if (!sameGitObjectFormat(input.expectedParentSha, treeSha)) {
      throw invalidResponse("GitHub compensation parent tree object format changed");
    }
    if (tree.url !== undefined) {
      assertExactUrl(
        tree.url,
        treeUrl(this.#apiBaseUrl, input.repositoryFullName, treeSha),
        "GitHub compensation parent tree URL",
      );
    }
    return treeSha;
  }

  async #requireExpectedCurrentPath(input: {
    repositoryFullName: string;
    path: string;
    expectedParentSha: string;
    treeSha: string;
    expectedCurrent: RepositoryFileCompensationPathState;
  }): Promise<void> {
    const response = await this.#request({
      repositoryFullName: input.repositoryFullName,
      access: "read",
      method: "GET",
      url: recursiveTreeUrl(this.#apiBaseUrl, input.repositoryFullName, input.treeSha),
      operation: "read compensation source-postimage tree",
    });
    requireStatus(response, 200, "read compensation source-postimage tree");
    const record = jsonRecord(
      await readJson(response, "read compensation source-postimage tree"),
      "GitHub compensation source-postimage tree",
    );
    if (
      admitGitObjectId(record.sha) !== input.treeSha
      || record.truncated !== false
    ) {
      throw invalidResponse("GitHub compensation source-postimage tree was incomplete");
    }
    if (record.url !== undefined) {
      assertExactUrl(
        record.url,
        treeUrl(this.#apiBaseUrl, input.repositoryFullName, input.treeSha),
        "GitHub compensation source-postimage tree URL",
      );
    }
    if (!Array.isArray(record.tree)) {
      throw invalidResponse("GitHub compensation source-postimage entries are invalid");
    }
    const matches: Record<string, unknown>[] = [];
    for (const value of record.tree) {
      const entry = jsonRecord(value, "GitHub compensation tree entry");
      if (entry.path === input.path) matches.push(entry);
    }
    if (input.expectedCurrent.kind === "absent") {
      if (matches.length !== 0) {
        throw new Error("GitHub compensation source-postimage path drifted");
      }
      return;
    }
    if (matches.length !== 1) {
      throw new Error("GitHub compensation source-postimage path drifted");
    }
    const entry = matches[0]!;
    if (
      entry.type !== "blob"
      || entry.mode !== input.expectedCurrent.mode
      || admitGitObjectId(entry.sha) !== input.expectedCurrent.blobSha
    ) {
      throw new Error("GitHub compensation source-postimage path drifted");
    }
    if (entry.url !== undefined) {
      assertExactUrl(
        entry.url,
        blobUrl(this.#apiBaseUrl, input.repositoryFullName, input.expectedCurrent.blobSha),
        "GitHub compensation source-postimage blob URL",
      );
    }
  }

  async #readRepositoryNodeIdentity(repositoryFullName: string) {
    const request = buildGitHubRepositoryNodeIdRequest(this.#apiBaseUrl, repositoryFullName);
    const response = await this.#request({
      repositoryFullName,
      access: "read",
      method: "POST",
      url: new URL(request.url),
      body: request.body as Record<string, unknown>,
      operation: "read compensation repository node identity",
    });
    requireStatus(response, 200, "read compensation repository node identity");
    return admitGitHubRepositoryNodeIdResponse(
      await readJson(response, "read compensation repository node identity"),
      request,
    );
  }

  async #createExactRestoredTree(input: {
    repositoryFullName: string;
    path: string;
    expectedParentSha: string;
    currentTreeSha: string;
    expectedCurrent: RepositoryFileCompensationPathState;
    restored: RepositoryFileCompensationPathState;
    expectedRestoredTreeSha: string;
  }): Promise<string> {
    const mode = input.restored.kind === "blob"
      ? input.restored.mode
      : input.expectedCurrent.kind === "blob"
        ? input.expectedCurrent.mode
        : null;
    if (mode === null) {
      throw new RangeError("Repository-file compensation cannot delete an already-absent path");
    }
    const response = await this.#request({
      repositoryFullName: input.repositoryFullName,
      access: "write",
      method: "POST",
      url: treeCollectionUrl(this.#apiBaseUrl, input.repositoryFullName),
      body: {
        base_tree: input.currentTreeSha,
        tree: [{
          path: input.path,
          mode,
          type: "blob",
          sha: input.restored.kind === "blob" ? input.restored.blobSha : null,
        }],
      },
      operation: "create exact restored compensation tree",
    });
    requireStatus(response, 201, "create exact restored compensation tree");
    const record = jsonRecord(
      await readJson(response, "create exact restored compensation tree"),
      "GitHub restored compensation tree",
    );
    const treeSha = admitGitObjectId(record.sha);
    if (
      treeSha !== input.expectedRestoredTreeSha
      || !sameGitObjectFormat(input.expectedParentSha, treeSha)
      || record.truncated === true
    ) {
      throw invalidResponse("GitHub compensation tree did not equal the immutable parent tree");
    }
    if (record.url !== undefined) {
      assertExactUrl(
        record.url,
        treeUrl(this.#apiBaseUrl, input.repositoryFullName, treeSha),
        "GitHub restored compensation tree URL",
      );
    }
    return treeSha;
  }

  async #createCompensationCommit(input: {
    repositoryFullName: string;
    expectedParentSha: string;
    treeSha: string;
    message: string;
  }): Promise<string> {
    const response = await this.#request({
      repositoryFullName: input.repositoryFullName,
      access: "write",
      method: "POST",
      url: commitCollectionUrl(this.#apiBaseUrl, input.repositoryFullName),
      body: {
        message: input.message,
        tree: input.treeSha,
        parents: [input.expectedParentSha],
      },
      operation: "create repository-file compensation commit",
    });
    requireStatus(response, 201, "create repository-file compensation commit");
    const record = jsonRecord(
      await readJson(response, "create repository-file compensation commit"),
      "GitHub repository-file compensation commit",
    );
    const commitSha = admitGitObjectId(record.sha);
    if (!sameGitObjectFormat(input.expectedParentSha, input.treeSha, commitSha)) {
      throw invalidResponse("GitHub compensation commit object format changed");
    }
    const tree = jsonRecord(record.tree, "GitHub compensation commit tree");
    if (admitGitObjectId(tree.sha) !== input.treeSha) {
      throw invalidResponse("GitHub compensation commit tree changed");
    }
    if (!Array.isArray(record.parents) || record.parents.length !== 1) {
      throw invalidResponse("GitHub compensation commit parents changed");
    }
    const parent = jsonRecord(record.parents[0], "GitHub compensation commit parent");
    if (admitGitObjectId(parent.sha) !== input.expectedParentSha) {
      throw invalidResponse("GitHub compensation commit parent changed");
    }
    if (record.url !== undefined) {
      assertExactUrl(
        record.url,
        commitUrl(this.#apiBaseUrl, input.repositoryFullName, commitSha),
        "GitHub compensation commit URL",
      );
    }
    return commitSha;
  }

  async #publishExactRef(input: {
    repositoryFullName: string;
    targetRef: string;
    expectedParentSha: string;
    nextCommitSha: string;
    restoredTreeSha: string;
    repository: ReturnType<typeof admitGitHubRepositoryNodeIdResponse>;
  }): Promise<RepositoryFileCompensationMutationResult> {
    const request = buildGitHubUpdateRefsCasRequest({
      repository: input.repository,
      targetRef: input.targetRef,
      expectedHeadSha: input.expectedParentSha,
      newHeadSha: input.nextCommitSha,
    });
    const response = await this.#request({
      repositoryFullName: input.repositoryFullName,
      access: "write",
      method: "POST",
      url: new URL(request.url),
      body: request.body as Record<string, unknown>,
      operation: "publish repository-file compensation ref",
    });
    requireStatus(response, 200, "publish repository-file compensation ref");
    const providerRequestId = admitProviderRequestId(
      response.headers.get("x-github-request-id"),
    );
    admitGitHubUpdateRefsCasResponse(
      await readJson(response, "publish repository-file compensation ref"),
      request.clientMutationId,
    );
    return Object.freeze({
      commitSha: input.nextCommitSha,
      targetRef: input.targetRef,
      parentSha: input.expectedParentSha,
      restoredTreeSha: input.restoredTreeSha,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
  }

  async #request(input: {
    repositoryFullName: string;
    access: "read" | "write";
    method: "GET" | "POST";
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

function admitPathState(
  value: RepositoryFileCompensationPathState,
  formatSha: string,
): RepositoryFileCompensationPathState {
  if (!value || typeof value !== "object") {
    throw new TypeError("Repository-file compensation path state is invalid");
  }
  if (value.kind === "absent") return Object.freeze({ kind: "absent" });
  if (
    value.kind !== "blob"
    || (value.mode !== "100644" && value.mode !== "100755")
  ) throw new TypeError("Repository-file compensation blob state is invalid");
  const blobSha = admitGitObjectId(value.blobSha);
  if (!sameGitObjectFormat(formatSha, blobSha)) {
    throw new RangeError("Repository-file compensation path object format changed");
  }
  return Object.freeze({ kind: "blob", mode: value.mode, blobSha });
}

function requireStatus(response: Response, expected: number, operation: string): void {
  if (response.status === expected) return;
  discardResponse(response);
  if (!response.ok) throw new Error(`GitHub could not ${operation} (HTTP ${response.status})`);
  throw invalidResponse(`GitHub ${operation} response status was invalid`);
}

async function readJson(
  response: Response,
  operation: string,
  maximumBytes = defaultResponseBytes,
): Promise<unknown> {
  const text = await readBoundedText(response, operation, maximumBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(`GitHub ${operation} response was not valid JSON`);
  }
}

async function readBoundedText(
  response: Response,
  operation: string,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      discardResponse(response);
      throw invalidResponse(`GitHub ${operation} response length was invalid`);
    }
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
      discardResponse(response);
      throw invalidResponse(`GitHub ${operation} response exceeded its byte limit`);
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += 1;
      if (count > maximumResponseChunks || !(next.value instanceof Uint8Array)) {
        void reader.cancel().catch(() => undefined);
        throw invalidResponse(`GitHub ${operation} response exceeded its work limit`);
      }
      total += next.value.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw invalidResponse(`GitHub ${operation} response exceeded its byte limit`);
      }
      const copy = new Uint8Array(next.value.byteLength);
      copy.set(next.value);
      chunks.push(copy);
    }
  } finally {
    reader.releaseLock();
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
    throw invalidResponse(`GitHub ${operation} response was not valid UTF-8`);
  }
}

function discardResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Fixed admission error remains authoritative.
  }
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(`${label} was malformed`);
  }
  return value as Record<string, unknown>;
}

function exactMaximumBytes(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximumPreimageBytes
  ) throw new RangeError("Repository-file compensation preimage byte limit is invalid");
  return value;
}

function maximumBlobResponseBytes(maximumBytes: number): number {
  return Math.ceil(maximumBytes * 4 / 3) + 128 * 1024;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse(`${label} was invalid`);
  }
  return value;
}

function exactCommitMessage(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value.trim() !== value
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) throw new TypeError("Repository-file compensation commit message is invalid");
  return value;
}

function exactIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function exactToken(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4096
    || /[\s\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error("GitHub repository contents credential is invalid");
  return value;
}

function admitProviderRequestId(value: unknown): string | null {
  return typeof value === "string" && providerRequestIdPattern.test(value)
    ? value
    : null;
}

function gitBlobObjectId(bytes: Uint8Array, length: number): string {
  const algorithm = length === 40 ? "sha1" : length === 64 ? "sha256" : null;
  if (!algorithm) throw new RangeError("GitHub object format is invalid");
  return createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function normalizedApiBaseUrl(value: string): string {
  const url = new URL(value);
  const localhostHttp = url.protocol === "http:" && url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !localhostHttp)
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) throw new RangeError("GitHub API base URL is invalid");
  return url.href.replace(/\/+$/u, "");
}

function repositoryUrl(base: string, repositoryFullName: string): string {
  return `${base}/repos/${repositoryFullName}`;
}
function commitUrl(base: string, repository: string, sha: string): URL {
  return new URL(`${repositoryUrl(base, repository)}/git/commits/${sha}`);
}
function commitCollectionUrl(base: string, repository: string): URL {
  return new URL(`${repositoryUrl(base, repository)}/git/commits`);
}
function treeUrl(base: string, repository: string, sha: string): URL {
  return new URL(`${repositoryUrl(base, repository)}/git/trees/${sha}`);
}
function recursiveTreeUrl(base: string, repository: string, sha: string): URL {
  const url = treeUrl(base, repository, sha);
  url.searchParams.set("recursive", "1");
  return url;
}
function treeCollectionUrl(base: string, repository: string): URL {
  return new URL(`${repositoryUrl(base, repository)}/git/trees`);
}
function blobUrl(base: string, repository: string, sha: string): URL {
  return new URL(`${repositoryUrl(base, repository)}/git/blobs/${sha}`);
}

function assertExactUrl(value: unknown, expected: URL, label: string): void {
  if (typeof value !== "string") throw invalidResponse(`${label} was invalid`);
  let observed: URL;
  try {
    observed = new URL(value);
  } catch {
    throw invalidResponse(`${label} was invalid`);
  }
  if (observed.href !== expected.href) throw invalidResponse(`${label} changed identity`);
}

function invalidResponse(message: string): Error {
  const error = new Error(message);
  error.name = "GitHubRepositoryFileCompensationProviderResponseError";
  return error;
}
