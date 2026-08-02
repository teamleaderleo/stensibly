import type { GitHubDelegatedReadAdapter } from "./github-delegated-read.js";
import {
  mapGitHubDelegatedReadToOfficialMcp,
  assertGitHubOfficialMcpReadMappingMatchesPolicy,
  type GitHubOfficialMcpMappedRead,
} from "./github-official-mcp-read-mapping.js";
import {
  GitHubOfficialMcpRemoteError,
  type GitHubOfficialMcpRemoteCallInput,
  type GitHubOfficialMcpRemoteCallResult,
  type GitHubOfficialMcpRemoteErrorCode,
} from "./github-official-mcp-remote-transport.js";
import { GitHubProviderRejectedError } from "./github-provider-contracts.js";
import {
  normalizeGitHubRepository,
  stableJson,
} from "./github-provider-validation.js";

export interface GitHubOfficialMcpPullRequestTransport {
  callMappedRead(
    input: GitHubOfficialMcpRemoteCallInput,
  ): Promise<GitHubOfficialMcpRemoteCallResult>;
}

export interface GitHubOfficialMcpPullRequestAdapterOptions {
  transport: GitHubOfficialMcpPullRequestTransport;
  connectionId: string;
  installationId: string;
  credentialRef: string;
}

interface AdmittedPullRequestCall {
  arguments: Readonly<{ pr_number: number }>;
  repositoryFullName: string;
}

const providerResultMaximumBytes = 256 * 1024;
const retainedResultMaximumBytes = 64 * 1024;
const maximumSnapshotDepth = 32;
const maximumSnapshotNodes = 20_000;
const maximumSnapshotArrayLength = 4_096;
const maximumSnapshotObjectFields = 512;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const realisticCredentialPattern =
  /(?:^|[\s:./=,;'"()[\]{}@#_-])(?:Bearer\s+[A-Za-z0-9._~+/-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9._-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,231}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?=$|[\s:./=,;'"()[\]{}@#_-])/imu;

const minimalPullRequestFields = [
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
] as const;

/**
 * Verifies the pinned official GitHub MCP `pull_request_read(method=get)`
 * result against one already-authorized delegated-read envelope.
 *
 * This adapter grants no authority. It re-admits the accepted binding and
 * catalogue identity, compiles and rechecks the pinned official mapping,
 * invokes the bounded remote transport, and publishes only content-minimized
 * metadata after provider-owned repository and pull-request identity match.
 */
export class GitHubOfficialMcpPullRequestAdapter
  implements GitHubDelegatedReadAdapter
{
  readonly #transport: GitHubOfficialMcpPullRequestTransport;
  readonly #connectionId: string;
  readonly #installationId: string;
  readonly #credentialRef: string;

  constructor(options: GitHubOfficialMcpPullRequestAdapterOptions) {
    this.#transport = options.transport;
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
      "GitHub delegated adapter call",
    );
    if (envelope.tool !== "get_pr_info") {
      throw rejected(
        "github_delegated_tool_denied",
        "Official GitHub MCP pull request adapter supports only get_pr_info",
      );
    }

    const admitted = this.#admitPullRequestCall(envelope);
    const mapping = exactPullRequestMapping(admitted);

    let called: unknown;
    try {
      called = await this.#transport.callMappedRead({
        mapping,
        credentialRef: this.#credentialRef,
      });
    } catch (error) {
      if (error instanceof GitHubOfficialMcpRemoteError) {
        throw rejected(error.code, officialRemoteErrorMessage(error.code));
      }
      throw rejected(
        "github_official_mcp_transport_failed",
        "Official GitHub MCP read failed before a verified result was available",
      );
    }

    const calledEnvelope = exactProviderRecord(
      called,
      ["result"],
      ["result"],
      "Official GitHub MCP transport result",
    );
    const detached = snapshotJsonData(
      calledEnvelope.result,
      "Official GitHub MCP pull request result",
    );
    let serialized: string;
    try {
      serialized = stableJson(detached);
    } catch {
      throw providerInvalid("Official GitHub MCP pull request result was invalid");
    }
    if (Buffer.byteLength(serialized, "utf8") > providerResultMaximumBytes) {
      throw rejected(
        "github_delegated_provider_result_too_large",
        "Official GitHub MCP pull request result exceeded its bounded input budget",
      );
    }

    const result = pullRequestResult(
      detached,
      admitted.repositoryFullName,
      admitted.arguments.pr_number,
    );
    if (Buffer.byteLength(stableJson(result), "utf8") > retainedResultMaximumBytes) {
      throw rejected(
        "github_delegated_provider_result_too_large",
        "Official GitHub MCP pull request result exceeded its retained result budget",
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
        "GitHub delegated adapter call did not match its admitted connection binding",
      );
    }
    const repositoryFullName = exactRepository(envelope.repositoryFullName);
    exactFingerprint(envelope.catalogueFingerprint);
    const argumentsRecord = exactDataRecord(
      envelope.arguments,
      ["pr_number"],
      ["pr_number"],
      "GitHub delegated get_pr_info arguments",
    );
    return Object.freeze({
      repositoryFullName,
      arguments: Object.freeze({
        pr_number: positiveInputInteger(
          argumentsRecord.pr_number,
          "GitHub pull request number",
        ),
      }),
    });
  }
}

