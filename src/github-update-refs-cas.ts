import {
  sha256,
  stableJson,
} from "./canonical-json.js";
import {
  admitGitHubBranchRef,
  admitGitHubRepositoryFullName,
  admitGitObjectId,
  sameGitObjectFormat,
} from "./github-repository-write-admission.js";

export interface GitHubGraphqlRequest {
  url: URL;
  body: Readonly<Record<string, unknown>>;
}

export interface GitHubRepositoryNodeIdentity {
  graphqlUrl: string;
  repositoryFullName: string;
  repositoryId: string;
}

export interface GitHubUpdateRefsCasRequest extends GitHubGraphqlRequest {
  clientMutationId: string;
}

export interface GitHubUpdateRefsCasInput {
  repository: GitHubRepositoryNodeIdentity;
  targetRef: string;
  expectedHeadSha: string;
  newHeadSha: string;
}

export interface GitHubUpdateRefsCasResult {
  clientMutationId: string;
}

const repositoryNodeIdQuery =
  "query StensiblyRepositoryNodeId($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id nameWithOwner } }";
const updateRefsMutation =
  "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }";
const nodeIdPattern = /^[\x21-\x7e]{1,256}$/u;
const providerRepositoryPattern = /^[\x20-\x7e]{1,200}$/u;
const clientMutationIdPattern = /^stensibly-write-[a-f0-9]{64}$/u;
const admittedRepositoryIdentities = new WeakSet<object>();

export function buildGitHubRepositoryNodeIdRequest(
  apiBaseUrl: string,
  repositoryFullName: string,
): GitHubGraphqlRequest {
  const repository = admitGitHubRepositoryFullName(repositoryFullName);
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw invalidGraphqlResponse();
  return Object.freeze({
    url: githubGraphqlUrl(apiBaseUrl),
    body: Object.freeze({
      query: repositoryNodeIdQuery,
      variables: Object.freeze({ owner, name }),
    }),
  });
}

export function admitGitHubRepositoryNodeIdResponse(
  value: unknown,
  apiBaseUrl: string,
  expectedRepositoryFullName: string,
): Readonly<GitHubRepositoryNodeIdentity> {
  const graphqlUrl = githubGraphqlUrl(apiBaseUrl).href;
  const expectedRepository = admitGitHubRepositoryFullName(
    expectedRepositoryFullName,
  );
  const envelope = record(value);
  if (optionalDataProperty(envelope, "errors") !== undefined) {
    throw new Error("GitHub could not read repository node identity");
  }
  const data = record(requiredDataProperty(envelope, "data"));
  const repository = record(requiredDataProperty(data, "repository"));
  const repositoryFullName = admitProviderRepositoryFullName(
    requiredDataProperty(repository, "nameWithOwner"),
  );
  if (repositoryFullName !== expectedRepository) {
    throw invalidGraphqlResponse();
  }
  const identity = Object.freeze({
    graphqlUrl,
    repositoryFullName,
    repositoryId: admitNodeId(requiredDataProperty(repository, "id")),
  });
  admittedRepositoryIdentities.add(identity);
  return identity;
}

export function buildGitHubUpdateRefsCasRequest(
  input: GitHubUpdateRefsCasInput,
): GitHubUpdateRefsCasRequest {
  const snapshot = snapshotCasInput(input);
  const url = admittedGraphqlEndpoint(snapshot.repository.graphqlUrl);
  const repositoryFullName = admitGitHubRepositoryFullName(
    snapshot.repository.repositoryFullName,
  );
  const repositoryId = admitNodeId(snapshot.repository.repositoryId);
  const targetRef = admitGitHubBranchRef(snapshot.targetRef);
  const expectedHeadSha = admitGitObjectId(snapshot.expectedHeadSha);
  const newHeadSha = admitGitObjectId(snapshot.newHeadSha);
  if (!sameGitObjectFormat(expectedHeadSha, newHeadSha)) {
    throw new RangeError("GitHub updateRefs object format is invalid");
  }
  const clientMutationId = mutationIdentity({
    apiUrl: url.href,
    repositoryFullName,
    repositoryId,
    targetRef,
    expectedHeadSha,
    newHeadSha,
    objectIdLength: expectedHeadSha.length,
  });
  return Object.freeze({
    url,
    body: Object.freeze({
      query: updateRefsMutation,
      variables: Object.freeze({
        input: Object.freeze({
          repositoryId,
          refUpdates: Object.freeze([Object.freeze({
            name: `refs/heads/${targetRef}`,
            beforeOid: expectedHeadSha,
            afterOid: newHeadSha,
            force: false,
          })]),
          clientMutationId,
        }),
      }),
    }),
    clientMutationId,
  });
}

