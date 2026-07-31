import {
  canonicalGitHubDelegatedReadTool,
  parseGitHubDelegatedReadArguments,
  type GitHubDelegatedReadContractTool,
} from "./github-delegated-read-contracts.js";
import {
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

export const githubOfficialMcpReadSource = deepFreeze({
  repository: "github/github-mcp-server" as const,
  commitSha: "3778a41476e31a072430cfee7c5d31c5f72def60",
  toolSnapshots: {
    search_repositories: "23b1d5e839bcc543296c91f8224791679ecce769",
    get_file_contents: "dec933c94d6c3e1142d6e7f83ee6778c4c1b13b3",
    pull_request_read: "41bc90b597466504646aa6aac139d6d4908f71b1",
    get_commit: "ad6a805515f53f04e2adf016939a69c2d5b8edbc",
    actions_list: "be97affbdb4e2dcf2afe6e11b0dc934add7c86bd",
    actions_get: "661f379f5f3855bd6edb117f58c9798dca40da8d",
    get_job_logs: "575182c0b146f3a2e37a6db192345a7faa648047",
  },
});

export type GitHubOfficialMcpReadToolset =
  | "repos"
  | "pull_requests"
  | "actions";

export type GitHubOfficialMcpReadTool =
  | "search_repositories"
  | "get_file_contents"
  | "pull_request_read"
  | "actions_get";

export type GitHubOfficialMcpReadResultContract =
  | "repository_search_exact"
  | "repository_file_at_commit"
  | "pull_request_exact"
  | "pull_request_diff"
  | "workflow_job_exact";

export type GitHubOfficialMcpReadUnsupportedReason =
  | "patch_format_unavailable"
  | "review_threads_require_pagination_contract"
  | "commit_status_requires_pull_request"
  | "workflow_runs_lack_commit_filter"
  | "workflow_jobs_require_pagination_contract"
  | "workflow_logs_require_truncation_contract";

type OfficialArgumentScalar = string | number | boolean;

interface MappedPolicyRule {
  readonly state: "mapped";
  readonly officialToolset: GitHubOfficialMcpReadToolset;
  readonly officialTool: GitHubOfficialMcpReadTool;
  readonly argumentKeys: readonly string[];
  readonly fixedArguments: Readonly<Record<string, OfficialArgumentScalar>>;
  readonly resultContract: GitHubOfficialMcpReadResultContract;
  readonly maximumResultItems: 1;
  readonly sourceToolSnapshotBlobShas: readonly string[];
}

interface ConditionalPolicyRule {
  readonly state: "conditional";
  readonly officialToolset: GitHubOfficialMcpReadToolset;
  readonly officialTool: GitHubOfficialMcpReadTool;
  readonly argumentKeys: readonly string[];
  readonly fixedArguments: Readonly<Record<string, OfficialArgumentScalar>>;
  readonly resultContract: GitHubOfficialMcpReadResultContract;
  readonly maximumResultItems: 1;
  readonly unsupportedReason: GitHubOfficialMcpReadUnsupportedReason;
  readonly sourceToolSnapshotBlobShas: readonly string[];
}

interface UnsupportedPolicyRule {
  readonly state: "unsupported";
  readonly reason: GitHubOfficialMcpReadUnsupportedReason;
  readonly sourceToolSnapshotBlobShas: readonly string[];
}

type GitHubOfficialMcpReadPolicyRule =
  | MappedPolicyRule
  | ConditionalPolicyRule
  | UnsupportedPolicyRule;

interface MappingPolicyDefinition {
  readonly version: 1;
  readonly authorizesProviderCall: false;
  readonly source: typeof githubOfficialMcpReadSource;
  readonly rules: Record<
    GitHubDelegatedReadContractTool,
    GitHubOfficialMcpReadPolicyRule
  >;
}

const mappingPolicyDefinition = {
  version: 1,
  authorizesProviderCall: false,
  source: githubOfficialMcpReadSource,
  rules: {
    get_repo: {
      state: "mapped",
      officialToolset: "repos",
      officialTool: "search_repositories",
      argumentKeys: ["minimal_output", "perPage", "query"],
      fixedArguments: { minimal_output: false, perPage: 1 },
      resultContract: "repository_search_exact",
      maximumResultItems: 1,
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.search_repositories,
      ],
    },
    fetch_file: {
      state: "mapped",
      officialToolset: "repos",
      officialTool: "get_file_contents",
      argumentKeys: ["owner", "path", "repo", "sha"],
      fixedArguments: {},
      resultContract: "repository_file_at_commit",
      maximumResultItems: 1,
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.get_file_contents,
      ],
    },
    get_pr_info: {
      state: "mapped",
      officialToolset: "pull_requests",
      officialTool: "pull_request_read",
      argumentKeys: ["method", "owner", "pullNumber", "repo"],
      fixedArguments: { method: "get" },
      resultContract: "pull_request_exact",
      maximumResultItems: 1,
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
      ],
    },
    get_pr_diff: {
      state: "conditional",
      officialToolset: "pull_requests",
      officialTool: "pull_request_read",
      argumentKeys: ["method", "owner", "pullNumber", "repo"],
      fixedArguments: { method: "get_diff" },
      resultContract: "pull_request_diff",
      maximumResultItems: 1,
      unsupportedReason: "patch_format_unavailable",
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
      ],
    },
    list_pull_request_review_threads: {
      state: "unsupported",
      reason: "review_threads_require_pagination_contract",
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
      ],
    },
    get_commit_combined_status: {
      state: "unsupported",
      reason: "commit_status_requires_pull_request",
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.get_commit,
        githubOfficialMcpReadSource.toolSnapshots.pull_request_read,
      ],
    },
    fetch_commit_workflow_runs: {
      state: "unsupported",
      reason: "workflow_runs_lack_commit_filter",
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.actions_list,
      ],
    },
    fetch_workflow_run_jobs: {
      state: "unsupported",
      reason: "workflow_jobs_require_pagination_contract",
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.actions_list,
      ],
    },
    fetch_workflow_job_steps: {
      state: "mapped",
      officialToolset: "actions",
      officialTool: "actions_get",
      argumentKeys: ["method", "owner", "repo", "resource_id"],
      fixedArguments: { method: "get_workflow_job" },
      resultContract: "workflow_job_exact",
      maximumResultItems: 1,
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.actions_get,
      ],
    },
    fetch_workflow_job_logs: {
      state: "unsupported",
      reason: "workflow_logs_require_truncation_contract",
      sourceToolSnapshotBlobShas: [
        githubOfficialMcpReadSource.toolSnapshots.get_job_logs,
      ],
    },
  },
} as const satisfies MappingPolicyDefinition;

