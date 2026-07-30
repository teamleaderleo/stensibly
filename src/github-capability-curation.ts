import {
  boundedText,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

export const githubCapabilityTiers = [
  "essential",
  "secondary",
  "advanced",
  "internal",
  "excluded",
] as const;
export type GitHubCapabilityTier = typeof githubCapabilityTiers[number];

export const githubCapabilitySkills = [
  "github",
  "review_follow_up",
  "ci_debug",
  "publish_changes",
] as const;
export type GitHubCapabilitySkill = typeof githubCapabilitySkills[number];

export const githubCapabilityExecutionModes = [
  "typed_first_party",
  "delegated",
  "internal_primitive",
  "excluded",
] as const;
export type GitHubCapabilityExecutionMode =
  typeof githubCapabilityExecutionModes[number];

export interface GitHubCapabilityDefinition {
  name: string;
  displayName: string;
  description: string;
  tier: GitHubCapabilityTier;
  skill: GitHubCapabilitySkill;
  readOnly: boolean;
  riskClass: "read" | "write" | "admin";
  repositoryScoped: boolean;
  executionMode: GitHubCapabilityExecutionMode;
  firstPartyTool: string | null;
  dispatchEnabled: boolean;
  modelVisibleByDefault: boolean;
  searchable: boolean;
}

export interface GitHubCapabilitySkillSummary {
  name: GitHubCapabilitySkill;
  description: string;
  defaultVisibleCount: number;
  searchableCount: number;
  totalCount: number;
  tierCounts: Record<GitHubCapabilityTier, number>;
}

export interface GitHubCapabilityRegistry {
  version: 1;
  source: "chatgpt-github-connector";
  sourceRevision: string;
  curationRevision: string;
  capabilities: readonly GitHubCapabilityDefinition[];
  skills: readonly GitHubCapabilitySkillSummary[];
  fingerprint: string;
}

const skillDescriptions: Record<GitHubCapabilitySkill, string> = {
  github: "Repository context, code, commits, issues, and ordinary pull-request reads.",
  review_follow_up: "Pull-request review, discussion, reviewer, and merge-follow-up operations.",
  ci_debug: "Statuses, workflow runs, jobs, steps, logs, artifacts, comparisons, and reruns.",
  publish_changes: "Branches, repository file mutations, pull-request publication, and internal Git primitives.",
};

interface CapabilitySeed {
  name: string;
  tier: GitHubCapabilityTier;
  skill: GitHubCapabilitySkill;
  readOnly: boolean;
}

function seeds(
  tier: GitHubCapabilityTier,
  skill: GitHubCapabilitySkill,
  readOnly: boolean,
  names: readonly string[],
): CapabilitySeed[] {
  return names.map((name) => ({ name, tier, skill, readOnly }));
}

const capabilitySeeds: CapabilitySeed[] = [
  ...seeds("essential", "github", true, [
    "get_profile",
    "list_repositories",
    "search_repositories",
    "get_repo",
    "list_directory",
    "fetch_file",
    "search",
    "list_commits",
    "fetch_commit",
    "compare_commits",
    "get_commit_diff",
    "get_commit_combined_status",
    "list_recent_issues",
    "search_issues",
    "fetch_issue",
    "fetch_issue_comments",
    "search_prs",
    "fetch_pr",
    "get_pr_info",
    "get_pr_diff",
    "list_pr_changed_filenames",
    "fetch_pr_comments",
    "list_pull_request_reviews",
    "list_pull_request_review_threads",
  ]),
  ...seeds("essential", "github", false, [
    "create_issue",
    "update_issue",
    "add_comment_to_issue",
    "add_issue_labels",
    "remove_issue_label",
    "add_issue_assignees",
    "remove_issue_assignees",
  ]),
  ...seeds("essential", "review_follow_up", false, [
    "create_pull_request",
    "update_pull_request",
    "add_review_to_pr",
    "reply_to_review_comment",
    "request_pull_request_reviewers",
    "remove_pull_request_reviewers",
    "convert_pull_request_to_draft",
    "mark_pull_request_ready_for_review",
    "merge_pull_request",
  ]),
  ...seeds("essential", "ci_debug", true, [
    "fetch_commit_workflow_runs",
    "fetch_workflow_run_jobs",
    "fetch_workflow_job_steps",
    "fetch_workflow_job_logs",
    "fetch_workflow_run_artifacts",
    "download_workflow_artifact",
  ]),
  ...seeds("essential", "ci_debug", false, [
    "rerun_failed_workflow_run_jobs",
    "rerun_workflow_job",
  ]),
  ...seeds("essential", "publish_changes", false, [
    "create_branch",
    "create_file",
    "update_file",
    "delete_file",
  ]),

  ...seeds("secondary", "review_follow_up", false, [
    "enable_auto_merge",
    "resolve_review_thread",
    "unresolve_review_thread",
    "dismiss_pull_request_review",
    "update_issue_comment",
    "update_review_comment",
    "label_pr",
  ]),
  ...seeds("secondary", "github", true, [
    "search_branches",
    "search_commits",
    "resolve_ref",
    "get_repo_collaborator_permission",
    "list_user_orgs",
    "list_user_org_memberships",
    "get_users_recent_prs_in_repo",
    "fetch_pr_file_patch",
    "fetch_pr_patch",
    "download_user_content",
  ]),

  ...seeds("advanced", "review_follow_up", false, [
    "lock_issue_conversation",
    "unlock_issue_conversation",
  ]),
  ...seeds("advanced", "github", true, [
    "list_repositories_by_affiliation",
    "list_repositories_by_installation",
    "search_installed_repositories_streaming",
    "search_installed_repositories_v2",
    "get_user_login",
    "oai_user_fetch",
    "oai_user_search",
    "get_repo_installation_id",
    "list_installations",
    "list_installed_accounts",
    "fetch_blob",
    "fetch",
  ]),

  ...seeds("internal", "publish_changes", true, [
    "check_repo_initialized",
  ]),
  ...seeds("internal", "publish_changes", false, [
    "create_blob",
    "create_tree",
    "create_commit",
    "update_ref",
  ]),

  ...seeds("excluded", "review_follow_up", true, [
    "get_issue_comment_reactions",
    "get_pr_reactions",
    "get_pr_review_comment_reactions",
  ]),
  ...seeds("excluded", "review_follow_up", false, [
    "add_reaction_to_issue_comment",
    "add_reaction_to_pr",
    "add_reaction_to_pr_review_comment",
    "remove_reaction_from_issue_comment",
    "remove_reaction_from_pr",
    "remove_reaction_from_pr_review_comment",
  ]),
];

const nonRepositoryScoped = new Set([
  "get_profile",
  "list_repositories",
  "search_repositories",
  "list_user_orgs",
  "list_user_org_memberships",
  "list_repositories_by_affiliation",
  "list_repositories_by_installation",
  "search_installed_repositories_streaming",
  "search_installed_repositories_v2",
  "get_user_login",
  "oai_user_fetch",
  "oai_user_search",
  "list_installations",
  "list_installed_accounts",
]);

const adminCapabilities = new Set([
  "merge_pull_request",
  "enable_auto_merge",
  "lock_issue_conversation",
  "unlock_issue_conversation",
  "dismiss_pull_request_review",
  "update_ref",
]);

const firstPartyBindings: Record<string, string> = {
  list_recent_issues: "github_list_issues",
  search_issues: "github_search_issues",
  fetch_issue: "github_get_issue",
};

export const githubCapabilityRegistry = compileGitHubCapabilityRegistry({
  version: 1,
  source: "chatgpt-github-connector",
  sourceRevision: "chatgpt-github-connector:observed-2026-07-31",
  curationRevision: "stensibly-github-curation:v1",
  capabilities: capabilitySeeds,
});

export function compileGitHubCapabilityRegistry(input: {
  version: 1;
  source: "chatgpt-github-connector";
  sourceRevision: string;
  curationRevision: string;
  capabilities: CapabilitySeed[];
}): GitHubCapabilityRegistry {
  if (input.version !== 1 || input.source !== "chatgpt-github-connector") {
    throw new RangeError("GitHub capability registry version or source is unsupported");
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length > 200) {
    throw new RangeError("GitHub capability registry accepts at most 200 capabilities");
  }
  const names = new Set<string>();
  const capabilities = input.capabilities.map((seed) => {
    const name = boundedText(seed.name, "GitHub capability name", 128)
      .toLocaleLowerCase("en-US");
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(name)) {
      throw new RangeError(`GitHub capability name is invalid: ${name}`);
    }
    if (names.has(name)) throw new RangeError(`Duplicate GitHub capability: ${name}`);
    names.add(name);
    if (!(githubCapabilityTiers as readonly string[]).includes(seed.tier)) {
      throw new RangeError(`GitHub capability tier is invalid: ${seed.tier}`);
    }
    if (!(githubCapabilitySkills as readonly string[]).includes(seed.skill)) {
      throw new RangeError(`GitHub capability skill is invalid: ${seed.skill}`);
    }
    if (typeof seed.readOnly !== "boolean") {
      throw new RangeError(`GitHub capability read-only flag is invalid: ${name}`);
    }
    const executionMode: GitHubCapabilityExecutionMode = seed.tier === "internal"
      ? "internal_primitive"
      : seed.tier === "excluded"
      ? "excluded"
      : firstPartyBindings[name]
      ? "typed_first_party"
      : "delegated";
    const firstPartyTool = firstPartyBindings[name] ?? null;
    const displayName = displayCapabilityName(name);
    return {
      name,
      displayName,
      description: `${displayName} through the GitHub capability boundary.`,
      tier: seed.tier,
      skill: seed.skill,
      readOnly: seed.readOnly,
      riskClass: seed.readOnly ? "read" : adminCapabilities.has(name) ? "admin" : "write",
      repositoryScoped: !nonRepositoryScoped.has(name),
      executionMode,
      firstPartyTool,
      dispatchEnabled: firstPartyTool !== null,
      modelVisibleByDefault: seed.tier === "essential",
      searchable: seed.tier === "essential"
        || seed.tier === "secondary"
        || seed.tier === "advanced",
    } satisfies GitHubCapabilityDefinition;
  }).sort((left, right) => codeUnitCompare(left.name, right.name));

  const skills = githubCapabilitySkills.map((name) => {
    const selected = capabilities.filter((capability) => capability.skill === name);
    const tierCounts = Object.fromEntries(
      githubCapabilityTiers.map((tier) => [
        tier,
        selected.filter((capability) => capability.tier === tier).length,
      ]),
    ) as Record<GitHubCapabilityTier, number>;
    return {
      name,
      description: skillDescriptions[name],
      defaultVisibleCount: selected.filter((capability) => capability.modelVisibleByDefault).length,
      searchableCount: selected.filter((capability) => capability.searchable).length,
      totalCount: selected.length,
      tierCounts,
    } satisfies GitHubCapabilitySkillSummary;
  });

  const canonical = {
    version: 1 as const,
    source: "chatgpt-github-connector" as const,
    sourceRevision: boundedText(input.sourceRevision, "GitHub capability source revision", 512),
    curationRevision: boundedText(input.curationRevision, "GitHub capability curation revision", 512),
    capabilities,
    skills,
  };
  return deepFreeze({
    ...canonical,
    fingerprint: sha256(stableJson(canonical)),
  });
}

function displayCapabilityName(name: string): string {
  return name.split("_").map((part) => part.length <= 3
    ? part.toUpperCase()
    : `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value) as T;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
