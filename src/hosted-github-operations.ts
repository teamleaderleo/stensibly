import { captureDataMethod } from "./captured-data-method.js";
import { exactBooleanEnv } from "./exact-boolean-env.js";
import { GitHubAppInstallationTokenMinter } from "./github-app-installation-token.js";
import { githubOperationRedirectFetch } from "./github-operation-redirect-fetch.js";
import {
  DefaultGitHubOperationsService,
  type GitHubLandPrInput,
  type GitHubOperationsService,
  withGitHubOperationsService,
} from "./github-operations.js";
import { GitHubRestOperationsAdapter } from "./github-rest-operations-adapter.js";
import { HostedGitHubAttachmentBindingStore } from "./hosted-github-attachment-binding.js";
import type { HostedGitHubDelegatedReadProvider } from "./hosted-github-delegated-read-provider.js";
import type { WorkLedger } from "./ledger.js";
import { operationWorkflowStore } from "./operation-workflow-contracts.js";
import { projectAttachmentLedger } from "./project-attachment-ledger.js";
import { runnerLedger } from "./runner-contracts.js";

export interface HostedGitHubOperationsOverrides {
  fetch?: typeof fetch;
  now?: () => number;
}

export function mountHostedGitHubOperationsFromEnv<
  T extends WorkLedger & Partial<HostedGitHubDelegatedReadProvider>,
>(
  ledger: T,
  env: Record<string, string | undefined>,
  overrides: HostedGitHubOperationsOverrides = {},
): T & Partial<GitHubOperationsService> {
  const config = configuration(env);
  if (!config) return ledger;
  const callDelegated = captureDataMethod(ledger, "callGitHubDelegatedRead");
  const projects = projectAttachmentLedger(ledger);
  const workflows = operationWorkflowStore(ledger);
  if (!callDelegated || !projects || !workflows) {
    throw new Error("Hosted GitHub operations require delegated reads, attachments, and durable workflows");
  }
  const now = overrides.now ?? Date.now;
  const bindings = new HostedGitHubAttachmentBindingStore(
    projects,
    config,
    new Date(now()).toISOString(),
  );
  const tokens = new GitHubAppInstallationTokenMinter({
    appId: config.appId,
    installationId: config.installationId,
    accountLogin: config.accountLogin,
    privateKeyPem: config.privateKeyPem,
    authorizeRepository: (repositoryFullName) => bindings.authorizesRepository(repositoryFullName),
    apiBaseUrl: config.apiBaseUrl,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    now,
  });
  const operationFetch = githubOperationRedirectFetch(overrides.fetch);
  const service = new DefaultGitHubOperationsService({
    delegated: (input) => Reflect.apply(callDelegated, ledger, [input]) as ReturnType<
      NonNullable<HostedGitHubDelegatedReadProvider["callGitHubDelegatedRead"]>
    >,
    provider: new GitHubRestOperationsAdapter({
      tokenProvider: tokens,
      apiBaseUrl: config.apiBaseUrl,
      fetch: operationFetch,
      now,
    }),
    workflows,
    assertAuthority: (input) => assertAuthority(ledger, input, now),
    now: () => new Date(now()).toISOString(),
  });
  const healthLedger = withHostedGitHubRepoHealth(ledger, service);
  return config.publicationWritesEnabled
    ? withGitHubOperationsService(healthLedger, service)
    : healthLedger;
}

function withHostedGitHubRepoHealth<T extends WorkLedger>(
  ledger: T,
  service: Pick<GitHubOperationsService, "githubRepoHealth">,
): T & Pick<GitHubOperationsService, "githubRepoHealth"> {
  const decorated = Object.create(ledger) as T & Pick<GitHubOperationsService, "githubRepoHealth">;
  Object.defineProperty(decorated, "githubRepoHealth", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: service.githubRepoHealth.bind(service),
  });
  return decorated;
}

async function assertAuthority(
  ledger: WorkLedger,
  input: GitHubLandPrInput,
  now: () => number,
): Promise<void> {
  const runs = runnerLedger(ledger);
  const projects = projectAttachmentLedger(ledger);
  if (!runs || !projects) throw new Error("Hosted GitHub operations require runner and attachment ledgers");
  const attachment = await projects.getProjectAttachment(input.project);
  const run = await runs.getRun(input.runId);
  const item = await ledger.getItem(input.itemId);
  const match = /^run:(.+):generation:(\d+)$/u.exec(input.authorityFence.resource);
  const expectedRunGeneration = match ? Number(match[2]) : Number.NaN;
  const currentLeaseExpiry = run.leaseExpiresAt === null ? Number.NaN : Date.parse(run.leaseExpiresAt);
  const fencedLeaseExpiry = Date.parse(input.authorityFence.expiresAt);
  if (
    !attachment
    || attachment.snapshot.contract.project !== input.project
    || !attachment.snapshot.contract.autonomousActions.includes("merge")
    || !match || match[1] !== input.runId || run.itemId !== input.itemId
    || item.item.project !== input.project || run.generation !== expectedRunGeneration
    || run.leaseGeneration !== input.authorityFence.generation
    || run.leaseOwnerId !== input.actorId || !Number.isFinite(currentLeaseExpiry)
    || currentLeaseExpiry < fencedLeaseExpiry
    || (run.status !== "starting" && run.status !== "running")
    || currentLeaseExpiry <= now()
  ) throw new Error("Hosted GitHub operation runner authority is stale or mismatched");
}

function configuration(env: Record<string, string | undefined>) {
  if (!exactBooleanEnv(env, "STENSIBLY_GITHUB_DELEGATED_READS_ENABLED")) return null;
  const project = required(env, "STENSIBLY_GITHUB_PROVIDER_PROJECT");
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(project)) throw new Error("Hosted GitHub operations project is invalid");
  return {
    project,
    appId: required(env, "STENSIBLY_GITHUB_APP_ID"),
    installationId: required(env, "STENSIBLY_GITHUB_INSTALLATION_ID"),
    accountLogin: required(env, "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN").toLowerCase(),
    privateKeyPem: required(env, "STENSIBLY_GITHUB_APP_PRIVATE_KEY", false),
    apiBaseUrl: env.STENSIBLY_GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
    credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    publicationWritesEnabled: exactBooleanEnv(env, "STENSIBLY_GITHUB_PUBLICATION_WRITES_ENABLED"),
  };
}

function required(env: Record<string, string | undefined>, key: string, trim = true): string {
  const raw = env[key];
  const value = trim ? raw?.trim() : raw;
  if (!value) throw new Error(`Hosted GitHub operations require ${key}`);
  return value;
}
