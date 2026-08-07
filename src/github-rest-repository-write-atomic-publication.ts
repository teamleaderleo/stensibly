import { createHash } from "node:crypto";
import type { GitHubRepositoryWritePayload } from "./github-repository-write-provider-service.js";
import {
  admitGitHubRepositoryNodeIdResponse,
  admitGitHubUpdateRefsCasResponse,
  buildGitHubRepositoryNodeIdRequest,
  buildGitHubUpdateRefsCasRequest,
} from "./github-update-refs-cas.js";
import {
  admitGitObjectId,
  sameGitObjectFormat,
} from "./github-repository-write-admission.js";

export interface GitHubAtomicRepositoryWriteRequest {
  repositoryFullName: string;
  access: "read" | "write";
  method: "GET" | "POST" | "PATCH";
  url: URL;
  body?: Record<string, unknown>;
  operation: string;
}

export interface GitHubAtomicRepositoryWriteDependencies {
  apiBaseUrl: string;
  repositoryFullName: string;
  path: string;
  targetRef: string;
  expectedParentSha: string;
  payload: GitHubRepositoryWritePayload;
  request(input: GitHubAtomicRepositoryWriteRequest): Promise<Response>;
  readJson(response: Response, operation: string): Promise<unknown>;
  discardResponse(response: Response): void;
  admitRequestId(value: unknown): string | null;
}

export interface GitHubAtomicRepositoryWriteResult {
  commitSha: string;
  providerRequestId?: string;
  targetRef: string;
  parentSha: string;
}

interface ParentTreeEntry {
  mode: "100644" | "100755";
  sha: string;
}

const parentPreconditionError =
  "GitHub repository write parent file precondition failed";
const unsupportedParentModeError =
  "GitHub repository write parent file mode is unsupported";

export async function publishGitHubRepositoryWriteAtomically(
  input: GitHubAtomicRepositoryWriteDependencies,
): Promise<GitHubAtomicRepositoryWriteResult> {
  const repositoryRoot = repositoryUrl(
    input.apiBaseUrl,
    input.repositoryFullName,
  );
  const parentTreeSha = await readParentTreeSha(input, repositoryRoot);
  const parentEntry = await readParentTreeEntry(
    input,
    repositoryRoot,
    parentTreeSha,
  );
  const repositoryId = await readRepositoryNodeId(input);
  const nextBlobSha = input.payload.operation === "delete_file"
    ? null
    : await createBlob(input, repositoryRoot);
  const mode = input.payload.operation === "create_file"
    ? "100644"
    : parentEntry?.mode;
  if (mode !== "100644" && mode !== "100755") {
    throw new Error(unsupportedParentModeError);
  }
  const nextTreeSha = await createTree(
    input,
    repositoryRoot,
    parentTreeSha,
    mode,
    nextBlobSha,
  );
  const nextCommitSha = await createCommit(
    input,
    repositoryRoot,
    nextTreeSha,
  );
  return await publishRef(input, repositoryId, nextCommitSha);
}

async function readRepositoryNodeId(
  input: GitHubAtomicRepositoryWriteDependencies,
): Promise<string> {
  const operation = "read repository node identity";
  const request = buildGitHubRepositoryNodeIdRequest(
    input.apiBaseUrl,
    input.repositoryFullName,
  );
  const response = await input.request({
    repositoryFullName: input.repositoryFullName,
    access: "read",
    method: "POST",
    url: request.url,
    body: request.body as Record<string, unknown>,
    operation,
  });
  requireStatus(input, response, 200, operation);
  return admitGitHubRepositoryNodeIdResponse(
    await input.readJson(response, operation),
  );
}

