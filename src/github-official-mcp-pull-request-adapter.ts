import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import {
  parseGitHubDelegatedReadArguments,
} from "./github-delegated-read-contracts.js";
import {
  mapGitHubDelegatedReadToOfficialMcp,
  type GitHubOfficialMcpMappedRead,
} from "./github-official-mcp-read-mapping.js";
import type {
  GitHubOfficialMcpRemoteCallResult,
} from "./github-official-mcp-remote-transport.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  normalizeGitHubRepository,
  stableJson,
} from "./github-provider-validation.js";

export interface GitHubOfficialMcpReadCaller {
  callMappedRead(input: {
    mapping: GitHubOfficialMcpMappedRead;
    credentialRef: string;
  }): Promise<GitHubOfficialMcpRemoteCallResult>;
}

export interface GitHubOfficialMcpPullRequestAdapterOptions {
  connectionId: string;
  installationId: string;
  credentialRef: string;
  transport: GitHubOfficialMcpReadCaller;
}

interface AdmittedPullRequestCall {
  repositoryFullName: string;
  pullRequestNumber: number;
}

const maximumRetainedResultBytes = 64 * 1024;
const unsafeTextPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const officialTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Verifies one official GitHub MCP pull-request metadata result before it
 * reaches the generic delegated-read receipt boundary. This adapter grants no
 * authority; callers must enter only after accepted attachment, binding,
 * catalogue, and principal checks.
 */
export class GitHubOfficialMcpPullRequestAdapter
  implements GitHubDelegatedReadAdapter
{
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;
  readonly #transport: GitHubOfficialMcpReadCaller;

  constructor(options: GitHubOfficialMcpPullRequestAdapterOptions) {
    this.#connectionId = exactIdentity(
      options.connectionId,
      "GitHub delegated connection ID",
      240,
    );
    this.#installationId = exactIdentity(
      options.installationId,
      "GitHub delegated installation ID",
      64,
    );
    this.#credentialRef = exactCredentialReference(options.credentialRef);
    this.#transport = options.transport;
  }

  async callReadTool(
    input: Parameters<GitHubDelegatedReadAdapter["callReadTool"]>[0],
  ): Promise<Awaited<ReturnType<GitHubDelegatedReadAdapter["callReadTool"]>>> {
    const envelope = exactDataRecord(
      input,
      [
        "tool",
        "arguments",
        "repositoryFullName",
        "connectionId",
        "installationId",
        "credentialRef",
        "catalogueFingerprint",
      ],
      [
        "tool",
        "arguments",
        "repositoryFullName",
        "connectionId",
        "installationId",
        "credentialRef",
        "catalogueFingerprint",
      ],
      "Official GitHub MCP delegated adapter call",
    );
    if (envelope.tool !== "get_pr_info") {
      throw rejected(
        "github_delegated_provider_tool_unsupported",
        "Official GitHub MCP adapter supports only pull request metadata in this release",
      );
    }

    const admitted = this.#admitPullRequestCall(envelope);
    let mapping: GitHubOfficialMcpMappedRead;
    try {
      const decision = mapGitHubDelegatedReadToOfficialMcp({
        tool: "get_pr_info",
        arguments: { pr_number: admitted.pullRequestNumber },
        repositoryFullName: admitted.repositoryFullName,
      });
      if (
        decision.state !== "mapped"
        || decision.stensiblyTool !== "get_pr_info"
        || decision.officialToolset !== "pull_requests"
        || decision.officialTool !== "pull_request_read"
        || decision.resultContract !== "pull_request_exact"
        || decision.maximumResultItems !== 1
      ) {
        throw new Error("mapping mismatch");
      }
      mapping = decision;
    } catch {
      throw rejected(
        "github_delegated_provider_mapping_rejected",
        "Official GitHub MCP pull request mapping is stale or unsupported",
      );
    }

    let called: GitHubOfficialMcpRemoteCallResult;
    try {
      called = await this.#transport.callMappedRead({
        mapping,
        credentialRef: this.#credentialRef,
      });
    } catch {
      throw rejected(
        "github_delegated_provider_request_failed",
        "Official GitHub MCP pull request read failed before a verified result was available",
      );
    }

    const result = pullRequestResult(
      called.result,
      admitted.repositoryFullName,
      admitted.pullRequestNumber,
    );
    if (Buffer.byteLength(stableJson(result), "utf8") > maximumRetainedResultBytes) {
      throw rejected(
        "github_delegated_provider_result_too_large",
        "Official GitHub MCP pull request result exceeds the retained result budget",
      );
    }
    return Object.freeze({ result });
  }

  #admitPullRequestCall(
    envelope: Record<string, unknown>,
  ): AdmittedPullRequestCall {
    if (
      envelope.connectionId !== this.#connectionId
      || envelope.installationId !== this.#installationId
      || envelope.credentialRef !== this.#credentialRef
    ) {
      throw rejected(
        "github_delegated_adapter_binding_mismatch",
        "Official GitHub MCP adapter call did not match its admitted connection binding",
      );
    }
    const repositoryFullName = exactRepository(envelope.repositoryFullName);
    exactFingerprint(envelope.catalogueFingerprint);

    let parsed: Record<string, unknown>;
    try {
      parsed = parseGitHubDelegatedReadArguments(
        "get_pr_info",
        envelope.arguments,
      );
    } catch {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        "Official GitHub MCP get_pr_info arguments were invalid",
      );
    }
    return Object.freeze({
      repositoryFullName,
      pullRequestNumber: positiveInteger(
        parsed.pr_number,
        "Official GitHub MCP pull request number",
      ),
    });
  }
}

