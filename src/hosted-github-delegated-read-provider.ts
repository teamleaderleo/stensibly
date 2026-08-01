import {
  GitHubAppInstallationTokenMinter,
} from "./github-app-installation-token.js";
import {
  GitHubCapabilityCatalogueService,
} from "./github-capability-service.js";
import {
  GitHubDelegatedReadService,
  type GitHubDelegatedReadAdapter,
  type GitHubDelegatedReadAuthority,
  type GitHubDelegatedReadReceipt,
} from "./github-delegated-read.js";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderBindingStore,
  GitHubProviderConnection,
} from "./github-provider-contracts.js";
import {
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import { GitHubRestActionsJobDetailAdapter } from "./github-rest-actions-job-detail-adapter.js";
import { GitHubRestActionsRunAdapter } from "./github-rest-actions-run-adapter.js";
import { GitHubRestCommitStatusAdapter } from "./github-rest-commit-status-adapter.js";
import { GitHubRestPullRequestReviewThreadAdapter } from "./github-rest-pull-request-review-thread-adapter.js";
import type { WorkLedger } from "./ledger.js";
import {
  projectAttachmentLedger,
  type ProjectAttachmentLedger,
} from "./project-attachment-ledger.js";

export const hostedGitHubDelegatedReadTools = Object.freeze([
  "get_repo",
  "fetch_file",
  "get_pr_info",
  "get_pr_diff",
  "list_pull_request_review_threads",
  "get_commit_combined_status",
  "fetch_commit_workflow_runs",
  "fetch_workflow_run_jobs",
] as const);

export const hostedGitHubDelegatedReadJobDetailTools = Object.freeze([
  ...hostedGitHubDelegatedReadTools,
  "fetch_workflow_job_steps",
  "fetch_workflow_job_logs",
] as const);

export type HostedGitHubDelegatedReadTool =
  typeof hostedGitHubDelegatedReadJobDetailTools[number];

export type HostedGitHubDelegatedReadToolDeclaration =
  | typeof hostedGitHubDelegatedReadTools
  | typeof hostedGitHubDelegatedReadJobDetailTools;

export type HostedGitHubDelegatedReadInput = Parameters<
  GitHubDelegatedReadService["call"]
>[0];

export interface HostedGitHubDelegatedReadProvider {
  readonly delegatedGitHubReadTools?: HostedGitHubDelegatedReadToolDeclaration;
  callGitHubDelegatedRead(
    input: HostedGitHubDelegatedReadInput,
  ): Promise<GitHubDelegatedReadReceipt>;
}

export interface HostedGitHubDelegatedReadOverrides {
  fetch?: typeof fetch;
  now?: () => number;
}

interface HostedGitHubDelegatedReadConfig {
  project: string;
  repositoryFullName: string;
  appId: string;
  installationId: string;
  accountLogin: string;
  privateKeyPem: string;
  apiBaseUrl: string;
  credentialRef: string;
  jobDetailReadsEnabled: boolean;
}

const actionsRunTools = new Set<string>([
  "fetch_commit_workflow_runs",
  "fetch_workflow_run_jobs",
]);
const actionsJobDetailTools = new Set<string>([
  "fetch_workflow_job_steps",
  "fetch_workflow_job_logs",
]);

/**
 * Mounts a private eight-tool delegated-read service when the explicit hosted
 * flag and the complete GitHub App configuration are present. A separate exact
 * flag extends that declaration to the reviewed ten-tool job-detail surface.
 * Public MCP dispatch and discovery remain separately controlled.
 */
export function mountHostedGitHubDelegatedReadProviderFromEnv<
  T extends WorkLedger,
>(
  ledger: T,
  env: Record<string, string | undefined>,
  overrides: HostedGitHubDelegatedReadOverrides = {},
): T & Partial<HostedGitHubDelegatedReadProvider> {
  const config = hostedGitHubDelegatedReadConfig(env);
  if (!config) return ledger;

  const projects = projectAttachmentLedger(ledger);
  if (!projects) {
    throw new Error(
      "Hosted GitHub delegated reads require a project-attachment ledger",
    );
  }

  const delegatedTools = config.jobDetailReadsEnabled
    ? hostedGitHubDelegatedReadJobDetailTools
    : hostedGitHubDelegatedReadTools;
  const enabledTools = new Set<string>(delegatedTools);
  const now = overrides.now ?? Date.now;
  const observedAt = exactObservationTime(now);
  const bindings = new AcceptedAttachmentDelegatedBindingStore(
    projects,
    config,
    observedAt,
  );
  const tokens = new GitHubAppInstallationTokenMinter({
    appId: config.appId,
    installationId: config.installationId,
    accountLogin: config.accountLogin,
    privateKeyPem: config.privateKeyPem,
    repositoryFullNames: [config.repositoryFullName],
    apiBaseUrl: config.apiBaseUrl,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    now,
  });
  const adapterOptions = {
    connectionId: bindings.connection.id,
    installationId: config.installationId,
    credentialRef: config.credentialRef,
    tokenProvider: tokens,
    apiBaseUrl: config.apiBaseUrl,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  };
  const pullRequestAdapter = new GitHubRestPullRequestReviewThreadAdapter(
    adapterOptions,
  );
  const statusAdapter = new GitHubRestCommitStatusAdapter(adapterOptions);
  const actionsAdapter = new GitHubRestActionsRunAdapter(adapterOptions);
  const actionsJobDetailAdapter = config.jobDetailReadsEnabled
    ? new GitHubRestActionsJobDetailAdapter(adapterOptions)
    : null;
  const adapter: GitHubDelegatedReadAdapter = Object.freeze({
    callReadTool: (
      input: Parameters<GitHubDelegatedReadAdapter["callReadTool"]>[0],
    ) => input.tool === "get_commit_combined_status"
      ? statusAdapter.callReadTool(input)
      : actionsJobDetailTools.has(input.tool)
      ? actionsJobDetailAdapter
        ? actionsJobDetailAdapter.callReadTool(input)
        : Promise.reject(
          new Error("Hosted GitHub Actions job-detail reads are unavailable"),
        )
      : actionsRunTools.has(input.tool)
      ? actionsAdapter.callReadTool(input)
      : pullRequestAdapter.callReadTool(input),
  });
  const catalogue = new GitHubCapabilityCatalogueService();
  const service = new GitHubDelegatedReadService({
    projects,
    bindings,
    authority: new HostedDelegatedReadAuthority(config, enabledTools),
    adapter,
    catalogue,
  });

  return Object.assign(ledger, {
    delegatedGitHubReadTools: delegatedTools,
    callGitHubDelegatedRead: (
      input: HostedGitHubDelegatedReadInput,
    ) => service.call(input),
  });
}

export function hostedGitHubDelegatedReadProviderConfigured(
  env: Record<string, string | undefined>,
): boolean {
  return hostedGitHubDelegatedReadConfig(env) !== null;
}

function hostedGitHubDelegatedReadConfig(
  env: Record<string, string | undefined>,
): HostedGitHubDelegatedReadConfig | null {
  const enabled = env.STENSIBLY_GITHUB_DELEGATED_READS_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "false") {
    return null;
  }
  if (enabled !== "true") {
    throw new Error(
      "STENSIBLY_GITHUB_DELEGATED_READS_ENABLED must be exact true or false",
    );
  }

  const appId = requiredEnv(env, "STENSIBLY_GITHUB_APP_ID");
  const privateKeyPem = requiredEnv(
    env,
    "STENSIBLY_GITHUB_APP_PRIVATE_KEY",
  );
  const installationId = requiredEnv(
    env,
    "STENSIBLY_GITHUB_INSTALLATION_ID",
  );
  const project = hostedProjectSlug(
    requiredEnv(env, "STENSIBLY_GITHUB_PROVIDER_PROJECT", false),
  );
  const repositoryFullName = normalizeGitHubRepository(
    exactAuthorityEnv(env, "STENSIBLY_GITHUB_PROVIDER_REPOSITORY"),
  ).toLowerCase();
  const accountLogin = exactAuthorityEnv(
    env,
    "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN",
  ).toLowerCase();
  const apiBaseUrl = trimmed(env.STENSIBLY_GITHUB_API_BASE_URL)
    ?? "https://api.github.com";
  const jobDetailReadsEnabled = optionalBooleanEnv(
    env,
    "STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED",
  );

  return {
    project,
    repositoryFullName,
    appId,
    installationId,
    accountLogin,
    privateKeyPem,
    apiBaseUrl,
    credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    jobDetailReadsEnabled,
  };
}