async function readParentTreeSha(
  input: GitHubAtomicRepositoryWriteDependencies,
  repositoryRoot: string,
): Promise<string> {
  const operation = "read expected parent commit";
  const response = await input.request({
    repositoryFullName: input.repositoryFullName,
    access: "read",
    method: "GET",
    url: commitUrl(repositoryRoot, input.expectedParentSha),
    operation,
  });
  requireStatus(input, response, 200, operation);
  const record = exactRecord(await input.readJson(response, operation), operation);
  const sha = objectId(record.sha, "GitHub expected parent commit SHA");
  if (sha !== input.expectedParentSha) {
    throw invalidResponse("GitHub expected parent commit identity changed");
  }
  assertExactUrl(
    record.url,
    commitUrl(repositoryRoot, input.expectedParentSha),
    "GitHub expected parent commit URL",
  );
  const tree = exactRecord(record.tree, "GitHub expected parent tree");
  const treeSha = objectId(tree.sha, "GitHub expected parent tree SHA");
  if (!sameGitObjectFormat(input.expectedParentSha, treeSha)) {
    throw invalidResponse("GitHub expected parent tree mixed object formats");
  }
  assertExactUrl(
    tree.url,
    treeUrl(repositoryRoot, treeSha),
    "GitHub expected parent tree URL",
  );
  return treeSha;
}

async function readParentTreeEntry(
  input: GitHubAtomicRepositoryWriteDependencies,
  repositoryRoot: string,
  parentTreeSha: string,
): Promise<ParentTreeEntry | null> {
  const operation = "read expected parent tree";
  const response = await input.request({
    repositoryFullName: input.repositoryFullName,
    access: "read",
    method: "GET",
    url: recursiveTreeUrl(repositoryRoot, parentTreeSha),
    operation,
  });
  requireStatus(input, response, 200, operation);
  const record = exactRecord(await input.readJson(response, operation), operation);
  if (objectId(record.sha, "GitHub expected parent tree response SHA") !== parentTreeSha) {
    throw invalidResponse("GitHub expected parent tree identity changed");
  }
  assertExactUrl(
    record.url,
    treeUrl(repositoryRoot, parentTreeSha),
    "GitHub expected parent tree response URL",
  );
  if (record.truncated !== false) {
    throw invalidResponse("GitHub expected parent tree response was incomplete");
  }
  const entries = exactArray(
    record.tree,
    "GitHub expected parent tree entries",
    100_000,
  );
  const matches: Record<string, unknown>[] = [];
  for (const value of entries) {
    const entry = exactRecord(value, "GitHub expected parent tree entry");
    if (entry.path === input.path) matches.push(entry);
  }
  if (input.payload.operation === "create_file") {
    if (matches.length !== 0) throw new Error(parentPreconditionError);
    return null;
  }
  if (matches.length !== 1) throw new Error(parentPreconditionError);
  const entry = matches[0]!;
  const mode = entry.mode;
  const type = entry.type;
  if (
    (mode !== "100644" && mode !== "100755")
    || type !== "blob"
  ) {
    throw new Error(unsupportedParentModeError);
  }
  const sha = objectId(entry.sha, "GitHub expected parent file SHA");
  if (
    !sameGitObjectFormat(input.expectedParentSha, sha)
    || sha !== input.payload.contentSha
  ) {
    throw new Error(parentPreconditionError);
  }
  assertExactUrl(
    entry.url,
    blobUrl(repositoryRoot, sha),
    "GitHub expected parent file URL",
  );
  return { mode, sha };
}

async function createBlob(
  input: GitHubAtomicRepositoryWriteDependencies,
  repositoryRoot: string,
): Promise<string> {
  if (input.payload.operation === "delete_file") {
    throw new TypeError("Delete repository writes do not create blobs");
  }
  const operation = "create repository blob";
  const expectedSha = gitBlobObjectId(
    input.payload.content,
    input.expectedParentSha.length,
  );
  const response = await input.request({
    repositoryFullName: input.repositoryFullName,
    access: "write",
    method: "POST",
    url: blobCollectionUrl(repositoryRoot),
    body: {
      content: Buffer.from(input.payload.content, "utf8").toString("base64"),
      encoding: "base64",
    },
    operation,
  });
  requireStatus(input, response, 201, operation);
  const record = exactRecord(await input.readJson(response, operation), operation);
  const sha = objectId(record.sha, "GitHub repository blob SHA");
  if (
    !sameGitObjectFormat(input.expectedParentSha, sha)
    || sha !== expectedSha
  ) {
    throw invalidResponse("GitHub repository blob identity changed");
  }
  assertExactUrl(
    record.url,
    blobUrl(repositoryRoot, sha),
    "GitHub repository blob URL",
  );
  return sha;
}