function pullRequestResult(
  value: unknown,
  repositoryFullName: string,
  requestedNumber: number,
): Readonly<Record<string, unknown>> {
  const record = exactDataRecord(
    value,
    [
      "number",
      "title",
      "body",
      "state",
      "draft",
      "merged",
      "mergeable_state",
      "html_url",
      "user",
      "labels",
      "assignees",
      "requested_reviewers",
      "merged_by",
      "head",
      "base",
      "additions",
      "deletions",
      "changed_files",
      "commits",
      "comments",
      "created_at",
      "updated_at",
      "closed_at",
      "merged_at",
      "milestone",
    ],
    [
      "number",
      "title",
      "state",
      "draft",
      "merged",
      "html_url",
      "user",
      "head",
      "base",
      "created_at",
      "updated_at",
    ],
    "Official GitHub MCP pull request result",
  );

  const number = positiveInteger(
    record.number,
    "Official GitHub MCP pull request number",
  );
  if (number !== requestedNumber) {
    throw identityMismatch(
      "Official GitHub MCP pull request result did not match the requested pull request",
    );
  }
  verifyPullRequestHtmlUrl(record.html_url, repositoryFullName, requestedNumber);

  const base = pullRequestBranch(
    record.base,
    "Official GitHub MCP pull request base",
    true,
  );
  if (base.repositoryFullName !== repositoryFullName) {
    throw identityMismatch(
      "Official GitHub MCP pull request result did not match the accepted repository",
    );
  }
  const head = pullRequestBranch(
    record.head,
    "Official GitHub MCP pull request head",
    false,
  );
  const user = exactDataRecord(
    record.user,
    ["login", "id", "profile_url", "avatar_url", "details"],
    ["login"],
    "Official GitHub MCP pull request author",
  );

  const state = pullRequestState(record.state);
  const merged = booleanValue(
    record.merged,
    "Official GitHub MCP pull request merged flag",
  );
  const createdAt = exactTimestamp(
    record.created_at,
    "Official GitHub MCP pull request created timestamp",
  );
  const updatedAt = exactTimestamp(
    record.updated_at,
    "Official GitHub MCP pull request updated timestamp",
  );
  const closedAt = optionalTimestamp(
    record.closed_at,
    "Official GitHub MCP pull request closed timestamp",
  );
  const mergedAt = optionalTimestamp(
    record.merged_at,
    "Official GitHub MCP pull request merged timestamp",
  );
  verifyLifecycle(state, merged, createdAt, updatedAt, closedAt, mergedAt);

  return Object.freeze({
    repositoryFullName,
    number,
    state,
    draft: booleanValue(
      record.draft,
      "Official GitHub MCP pull request draft flag",
    ),
    merged,
    title: exactText(
      record.title,
      "Official GitHub MCP pull request title",
      1_024,
    ),
    authorLogin: exactText(
      user.login,
      "Official GitHub MCP pull request author login",
      120,
    ),
    headRepositoryFullName: head.repositoryFullName,
    headSha: head.sha,
    headRef: head.ref,
    baseSha: base.sha,
    baseRef: base.ref,
    mergeableState: optionalText(
      record.mergeable_state,
      "Official GitHub MCP pull request mergeable state",
      80,
    ),
    labels: stringArray(
      record.labels,
      "Official GitHub MCP pull request labels",
      100,
      120,
    ),
    assignees: stringArray(
      record.assignees,
      "Official GitHub MCP pull request assignees",
      100,
      120,
    ),
    requestedReviewers: stringArray(
      record.requested_reviewers,
      "Official GitHub MCP pull request requested reviewers",
      100,
      120,
    ),
    mergedBy: optionalText(
      record.merged_by,
      "Official GitHub MCP pull request merger",
      120,
    ),
    milestone: optionalText(
      record.milestone,
      "Official GitHub MCP pull request milestone",
      256,
    ),
    createdAt,
    updatedAt,
    closedAt,
    mergedAt,
    additions: optionalNonNegativeInteger(
      record.additions,
      "Official GitHub MCP pull request additions",
    ),
    deletions: optionalNonNegativeInteger(
      record.deletions,
      "Official GitHub MCP pull request deletions",
    ),
    changedFiles: optionalNonNegativeInteger(
      record.changed_files,
      "Official GitHub MCP pull request changed file count",
    ),
    commits: optionalNonNegativeInteger(
      record.commits,
      "Official GitHub MCP pull request commit count",
    ),
    comments: optionalNonNegativeInteger(
      record.comments,
      "Official GitHub MCP pull request comment count",
    ),
  });
}