class AcceptedAttachmentDelegatedBindingStore
  implements GitHubProviderBindingStore
{
  readonly #projects: ProjectAttachmentLedger;
  readonly #config: HostedGitHubDelegatedReadConfig;
  readonly connection: GitHubProviderConnection;

  constructor(
    projects: ProjectAttachmentLedger,
    config: HostedGitHubDelegatedReadConfig,
    observedAt: string,
  ) {
    this.#projects = projects;
    this.#config = config;
    this.connection = Object.freeze({
      id: `ghconn_installation_${config.installationId}`,
      provider: "github",
      installationId: config.installationId,
      accountLogin: config.accountLogin,
      credentialRef: config.credentialRef,
      status: "active",
      repositoryFullNames: [config.repositoryFullName],
      observedAt,
    });
  }

  async getGitHubProjectRepositoryBinding(
    project: string,
    repositoryFullName: string,
  ): Promise<GitHubProjectRepositoryBinding | null> {
    if (
      project !== this.#config.project
      || repositoryFullName !== this.#config.repositoryFullName
    ) {
      return null;
    }
    const attachment = await this.#projects.getProjectAttachment(project);
    if (!attachment) return null;
    const digest = sha256(stableJson({
      project,
      repositoryFullName,
      connectionId: this.connection.id,
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    }));
    return Object.freeze({
      id: `ghbind_${digest.slice("sha256:".length, "sha256:".length + 24)}`,
      project,
      repositoryFullName,
      connectionId: this.connection.id,
      attachmentId: attachment.id,
      attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
      status: "active",
      acceptedAt: attachment.acceptedAt,
    });
  }

  async getGitHubProviderConnection(
    id: string,
  ): Promise<GitHubProviderConnection | null> {
    return id === this.connection.id ? this.connection : null;
  }
}

