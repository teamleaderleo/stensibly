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

export interface GitHubUpdateRefsCasInput {
  apiBaseUrl: string;
  repositoryFullName: string;
  repositoryId: string;
  targetRef: string;
  expectedHeadSha: string;
  newHeadSha: string;
}

export interface GitHubUpdateRefsCasResult {
  clientMutationId: string;
}

export class GitHubUpdateRefsCasStaleRefError extends Error {
  readonly code = "github_update_refs_stale_ref" as const;

  constructor() {
    super("GitHub repository write exact old ref changed before publication");
    this.name = "GitHubUpdateRefsCasStaleRefError";
    Object.freeze(this);
  }
}

const repositoryNodeIdQuery =
  "query StensiblyRepositoryNodeId($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }";
const updateRefsMutation =
  "mutation StensiblyUpdateRefs($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }";
const nodeIdPattern = /^[A-Za-z0-9_=-]{1,256}$/u;
const maximumGraphqlErrors = 4;

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

export function admitGitHubRepositoryNodeIdResponse(value: unknown): string {
  const envelope = record(value);
  if (optionalDataProperty(envelope, "errors") !== undefined) {
    throw new Error("GitHub could not read repository node identity");
  }
  const data = record(requiredDataProperty(envelope, "data"));
  const repository = record(requiredDataProperty(data, "repository"));
  return admitNodeId(requiredDataProperty(repository, "id"));
}

export function buildGitHubUpdateRefsCasRequest(
  input: GitHubUpdateRefsCasInput,
): GitHubGraphqlRequest {
  const repositoryFullName = admitGitHubRepositoryFullName(input.repositoryFullName);
  const repositoryId = admitNodeId(input.repositoryId);
  const targetRef = admitGitHubBranchRef(input.targetRef);
  const expectedHeadSha = admitGitObjectId(input.expectedHeadSha);
  const newHeadSha = admitGitObjectId(input.newHeadSha);
  if (!sameGitObjectFormat(expectedHeadSha, newHeadSha)) {
    throw new RangeError("GitHub updateRefs object format is invalid");
  }
  const clientMutationId = `stensibly-write-${newHeadSha.slice(0, 16)}`;
  return Object.freeze({
    url: githubGraphqlUrl(input.apiBaseUrl),
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
  });
}

export function admitGitHubUpdateRefsCasResponse(
  value: unknown,
  expectedClientMutationId: string,
): GitHubUpdateRefsCasResult {
  if (
    typeof expectedClientMutationId !== "string"
    || !/^stensibly-write-[a-f0-9]{16}$/u.test(expectedClientMutationId)
  ) {
    throw invalidGraphqlResponse();
  }
  const envelope = record(value);
  const errors = optionalDataProperty(envelope, "errors");
  if (errors !== undefined) {
    if (isExactStaleRefResponse(envelope, errors)) {
      throw new GitHubUpdateRefsCasStaleRefError();
    }
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
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw new RangeError("GitHub API base URL is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
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

function isExactStaleRefResponse(
  envelope: Record<string, unknown>,
  errorsValue: unknown,
): boolean {
  try {
    const errors = denseArray(errorsValue, maximumGraphqlErrors);
    if (errors.length !== 1) return false;
    const error = record(errors[0]);
    if (
      typeof optionalDataProperty(error, "message") !== "string"
      || optionalDataProperty(error, "type") !== "STALE_REF"
    ) {
      return false;
    }
    const data = record(requiredDataProperty(envelope, "data"));
    return requiredDataProperty(data, "updateRefs") === null;
  } catch {
    return false;
  }
}

function admitNodeId(value: unknown): string {
  if (typeof value !== "string" || !nodeIdPattern.test(value)) {
    throw invalidGraphqlResponse();
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidGraphqlResponse();
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw invalidGraphqlResponse();
  }
  if (prototype !== Object.prototype && prototype !== null) {
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

function denseArray(value: unknown, maximumLength: number): unknown[] {
  if (!Array.isArray(value)) throw invalidGraphqlResponse();
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw invalidGraphqlResponse();
  }
  if (prototype !== Array.prototype) throw invalidGraphqlResponse();
  const lengthValue = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (
    typeof lengthValue !== "number"
    || !Number.isSafeInteger(lengthValue)
    || lengthValue < 0
    || lengthValue > maximumLength
  ) {
    throw invalidGraphqlResponse();
  }
  const result: unknown[] = [];
  for (let index = 0; index < lengthValue; index += 1) {
    const descriptor = dataDescriptor(value, String(index));
    if (!descriptor) throw invalidGraphqlResponse();
    result.push(descriptor.value);
  }
  return result;
}

function invalidGraphqlResponse(): RangeError {
  return new RangeError("GitHub updateRefs GraphQL response is invalid");
}