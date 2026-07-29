import type { FailureCategory } from "./worker-observability.js";

export const SERVICE_ACTIVITY_BUCKET_INTERVALS = ["minute", "hour", "day"] as const;
export const SERVICE_ROUTE_CLASSES = ["health", "rest_v1", "mcp", "auth", "other"] as const;
export const SERVICE_OPERATION_CLASSES = [
  "read",
  "write",
  "discovery",
  "verification",
  "unknown",
] as const;
export const SERVICE_CLIENT_CLASSES = [
  "dashboard",
  "chatgpt",
  "generic_mcp",
  "hosted_verifier",
  "github_action",
  "operator_cli",
  "unknown",
] as const;
export const SERVICE_AUTH_MODES = [
  "hosted_session",
  "oauth_grant",
  "bearer_token",
  "unauthenticated",
  "service",
  "unknown",
] as const;
export const SERVICE_REQUEST_INTENTS = [
  "interactive",
  "background_refresh",
  "verification",
  "reconciliation",
  "automation",
  "unknown",
] as const;
export const SERVICE_OUTCOMES = ["success", "failure"] as const;
export const SERVICE_STATUS_BANDS = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;
export const SERVICE_FAILURE_CATEGORIES = [
  "auth_failure",
  "authorization_failure",
  "cors_rejection",
  "convex_failure",
  "mcp_failure",
  "gateway_failure",
  "request_failure",
  "unknown",
] as const satisfies readonly (FailureCategory | "unknown")[];
export const SERVICE_LATENCY_BUCKETS = [
  { key: "le_10", upperBoundMs: 10 },
  { key: "le_25", upperBoundMs: 25 },
  { key: "le_50", upperBoundMs: 50 },
  { key: "le_100", upperBoundMs: 100 },
  { key: "le_250", upperBoundMs: 250 },
  { key: "le_500", upperBoundMs: 500 },
  { key: "le_1000", upperBoundMs: 1_000 },
  { key: "le_2500", upperBoundMs: 2_500 },
  { key: "le_5000", upperBoundMs: 5_000 },
  { key: "le_10000", upperBoundMs: 10_000 },
  { key: "gt_10000", upperBoundMs: null },
] as const;

export type ServiceActivityBucketInterval = typeof SERVICE_ACTIVITY_BUCKET_INTERVALS[number];
export type ServiceRouteClass = typeof SERVICE_ROUTE_CLASSES[number];
export type ServiceOperationClass = typeof SERVICE_OPERATION_CLASSES[number];
export type ServiceClientClass = typeof SERVICE_CLIENT_CLASSES[number];
export type ServiceAuthMode = typeof SERVICE_AUTH_MODES[number];
export type ServiceRequestIntent = typeof SERVICE_REQUEST_INTENTS[number];
export type ServiceOutcome = typeof SERVICE_OUTCOMES[number];
export type ServiceStatusBand = typeof SERVICE_STATUS_BANDS[number];
export type ServiceFailureCategory = typeof SERVICE_FAILURE_CATEGORIES[number];
export type ServiceLatencyBucketKey = typeof SERVICE_LATENCY_BUCKETS[number]["key"];

export interface ServiceRequestObservation {
  workspace: string;
  observedAt: string;
  routeClass: ServiceRouteClass;
  operationClass: ServiceOperationClass;
  clientClass: ServiceClientClass;
  authMode: ServiceAuthMode;
  requestIntent: ServiceRequestIntent;
  outcome: ServiceOutcome;
  status: number;
  durationMs: number;
  failureCategory?: ServiceFailureCategory;
  workerVersionId?: string;
  releaseId?: string;
  manifestDigest?: string;
}

export interface ServiceActivityDimensions {
  workspace: string;
  routeClass: ServiceRouteClass;
  operationClass: ServiceOperationClass;
  clientClass: ServiceClientClass;
  authMode: ServiceAuthMode;
  workerVersionId?: string;
  releaseId?: string;
  manifestDigest?: string;
}

export interface ServiceDurationAggregate {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  histogram: Record<ServiceLatencyBucketKey, number>;
}

export interface ServiceActivityBucket {
  schemaVersion: 1;
  interval: ServiceActivityBucketInterval;
  startAt: string;
  endAt: string;
  dimensions: ServiceActivityDimensions;
  requestCount: number;
  successCount: number;
  failureCount: number;
  statusBands: Record<ServiceStatusBand, number>;
  requestIntents: Record<ServiceRequestIntent, number>;
  failureCategories: Record<ServiceFailureCategory, number>;
  duration: ServiceDurationAggregate;
  lastObservedAt: string;
}

