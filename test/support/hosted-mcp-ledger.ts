import {
  hostedGitHubDelegatedReadJobDetailTools,
  type HostedGitHubDelegatedReadInput,
  type HostedGitHubDelegatedReadProvider,
} from "../../src/hosted-github-delegated-read-provider.ts";
import type { WorkLedger } from "../../src/ledger.ts";
import type {
  WorkerEnrolmentProvider,
  WorkerEnrolmentProviderInput,
} from "../../src/worker-enrolment-mcp.ts";

export function withHostedGitHubDelegatedReadProvider<T extends WorkLedger>(
  ledger: T,
): T & HostedGitHubDelegatedReadProvider {
  return Object.assign(ledger, {
    delegatedGitHubReadTools: hostedGitHubDelegatedReadJobDetailTools,
    callGitHubDelegatedRead(_input: HostedGitHubDelegatedReadInput) {
      throw new Error("Hosted contract fixture must not dispatch GitHub reads");
    },
  });
}

export function withHostedWorkerEnrolmentProvider<T extends WorkLedger>(
  ledger: T,
): T & WorkerEnrolmentProvider {
  return Object.assign(ledger, {
    enrolWorker(_input: WorkerEnrolmentProviderInput): Promise<unknown> {
      throw new Error("Hosted contract fixture must not enrol workers");
    },
  });
}

export function withHostedMcpProviders<T extends WorkLedger>(
  ledger: T,
): T & HostedGitHubDelegatedReadProvider & WorkerEnrolmentProvider {
  return withHostedWorkerEnrolmentProvider(
    withHostedGitHubDelegatedReadProvider(ledger),
  );
}
