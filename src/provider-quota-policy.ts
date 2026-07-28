export const providerPressureBands = [
  "open",
  "metered",
  "queued",
  "reserve_only",
  "closed",
] as const;

export const providerRequestClasses = [
  "preview",
  "production",
  "rollback",
  "incident",
  "operator",
] as const;

export const providerAdmissionActions = [
  "admit",
  "queue",
  "defer",
  "coalesce",
  "hold",
] as const;

export type ProviderPressureBand = (typeof providerPressureBands)[number];
export type ProviderRequestClass = (typeof providerRequestClasses)[number];
export type ProviderAdmissionAction = (typeof providerAdmissionActions)[number];
export type ProviderSnapshotFreshness = "fresh" | "stale" | "missing";

export interface ProviderQuotaPolicy {
  provider: string;
  accountBoundary: string;
  rollingWindowSeconds: number;
  meteredAt: number;
  queuedAt: number;
  reserveOnlyAt: number;
  hardLimit: number;
  maxSnapshotAgeSeconds: number;
}

export interface ProviderQuotaSnapshot {
  observedUnits: number;
  activeReservationUnits: number;
  unreconciledStartedUnits: number;
  uncertaintyUnits: number;
  recentStartsLastHour: number;
  expiringNextHourUnits: number;
  observedAt: string | null;
  evaluatedAt: string;
  nextCapacityAt?: string | null;
}

export interface ProviderQuotaRequest {
  requestClass: ProviderRequestClass;
  units: number;
  ready: boolean;
  equivalentActiveRequest: boolean;
}

export interface ProviderQuotaAdmission {
  provider: string;
  accountBoundary: string;
  pressureBand: ProviderPressureBand;
  snapshotFreshness: ProviderSnapshotFreshness;
  action: ProviderAdmissionAction;
  reason:
    | "immediate_capacity_available"
    | "preview_metered"
    | "routine_queue_required"
    | "protected_reserve"
    | "hard_limit_reached"
    | "insufficient_headroom"
    | "equivalent_request_active"
    | "request_not_ready";
  observedUnits: number;
  committedUnits: number;
  effectiveUnits: number;
  forecastUnits: number;
  pressureUnits: number;
  remainingUnits: number;
  requestedUnits: number;
  projectedUnitsAfterAdmission: number;
  requiresLease: boolean;
  nextCapacityAt: string | null;
}

const boundedTextPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function createDefaultVercelQuotaPolicy(accountBoundary: string): ProviderQuotaPolicy {
  return parseProviderQuotaPolicy({
    provider: "vercel",
    accountBoundary,
    rollingWindowSeconds: 24 * 60 * 60,
    meteredAt: 50,
    queuedAt: 75,
    reserveOnlyAt: 90,
    hardLimit: 100,
    maxSnapshotAgeSeconds: 15 * 60,
  });
}

export function parseProviderQuotaPolicy(value: ProviderQuotaPolicy): ProviderQuotaPolicy {
  const provider = boundedText(value.provider, "Provider");
  const accountBoundary = boundedText(value.accountBoundary, "Account boundary");
  const rollingWindowSeconds = positiveInteger(
    value.rollingWindowSeconds,
    "Rolling window seconds",
  );
  const meteredAt = nonNegativeInteger(value.meteredAt, "Metered threshold");
  const queuedAt = positiveInteger(value.queuedAt, "Queued threshold");
  const reserveOnlyAt = positiveInteger(value.reserveOnlyAt, "Reserve-only threshold");
  const hardLimit = positiveInteger(value.hardLimit, "Hard limit");
  const maxSnapshotAgeSeconds = positiveInteger(
    value.maxSnapshotAgeSeconds,
    "Maximum snapshot age seconds",
  );

  if (!(meteredAt < queuedAt && queuedAt < reserveOnlyAt && reserveOnlyAt < hardLimit)) {
    throw new RangeError(
      "Provider quota thresholds must satisfy meteredAt < queuedAt < reserveOnlyAt < hardLimit",
    );
  }

  return {
    provider,
    accountBoundary,
    rollingWindowSeconds,
    meteredAt,
    queuedAt,
    reserveOnlyAt,
    hardLimit,
    maxSnapshotAgeSeconds,
  };
}

