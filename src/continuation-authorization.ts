import type { ContinuationLedger } from "./continuation-contracts.js";
import type { ContinuationProposal } from "./continuations.js";
import type { WorkLedger } from "./ledger.js";

export async function continuationAccessProjects(
  ledger: WorkLedger,
  continuation: ContinuationProposal,
): Promise<string[]> {
  const projects = new Set<string>();
  projects.add((await ledger.getItem(continuation.sourceItemId)).item.project);

  if (continuation.action.kind === "create_item") {
    projects.add(continuation.action.project);
  } else if (
    continuation.action.kind === "resume_item"
    || continuation.action.kind === "dispatch_item"
  ) {
    projects.add((await ledger.getItem(continuation.action.itemId)).item.project);
  }
  return [...projects].sort();
}

export async function supervisorPolicyAccessProjects(
  ledger: WorkLedger,
  continuations: ContinuationLedger,
  project?: string,
): Promise<string[]> {
  const rows = (
    await Promise.all([
      continuations.listContinuations({
        status: "proposed",
        deliveryMode: "supervisor",
      }),
      continuations.listContinuations({
        status: "deferred",
        deliveryMode: "supervisor",
      }),
    ])
  )
    .flat()
    .filter((proposal) =>
      proposal.approvalMode === "automatic" || proposal.approvalMode === "notify"
    );

  const projects = new Set<string>();
  for (const proposal of rows) {
    const sourceProject = (await ledger.getItem(proposal.sourceItemId)).item.project;
    if (project && sourceProject !== project) continue;
    for (const touched of await continuationAccessProjects(ledger, proposal)) {
      projects.add(touched);
    }
  }
  if (project) projects.add(project);
  return [...projects].sort();
}
