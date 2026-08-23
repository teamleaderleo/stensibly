import {
  ConvexGitHubRepositoryObservationService,
} from "./github-repository-observation-convex.js";
import { GitHubMailPublicObservationConsumer } from "./github-mail-public-observation-consumer.js";
import {
  GitHubPublicEventsClient,
  GitHubPublicEventsProviderError,
} from "./github-public-events-client.js";
import { sharedGitHubPublicEventsPollState } from "./github-public-events-memory-state.js";
import { GitHubPublicRepositoryObserver } from "./github-public-repository-observer.js";
import {
  createHostedGitHubMailRuntimeFromEnv,
  type HostedGitHubMailWorkerEnvironment,
} from "./hosted-github-mail-worker.js";

export interface HostedGitHubPublicRepositoryWorkerEnvironment
extends HostedGitHubMailWorkerEnvironment {
  STENSIBLY_GITHUB_PUBLIC_EVENTS_FALLBACK_ENABLED?: string;
}

export type HostedGitHubPublicRepositoryObserver = GitHubPublicRepositoryObserver<unknown>;

export function hostedGitHubPublicRepositoryFallbackEnabled(
  env: HostedGitHubPublicRepositoryWorkerEnvironment,
): boolean {
  const value = env.STENSIBLY_GITHUB_PUBLIC_EVENTS_FALLBACK_ENABLED;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(
    "STENSIBLY_GITHUB_PUBLIC_EVENTS_FALLBACK_ENABLED must be true or false",
  );
}

export function createHostedGitHubPublicRepositoryObserverFromEnv(
  env: HostedGitHubPublicRepositoryWorkerEnvironment,
): HostedGitHubPublicRepositoryObserver | undefined {
  if (!hostedGitHubPublicRepositoryFallbackEnabled(env)) return undefined;
  const runtime = createHostedGitHubMailRuntimeFromEnv(env);
  if (!runtime) {
    throw new Error(
      "GitHub public repository fallback requires the hosted GitHub mail mapping",
    );
  }
  const ledger = new ConvexGitHubRepositoryObservationService({
    client: runtime.client,
    serviceSecret: runtime.serviceSecret,
    workspace: runtime.workspace,
  });
  const mail = new GitHubMailPublicObservationConsumer({
    store: runtime.store,
    publisher: runtime.publisher,
    workspace: runtime.workspace,
    project: runtime.project,
    repository: runtime.repository,
    publicProjectCode: runtime.publicProjectCode,
  });
  const client = new GitHubPublicEventsClient({
    repository: runtime.repository,
    stateStore: sharedGitHubPublicEventsPollState,
  });
  return new GitHubPublicRepositoryObserver({
    repository: runtime.repository,
    client,
    ledger,
    mail,
  });
}

export async function runHostedGitHubPublicRepositoryReconciliation(
  env: HostedGitHubPublicRepositoryWorkerEnvironment,
): Promise<void> {
  const observer = createHostedGitHubPublicRepositoryObserverFromEnv(env);
  if (!observer) return;
  try {
    const result = await observer.reconcile();
    console.log(JSON.stringify({
      event: "github.public_repository_reconciled",
      repository: result.repository,
      status: result.status,
      fetchedEvents: result.fetchedEvents,
      supportedEvents: result.supportedEvents,
      persistedEvents: result.persistedEvents,
      replayedEvents: result.replayedEvents,
      crossSourceSuppressed: result.crossSourceSuppressed,
      published: result.published,
      quiet: result.quiet,
      ignored: result.ignored,
    }));
  } catch (error) {
    if (error instanceof GitHubPublicEventsProviderError) {
      console.log(JSON.stringify({
        event: "github.public_repository_provider_unavailable",
        status: error.status,
      }));
      return;
    }
    throw error;
  }
}