export function admitGitHubUpdateRefsCasResponse(
  value: unknown,
  expectedClientMutationId: string,
): GitHubUpdateRefsCasResult {
  if (
    typeof expectedClientMutationId !== "string"
    || !clientMutationIdPattern.test(expectedClientMutationId)
  ) {
    throw invalidGraphqlResponse();
  }
  const envelope = record(value);
  if (optionalDataProperty(envelope, "errors") !== undefined) {
    throw new Error("GitHub could not publish repository ref");
  }
  const data = record(requiredDataProperty(envelope, "data"));
  const updateRefs = record(requiredDataProperty(data, "updateRefs"));
  if (requiredDataProperty(updateRefs, "clientMutationId") !== expectedClientMutationId) {
    throw invalidGraphqlResponse();
  }
  return Object.freeze({ clientMutationId: expectedClientMutationId });
}

export function githubGraphqlUrl(apiBaseUrl: string): URL {
  if (typeof apiBaseUrl !== "string") {
    throw new RangeError("GitHub API base URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw new RangeError("GitHub API base URL is invalid");
  }
  const localhostHttp = url.protocol === "http:" && url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !localhostHttp)
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new RangeError("GitHub API base URL is invalid");
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname === "/api/v3"
    ? "/api/graphql"
    : `${pathname}/graphql`.replace(/\/{2,}/gu, "/");
  return url;
}

function admittedGraphqlEndpoint(value: unknown): URL {
  if (typeof value !== "string") throw invalidCasInput();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidCasInput();
  }
  const localhostHttp = url.protocol === "http:" && url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !localhostHttp)
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !url.pathname.endsWith("/graphql")
    || url.href !== value
  ) {
    throw invalidCasInput();
  }
  return url;
}

function mutationIdentity(value: Readonly<{
  apiUrl: string;
  repositoryFullName: string;
  repositoryId: string;
  targetRef: string;
  expectedHeadSha: string;
  newHeadSha: string;
  objectIdLength: number;
}>): string {
  const digest = sha256(stableJson(value)).slice("sha256:".length);
  return `stensibly-write-${digest}`;
}

function snapshotCasInput(value: unknown): GitHubUpdateRefsCasInput {
  const record = casInputRecord(value);
  return Object.freeze({
    repository: snapshotRepositoryIdentity(
      casInputValue(record, "repository"),
    ),
    targetRef: casInputString(record, "targetRef"),
    expectedHeadSha: casInputString(record, "expectedHeadSha"),
    newHeadSha: casInputString(record, "newHeadSha"),
  });
}

function snapshotRepositoryIdentity(
  value: unknown,
): GitHubRepositoryNodeIdentity {
  if (
    value === null
    || typeof value !== "object"
    || !admittedRepositoryIdentities.has(value)
  ) {
    throw invalidCasInput();
  }
  const record = casInputRecord(value);
  return Object.freeze({
    graphqlUrl: casInputString(record, "graphqlUrl"),
    repositoryFullName: casInputString(record, "repositoryFullName"),
    repositoryId: casInputString(record, "repositoryId"),
  });
}

function casInputRecord(value: unknown): object {
  if (!value || typeof value !== "object") {
    throw invalidCasInput();
  }
  try {
    if (Array.isArray(value)) throw invalidCasInput();
  } catch (error) {
    if (isInvalidCasInput(error)) throw error;
    throw invalidCasInput();
  }
  return value;
}

function casInputString(value: object, key: string): string {
  const admitted = casInputValue(value, key);
  if (typeof admitted !== "string") throw invalidCasInput();
  return admitted;
}

function casInputValue(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw invalidCasInput();
  }
  if (
    !descriptor
    || !("value" in descriptor)
    || descriptor.enumerable !== true
  ) {
    throw invalidCasInput();
  }
  return descriptor.value;
}

function admitProviderRepositoryFullName(value: unknown): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !providerRepositoryPattern.test(value)
  ) {
    throw invalidGraphqlResponse();
  }
  try {
    return admitGitHubRepositoryFullName(value.toLowerCase());
  } catch {
    throw invalidGraphqlResponse();
  }
}

function admitNodeId(value: unknown): string {
  if (typeof value !== "string" || !nodeIdPattern.test(value)) {
    throw invalidGraphqlResponse();
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw invalidGraphqlResponse();
  }
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw invalidGraphqlResponse();
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) {
    throw invalidGraphqlResponse();
  }
  return value as Record<string, unknown>;
}

function requiredDataProperty(value: object, key: string): unknown {
  const descriptor = dataDescriptor(value, key);
  if (!descriptor) throw invalidGraphqlResponse();
  return descriptor.value;
}

function optionalDataProperty(value: object, key: string): unknown {
  const descriptor = dataDescriptor(value, key);
  return descriptor?.value;
}

function dataDescriptor(
  value: object,
  key: string,
): (PropertyDescriptor & { value: unknown }) | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw invalidGraphqlResponse();
  }
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw invalidGraphqlResponse();
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

function invalidCasInput(): RangeError {
  return new RangeError("GitHub updateRefs CAS input is invalid");
}

function isInvalidCasInput(error: unknown): error is RangeError {
  return error instanceof RangeError
    && error.message === "GitHub updateRefs CAS input is invalid";
}

function invalidGraphqlResponse(): RangeError {
  return new RangeError("GitHub updateRefs GraphQL response is invalid");
}