export const githubOfficialMcpReadMappingPolicy = deepFreeze({
  ...mappingPolicyDefinition,
  fingerprint: sha256(stableJson(mappingPolicyDefinition)),
});

interface GitHubOfficialMcpReadEvidence {
  authorizesProviderCall: false;
  mappingPolicyVersion: 1;
  mappingPolicyFingerprint: string;
  sourceCommitSha: string;
  sourceToolSnapshotBlobShas: readonly string[];
}

export interface GitHubOfficialMcpMappedRead
  extends GitHubOfficialMcpReadEvidence
{
  state: "mapped";
  stensiblyTool: GitHubDelegatedReadContractTool;
  repositoryFullName: string;
  officialToolset: GitHubOfficialMcpReadToolset;
  officialTool: GitHubOfficialMcpReadTool;
  officialArguments: Readonly<Record<string, unknown>>;
  resultContract: GitHubOfficialMcpReadResultContract;
  maximumResultItems: 1;
}

export interface GitHubOfficialMcpUnsupportedRead
  extends GitHubOfficialMcpReadEvidence
{
  state: "unsupported";
  stensiblyTool: GitHubDelegatedReadContractTool;
  repositoryFullName: string;
  reason: GitHubOfficialMcpReadUnsupportedReason;
}

export type GitHubOfficialMcpReadMapping =
  | GitHubOfficialMcpMappedRead
  | GitHubOfficialMcpUnsupportedRead;

interface MappingInput {
  tool: unknown;
  arguments: unknown;
  repositoryFullName: unknown;
}

const evidenceDecisionKeys = [
  "authorizesProviderCall",
  "mappingPolicyVersion",
  "mappingPolicyFingerprint",
  "sourceCommitSha",
  "sourceToolSnapshotBlobShas",
] as const;

const mappedDecisionKeys = [
  ...evidenceDecisionKeys,
  "state",
  "stensiblyTool",
  "repositoryFullName",
  "officialToolset",
  "officialTool",
  "officialArguments",
  "resultContract",
  "maximumResultItems",
] as const;

const unsupportedDecisionKeys = [
  ...evidenceDecisionKeys,
  "state",
  "stensiblyTool",
  "repositoryFullName",
  "reason",
] as const;

