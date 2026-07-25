import { inspectScrapbook, type CustodianReport } from "./custodian-report.js";
import { expireClaimIds } from "./leases.js";
import { StensiblyStore } from "./store.js";

export const CUSTODIAN_POLICY_VERSION = "2026-07-25.v1";

export type CustodianMode = "observe" | "dry-run" | "apply";
export type CustodianActionStatus = "reported" | "planned" | "applied" | "skipped";

export interface CustodianPolicy {
  version: string;
  mode: CustodianMode;
  maxActions: number;
  rules: {
    expiredClaim: "reconcile";
    expiringClaim: "notify";
    missingNextAction: "report";
    staleReady: "report";
    staleBlocked: "report";
    duplicateTitle: "report";
  };
  semanticTransitions: "disabled";
}

export interface CustodianAction {
  kind: "expire_claim";
  itemId: string;
  project: string;
  status: CustodianActionStatus;
  rationale: string;
  previousClaimant: string | null;
  claimExpiredAt: string | null;
  durableEvent: "claim.expired" | null;
  reason?: "action_limit" | "state_changed";
}

export interface CustodianPolicyResult {
  generatedAt: string;
  policy: CustodianPolicy;
  report: CustodianReport;
  actionSummary: {
    eligible: number;
    reported: number;
    planned: number;
    applied: number;
    skipped: number;
  };
  actions: CustodianAction[];
}

export function runCustodianPolicy(
  store: StensiblyStore,
  options: {
    mode?: CustodianMode;
    project?: string;
    staleDays?: number;
    expiringWithinMinutes?: number;
    maxActions?: number;
    now?: Date;
  } = {},
): CustodianPolicyResult {
  const mode = options.mode ?? "observe";
  if (!(["observe", "dry-run", "apply"] as const).includes(mode)) {
    throw new RangeError("mode must be observe, dry-run, or apply");
  }
  const maxActions = options.maxActions ?? 100;
  if (!Number.isInteger(maxActions) || maxActions < 0 || maxActions > 10_000) {
    throw new RangeError("maxActions must be a whole number between 0 and 10000");
  }
  const now = options.now ?? new Date();
  const report = inspectScrapbook(store, {
    ...(options.project ? { project: options.project } : {}),
    ...(options.staleDays === undefined ? {} : { staleDays: options.staleDays }),
    ...(options.expiringWithinMinutes === undefined
      ? {}
      : { expiringWithinMinutes: options.expiringWithinMinutes }),
    now,
  });
  const policy: CustodianPolicy = {
    version: CUSTODIAN_POLICY_VERSION,
    mode,
    maxActions,
    rules: {
      expiredClaim: "reconcile",
      expiringClaim: "notify",
      missingNextAction: "report",
      staleReady: "report",
      staleBlocked: "report",
      duplicateTitle: "report",
    },
    semanticTransitions: "disabled",
  };

  const eligible = report.expiredClaims;
  const allowed = eligible.slice(0, maxActions);
  const overflow = eligible.slice(maxActions);
  const appliedIds = mode === "apply"
    ? new Set(expireClaimIds(
        store,
        allowed.map((item) => item.id),
        now,
        { source: "custodian", policyVersion: policy.version, mode },
      ))
    : new Set<string>();

  const actions: CustodianAction[] = [];
  for (const item of allowed) {
    if (mode === "observe") {
      actions.push(toAction(item, "reported", null));
    } else if (mode === "dry-run") {
      actions.push(toAction(item, "planned", null));
    } else if (appliedIds.has(item.id)) {
      actions.push(toAction(item, "applied", "claim.expired"));
    } else {
      actions.push({ ...toAction(item, "skipped", null), reason: "state_changed" });
    }
  }
  for (const item of overflow) {
    actions.push({ ...toAction(item, "skipped", null), reason: "action_limit" });
  }

  return {
    generatedAt: now.toISOString(),
    policy,
    report,
    actionSummary: {
      eligible: eligible.length,
      reported: actions.filter((action) => action.status === "reported").length,
      planned: actions.filter((action) => action.status === "planned").length,
      applied: actions.filter((action) => action.status === "applied").length,
      skipped: actions.filter((action) => action.status === "skipped").length,
    },
    actions,
  };
}

function toAction(
  item: CustodianReport["expiredClaims"][number],
  status: CustodianActionStatus,
  durableEvent: "claim.expired" | null,
): CustodianAction {
  return {
    kind: "expire_claim",
    itemId: item.id,
    project: item.project,
    status,
    rationale: "The server-reported claim expiry has elapsed; returning the item to ready is invariant reconciliation, not a semantic work decision.",
    previousClaimant: item.claimedBy,
    claimExpiredAt: item.claimExpiresAt,
    durableEvent,
  };
}
