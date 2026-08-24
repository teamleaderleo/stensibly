import { createGitHubWebhookIngress } from "./github-webhook-ingress.js";
import {
  createHostedDeployGovernorConsumerFromEnv,
  type HostedDeployGovernorOverrides,
} from "./hosted-deploy-governor-worker.js";

export interface HostedDeployGovernorRequestConsumer {
  consume(request: Request): Promise<Readonly<{ status: "ignored" | "dispatched" }>>;
}

export function createHostedDeployGovernorRequestConsumerFromEnv(
  env: Record<string, string | undefined>,
  overrides: HostedDeployGovernorOverrides = {},
): HostedDeployGovernorRequestConsumer | undefined {
  const consumer = createHostedDeployGovernorConsumerFromEnv(env, overrides);
  if (!consumer) return undefined;
  const secret = env.STENSIBLY_GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("Hosted deploy governor requires STENSIBLY_GITHUB_WEBHOOK_SECRET");
  }
  const ingress = createGitHubWebhookIngress({
    secret,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return Object.freeze({
    consume: async (request: Request) => consumer.consume(await ingress(request)),
  });
}