function pullRequestBranch(
  value: unknown,
  label: string,
  requireRepository: boolean,
): Readonly<{
  ref: string;
  sha: string;
  repositoryFullName: string | null;
}> {
  const record = exactDataRecord(
    value,
    ["ref", "sha", "repo"],
    ["ref", "sha"],
    label,
  );
  let repositoryFullName: string | null = null;
  if (record.repo !== undefined && record.repo !== null) {
    const repository = exactDataRecord(
      record.repo,
      ["full_name", "description"],
      ["full_name"],
      `${label} repository`,
    );
    repositoryFullName = exactRepository(repository.full_name);
  }
  if (requireRepository && repositoryFullName === null) {
    throw identityMismatch(`${label} omitted repository identity`);
  }
  return Object.freeze({
    ref: exactText(record.ref, `${label} ref`, 512),
    sha: commitSha(record.sha, `${label} SHA`),
    repositoryFullName,
  });
}

function verifyPullRequestHtmlUrl(
  value: unknown,
  repositoryFullName: string,
  pullRequestNumber: number,
): void {
  if (typeof value !== "string" || value.length > 2_048) {
    throw identityMismatch("Official GitHub MCP pull request URL was invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw identityMismatch("Official GitHub MCP pull request URL was invalid");
  }
  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "github.com"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw identityMismatch("Official GitHub MCP pull request URL was invalid");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length !== 4
    || parts[2] !== "pull"
    || parts[3] !== String(pullRequestNumber)
  ) {
    throw identityMismatch(
      "Official GitHub MCP pull request URL did not match the requested pull request",
    );
  }
  let urlRepository: string;
  try {
    urlRepository = normalizeGitHubRepository(
      `${decodeURIComponent(parts[0]!)}/${decodeURIComponent(parts[1]!)}`,
    ).toLowerCase();
  } catch {
    throw identityMismatch("Official GitHub MCP pull request URL was invalid");
  }
  if (urlRepository !== repositoryFullName) {
    throw identityMismatch(
      "Official GitHub MCP pull request URL did not match the accepted repository",
    );
  }
}