function exactPullRequestMapping(
  input: AdmittedPullRequestCall,
): GitHubOfficialMcpMappedRead {
  let mapping;
  try {
    mapping = mapGitHubDelegatedReadToOfficialMcp({
      tool: "get_pr_info",
      arguments: input.arguments,
      repositoryFullName: input.repositoryFullName,
    });
    assertGitHubOfficialMcpReadMappingMatchesPolicy(mapping);
  } catch {
    throw rejected(
      "github_official_mcp_mapping_rejected",
      "Official GitHub MCP pull request mapping was stale or unsupported",
    );
  }
  if (
    mapping.state !== "mapped"
    || mapping.stensiblyTool !== "get_pr_info"
    || mapping.repositoryFullName !== input.repositoryFullName
    || mapping.officialToolset !== "pull_requests"
    || mapping.officialTool !== "pull_request_read"
    || mapping.resultContract !== "pull_request_exact"
    || mapping.maximumResultItems !== 1
  ) {
    throw rejected(
      "github_official_mcp_mapping_rejected",
      "Official GitHub MCP pull request mapping was stale or unsupported",
    );
  }
  const [owner, repo] = input.repositoryFullName.split("/") as [string, string];
  if (
    stableJson(mapping.officialArguments) !== stableJson({
      method: "get",
      owner,
      pullNumber: input.arguments.pr_number,
      repo,
    })
  ) {
    throw rejected(
      "github_official_mcp_mapping_rejected",
      "Official GitHub MCP pull request mapping was stale or unsupported",
    );
  }
  return mapping;
}