export interface ServiceActivitySummary {
  requestCount: number;
  successRate: number | null;
  backgroundRefreshShare: number | null;
  p50LatencyUpperBoundMs: number | null;
  p95LatencyUpperBoundMs: number | null;
  latencyOverflowAtP50: boolean;
  latencyOverflowAtP95: boolean;
}

export function parseServiceRequestObservation(input: unknown): ServiceRequestObservation {
  if (!isRecord(input)) throw new Error("Service request observation must be an object");
  const workspace = boundedSlug(input.workspace, "workspace", 80);
  const observedAt = canonicalTimestamp(input.observedAt);
  const routeClass = closedValue(input.routeClass, SERVICE_ROUTE_CLASSES, "route class");
  const operationClass = closedValue(
    input.operationClass,
    SERVICE_OPERATION_CLASSES,
    "operation class",
  );
  const clientClass = closedValue(input.clientClass, SERVICE_CLIENT_CLASSES, "client class");
  const authMode = closedValue(input.authMode, SERVICE_AUTH_MODES, "auth mode");
  const requestIntent = closedValue(
    input.requestIntent,
    SERVICE_REQUEST_INTENTS,
    "request intent",
  );
  const outcome = closedValue(input.outcome, SERVICE_OUTCOMES, "outcome");
  const status = boundedInteger(input.status, "status", 100, 599);
  const durationMs = boundedNumber(input.durationMs, "durationMs", 0, 3_600_000);
  const expectedOutcome: ServiceOutcome = status < 400 ? "success" : "failure";
  if (outcome !== expectedOutcome) {
    throw new Error(`Outcome ${outcome} does not match HTTP status ${status}`);
  }

  const failureCategory = outcome === "failure"
    ? input.failureCategory === undefined
      ? "unknown"
      : closedValue(input.failureCategory, SERVICE_FAILURE_CATEGORIES, "failure category")
    : undefined;
  if (outcome === "success" && input.failureCategory !== undefined) {
    throw new Error("Successful observations cannot carry a failure category");
  }

  const workerVersionId = optionalDiagnosticId(input.workerVersionId, "worker version ID");
  const releaseId = optionalDiagnosticId(input.releaseId, "release ID");
  const manifestDigest = optionalManifestDigest(input.manifestDigest);

  return {
    workspace,
    observedAt,
    routeClass,
    operationClass,
    clientClass,
    authMode,
    requestIntent,
    outcome,
    status,
    durationMs,
    ...(failureCategory ? { failureCategory } : {}),
    ...(workerVersionId ? { workerVersionId } : {}),
    ...(releaseId ? { releaseId } : {}),
    ...(manifestDigest ? { manifestDigest } : {}),
  };
}

export function aggregateServiceActivity(
  observations: readonly ServiceRequestObservation[],
  interval: ServiceActivityBucketInterval,
): ServiceActivityBucket[] {
  const buckets = new Map<string, ServiceActivityBucket>();
  for (const observation of observations) {
    const normalized = parseServiceRequestObservation(observation);
    const window = serviceActivityWindow(normalized.observedAt, interval);
    const dimensions = serviceActivityDimensions(normalized);
    const key = `${window.startAt}|${serviceActivityDimensionKey(dimensions)}`;
    const current = buckets.get(key) ?? emptyServiceActivityBucket(interval, window, dimensions);
    buckets.set(key, addServiceRequestObservation(current, normalized));
  }
  return [...buckets.values()].sort(
    (left, right) => left.startAt.localeCompare(right.startAt)
      || serviceActivityDimensionKey(left.dimensions)
        .localeCompare(serviceActivityDimensionKey(right.dimensions)),
  );
}