function verifyLifecycle(
  state: "open" | "closed",
  merged: boolean,
  createdAt: string,
  updatedAt: string,
  closedAt: string | null,
  mergedAt: string | null,
): void {
  const createdMs = Date.parse(createdAt);
  const updatedMs = Date.parse(updatedAt);
  const closedMs = closedAt === null ? null : Date.parse(closedAt);
  const mergedMs = mergedAt === null ? null : Date.parse(mergedAt);
  if (
    updatedMs < createdMs
    || (closedMs !== null && (closedMs < createdMs || closedMs > updatedMs))
    || (mergedMs !== null && (mergedMs < createdMs || mergedMs > updatedMs))
    || (mergedMs !== null && closedMs !== null && mergedMs > closedMs)
    || (state === "open" && closedAt !== null)
    || (state === "closed" && closedAt === null)
    || (merged && (state !== "closed" || mergedAt === null))
    || (!merged && mergedAt !== null)
  ) {
    throw rejected(
      "github_delegated_provider_invalid_response",
      "Official GitHub MCP pull request lifecycle fields were inconsistent",
    );
  }
}

function exactDataRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidResponse(`${label} must use a plain or null prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidResponse(`${label} contains a symbol field`);
  }
  const allowed = new Set(allowedFields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) {
      throw invalidResponse(`${label} has an unknown field`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw invalidResponse(`${label} fields must be enumerable data properties`);
    }
    output[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(output, key)) {
      throw invalidResponse(`${label} is missing a required field`);
    }
  }
  return output;
}

function stringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalidResponse(`${label} must be a dense array`);
  }
  if (value.length > maximumItems || Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidResponse(`${label} is oversized or decorated`);
  }
  const names = Object.getOwnPropertyNames(value);
  const expected = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (names.some((name) => !expected.has(name))) {
    throw invalidResponse(`${label} is decorated`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalidResponse(`${label} must contain dense data slots`);
    }
    output.push(exactText(
      descriptor.value,
      `${label} item`,
      maximumItemLength,
    ));
  }
  return Object.freeze(output);
}

function exactRepository(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > 200
    || value !== value.trim()
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw invalidResponse("Official GitHub MCP repository identity was invalid");
  }
  try {
    return normalizeGitHubRepository(value).toLowerCase();
  } catch {
    throw invalidResponse("Official GitHub MCP repository identity was invalid");
  }
}

function exactFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "Official GitHub MCP catalogue fingerprint was invalid",
    );
  }
  return value;
}

function exactCredentialReference(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}$/.test(value)
  ) {
    throw new RangeError(
      "Official GitHub MCP credential reference must use env:// or secret://",
    );
  }
  return value;
}

function exactIdentity(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || unsafeTextPattern.test(value)
  ) {
    throw invalidResponse(`${label} was invalid`);
  }
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return exactText(value, label, maximum);
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw invalidResponse(`${label} was invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidResponse(`${label} must be a positive integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse(`${label} must be a non-negative integer`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidResponse(`${label} must be boolean`);
  }
  return value;
}

function pullRequestState(value: unknown): "open" | "closed" {
  if (value !== "open" && value !== "closed") {
    throw invalidResponse("Official GitHub MCP pull request state was invalid");
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length !== 20
    || !officialTimestampPattern.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw invalidResponse(`${label} must use canonical RFC3339 UTC seconds`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return exactTimestamp(value, label);
}

function identityMismatch(message: string): GitHubProviderRejectedError {
  return rejected("github_delegated_provider_identity_mismatch", message);
}

function invalidResponse(message: string): GitHubProviderRejectedError {
  return rejected("github_delegated_provider_invalid_response", message);
}

function rejected(code: string, message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(code, message);
}
