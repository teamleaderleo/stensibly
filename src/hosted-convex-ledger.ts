import { ConvexHttpClient } from "convex/browser";
import type { GetGitHubProjectContextInput, GitHubProjectContextLedger } from "./github-project-context.js";
import {
  ConvexGitHubProjectContextLedger,
  type AcceptHostedGitHubIssueContextInput,
} from "./github-project-context-convex-ledger.js";
import {
  ConvexProjectAttachmentLedger,
} from "./project-attachment-convex-ledger.js";
import type { ConvexWorkLedgerOptions } from "./convex-ledger.js";

export class HostedConvexLedger extends ConvexProjectAttachmentLedger
  implements GitHubProjectContextLedger {
  private readonly githubContext: ConvexGitHubProjectContextLedger;

  constructor(options: ConvexWorkLedgerOptions) {
    super(options);
    this.githubContext = new ConvexGitHubProjectContextLedger(options);
  }

  async getGitHubProjectContext(input: GetGitHubProjectContextInput) {
    return await this.githubContext.getGitHubProjectContext(input);
  }

  async acceptGitHubIssueContext(input: AcceptHostedGitHubIssueContextInput) {
    return await this.githubContext.acceptGitHubIssueContext(input);
  }
}

export function createHostedConvexLedgerFromEnv(
  env: Record<string, string | undefined> = Bun.env,
): HostedConvexLedger {
  const url = required(env.CONVEX_URL, "CONVEX_URL");
  const serviceSecret = required(
    env.STENSIBLY_SERVICE_SECRET,
    "STENSIBLY_SERVICE_SECRET",
  );
  return new HostedConvexLedger({
    client: new ConvexHttpClient(url),
    serviceSecret,
    workspace: env.STENSIBLY_WORKSPACE ?? "default",
  });
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
