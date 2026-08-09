import {
  githubCapabilityRegistry,
  type GitHubCapabilityRegistry,
} from "./github-capability-curation.js";
import { sha256, stableJson } from "./github-provider-validation.js";

export interface GitHubLiveConnectorObservation {
  version: 1;
  source: "chatgpt-github-connector";
  sourceRevision: string;
  observedAt: string;
  toolNames: readonly string[];
  fingerprint: string;
}

export interface GitHubLiveConnectorDrift {
  version: 1;
  observationFingerprint: string;
  registryFingerprint: string;
  liveAndCurated: readonly string[];
  curatedButLiveMissing: readonly string[];
  liveButUncurated: readonly string[];
  fingerprint: string;
}

const toolNamePattern = /^[a-z][a-z0-9_]{0,127}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function compileGitHubLiveConnectorObservation(input: {
  version: 1;
  source: "chatgpt-github-connector";
  sourceRevision: string;
  observedAt: string;
  toolNames: readonly string[];
}): GitHubLiveConnectorObservation {
  if (input.version !== 1 || input.source !== "chatgpt-github-connector") {
    throw new RangeError("GitHub live connector observation version or source is unsupported");
  }
  const sourceRevision = exactText(
    input.sourceRevision,
    "GitHub live connector source revision",
    512,
  );
  const observedAt = exactText(
    input.observedAt,
    "GitHub live connector observation date",
    32,
  );
  if (!datePattern.test(observedAt)) {
    throw new RangeError("GitHub live connector observation date must use YYYY-MM-DD");
  }
  if (!Array.isArray(input.toolNames) || input.toolNames.length < 1 || input.toolNames.length > 200) {
    throw new RangeError("GitHub live connector observation accepts 1 to 200 tool names");
  }
  const toolNames = input.toolNames.map((value) => {
    const name = exactText(value, "GitHub live connector tool name", 128);
    if (!toolNamePattern.test(name)) {
      throw new RangeError(`GitHub live connector tool name is invalid: ${name}`);
    }
    return name;
  });
  if (new Set(toolNames).size !== toolNames.length) {
    throw new RangeError("GitHub live connector tool names must be unique");
  }
  toolNames.sort(codeUnitCompare);

  const canonical = {
    version: 1 as const,
    source: "chatgpt-github-connector" as const,
    sourceRevision,
    observedAt,
    toolNames: Object.freeze(toolNames),
  };
  return Object.freeze({
    ...canonical,
    fingerprint: sha256(stableJson(canonical)),
  });
}

export function compareGitHubLiveConnectorObservation(
  observation: GitHubLiveConnectorObservation,
  registry: GitHubCapabilityRegistry = githubCapabilityRegistry,
): GitHubLiveConnectorDrift {
  const live = new Set(observation.toolNames);
  const curated = new Set(registry.capabilities.map((entry) => entry.name));
  const liveAndCurated = sorted(
    observation.toolNames.filter((name) => curated.has(name)),
  );
  const curatedButLiveMissing = sorted(
    [...curated].filter((name) => !live.has(name)),
  );
  const liveButUncurated = sorted(
    observation.toolNames.filter((name) => !curated.has(name)),
  );
  const canonical = {
    version: 1 as const,
    observationFingerprint: observation.fingerprint,
    registryFingerprint: registry.fingerprint,
    liveAndCurated: Object.freeze(liveAndCurated),
    curatedButLiveMissing: Object.freeze(curatedButLiveMissing),
    liveButUncurated: Object.freeze(liveButUncurated),
  };
  return Object.freeze({
    ...canonical,
    fingerprint: sha256(stableJson(canonical)),
  });
}

export const githubLiveConnectorObservation = compileGitHubLiveConnectorObservation({
  version: 1,
  source: "chatgpt-github-connector",
  sourceRevision: "chatgpt-github-connector:observed-2026-08-10:issue-1322",
  observedAt: "2026-08-10",
  toolNames: [
    "add_comment_to_issue",
    "add_issue_assignees",
    "add_issue_labels",
    "add_reaction_to_issue_comment",
    "add_reaction_to_pr",
    "add_reaction_to_pr_review_comment",
    "add_review_to_pr",
    "compare_commits",
    "convert_pull_request_to_draft",
    "create_blob",
    "create_branch",
    "create_commit",
    "create_file",
    "create_issue",
    "create_pull_request",
    "create_tree",
    "delete_file",
    "dismiss_pull_request_review",
    "download_user_content",
    "download_workflow_artifact",
    "enable_auto_merge",
    "fetch",
    "fetch_blob",
    "fetch_commit",
    "fetch_commit_workflow_runs",
    "fetch_file",
    "fetch_issue",
    "fetch_issue_comments",
    "fetch_pr",
    "fetch_pr_comments",
    "fetch_pr_file_patch",
    "fetch_pr_patch",
    "fetch_workflow_job_logs",
    "fetch_workflow_job_steps",
    "fetch_workflow_run_artifacts",
    "fetch_workflow_run_jobs",
    "get_commit_combined_status",
    "get_issue_comment_reactions",
    "get_pr_diff",
    "get_pr_info",
    "get_pr_reactions",
    "get_pr_review_comment_reactions",
    "get_profile",
    "get_repo",
    "get_repo_collaborator_permission",
    "get_user_login",
    "get_users_recent_prs_in_repo",
    "label_pr",
    "list_installations",
    "list_installed_accounts",
    "list_pr_changed_filenames",
    "list_pull_request_review_threads",
    "list_pull_request_reviews",
    "list_recent_issues",
    "list_repositories",
    "list_repositories_by_affiliation",
    "list_repositories_by_installation",
    "list_user_org_memberships",
    "list_user_orgs",
    "lock_issue_conversation",
    "mark_pull_request_ready_for_review",
    "merge_pull_request",
    "remove_issue_assignees",
    "remove_issue_label",
    "remove_pull_request_reviewers",
    "remove_reaction_from_issue_comment",
    "remove_reaction_from_pr",
    "remove_reaction_from_pr_review_comment",
    "reply_to_review_comment",
    "request_pull_request_reviewers",
    "rerun_failed_workflow_run_jobs",
    "rerun_workflow_job",
    "resolve_review_thread",
    "search",
    "search_branches",
    "search_commits",
    "search_installed_repositories_streaming",
    "search_installed_repositories_v2",
    "search_issues",
    "search_prs",
    "search_repositories",
    "unlock_issue_conversation",
    "unresolve_review_thread",
    "update_file",
    "update_issue",
    "update_issue_comment",
    "update_pull_request",
    "update_ref",
    "update_review_comment",
  ],
});

export const githubLiveConnectorDrift = compareGitHubLiveConnectorObservation(
  githubLiveConnectorObservation,
);

function exactText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  if (!value || value.length > maximum || value !== value.trim()) {
    throw new RangeError(`${label} must contain 1 to ${maximum} exact characters without surrounding whitespace`);
  }
  if (!/^[\x20-\x7e]+$/.test(value)) {
    throw new RangeError(`${label} must use exact printable ASCII characters`);
  }
  return value;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(codeUnitCompare);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
