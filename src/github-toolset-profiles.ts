export type GitHubToolsetAvailability = "local_and_remote" | "remote_only";
export type GitHubProviderMode = "local" | "remote";

export interface GitHubUpstreamToolset {
  name: string;
  description: string;
  availability: GitHubToolsetAvailability;
}

export const githubUpstreamToolsets = [
  {
    name: "actions",
    description: "GitHub Actions workflows and CI/CD operations.",
    availability: "local_and_remote",
  },
  {
    name: "code_quality",
    description: "GitHub Code Quality related tools.",
    availability: "local_and_remote",
  },
  {
    name: "code_security",
    description: "Code security tools, including GitHub Code Scanning.",
    availability: "local_and_remote",
  },
  {
    name: "copilot",
    description: "GitHub Copilot related tools.",
    availability: "local_and_remote",
  },
  {
    name: "copilot_issue_intents",
    description: "Opt-in Copilot issue assignment tools carrying intent metadata.",
    availability: "local_and_remote",
  },
  {
    name: "copilot_spaces",
    description: "GitHub Copilot Spaces tools.",
    availability: "remote_only",
  },
  {
    name: "dependabot",
    description: "GitHub Dependabot tools.",
    availability: "local_and_remote",
  },
  {
    name: "discussions",
    description: "GitHub Discussions related tools.",
    availability: "local_and_remote",
  },
  {
    name: "gists",
    description: "GitHub Gist related tools.",
    availability: "local_and_remote",
  },
  {
    name: "git",
    description: "Low-level GitHub Git API operations.",
    availability: "local_and_remote",
  },
  {
    name: "github_support_docs_search",
    description: "GitHub product and support documentation search.",
    availability: "remote_only",
  },
  {
    name: "issues",
    description: "GitHub Issues related tools.",
    availability: "local_and_remote",
  },
  {
    name: "labels",
    description: "GitHub Labels related tools.",
    availability: "local_and_remote",
  },
  {
    name: "notifications",
    description: "GitHub Notifications related tools.",
    availability: "local_and_remote",
  },
  {
    name: "orgs",
    description: "GitHub Organization related tools.",
    availability: "local_and_remote",
  },
  {
    name: "projects",
    description: "GitHub Projects related tools.",
    availability: "local_and_remote",
  },
  {
    name: "pull_requests",
    description: "GitHub Pull Request related tools.",
    availability: "local_and_remote",
  },
  {
    name: "repos",
    description: "GitHub Repository related tools.",
    availability: "local_and_remote",
  },
  {
    name: "secret_protection",
    description: "Secret protection tools, including GitHub Secret Scanning.",
    availability: "local_and_remote",
  },
  {
    name: "security_advisories",
    description: "GitHub Security Advisory related tools.",
    availability: "local_and_remote",
  },
  {
    name: "stargazers",
    description: "GitHub Stargazer related tools.",
    availability: "local_and_remote",
  },
  {
    name: "users",
    description: "GitHub User related tools.",
    availability: "local_and_remote",
  },
] as const satisfies readonly GitHubUpstreamToolset[];

export type GitHubUpstreamToolsetName =
  typeof githubUpstreamToolsets[number]["name"];

export const githubToolsetProfileNames = [
  "default",
  "read_only",
  "actions",
  "security",
  "projects",
  "notifications",
  "all",
] as const;
export type GitHubToolsetProfileName = typeof githubToolsetProfileNames[number];

interface GitHubToolsetProfileDefinition {
  description: string;
  toolsets: readonly GitHubUpstreamToolsetName[];
  readOnly: boolean;
  requiresOperatorApproval: boolean;
}

const allToolsetNames: readonly GitHubUpstreamToolsetName[] =
  githubUpstreamToolsets.map((toolset) => toolset.name);

const githubToolsetProfileDefinitions: Record<
  GitHubToolsetProfileName,
  GitHubToolsetProfileDefinition
> = {
  default: {
    description: "High-value repository, issue, pull-request, and user operations.",
    toolsets: ["repos", "issues", "pull_requests", "users"],
    readOnly: false,
    requiresOperatorApproval: false,
  },
  read_only: {
    description: "Every available toolset with provider writes removed.",
    toolsets: allToolsetNames,
    readOnly: true,
    requiresOperatorApproval: false,
  },
  actions: {
    description: "Focused GitHub Actions operations.",
    toolsets: ["actions"],
    readOnly: false,
    requiresOperatorApproval: false,
  },
  security: {
    description: "Code quality, code security, Dependabot, secrets, and advisories.",
    toolsets: [
      "code_quality",
      "code_security",
      "dependabot",
      "secret_protection",
      "security_advisories",
    ],
    readOnly: true,
    requiresOperatorApproval: false,
  },
  projects: {
    description: "Focused GitHub Projects operations.",
    toolsets: ["projects"],
    readOnly: false,
    requiresOperatorApproval: false,
  },
  notifications: {
    description: "Focused GitHub Notifications operations.",
    toolsets: ["notifications"],
    readOnly: false,
    requiresOperatorApproval: false,
  },
  all: {
    description: "Every available GitHub MCP toolset, including write surfaces.",
    toolsets: allToolsetNames,
    readOnly: false,
    requiresOperatorApproval: true,
  },
};

export interface ResolvedGitHubToolsetProfile {
  name: GitHubToolsetProfileName;
  description: string;
  providerMode: GitHubProviderMode;
  toolsets: GitHubUpstreamToolsetName[];
  omittedToolsets: GitHubUpstreamToolsetName[];
  readOnly: boolean;
  requiresOperatorApproval: boolean;
}

export function resolveGitHubToolsetProfile(
  name: GitHubToolsetProfileName,
  providerMode: GitHubProviderMode,
): ResolvedGitHubToolsetProfile {
  const profile = githubToolsetProfileDefinitions[name];
  const available = new Set<GitHubUpstreamToolsetName>(
    githubUpstreamToolsets
      .filter((toolset) => providerMode === "remote"
        || toolset.availability === "local_and_remote")
      .map((toolset) => toolset.name),
  );
  const toolsets = profile.toolsets.filter((toolset) => available.has(toolset));
  const omittedToolsets = profile.toolsets.filter((toolset) => !available.has(toolset));

  return {
    name,
    description: profile.description,
    providerMode,
    toolsets,
    omittedToolsets,
    readOnly: profile.readOnly,
    requiresOperatorApproval: profile.requiresOperatorApproval,
  };
}
