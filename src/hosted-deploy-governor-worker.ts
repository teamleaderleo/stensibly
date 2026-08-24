import { exactBooleanEnv } from "./exact-boolean-env.js";
import { GitHubAppInstallationTokenMinter } from "./github-app-installation-token.js";
import type { PreparedGitHubWebhookDelivery } from "./github-webhook-ingress.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { receiverSafeFetch } from "./fetch-implementation.js";

export interface HostedDeployCandidate {
  readonly repository: string;
  readonly branch: string;
  readonly sha: string;
  readonly deliveryId: string;
}

export interface HostedDeployGovernorDispatcher {
  dispatch(
    candidate: HostedDeployCandidate,
  ): Promise<Readonly<{ status: "ignored" | "dispatched" }>>;
}

export interface HostedDeployGovernorWebhookConsumer {
  consume(
    delivery: PreparedGitHubWebhookDelivery,
  ): Promise<Readonly<{ status: "ignored" | "dispatched" }>>;
}

export interface HostedDeployGovernorOverrides {
  fetch?: typeof fetch;
  now?: () => number;
}

interface HostedDeployGovernorConfiguration {
  targetRepository: string;
  sourceRepositories: ReadonlySet<string>;
  apiBaseUrl: string;
  appId: string;
  installationId: string;
  accountLogin: string;
  privateKeyPem: string;
}

const fullRevisionPattern = /^[a-f0-9]{40}$/u;
const githubApiVersion = "2022-11-28";
const deploySignalWorkflowName = "Production deploy signal";

export function createHostedDeployGovernorDispatcherFromEnv(
  env: Record<string, string | undefined>,
  overrides: HostedDeployGovernorOverrides = {},
): HostedDeployGovernorDispatcher | undefined {
  if (!exactBooleanEnv(env, "STENSIBLY_DEPLOY_GOVERNOR_ENABLED")) return undefined;
  const config = configuration(env);
  const fetchImpl = receiverSafeFetch(overrides.fetch);
  const tokens = new GitHubAppInstallationTokenMinter({
    appId: config.appId,
    installationId: config.installationId,
    accountLogin: config.accountLogin,
    privateKeyPem: config.privateKeyPem,
    repositoryFullNames: [config.targetRepository],
    apiBaseUrl: config.apiBaseUrl,
    fetch: fetchImpl,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  return Object.freeze({
    dispatch: async (candidateInput: HostedDeployCandidate) => {
      const candidate = normalizeCandidate(candidateInput);
      if (!config.sourceRepositories.has(candidate.repository.toLowerCase())) {
        return Object.freeze({ status: "ignored" as const });
      }

      const credential = await tokens.getInstallationToken({
        repositoryFullName: config.targetRepository,
        permission: { name: "contents", access: "write" },
      });
      const response = await fetchImpl(
        `${config.apiBaseUrl}/repos/${config.targetRepository}/dispatches`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": "application/json",
            "User-Agent": "stensibly",
            "X-GitHub-Api-Version": githubApiVersion,
          },
          body: JSON.stringify({
            event_type: "vercel-deploy-candidate",
            client_payload: {
              repository: candidate.repository,
              branch: candidate.branch,
              sha: candidate.sha,
              delivery_id: candidate.deliveryId,
            },
          }),
        },
      );
      if (response.status !== 204) {
        try {
          await response.body?.cancel();
        } catch {
          // Provider body disposal does not change the fixed dispatch failure.
        }
        throw new Error(`Deploy governor dispatch failed with GitHub status ${response.status}`);
      }
      return Object.freeze({ status: "dispatched" as const });
    },
  });
}

export function createHostedDeployGovernorConsumerFromEnv(
  env: Record<string, string | undefined>,
  overrides: HostedDeployGovernorOverrides = {},
): HostedDeployGovernorWebhookConsumer | undefined {
  const dispatcher = createHostedDeployGovernorDispatcherFromEnv(env, overrides);
  if (!dispatcher) return undefined;
  return Object.freeze({
    consume: async (delivery: PreparedGitHubWebhookDelivery) => {
      const candidate = deployCandidate(delivery);
      if (!candidate) return Object.freeze({ status: "ignored" as const });
      return dispatcher.dispatch({ ...candidate, deliveryId: delivery.deliveryId });
    },
  });
}

function deployCandidate(
  delivery: PreparedGitHubWebhookDelivery,
): Readonly<{ repository: string; branch: string; sha: string }> | null {
  const pushCandidate = deployCandidateFromPush(delivery);
  if (pushCandidate) return pushCandidate;
  return deployCandidateFromWorkflowRun(delivery);
}