export function addServiceRequestObservation(
  bucket: ServiceActivityBucket,
  observation: ServiceRequestObservation,
): ServiceActivityBucket {
  const normalized = parseServiceRequestObservation(observation);
  const window = serviceActivityWindow(normalized.observedAt, bucket.interval);
  if (window.startAt !== bucket.startAt || window.endAt !== bucket.endAt) {
    throw new Error("Observation is outside the service activity bucket window");
  }
  const dimensions = serviceActivityDimensions(normalized);
  if (serviceActivityDimensionKey(dimensions) !== serviceActivityDimensionKey(bucket.dimensions)) {
    throw new Error("Observation dimensions do not match the service activity bucket");
  }

  const statusBands = { ...bucket.statusBands };
  statusBands[statusBand(normalized.status)] += 1;
  const requestIntents = { ...bucket.requestIntents };
  requestIntents[normalized.requestIntent] += 1;
  const failureCategories = { ...bucket.failureCategories };
  if (normalized.failureCategory) failureCategories[normalized.failureCategory] += 1;
  const histogram = { ...bucket.duration.histogram };
  histogram[latencyBucket(normalized.durationMs)] += 1;

  return {
    ...bucket,
    requestCount: bucket.requestCount + 1,
    successCount: bucket.successCount + (normalized.outcome === "success" ? 1 : 0),
    failureCount: bucket.failureCount + (normalized.outcome === "failure" ? 1 : 0),
    statusBands,
    requestIntents,
    failureCategories,
    duration: {
      count: bucket.duration.count + 1,
      sumMs: bucket.duration.sumMs + normalized.durationMs,
      minMs: Math.min(bucket.duration.minMs, normalized.durationMs),
      maxMs: Math.max(bucket.duration.maxMs, normalized.durationMs),
      histogram,
    },
    lastObservedAt: bucket.lastObservedAt > normalized.observedAt
      ? bucket.lastObservedAt
      : normalized.observedAt,
  };
}

export function mergeServiceActivityBuckets(
  left: ServiceActivityBucket,
  right: ServiceActivityBucket,
): ServiceActivityBucket {
  if (
    left.interval !== right.interval
    || left.startAt !== right.startAt
    || left.endAt !== right.endAt
    || serviceActivityDimensionKey(left.dimensions) !== serviceActivityDimensionKey(right.dimensions)
  ) {
    throw new Error("Only equivalent service activity buckets can be merged");
  }
  return {
    ...left,
    requestCount: left.requestCount + right.requestCount,
    successCount: left.successCount + right.successCount,
    failureCount: left.failureCount + right.failureCount,
    statusBands: addCounters(left.statusBands, right.statusBands),
    requestIntents: addCounters(left.requestIntents, right.requestIntents),
    failureCategories: addCounters(left.failureCategories, right.failureCategories),
    duration: {
      count: left.duration.count + right.duration.count,
      sumMs: left.duration.sumMs + right.duration.sumMs,
      minMs: Math.min(left.duration.minMs, right.duration.minMs),
      maxMs: Math.max(left.duration.maxMs, right.duration.maxMs),
      histogram: addCounters(left.duration.histogram, right.duration.histogram),
    },
    lastObservedAt: left.lastObservedAt > right.lastObservedAt
      ? left.lastObservedAt
      : right.lastObservedAt,
  };
}

export function summarizeServiceActivity(
  buckets: readonly ServiceActivityBucket[],
): ServiceActivitySummary {
  const requestCount = buckets.reduce((sum, bucket) => sum + bucket.requestCount, 0);
  const successCount = buckets.reduce((sum, bucket) => sum + bucket.successCount, 0);
  const backgroundCount = buckets.reduce(
    (sum, bucket) => sum + bucket.requestIntents.background_refresh,
    0,
  );
  const histogram = emptyLatencyHistogram();
  for (const bucket of buckets) {
    for (const key of Object.keys(histogram) as ServiceLatencyBucketKey[]) {
      histogram[key] += bucket.duration.histogram[key];
    }
  }
  const p50 = latencyPercentile(histogram, requestCount, 0.5);
  const p95 = latencyPercentile(histogram, requestCount, 0.95);
  return {
    requestCount,
    successRate: requestCount ? successCount / requestCount : null,
    backgroundRefreshShare: requestCount ? backgroundCount / requestCount : null,
    p50LatencyUpperBoundMs: p50.upperBoundMs,
    p95LatencyUpperBoundMs: p95.upperBoundMs,
    latencyOverflowAtP50: p50.overflow,
    latencyOverflowAtP95: p95.overflow,
  };
}

export function serviceActivityDimensionKey(dimensions: ServiceActivityDimensions): string {
  return JSON.stringify([
    dimensions.workspace,
    dimensions.routeClass,
    dimensions.operationClass,
    dimensions.clientClass,
    dimensions.authMode,
    dimensions.workerVersionId ?? null,
    dimensions.releaseId ?? null,
    dimensions.manifestDigest ?? null,
  ]);
}

