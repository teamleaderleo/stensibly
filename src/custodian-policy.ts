import { inspectScrapbook, type CustodianReport } from "./custodian-report.js";
import {
  expireClaims,
  type ExpireClaimsOptions,
  type ExpectedExpiredClaim,
} from "./leases.js";
import { StensiblyStore } from "./store.js";

export const CUSTODIAN_POLICY_ID = "conservative-custodian";
export const CUSTODIAN_POLICY_VERSION = "2026-07-26.v2";

export type CustodianMode = "observe" | "dry-run" | "apply";
export type CustodianActionStatus = "reported" | "planned" | "applied" | "skipped";

export interface CustodianPolicy {
  id: string;
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
  previousClaimant: string;
  claimExpiredAt: string;
  expectedClaimGeneration: number;
  expectedVersion: number;
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

export interface CustodianPolicyDependencies {
  expireClaims: (
    store: StensiblyStore,
    now: Date,
    options: ExpireClaimsOptions,
  ) => string[];
}

const defaultDependencies: CustodianPolicyDependencies = { expireClaims };

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
  dependencies: CustodianPolicyDependencies = defaultDependencies,
): CustodianPolicyResult {
  const mode = options.mode ?? "observe";
  if (!( ["observe", "dry-run", "apply"] as const).includes(mode)) {
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
    id: CUSTODIAN_POLICY_ID,
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
  const actions = mode === "observe"
    ? eligible.map((item) => toAction(item, "reported", null))
    : executeBoundedMode(store, eligible, policy, now, options.project, dependencies);

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

function executeBoundedMode(
  store: StensiblyStore,
  eligible: CustodianReport["expiredClaims"],
  policy: CustodianPolicy,
  now: Date,
  project: string | undefined,
  dependencies: CustodianPolicyDependencies,
): CustodianAction[] {
  const allowed = eligible.slice(0, policy.maxActions);
  const overflow = eligible.slice(policy.maxActions);
  const appliedIds = policy.mode === "apply" && allowed.length > 0
    ? new Set(dependencies.expireClaims(store, now, {
        ...(project ? { project } : {}),
        limit: policy.maxActions,
        expectedClaims: allowed.map(toExpectedClaim),
        audit: {
          source: "custodian",
          policy: policy.id,
          policyVersion: policy.version,
          mode: policy.mode,
        },
      }))
    : new Set<string>();

  const actions: CustodianAction[] = [];
  for (const item of allowed) {
    if (policy.mode === "dry-run") {
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
  return actions;
}

function toExpectedClaim(
  item: CustodianReport["expiredClaims"][number],
): ExpectedExpiredClaim {
  if (!item.claimedBy || !item.claimExpiresAt) {
    throw new Error(`Expired claim ${item.id} lacks an exact claim snapshot`);
  }
  return {
    id: item.id,
    project: item.project,
    claimedBy: item.claimedBy,
    claimExpiresAt: item.claimExpiresAt,
    claimGeneration: item.claimGeneration,
    version: item.version,
  };
}

function toAction(
  item: CustodianReport["expiredClaims"][number],
  status: CustodianActionStatus,
  durableEvent: "claim.expired" | null,
): CustodianAction {
  const expected = toExpectedClaim(item);
  return {
    kind: "expire_claim",
    itemId: item.id,
    project: item.project,
    status,
    rationale: "The stored claim expiry has elapsed; the custodian can return the item to ready while leaving every semantic work decision with its authorised owner.",
    previousClaimant: expected.claimedBy,
    claimExpiredAt: expected.claimExpiresAt,
    expectedClaimGeneration: expected.claimGeneration,
    expectedVersion: expected.version,
    durableEvent,
  };
}
