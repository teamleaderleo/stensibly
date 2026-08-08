import {
  hostedGitHubDelegatedReadJobDetailTools,
  type HostedGitHubDelegatedReadInput,
  type HostedGitHubDelegatedReadProvider,
} from "../../src/hosted-github-delegated-read-provider.ts";
import type { WorkLedger } from "../../src/ledger.ts";

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