export function serviceActivityWindow(
  observedAt: string,
  interval: ServiceActivityBucketInterval,
): { startAt: string; endAt: string } {
  closedValue(interval, SERVICE_ACTIVITY_BUCKET_INTERVALS, "bucket interval");
  const instant = new Date(canonicalTimestamp(observedAt));
  if (interval === "minute") instant.setUTCSeconds(0, 0);
  if (interval === "hour") instant.setUTCMinutes(0, 0, 0);
  if (interval === "day") instant.setUTCHours(0, 0, 0, 0);
  const start = instant.getTime();
  const duration = interval === "minute" ? 60_000 : interval === "hour" ? 3_600_000 : 86_400_000;
  return {
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + duration).toISOString(),
  };
}

function emptyServiceActivityBucket(
  interval: ServiceActivityBucketInterval,
  window: { startAt: string; endAt: string },
  dimensions: ServiceActivityDimensions,
): ServiceActivityBucket {
  return {
    schemaVersion: 1,
    interval,
    ...window,
    dimensions,
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    statusBands: counter(SERVICE_STATUS_BANDS),
    requestIntents: counter(SERVICE_REQUEST_INTENTS),
    failureCategories: counter(SERVICE_FAILURE_CATEGORIES),
    duration: {
      count: 0,
      sumMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      histogram: emptyLatencyHistogram(),
    },
    lastObservedAt: window.startAt,
  };
}

function serviceActivityDimensions(
  observation: ServiceRequestObservation,
): ServiceActivityDimensions {
  return {
    workspace: observation.workspace,
    routeClass: observation.routeClass,
    operationClass: observation.operationClass,
    clientClass: observation.clientClass,
    authMode: observation.authMode,
    ...(observation.workerVersionId
      ? { workerVersionId: observation.workerVersionId }
      : {}),
    ...(observation.releaseId ? { releaseId: observation.releaseId } : {}),
    ...(observation.manifestDigest ? { manifestDigest: observation.manifestDigest } : {}),
  };
}

function latencyPercentile(
  histogram: Record<ServiceLatencyBucketKey, number>,
  total: number,
  percentile: number,
): { upperBoundMs: number | null; overflow: boolean } {
  if (!total) return { upperBoundMs: null, overflow: false };
  const target = Math.ceil(total * percentile);
  let observed = 0;
  for (const bucket of SERVICE_LATENCY_BUCKETS) {
    observed += histogram[bucket.key];
    if (observed >= target) {
      return {
        upperBoundMs: bucket.upperBoundMs,
        overflow: bucket.upperBoundMs === null,
      };
    }
  }
  throw new Error("Latency histogram count is lower than the request total");
}

function latencyBucket(durationMs: number): ServiceLatencyBucketKey {
  return SERVICE_LATENCY_BUCKETS.find(
    (bucket) => bucket.upperBoundMs === null || durationMs <= bucket.upperBoundMs,
  )!.key;
}

function statusBand(status: number): ServiceStatusBand {
  return `${Math.floor(status / 100)}xx` as ServiceStatusBand;
}

function emptyLatencyHistogram(): Record<ServiceLatencyBucketKey, number> {
  return counter(SERVICE_LATENCY_BUCKETS.map((bucket) => bucket.key));
}

function counter<const T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

function addCounters<T extends string>(
  left: Record<T, number>,
  right: Record<T, number>,
): Record<T, number> {
  return Object.fromEntries(
    Object.keys(left).map((key) => [key, left[key as T] + right[key as T]]),
  ) as Record<T, number>;
}

function boundedSlug(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!new RegExp(`^[a-z0-9][a-z0-9_-]{0,${maxLength - 1}}$`).test(normalized)) {
    throw new Error(`${label} must be a bounded lowercase slug`);
  }
  return normalized;
}

function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new Error("observedAt must be a canonical UTC ISO timestamp");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("observedAt must be a canonical UTC ISO timestamp");
  }
  const canonical = new Date(timestamp).toISOString();
  const supplied = value.endsWith("Z") && !value.includes(".")
    ? value.replace(/Z$/, ".000Z")
    : value;
  if (canonical !== supplied) {
    throw new Error("observedAt must be a canonical UTC ISO timestamp");
  }
  return canonical;
}

function optionalDiagnosticId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} is not a bounded diagnostic identifier`);
  }
  return normalized;
}

function optionalManifestDigest(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("manifest digest must be sha256:<64 lowercase hex characters>");
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${label} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}

function closedValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new Error(`${label} must use the closed server vocabulary`);
  }
  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