/**
 * Compiles one guarded Stensibly read into non-authorizing official GitHub MCP data.
 *
 * The compiler performs no provider call. It re-admits the request and caller arguments,
 * injects the accepted repository identity, and returns exact evidence for both positive
 * and negative compatibility decisions. A later result verifier and dispatcher must make
 * a separate authority decision before any `state: mapped` output can reach transport.
 */
export function mapGitHubDelegatedReadToOfficialMcp(
  inputValue: unknown,
): GitHubOfficialMcpReadMapping {
  const input = mappingInput(inputValue);
  const stensiblyTool = delegatedTool(input.tool);
  const delegatedArguments = parseGitHubDelegatedReadArguments(
    stensiblyTool,
    input.arguments,
  );
  const repositoryFullName = repositoryIdentity(input.repositoryFullName);
  const [owner, repo] = repositoryFullName.split("/") as [string, string];

  switch (stensiblyTool) {
    case "get_repo":
      return mapped(stensiblyTool, repositoryFullName, {
        query: `repo:${repositoryFullName}`,
      });

    case "fetch_file":
      return mapped(stensiblyTool, repositoryFullName, {
        owner,
        repo,
        path: delegatedArguments.path,
        sha: delegatedArguments.ref,
      });

    case "get_pr_info":
      return mapped(stensiblyTool, repositoryFullName, {
        owner,
        repo,
        pullNumber: delegatedArguments.pr_number,
      });

    case "get_pr_diff":
      if (delegatedArguments.format === "patch") {
        return unsupported(stensiblyTool, repositoryFullName);
      }
      return mapped(stensiblyTool, repositoryFullName, {
        owner,
        repo,
        pullNumber: delegatedArguments.pr_number,
      });

    case "list_pull_request_review_threads":
    case "get_commit_combined_status":
    case "fetch_commit_workflow_runs":
    case "fetch_workflow_run_jobs":
    case "fetch_workflow_job_logs":
      return unsupported(stensiblyTool, repositoryFullName);

    case "fetch_workflow_job_steps":
      return mapped(stensiblyTool, repositoryFullName, {
        owner,
        repo,
        resource_id: String(delegatedArguments.job_id),
      });
  }
}

/** Re-admits a compatibility decision before a later dispatcher trusts policy evidence. */
export function assertGitHubOfficialMcpReadMappingMatchesPolicy(
  inputValue: unknown,
): void {
  const input = policyDecisionInput(inputValue);
  if (
    input.authorizesProviderCall !== false
    || input.mappingPolicyVersion !== githubOfficialMcpReadMappingPolicy.version
    || input.mappingPolicyFingerprint
      !== githubOfficialMcpReadMappingPolicy.fingerprint
    || input.sourceCommitSha !== githubOfficialMcpReadSource.commitSha
  ) {
    throw policyDivergence();
  }
  if (
    typeof input.repositoryFullName !== "string"
    || repositoryIdentity(input.repositoryFullName) !== input.repositoryFullName
  ) {
    throw policyDivergence();
  }

  const tool = exactDelegatedTool(input.stensiblyTool);
  const rule = githubOfficialMcpReadMappingPolicy.rules[tool];
  const evidence = exactSnapshotList(input.sourceToolSnapshotBlobShas);
  if (stableJson(evidence) !== stableJson(rule.sourceToolSnapshotBlobShas)) {
    throw policyDivergence();
  }

  if (input.state === "unsupported") {
    if (input.reason !== policyUnsupportedReason(rule)) {
      throw policyDivergence();
    }
    return;
  }
  if (rule.state !== "mapped" && rule.state !== "conditional") {
    throw policyDivergence();
  }

  const argumentsValue = exactPolicyArguments(input.officialArguments);
  if (
    input.officialToolset !== rule.officialToolset
    || input.officialTool !== rule.officialTool
    || input.resultContract !== rule.resultContract
    || input.maximumResultItems !== rule.maximumResultItems
    || stableJson(Object.keys(argumentsValue).sort(codeUnitCompare))
      !== stableJson(rule.argumentKeys)
  ) {
    throw policyDivergence();
  }
  for (const [key, expected] of Object.entries(rule.fixedArguments)) {
    if (stableJson(argumentsValue[key]) !== stableJson(expected)) {
      throw policyDivergence();
    }
  }
  assertDynamicArguments(tool, input.repositoryFullName, argumentsValue);
}