async function createTree(
  input: GitHubAtomicRepositoryWriteDependencies,
  repositoryRoot: string,
  parentTreeSha: string,
  mode: "100644" | "100755",
  blobSha: string | null,
): Promise<string> {
  const operation = "create repository tree";
  const response = await input.request({
    repositoryFullName: input.repositoryFullName,
    access: "write",
    method: "POST",
    url: treeCollectionUrl(repositoryRoot),
    body: {
      base_tree: parentTreeSha,
      tree: [{
        path: input.path,
        mode,
        type: "blob",
        sha: blobSha,
      }],
    },
    operation,
  });
  requireStatus(input, response, 201, operation);
  const record = exactRecord(await input.readJson(response, operation), operation);
  const sha = objectId(record.sha, "GitHub repository tree SHA");
  if (!sameGitObjectFormat(input.expectedParentSha, sha)) {
    throw invalidResponse("GitHub repository tree mixed object formats");
  }
  assertExactUrl(
    record.url,
    treeUrl(repositoryRoot, sha),
    "GitHub repository tree URL",
  );
  if (record.truncated !== false) {
    throw invalidResponse("GitHub repository tree response was incomplete");
  }
  return sha;
}

async function createCommit(
  input: GitHubAtomicRepositoryWriteDependencies,
  repositoryRoot: string,
  treeSha: string,
): Promise<string> {
  const operation = "create repository commit";
  const response = await input.request({
    repositoryFullName: input.repositoryFullName,
    access: "write",
    method: "POST",
    url: commitCollectionUrl(repositoryRoot),
    body: {
      message: input.payload.message,
      tree: treeSha,
      parents: [input.expectedParentSha],
    },
    operation,
  });
  requireStatus(input, response, 201, operation);
  const record = exactRecord(await input.readJson(response, operation), operation);
  const sha = objectId(record.sha, "GitHub repository commit SHA");
  if (!sameGitObjectFormat(input.expectedParentSha, treeSha, sha)) {
    throw invalidResponse("GitHub repository commit mixed object formats");
  }
  assertExactUrl(
    record.url,
    commitUrl(repositoryRoot, sha),
    "GitHub repository commit URL",
  );
  const tree = exactRecord(record.tree, "GitHub repository commit tree");
  if (objectId(tree.sha, "GitHub repository commit tree SHA") !== treeSha) {
    throw invalidResponse("GitHub repository commit tree changed");
  }
  assertExactUrl(
    tree.url,
    treeUrl(repositoryRoot, treeSha),
    "GitHub repository commit tree URL",
  );
  const parents = exactParents(record.parents);
  if (parents.length !== 1 || parents[0] !== input.expectedParentSha) {
    throw invalidResponse("GitHub repository commit parent changed");
  }
  return sha;
}

async function publishRef(
  input: GitHubAtomicRepositoryWriteDependencies,
  repositoryId: string,
  commitSha: string,
): Promise<GitHubAtomicRepositoryWriteResult> {
  const operation = "publish repository ref";
  const request = buildGitHubUpdateRefsCasRequest({
    apiBaseUrl: input.apiBaseUrl,
    repositoryFullName: input.repositoryFullName,
    repositoryId,
    targetRef: input.targetRef,
    expectedHeadSha: input.expectedParentSha,
    newHeadSha: commitSha,
  });
  const response = await input.request({
    repositoryFullName: input.repositoryFullName,
    access: "write",
    method: "POST",
    url: request.url,
    body: request.body as Record<string, unknown>,
    operation,
  });
  requireStatus(input, response, 200, operation);
  const providerRequestId = input.admitRequestId(
    response.headers.get("x-github-request-id"),
  );
  admitGitHubUpdateRefsCasResponse(
    await input.readJson(response, operation),
    request.clientMutationId,
  );
  return Object.freeze({
    commitSha,
    ...(providerRequestId ? { providerRequestId } : {}),
    targetRef: input.targetRef,
    parentSha: input.expectedParentSha,
  });
}

