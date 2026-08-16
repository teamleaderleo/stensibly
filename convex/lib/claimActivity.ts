import type {
  OrchestratorActivityClass,
  OrchestratorActivityState,
} from "../../src/orchestrator-activity-observation";
import type { MutationContext } from "./domain";
import {
  persistLedgerEventActivity,
  type LedgerActivityEvent,
  type LedgerActivityItem,
} from "./ledgerEventActivity";

export type ClaimActivityItem = LedgerActivityItem;
export type ClaimActivityEvent = LedgerActivityEvent;

/**
 * Projects one already-committed canonical claim event into the durable
 * activity store inside the caller's Convex transaction.
 */
export async function persistClaimActivity(
  ctx: MutationContext,
  input: Readonly<{
    item: ClaimActivityItem;
    claimEvent: ClaimActivityEvent;
    actorExternalId: string;
    activityClass: OrchestratorActivityClass;
    activityState: OrchestratorActivityState;
    responsibilityGeneration: number;
  }>,
): Promise<void> {
  await persistLedgerEventActivity(ctx, {
    item: input.item,
    event: input.claimEvent,
    actorExternalId: input.actorExternalId,
    sourceClass: "responsibility",
    activityClass: input.activityClass,
    activityState: input.activityState,
    responsibilityGeneration: input.responsibilityGeneration,
  });
}