function mapped(
  stensiblyTool: GitHubDelegatedReadContractTool,
  repositoryFullName: string,
  dynamicArguments: Record<string, unknown>,
): GitHubOfficialMcpMappedRead {
  const rule = githubOfficialMcpReadMappingPolicy.rules[stensiblyTool];
  if (rule.state !== "mapped" && rule.state !== "conditional") {
    throw policyDivergence();
  }
  const officialArguments = deepFreeze({
    ...dynamicArguments,
    ...rule.fixedArguments,
  });
  const output = {
    state: "mapped" as const,
    stensiblyTool,
    repositoryFullName,
    officialToolset: rule.officialToolset,
    officialTool: rule.officialTool,
    officialArguments,
    resultContract: rule.resultContract,
    maximumResultItems: rule.maximumResultItems,
    ...commonEvidence(rule.sourceToolSnapshotBlobShas),
  } satisfies GitHubOfficialMcpMappedRead;
  assertGitHubOfficialMcpReadMappingMatchesPolicy(output);
  return deepFreeze(output);
}

function unsupported(
  stensiblyTool: GitHubDelegatedReadContractTool,
  repositoryFullName: string,
): GitHubOfficialMcpUnsupportedRead {
  const rule = githubOfficialMcpReadMappingPolicy.rules[stensiblyTool];
  const output = {
    state: "unsupported" as const,
    stensiblyTool,
    repositoryFullName,
    reason: policyUnsupportedReason(rule),
    ...commonEvidence(rule.sourceToolSnapshotBlobShas),
  } satisfies GitHubOfficialMcpUnsupportedRead;
  assertGitHubOfficialMcpReadMappingMatchesPolicy(output);
  return deepFreeze(output);
}

function policyUnsupportedReason(
  rule: GitHubOfficialMcpReadPolicyRule,
): GitHubOfficialMcpReadUnsupportedReason {
  if (rule.state === "unsupported") return rule.reason;
  if (rule.state === "conditional") return rule.unsupportedReason;
  throw policyDivergence();
}

function commonEvidence(
  sourceToolSnapshotBlobShas: readonly string[],
): GitHubOfficialMcpReadEvidence {
  return {
    authorizesProviderCall: false,
    mappingPolicyVersion: githubOfficialMcpReadMappingPolicy.version,
    mappingPolicyFingerprint: githubOfficialMcpReadMappingPolicy.fingerprint,
    sourceCommitSha: githubOfficialMcpReadSource.commitSha,
    sourceToolSnapshotBlobShas: [...sourceToolSnapshotBlobShas],
  };
}

function mappingInput(value: unknown): MappingInput {
  const admitted = exactOwnDataRecord(
    value,
    ["tool", "arguments", "repositoryFullName"],
    "GitHub official MCP read mapping input",
  );
  return admitted as unknown as MappingInput;
}

function policyDecisionInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw policyDivergence();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw policyDivergence();
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw policyDivergence();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const stateDescriptor = descriptors.state;
  if (
    !stateDescriptor
    || !stateDescriptor.enumerable
    || !("value" in stateDescriptor)
    || (stateDescriptor.value !== "mapped"
      && stateDescriptor.value !== "unsupported")
  ) {
    throw policyDivergence();
  }
  const keys = stateDescriptor.value === "mapped"
    ? mappedDecisionKeys
    : unsupportedDecisionKeys;
  return exactDescriptors(descriptors, keys, policyDivergence);
}

function exactPolicyArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw policyDivergence();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw policyDivergence();
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw policyDivergence();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 16) throw policyDivergence();
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw policyDivergence();
    }
    const entry = descriptor.value;
    if (
      typeof entry !== "string"
      && typeof entry !== "number"
      && typeof entry !== "boolean"
    ) {
      throw policyDivergence();
    }
    if (
      typeof entry === "number"
      && (!Number.isFinite(entry) || Object.is(entry, -0))
    ) {
      throw policyDivergence();
    }
    result[key] = entry;
  }
  return result;
}

function exactSnapshotList(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw policyDivergence();
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw policyDivergence();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || lengthDescriptor.enumerable
    || lengthDescriptor.configurable
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 1
    || lengthDescriptor.value > 8
  ) {
    throw policyDivergence();
  }
  const length = lengthDescriptor.value;
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      throw policyDivergence();
    }
  }
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor
      || !descriptor.enumerable
      || !("value" in descriptor)
      || typeof descriptor.value !== "string"
      || !/^[a-f0-9]{40}$/.test(descriptor.value)
    ) {
      throw policyDivergence();
    }
    result.push(descriptor.value);
  }
  return result;
}