function requireStatus(
  input: GitHubAtomicRepositoryWriteDependencies,
  response: Response,
  expectedStatus: number,
  operation: string,
): void {
  if (response.status === expectedStatus) return;
  input.discardResponse(response);
  if (!response.ok) {
    throw new Error(`GitHub could not ${operation} (HTTP ${response.status})`);
  }
  throw invalidResponse(`GitHub ${operation} response status was invalid`);
}

function exactParents(value: unknown): string[] {
  return exactArray(value, "GitHub repository commit parents", 16).map(
    (entry) => {
      const record = exactRecord(entry, "GitHub repository commit parent");
      return objectId(record.sha, "GitHub repository commit parent SHA");
    },
  );
}

function exactArray(
  value: unknown,
  label: string,
  maximumLength: number,
): unknown[] {
  let isArray: boolean;
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    prototype = isArray && value !== null ? Object.getPrototypeOf(value) : null;
    lengthDescriptor = isArray && value !== null
      ? Object.getOwnPropertyDescriptor(value, "length")
      : undefined;
  } catch {
    throw invalidResponse(`${label} were malformed`);
  }
  if (!isArray || prototype !== Array.prototype) {
    throw invalidResponse(`${label} were malformed`);
  }
  const lengthValue = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (
    typeof lengthValue !== "number"
    || !Number.isSafeInteger(lengthValue)
    || lengthValue < 0
    || lengthValue > maximumLength
  ) {
    throw invalidResponse(`${label} were malformed`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < lengthValue; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw invalidResponse(`${label} were malformed`);
    }
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw invalidResponse(`${label} were malformed`);
    }
    result.push(descriptor.value);
  }
  return result;
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

function objectId(value: unknown, label: string): string {
  try {
    return admitGitObjectId(value);
  } catch {
    throw invalidResponse(`${label} was invalid`);
  }
}

function gitBlobObjectId(content: string, objectIdLength: number): string {
  const bytes = Buffer.from(content, "utf8");
  const algorithm = objectIdLength === 40
    ? "sha1"
    : objectIdLength === 64
      ? "sha256"
      : null;
  if (!algorithm) {
    throw invalidResponse("GitHub repository object format was invalid");
  }
  return createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function assertExactUrl(value: unknown, expected: URL, label: string): void {
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
  ) {
    throw invalidResponse(`${label} was invalid`);
  }
}

function repositoryUrl(apiBaseUrl: string, repositoryFullName: string): string {
  const [owner, repository] = repositoryFullName.split("/");
  if (!owner || !repository) {
    throw new RangeError("Use a GitHub owner/repository identifier");
  }
  return `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function commitUrl(repositoryRoot: string, sha: string): URL {
  return new URL(`${repositoryRoot}/git/commits/${sha}`);
}

function commitCollectionUrl(repositoryRoot: string): URL {
  return new URL(`${repositoryRoot}/git/commits`);
}

function treeUrl(repositoryRoot: string, sha: string): URL {
  return new URL(`${repositoryRoot}/git/trees/${sha}`);
}

function recursiveTreeUrl(repositoryRoot: string, sha: string): URL {
  const url = treeUrl(repositoryRoot, sha);
  url.searchParams.set("recursive", "1");
  return url;
}

function treeCollectionUrl(repositoryRoot: string): URL {
  return new URL(`${repositoryRoot}/git/trees`);
}

function blobUrl(repositoryRoot: string, sha: string): URL {
  return new URL(`${repositoryRoot}/git/blobs/${sha}`);
}

function blobCollectionUrl(repositoryRoot: string): URL {
  return new URL(`${repositoryRoot}/git/blobs`);
}

function invalidResponse(message: string): Error {
  return new Error(message);
}