class HostedDelegatedReadAuthority
  implements GitHubDelegatedReadAuthority
{
  readonly #config: HostedGitHubDelegatedReadConfig;
  readonly #enabledTools: ReadonlySet<string>;

  constructor(
    config: HostedGitHubDelegatedReadConfig,
    enabledTools: ReadonlySet<string>,
  ) {
    this.#config = config;
    this.#enabledTools = enabledTools;
  }

  async authorizeGitHubDelegatedRead(input: {
    project: string;
    repositoryFullName: string;
    tool: string;
    actorId: string;
    clientId: string;
    catalogueFingerprint: string;
    capabilityGrantId?: string;
    approvalId?: string;
  }): Promise<{ allowed: boolean }> {
    return {
      allowed:
        input.project === this.#config.project
        && input.repositoryFullName === this.#config.repositoryFullName
        && this.#enabledTools.has(input.tool),
    };
  }
}

function exactObservationTime(now: () => number): string {
  let milliseconds: number;
  try {
    milliseconds = now();
  } catch {
    throw new Error(
      "Hosted GitHub delegated reads require a valid current time",
    );
  }
  if (!Number.isFinite(milliseconds)) {
    throw new Error(
      "Hosted GitHub delegated reads require a valid current time",
    );
  }
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    throw new Error(
      "Hosted GitHub delegated reads require a valid current time",
    );
  }
}

function hostedProjectSlug(value: string): string {
  if (
    !value
    || value.length > 80
    || !/^[\x20-\x7e]+$/.test(value)
    || value !== value.trim()
    || !/^[a-z0-9][a-z0-9_-]*$/.test(value)
  ) {
    throw new RangeError("Use an exact lowercase project slug");
  }
  return value;
}

function exactAuthorityEnv(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = requiredEnv(env, key, false);
  if (value !== value.trim() || !/^[\x20-\x7e]+$/.test(value)) {
    throw new Error(
      `Hosted GitHub delegated reads require exact printable ASCII ${key}`,
    );
  }
  return value;
}

function optionalBooleanEnv(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const value = env[key];
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") return true;
  throw new Error(`${key} must be exact true or false`);
}

function requiredEnv(
  env: Record<string, string | undefined>,
  key: string,
  trim = true,
): string {
  const raw = env[key];
  const value = trim ? trimmed(raw) : raw;
  if (!value) {
    throw new Error(`Hosted GitHub delegated reads require ${key}`);
  }
  return value;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