function pullRequestResult(
  value: unknown,
  repositoryFullName: string,
  requestedNumber: number,
): Readonly<Record<string, unknown>> {
  const record = exactProviderRecord(
    value,
    minimalPullRequestFields,
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
    "Official GitHub MCP minimal pull request",
  );
  const number = positiveProviderInteger(
    record.number,
    "GitHub pull request number",
  );
  if (number !== requestedNumber) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "Official GitHub MCP result did not match the requested pull request",
    );
  }

  const base = minimalBranch(record.base, "GitHub pull request base", true);
  if (base.repositoryFullName !== repositoryFullName) {
    throw rejected(
      "github_delegated_provider_identity_mismatch",
      "Official GitHub MCP result did not match the accepted repository",
    );
  }
  const head = minimalBranch(record.head, "GitHub pull request head", false);
  const user = exactProviderRecord(
    record.user,
    ["login", "id", "profile_url", "avatar_url", "details"],
    ["login"],
    "GitHub pull request author",
  );

  // Title/body/HTML URL and list-valued upstream fields are bounded only
  // for schema admission. They are provider prose and are never retained.
  discardedText(record.title, "GitHub pull request title", 1_024);
  exactWebUrl(record.html_url, "GitHub pull request HTML URL");
  optionalDiscardedText(record.body, "GitHub pull request body", 128 * 1024);
  optionalDiscardedText(
    record.mergeable_state,
    "GitHub pull request mergeable state",
    64,
  );
  optionalDiscardedStringArray(
    record.labels,
    "GitHub pull request labels",
    100,
    120,
  );
  optionalDiscardedStringArray(
    record.assignees,
    "GitHub pull request assignees",
    100,
    120,
  );
  optionalDiscardedStringArray(
    record.requested_reviewers,
    "GitHub pull request requested reviewers",
    100,
    120,
  );
  optionalDiscardedText(record.merged_by, "GitHub pull request merger", 120);
  optionalDiscardedText(record.milestone, "GitHub pull request milestone", 256);

  const state = pullRequestState(record.state);
  const merged = booleanValue(record.merged, "GitHub pull request merged flag");
  const createdAt = exactTimestamp(
    record.created_at,
    "GitHub pull request created timestamp",
  );
  const updatedAt = exactTimestamp(
    record.updated_at,
    "GitHub pull request updated timestamp",
  );
  const closedAt = optionalTimestamp(
    record.closed_at,
    "GitHub pull request closed timestamp",
  );
  const mergedAt = optionalTimestamp(
    record.merged_at,
    "GitHub pull request merged timestamp",
  );
  const createdMs = Date.parse(createdAt);
  const updatedMs = Date.parse(updatedAt);
  const closedMs = closedAt === null ? null : Date.parse(closedAt);
  const mergedMs = mergedAt === null ? null : Date.parse(mergedAt);
  if (
    updatedMs < createdMs
    || (closedMs !== null && (closedMs < createdMs || closedMs > updatedMs))
    || (mergedMs !== null && (mergedMs < createdMs || mergedMs > updatedMs))
    || (merged && closedMs !== null && mergedMs !== null && mergedMs > closedMs)
    || (state === "open" && closedAt !== null)
    || (state === "closed" && closedAt === null)
    || (merged && (state !== "closed" || mergedAt === null))
    || (!merged && mergedAt !== null)
  ) {
    throw providerInvalid("GitHub pull request lifecycle fields were inconsistent");
  }

  return Object.freeze({
    repositoryFullName,
    number,
    state,
    draft: booleanValue(record.draft, "GitHub pull request draft flag"),
    merged,
    authorLogin: exactText(
      user.login,
      "GitHub pull request author login",
      120,
    ),
    headRepositoryFullName: head.repositoryFullName,
    headSha: head.sha,
    headRef: head.ref,
    baseSha: base.sha,
    baseRef: base.ref,
    createdAt,
    updatedAt,
    closedAt,
    mergedAt,
    additions: optionalNonNegativeProviderInteger(
      record.additions,
      "GitHub pull request additions",
    ),
    deletions: optionalNonNegativeProviderInteger(
      record.deletions,
      "GitHub pull request deletions",
    ),
    changedFiles: optionalNonNegativeProviderInteger(
      record.changed_files,
      "GitHub pull request changed file count",
    ),
    commits: optionalNonNegativeProviderInteger(
      record.commits,
      "GitHub pull request commit count",
    ),
    comments: optionalNonNegativeProviderInteger(
      record.comments,
      "GitHub pull request comment count",
    ),
  });
}