function deployCandidateFromPush(
  delivery: PreparedGitHubWebhookDelivery,
): Readonly<{ repository: string; branch: string; sha: string }> | null {
  const observation = delivery.observation;
  if (!observation || observation.eventType !== "push" || observation.action !== "pushed") {
    return null;
  }
  const ref = observation.relationships.ref;
  const sha = observation.relationships.revision;
  if (!ref?.startsWith("refs/heads/") || !sha || !fullRevisionPattern.test(sha)) {
    return null;
  }
  const branch = ref.slice("refs/heads/".length);
  if (!validBranch(branch)) return null;
  return Object.freeze({
    repository: normalizeGitHubRepository(observation.repository),
    branch,
    sha,
  });
}

function deployCandidateFromWorkflowRun(
  delivery: PreparedGitHubWebhookDelivery,
): Readonly<{ repository: string; branch: string; sha: string }> | null {
  if (delivery.eventType !== "workflow_run") return null;
  const payload = record(delivery.payload);
  if (!payload || payload.action !== "completed") return null;

  const repository = record(payload.repository);
  const workflowRun = record(payload.workflow_run);
  if (
    !repository
    || !workflowRun
    || workflowRun.name !== deploySignalWorkflowName
    || workflowRun.status !== "completed"
    || workflowRun.conclusion !== "success"
    || workflowRun.event !== "push"
    || typeof repository.full_name !== "string"
    || typeof workflowRun.head_branch !== "string"
    || typeof workflowRun.head_sha !== "string"
  ) {
    return null;
  }

  const branch = workflowRun.head_branch;
  const sha = workflowRun.head_sha;
  if (!validBranch(branch) || !fullRevisionPattern.test(sha)) return null;
  return Object.freeze({
    repository: normalizeGitHubRepository(repository.full_name),
    branch,
    sha,
  });
}

function normalizeCandidate(candidate: HostedDeployCandidate): HostedDeployCandidate {
  const repository = normalizeGitHubRepository(candidate.repository);
  const branch = candidate.branch;
  const sha = candidate.sha;
  const deliveryId = candidate.deliveryId;
  if (!validBranch(branch) || !fullRevisionPattern.test(sha)) {
    throw new Error("Deploy governor candidate is invalid");
  }
  if (
    typeof deliveryId !== "string"
    || deliveryId.length < 1
    || deliveryId.length > 1024
    || /[\u0000-\u001f\u007f-\u009f]/u.test(deliveryId)
  ) {
    throw new Error("Deploy governor delivery identity is invalid");
  }
  return Object.freeze({ repository, branch, sha, deliveryId });
}

function validBranch(branch: string): boolean {
  return typeof branch === "string"
    && Boolean(branch)
    && branch.length <= 255
    && !branch.includes("|");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function configuration(
  env: Record<string, string | undefined>,
): HostedDeployGovernorConfiguration {
  const targetRepository = normalizeGitHubRepository(
    required(env, "STENSIBLY_DEPLOY_GOVERNOR_REPOSITORY"),
  ).toLowerCase();
  const sourceRepositories = repositorySet(
    required(env, "STENSIBLY_DEPLOY_GOVERNOR_REPOSITORIES"),
  );
  return {
    targetRepository,
    sourceRepositories,
    apiBaseUrl: apiBaseUrl(env.STENSIBLY_GITHUB_API_BASE_URL),
    appId: required(env, "STENSIBLY_GITHUB_APP_ID"),
    installationId: required(env, "STENSIBLY_GITHUB_INSTALLATION_ID"),
    accountLogin: required(env, "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN").toLowerCase(),
    privateKeyPem: required(env, "STENSIBLY_GITHUB_APP_PRIVATE_KEY", false),
  };
}

function repositorySet(value: string): ReadonlySet<string> {
  const repositories = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalizeGitHubRepository(entry).toLowerCase());
  if (repositories.length === 0) {
    throw new Error("Hosted deploy governor requires at least one source repository");
  }
  return new Set(repositories);
}

function apiBaseUrl(value: string | undefined): string {
  const url = new URL(value?.trim() || "https://api.github.com");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("Deploy governor GitHub API base URL must use HTTPS");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function required(
  env: Record<string, string | undefined>,
  key: string,
  trim = true,
): string {
  const raw = env[key];
  const value = trim ? raw?.trim() : raw;
  if (!value) throw new Error(`Hosted deploy governor requires ${key}`);
  return value;
}