export function evaluateProviderQuotaAdmission(
  rawPolicy: ProviderQuotaPolicy,
  rawSnapshot: ProviderQuotaSnapshot,
  rawRequest: ProviderQuotaRequest,
): ProviderQuotaAdmission {
  const policy = parseProviderQuotaPolicy(rawPolicy);
  const snapshot = parseSnapshot(rawSnapshot);
  const request = parseRequest(rawRequest);

  const committedUnits = snapshot.activeReservationUnits + snapshot.unreconciledStartedUnits;
  const effectiveUnits = clampToSafeInteger(
    snapshot.observedUnits + committedUnits + snapshot.uncertaintyUnits,
    "Effective units",
  );
  const forecastUnits = clampToSafeInteger(
    Math.max(
      effectiveUnits,
      effectiveUnits - snapshot.expiringNextHourUnits + snapshot.recentStartsLastHour,
    ),
    "Forecast units",
  );
  const snapshotFreshness = classifySnapshotFreshness(
    snapshot.observedAt,
    snapshot.evaluatedAt,
    policy.maxSnapshotAgeSeconds,
  );
  const rawPressureBand = classifyPressureBand(forecastUnits, policy);
  const pressureBand = applyFreshnessFloor(rawPressureBand, snapshotFreshness);
  const pressureUnits = Math.max(forecastUnits, minimumUnitsForBand(pressureBand, policy));
  const remainingUnits = Math.max(0, policy.hardLimit - effectiveUnits);
  const projectedUnitsAfterAdmission = clampToSafeInteger(
    effectiveUnits + request.units,
    "Projected units after admission",
  );

  const base = {
    provider: policy.provider,
    accountBoundary: policy.accountBoundary,
    pressureBand,
    snapshotFreshness,
    observedUnits: snapshot.observedUnits,
    committedUnits,
    effectiveUnits,
    forecastUnits,
    pressureUnits,
    remainingUnits,
    requestedUnits: request.units,
    projectedUnitsAfterAdmission,
    nextCapacityAt: snapshot.nextCapacityAt ?? null,
  };

  if (!request.ready) {
    return decision(base, "hold", "request_not_ready");
  }
  if (request.equivalentActiveRequest) {
    return decision(base, "coalesce", "equivalent_request_active");
  }
  if (effectiveUnits >= policy.hardLimit || pressureBand === "closed") {
    return decision(base, "defer", "hard_limit_reached");
  }
  if (request.units > remainingUnits) {
    return decision(base, "defer", "insufficient_headroom");
  }

  if (pressureBand === "open") {
    return decision(base, "admit", "immediate_capacity_available");
  }

  if (pressureBand === "metered") {
    return request.requestClass === "preview"
      ? decision(base, "queue", "preview_metered")
      : decision(base, "admit", "immediate_capacity_available");
  }

  if (pressureBand === "queued") {
    return isPriorityBypass(request.requestClass)
      ? decision(base, "admit", "immediate_capacity_available")
      : decision(base, "queue", "routine_queue_required");
  }

  if (pressureBand === "reserve_only") {
    return isPriorityBypass(request.requestClass)
      ? decision(base, "admit", "immediate_capacity_available")
      : decision(base, "queue", "protected_reserve");
  }

  return decision(base, "defer", "hard_limit_reached");
}