function minimalBranch(
  value: unknown,
  label: string,
  requireRepository: boolean,
): {
  ref: string;
  sha: string;
  repositoryFullName: string | null;
} {
  const record = exactProviderRecord(
    value,
    ["ref", "sha", "repo"],
    ["ref", "sha", ...(requireRepository ? ["repo"] : [])],
    label,
  );
  let repositoryFullName: string | null = null;
  if (Object.hasOwn(record, "repo")) {
    const repository = exactProviderRecord(
      record.repo,
      ["full_name", "description"],
      ["full_name"],
      `${label} repository`,
    );
    repositoryFullName = providerRepository(repository.full_name);
    optionalDiscardedText(
      repository.description,
      `${label} repository description`,
      4_096,
    );
  }
  if (requireRepository && repositoryFullName === null) {
    throw providerInvalid(`${label} repository identity was absent`);
  }
  return {
    ref: exactText(record.ref, `${label} ref`, 512),
    sha: commitSha(record.sha),
    repositoryFullName,
  };
}

function exactDataRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} must use a plain or null prototype`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} contains a symbol field`,
    );
  }
  const allowed = new Set(allowedFields);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!allowed.has(key)) {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        `${label} has an unknown field`,
      );
    }
    if (
      !descriptor
      || !descriptor.enumerable
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        `${label} fields must be enumerable data properties`,
      );
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(result, key)) {
      throw rejected(
        "github_delegated_adapter_invalid_input",
        `${label} is missing a required field`,
      );
    }
  }
  return result;
}

function exactProviderRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerInvalid(`${label} was not an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw providerInvalid(`${label} was not a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw providerInvalid(`${label} contained a symbol field`);
  }
  const allowed = new Set(allowedFields);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!allowed.has(key)) {
      throw providerInvalid(`${label} contained an unexpected field`);
    }
    if (
      !descriptor
      || !descriptor.enumerable
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) {
      throw providerInvalid(`${label} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  for (const key of requiredFields) {
    if (!Object.hasOwn(result, key)) {
      throw providerInvalid(`${label} was missing a required field`);
    }
  }
  return result;
}

function exactRepository(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_096
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated repository must use exact printable ASCII",
    );
  }
  try {
    return normalizeGitHubRepository(value).toLowerCase();
  } catch {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated repository identity is invalid",
    );
  }
}

function providerRepository(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_096
    || value !== value.trim()
    || !/^[\x20-\x7e]+$/.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw providerInvalid("GitHub pull request repository identity was invalid");
  }
  try {
    return normalizeGitHubRepository(value).toLowerCase();
  } catch {
    throw providerInvalid("GitHub pull request repository identity was invalid");
  }
}

function exactFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      "GitHub delegated catalogue fingerprint is invalid",
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
      "GitHub delegated credential reference must use env:// or secret://",
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
    || realisticCredentialPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function positiveInputInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw rejected(
      "github_delegated_adapter_invalid_input",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function positiveProviderInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw providerInvalid(`${label} was invalid`);
  }
  return value;
}

function optionalNonNegativeProviderInteger(
  value: unknown,
  label: string,
): number {
  if (value === undefined) return 0;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < 0
  ) {
    throw providerInvalid(`${label} was invalid`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw providerInvalid(`${label} was invalid`);
  }
  return value;
}

function pullRequestState(value: unknown): "open" | "closed" {
  if (value !== "open" && value !== "closed") {
    throw providerInvalid("GitHub pull request state was invalid");
  }
  return value;
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || unsafeTextPattern.test(value)
    || realisticCredentialPattern.test(value)
  ) {
    throw providerInvalid(`${label} was invalid`);
  }
  return value;
}

function discardedText(
  value: unknown,
  label: string,
  maximumBytes: number,
): void {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw providerInvalid(`${label} was invalid`);
  }
}

function optionalDiscardedText(
  value: unknown,
  label: string,
  maximumBytes: number,
): void {
  if (value === undefined) return;
  discardedText(value, label, maximumBytes);
}

function optionalDiscardedStringArray(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumEntryBytes: number,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw providerInvalid(`${label} was invalid`);
  }
  for (const entry of value) {
    discardedText(entry, `${label} entry`, maximumEntryBytes);
  }
}

function exactWebUrl(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length > 4_096) {
    throw providerInvalid(`${label} was invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw providerInvalid(`${label} was invalid`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw providerInvalid(`${label} was invalid`);
  }
}

function commitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw providerInvalid("GitHub pull request commit SHA was invalid");
  }
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw providerInvalid(`${label} was absent`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw providerInvalid(`${label} was invalid`);
  }
  return date.toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === undefined ? null : exactTimestamp(value, label);
}