function assertDynamicArguments(
  tool: GitHubDelegatedReadContractTool,
  repositoryFullName: string,
  argumentsValue: Record<string, unknown>,
): void {
  try {
    const [owner, repo] = repositoryFullName.split("/") as [string, string];
    switch (tool) {
      case "get_repo": {
        parseGitHubDelegatedReadArguments(tool, {});
        if (argumentsValue.query !== `repo:${repositoryFullName}`) {
          throw policyDivergence();
        }
        return;
      }
      case "fetch_file": {
        assertRepositorySelectors(argumentsValue, owner, repo);
        const parsed = parseGitHubDelegatedReadArguments(tool, {
          path: argumentsValue.path,
          ref: argumentsValue.sha,
        });
        if (
          parsed.path !== argumentsValue.path
          || parsed.ref !== argumentsValue.sha
        ) {
          throw policyDivergence();
        }
        return;
      }
      case "get_pr_info": {
        assertRepositorySelectors(argumentsValue, owner, repo);
        const parsed = parseGitHubDelegatedReadArguments(tool, {
          pr_number: argumentsValue.pullNumber,
        });
        if (parsed.pr_number !== argumentsValue.pullNumber) {
          throw policyDivergence();
        }
        return;
      }
      case "get_pr_diff": {
        assertRepositorySelectors(argumentsValue, owner, repo);
        const parsed = parseGitHubDelegatedReadArguments(tool, {
          pr_number: argumentsValue.pullNumber,
          format: "diff",
        });
        if (parsed.pr_number !== argumentsValue.pullNumber) {
          throw policyDivergence();
        }
        return;
      }
      case "fetch_workflow_job_steps": {
        assertRepositorySelectors(argumentsValue, owner, repo);
        const jobId = canonicalPositiveIntegerString(argumentsValue.resource_id);
        const parsed = parseGitHubDelegatedReadArguments(tool, { job_id: jobId });
        if (
          parsed.job_id !== jobId
          || String(parsed.job_id) !== argumentsValue.resource_id
        ) {
          throw policyDivergence();
        }
        return;
      }
      case "list_pull_request_review_threads":
      case "get_commit_combined_status":
      case "fetch_commit_workflow_runs":
      case "fetch_workflow_run_jobs":
      case "fetch_workflow_job_logs":
        throw policyDivergence();
    }
  } catch {
    throw policyDivergence();
  }
}

function assertRepositorySelectors(
  argumentsValue: Record<string, unknown>,
  owner: string,
  repo: string,
): void {
  if (argumentsValue.owner !== owner || argumentsValue.repo !== repo) {
    throw policyDivergence();
  }
}

function canonicalPositiveIntegerString(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw policyDivergence();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw policyDivergence();
  }
  return parsed;
}

function exactOwnDataRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  return exactDescriptors(
    Object.getOwnPropertyDescriptors(value),
    keys,
    () => new RangeError(`${label} contains an unknown or invalid field`),
  );
}

function exactDescriptors(
  descriptors: Record<string, PropertyDescriptor>,
  keys: readonly string[],
  errorFactory: () => Error,
): Record<string, unknown> {
  const allowed = new Set(keys);
  if (Object.keys(descriptors).length !== allowed.size) throw errorFactory();
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !allowed.has(key)
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw errorFactory();
    }
    result[key] = descriptor.value;
  }
  for (const key of allowed) {
    if (!Object.hasOwn(descriptors, key)) throw errorFactory();
  }
  return result;
}

function exactDelegatedTool(value: unknown): GitHubDelegatedReadContractTool {
  if (typeof value !== "string") throw policyDivergence();
  const canonical = delegatedTool(value);
  if (canonical !== value) throw policyDivergence();
  return canonical;
}

function delegatedTool(value: unknown): GitHubDelegatedReadContractTool {
  const tool = canonicalGitHubDelegatedReadTool(value);
  return tool as GitHubDelegatedReadContractTool;
}

function repositoryIdentity(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("GitHub official MCP repository identity must be a string");
  }
  if (value.length < 1 || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new RangeError(
      "GitHub official MCP repository identity must use exact printable ASCII without whitespace",
    );
  }
  return normalizeGitHubRepository(value).toLowerCase();
}

function policyDivergence(): Error {
  return new Error(
    "GitHub official MCP mapping diverges from its fingerprinted policy",
  );
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  const entries = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const entry of entries) deepFreeze(entry, seen);
  return value;
}