function parseSnapshot(value: ProviderQuotaSnapshot): ProviderQuotaSnapshot {
  const observedAt = value.observedAt === null
    ? null
    : canonicalTimestamp(value.observedAt, "Provider observation time");
  const evaluatedAt = canonicalTimestamp(value.evaluatedAt, "Evaluation time");
  if (observedAt !== null && Date.parse(observedAt) > Date.parse(evaluatedAt)) {
    throw new RangeError("Provider observation time cannot be later than evaluation time");
  }

  const nextCapacityAt = value.nextCapacityAt === undefined || value.nextCapacityAt === null
    ? null
    : canonicalTimestamp(value.nextCapacityAt, "Next capacity time");

  return {
    observedUnits: nonNegativeInteger(value.observedUnits, "Observed units"),
    activeReservationUnits: nonNegativeInteger(
      value.activeReservationUnits,
      "Active reservation units",
    ),
    unreconciledStartedUnits: nonNegativeInteger(
      value.unreconciledStartedUnits,
      "Unreconciled started units",
    ),
    uncertaintyUnits: nonNegativeInteger(value.uncertaintyUnits, "Uncertainty units"),
    recentStartsLastHour: nonNegativeInteger(
      value.recentStartsLastHour,
      "Recent starts in the last hour",
    ),
    expiringNextHourUnits: nonNegativeInteger(
      value.expiringNextHourUnits,
      "Units expiring in the next hour",
    ),
    observedAt,
    evaluatedAt,
    nextCapacityAt,
  };
}

function parseRequest(value: ProviderQuotaRequest): ProviderQuotaRequest {
  if (!providerRequestClasses.includes(value.requestClass)) {
    throw new RangeError(`Unsupported provider request class: ${String(value.requestClass)}`);
  }
  if (typeof value.ready !== "boolean") {
    throw new TypeError("Provider request readiness must be boolean");
  }
  if (typeof value.equivalentActiveRequest !== "boolean") {
    throw new TypeError("Equivalent active request flag must be boolean");
  }
  return {
    requestClass: value.requestClass,
    units: positiveInteger(value.units, "Requested units"),
    ready: value.ready,
    equivalentActiveRequest: value.equivalentActiveRequest,
  };
}

function classifySnapshotFreshness(
  observedAt: string | null,
  evaluatedAt: string,
  maxAgeSeconds: number,
): ProviderSnapshotFreshness {
  if (observedAt === null) return "missing";
  const ageSeconds = (Date.parse(evaluatedAt) - Date.parse(observedAt)) / 1_000;
  return ageSeconds <= maxAgeSeconds ? "fresh" : "stale";
}

function classifyPressureBand(
  units: number,
  policy: ProviderQuotaPolicy,
): ProviderPressureBand {
  if (units >= policy.hardLimit) return "closed";
  if (units >= policy.reserveOnlyAt) return "reserve_only";
  if (units >= policy.queuedAt) return "queued";
  if (units >= policy.meteredAt) return "metered";
  return "open";
}

function applyFreshnessFloor(
  band: ProviderPressureBand,
  freshness: ProviderSnapshotFreshness,
): ProviderPressureBand {
  if (freshness === "missing") return maximumBand(band, "queued");
  if (freshness === "stale") return maximumBand(band, "metered");
  return band;
}

function maximumBand(
  left: ProviderPressureBand,
  right: ProviderPressureBand,
): ProviderPressureBand {
  return providerPressureBands.indexOf(left) >= providerPressureBands.indexOf(right) ? left : right;
}

function minimumUnitsForBand(
  band: ProviderPressureBand,
  policy: ProviderQuotaPolicy,
): number {
  switch (band) {
    case "open":
      return 0;
    case "metered":
      return policy.meteredAt;
    case "queued":
      return policy.queuedAt;
    case "reserve_only":
      return policy.reserveOnlyAt;
    case "closed":
      return policy.hardLimit;
  }
}

function isPriorityBypass(requestClass: ProviderRequestClass): boolean {
  return requestClass === "rollback" || requestClass === "incident" || requestClass === "operator";
}

function decision(
  base: Omit<ProviderQuotaAdmission, "action" | "reason" | "requiresLease">,
  action: ProviderAdmissionAction,
  reason: ProviderQuotaAdmission["reason"],
): ProviderQuotaAdmission {
  return {
    ...base,
    action,
    reason,
    requiresLease: action === "admit",
  };
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) {
    throw new TypeError(`${label} must be a non-empty string of at most 160 characters`);
  }
  if (!boundedTextPattern.test(value)) {
    throw new TypeError(`${label} contains unsupported characters`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return parsed;
}

function clampToSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} exceeds the supported safe integer range`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return new Date(value).toISOString();
}
