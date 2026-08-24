import { exactBooleanEnv } from "./exact-boolean-env.js";
import { GitHubAppInstallationTokenMinter } from "./github-app-installation-token.js";
import type { PreparedGitHubWebhookDelivery } from "./github-webhook-ingress.js";
import { normalizeGitHubRepository } from "./github-provider-validation.js";
import { receiverSafeFetch } from "./fetch-implementation.js";

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
  apiBaseUrl: string;
  appId: string;
  installationId: string;
  accountLogin: string;
  privateKeyPem: string;
}

const fullRevisionPattern = /^[a-f0-9]{40}$/u;
const branchPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,253}[A-Za-z0-9._-])?$/u;
const githubApiVersion = "2022-11-28";

export function createHostedDeployGovernorConsumerFromEnv(
  env: Record<string, string | undefined>,
  overrides: HostedDeployGovernorOverrides = {},
): HostedDeployGovernorWebhookConsumer | undefined {
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
    consume: async (delivery: PreparedGitHubWebhookDelivery) => {
      const candidate = deployCandidate(delivery);
      if (!candidate) return Object.freeze({ status: "ignored" as const });

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
              delivery_id: delivery.deliveryId,
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

function deployCandidate(
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
  if (!branchPattern.test(branch)) return null;
  return Object.freeze({
    repository: normalizeGitHubRepository(observation.repository),
    branch,
    sha,
  });
}

function configuration(
  env: Record<string, string | undefined>,
): HostedDeployGovernorConfiguration {
  const targetRepository = normalizeGitHubRepository(
    required(env, "STENSIBLY_DEPLOY_GOVERNOR_REPOSITORY"),
  ).toLowerCase();
  return {
    targetRepository,
    apiBaseUrl: apiBaseUrl(env.STENSIBLY_GITHUB_API_BASE_URL),
    appId: required(env, "STENSIBLY_GITHUB_APP_ID"),
    installationId: required(env, "STENSIBLY_GITHUB_INSTALLATION_ID"),
    accountLogin: required(env, "STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN").toLowerCase(),
    privateKeyPem: required(env, "STENSIBLY_GITHUB_APP_PRIVATE_KEY", false),
  };
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