function snapshotJsonData(
  value: unknown,
  label: string,
  depth = 0,
  budget: { nodes: number; bytes: number } = { nodes: 0, bytes: 0 },
): unknown {
  budget.nodes += 1;
  if (depth > maximumSnapshotDepth || budget.nodes > maximumSnapshotNodes) {
    throw rejected(
      "github_delegated_provider_result_too_large",
      `${label} exceeded its bounded graph budget`,
    );
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    consumeSnapshotBytes(budget, value, label);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw providerInvalid(`${label} contained a non-canonical number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw providerInvalid(`${label} contained a non-ordinary array`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
      Record<PropertyKey, PropertyDescriptor>;
    const lengthDescriptor = descriptors["length"];
    if (
      !lengthDescriptor
      || !("value" in lengthDescriptor)
      || lengthDescriptor.enumerable
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > maximumSnapshotArrayLength
    ) {
      throw providerInvalid(`${label} contained an invalid array length`);
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(descriptors);
    const expected = new Set<PropertyKey>([
      "length",
      ...Array.from({ length }, (_, index) => String(index)),
    ]);
    if (
      keys.length !== expected.size
      || keys.some((key) => !expected.has(key))
    ) {
      throw providerInvalid(`${label} contained a sparse or decorated array`);
    }
    return Object.freeze(Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || !("value" in descriptor)
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined
      ) {
        throw providerInvalid(`${label} contained a non-data array entry`);
      }
      return snapshotJsonData(
        descriptor.value,
        label,
        depth + 1,
        budget,
      );
    }));
  }
  if (!value || typeof value !== "object") {
    throw providerInvalid(`${label} contained a non-data value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw providerInvalid(`${label} contained a non-plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length > maximumSnapshotObjectFields
    || keys.some((key) => typeof key !== "string")
  ) {
    throw providerInvalid(`${label} contained invalid object fields`);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    consumeSnapshotBytes(budget, key, label);
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable !== true
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) {
      throw providerInvalid(`${label} must contain only enumerable data properties`);
    }
    output[key] = snapshotJsonData(
      descriptor.value,
      label,
      depth + 1,
      budget,
    );
  }
  return Object.freeze(output);
}

function consumeSnapshotBytes(
  budget: { nodes: number; bytes: number },
  value: string,
  label: string,
): void {
  budget.bytes += Buffer.byteLength(value, "utf8");
  if (budget.bytes > providerResultMaximumBytes) {
    throw rejected(
      "github_delegated_provider_result_too_large",
      `${label} exceeded its bounded UTF-8 budget`,
    );
  }
}

function officialRemoteErrorMessage(
  code: GitHubOfficialMcpRemoteErrorCode,
): string {
  switch (code) {
    case "github_official_mcp_mapping_rejected":
      return "Official GitHub MCP read mapping was stale or unsupported";
    case "github_official_mcp_credential_unavailable":
      return "Official GitHub MCP credential was unavailable";
    case "github_official_mcp_transport_failed":
      return "Official GitHub MCP read failed before a verified result was available";
    case "github_official_mcp_invalid_result":
      return "Official GitHub MCP returned an invalid result";
    case "github_official_mcp_close_failed":
      return "Official GitHub MCP session could not be closed";
  }
}

function providerInvalid(message: string): GitHubProviderRejectedError {
  return rejected("github_delegated_provider_invalid_response", message);
}

function rejected(code: string, message: string): GitHubProviderRejectedError {
  return new GitHubProviderRejectedError(code, message);
}
