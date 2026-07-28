import { createHash } from "node:crypto";
import {
  baseCallsignCategories,
  callsignCollisionKey,
  callsignPools,
  type BaseCallsignCategory,
} from "./callsign-suggestions.ts";

export const callsignAvailabilityStates = [
  "available",
  "active",
  "cooling_off",
  "reusable",
  "retired",
] as const;

export type CallsignAvailabilityState = typeof callsignAvailabilityStates[number];

const limits = {
  query: 80,
  cursor: 80,
  pageSize: 100,
  callsign: 80,
  workspace: 80,
  workerSessionId: 160,
  runId: 160,
  requestId: 240,
  relationId: 240,
  maximumAvailabilityRows: 1_000,
  maximumLeaseSeconds: 7 * 24 * 60 * 60,
} as const;

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const workspacePattern = /^[a-z0-9][a-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;
const runIdPattern = /^run_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const cursorPattern = /^catalog:(\d+)$/;
const curatedCallsignKeys = new Set(
  baseCallsignCategories.flatMap((category) =>
    callsignPools[category].map((callsign) => callsignCollisionKey(callsign))
  ),
);

export interface CallsignAvailabilityInput {
  callsign: string;
  state: CallsignAvailabilityState;
  previouslyUsed?: boolean;
  holderRunId?: string;
  holderWorkerSessionId?: string;
  generation?: number;
  availableAt?: string;
}

export interface BrowseCallsignCatalogInput {
  query?: string;
  categories?: readonly BaseCallsignCategory[];
  states?: readonly CallsignAvailabilityState[];
  availability?: readonly CallsignAvailabilityInput[];
  limit?: number;
  cursor?: string;
}

export interface CallsignCatalogEntry {
  callsign: string;
  collisionKey: string;
  category: BaseCallsignCategory;
  source: "curated";
  state: CallsignAvailabilityState;
  previouslyUsed: boolean;
  holderRunId: string | null;
  holderWorkerSessionId: string | null;
  generation: number | null;
  availableAt: string | null;
}

export interface BrowseCallsignCatalogResult {
  version: 1;
  totalCatalogEntries: number;
  matchedEntries: number;
  nextCursor: string | null;
  entries: CallsignCatalogEntry[];
  reservesCallsign: false;
  grantsIdentityContinuity: false;
  grantsAuthority: false;
}

export interface CallsignReservationRequestInput {
  workspace: string;
  requestedCallsign: string;
  workerSessionId: string;
  runId: string;
  requestId: string;
  requestedAt: string;
  expiresAt: string;
  expectedGeneration?: number;
  inheritance?: {
    fromRunId: string;
    transferReference: string;
  };
}

export interface CallsignReservationRequest {
  version: 1;
  workspace: string;
  requestedCallsign: string;
  collisionKey: string;
  workerSessionId: string;
  runId: string;
  requestId: string;
  requestedAt: string;
  expiresAt: string;
  expectedGeneration: number | null;
  inheritance: {
    fromRunId: string;
    transferReference: string;
  } | null;
  requestsReservation: true;
  reservationAccepted: false;
  grantsIdentityContinuity: false;
  grantsAuthority: false;
  fingerprint: string;
}

/**
 * Projects the curated callsign pools into a deterministic, bounded catalog and
 * overlays caller-supplied availability. The result is a read model only.
 */
export function browseCallsignCatalog(
  input: BrowseCallsignCatalogInput = {},
): BrowseCallsignCatalogResult {
  const query = canonicalQuery(input.query);
  const categories = canonicalCategories(input.categories);
  const states = canonicalStates(input.states);
  const availability = canonicalAvailability(input.availability ?? []);
  const limit = boundedPageSize(input.limit ?? 25);
  const offset = parseCursor(input.cursor);

  const catalog = baseCallsignCategories
    .flatMap((category) =>
      callsignPools[category].map((callsign) => {
        const collisionKey = callsignCollisionKey(callsign);
        const overlay = availability.get(collisionKey);
        return {
          callsign,
          collisionKey,
          category,
          source: "curated" as const,
          state: overlay?.state ?? "available",
          previouslyUsed: overlay?.previouslyUsed ?? false,
          holderRunId: overlay?.holderRunId ?? null,
          holderWorkerSessionId: overlay?.holderWorkerSessionId ?? null,
          generation: overlay?.generation ?? null,
          availableAt: overlay?.availableAt ?? null,
        } satisfies CallsignCatalogEntry;
      })
    )
    .sort(compareCatalogEntries);

  const filtered = catalog.filter((entry) => {
    if (categories && !categories.has(entry.category)) return false;
    if (states && !states.has(entry.state)) return false;
    if (!query) return true;
    return entry.callsign.toLowerCase().includes(query.display)
      || entry.collisionKey.includes(query.collisionKey);
  });

  if (offset > filtered.length) {
    throw new RangeError("Callsign catalog cursor is beyond the matched result set");
  }

  const entries = filtered.slice(offset, offset + limit);
  const nextOffset = offset + entries.length;
  const nextCursor = nextOffset < filtered.length ? `catalog:${nextOffset}` : null;

  return {
    version: 1,
    totalCatalogEntries: catalog.length,
    matchedEntries: filtered.length,
    nextCursor,
    entries,
    reservesCallsign: false,
    grantsIdentityContinuity: false,
    grantsAuthority: false,
  };
}

/**
 * Canonicalises a reservation request for durable replay and later atomic
 * acceptance. Building this request does not reserve the callsign.
 */
export function buildCallsignReservationRequest(
  input: CallsignReservationRequestInput,
): CallsignReservationRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RangeError("Callsign reservation request must be an object");
  }

  const workspace = boundedWorkspace(input.workspace);
  const requestedCallsign = boundedCallsign(input.requestedCallsign);
  const collisionKey = callsignCollisionKey(requestedCallsign);
  const workerSessionId = boundedIdentifier(
    input.workerSessionId,
    "Worker session ID",
    limits.workerSessionId,
    identifierPattern,
  );
  const runId = boundedIdentifier(input.runId, "Run ID", limits.runId, runIdPattern);
  const requestId = boundedIdentifier(
    input.requestId,
    "Request ID",
    limits.requestId,
    identifierPattern,
  );
  const requestedAt = canonicalTimestamp(input.requestedAt, "Request time");
  const expiresAt = canonicalTimestamp(input.expiresAt, "Reservation expiry");
  const leaseSeconds = (Date.parse(expiresAt) - Date.parse(requestedAt)) / 1_000;
  if (leaseSeconds <= 0) {
    throw new RangeError("Reservation expiry must be later than request time");
  }
  if (leaseSeconds > limits.maximumLeaseSeconds) {
    throw new RangeError("Reservation lifetime must be at most 604800 seconds");
  }

  const expectedGeneration = input.expectedGeneration === undefined
    ? null
    : positiveGeneration(input.expectedGeneration);
  const inheritance = canonicalInheritance(input.inheritance, runId);

  const canonical = {
    version: 1 as const,
    workspace,
    requestedCallsign,
    collisionKey,
    workerSessionId,
    runId,
    requestId,
    requestedAt,
    expiresAt,
    expectedGeneration,
    inheritance,
    requestsReservation: true as const,
    reservationAccepted: false as const,
    grantsIdentityContinuity: false as const,
    grantsAuthority: false as const,
  };
  const fingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;

  return { ...canonical, fingerprint };
}

function canonicalAvailability(
  rows: readonly CallsignAvailabilityInput[],
): Map<string, Omit<CallsignCatalogEntry, "callsign" | "collisionKey" | "category" | "source">> {
  if (!Array.isArray(rows) || rows.length > limits.maximumAvailabilityRows) {
    throw new RangeError(
      `Callsign availability must contain at most ${limits.maximumAvailabilityRows} entries`,
    );
  }

  const result = new Map<
    string,
    Omit<CallsignCatalogEntry, "callsign" | "collisionKey" | "category" | "source">
  >();
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new RangeError("Callsign availability entry must be an object");
    }
    const callsign = boundedCallsign(row.callsign);
    const collisionKey = callsignCollisionKey(callsign);
    if (!curatedCallsignKeys.has(collisionKey)) {
      throw new RangeError(`Callsign availability entry is outside the curated catalog: ${callsign}`);
    }
    if (result.has(collisionKey)) {
      throw new RangeError(`Duplicate callsign availability entry: ${callsign}`);
    }
    if (!callsignAvailabilityStates.includes(row.state)) {
      throw new RangeError(`Unknown callsign availability state: ${String(row.state)}`);
    }

    const holderRunId = row.holderRunId === undefined
      ? null
      : boundedIdentifier(row.holderRunId, "Holder run ID", limits.runId, runIdPattern);
    const holderWorkerSessionId = row.holderWorkerSessionId === undefined
      ? null
      : boundedIdentifier(
        row.holderWorkerSessionId,
        "Holder worker session ID",
        limits.workerSessionId,
        identifierPattern,
      );
    const generation = row.generation === undefined ? null : positiveGeneration(row.generation);
    const availableAt = row.availableAt === undefined
      ? null
      : canonicalTimestamp(row.availableAt, "Callsign available time");
    const previouslyUsed = row.previouslyUsed
      ?? row.state !== "available";

    if (typeof previouslyUsed !== "boolean") {
      throw new RangeError("Callsign previously-used flag must be a boolean");
    }
    if (row.state === "active") {
      if (!holderRunId || !holderWorkerSessionId || generation === null) {
        throw new RangeError(
          "Active callsign availability requires holder run, worker session, and generation",
        );
      }
      if (availableAt) throw new RangeError("Active callsign cannot include an available time");
    } else {
      if (holderRunId || holderWorkerSessionId) {
        throw new RangeError(`${row.state} callsign availability cannot include a live holder`);
      }
      if (generation !== null) {
        throw new RangeError(`${row.state} callsign availability cannot include a live generation`);
      }
    }
    if (row.state === "cooling_off" && !availableAt) {
      throw new RangeError("Cooling-off callsign availability requires an available time");
    }
    if (row.state !== "cooling_off" && availableAt) {
      throw new RangeError(`${row.state} callsign availability cannot include an available time`);
    }
    if (
      (row.state === "active" || row.state === "cooling_off" || row.state === "reusable")
      && !previouslyUsed
    ) {
      throw new RangeError(`${row.state} callsign must be marked previously used`);
    }

    result.set(collisionKey, {
      state: row.state,
      previouslyUsed,
      holderRunId,
      holderWorkerSessionId,
      generation,
      availableAt,
    });
  }
  return result;
}

function canonicalQuery(value: string | undefined): {
  display: string;
  collisionKey: string;
} | null {
  if (value === undefined) return null;
  assertSafeText(value, "Callsign catalog query");
  const display = value.normalize("NFKC").trim().toLowerCase();
  if (display.length === 0) return null;
  if ([...display].length > limits.query) {
    throw new RangeError(`Callsign catalog query must be at most ${limits.query} characters`);
  }
  if (!/^[a-z0-9 _-]+$/.test(display)) {
    throw new RangeError("Callsign catalog query contains unsupported characters");
  }
  return {
    display,
    collisionKey: display.replace(/[ _-]+/g, ""),
  };
}

function canonicalCategories(
  values: readonly BaseCallsignCategory[] | undefined,
): Set<BaseCallsignCategory> | null {
  if (values === undefined) return null;
  if (!Array.isArray(values) || values.length < 1 || values.length > baseCallsignCategories.length) {
    throw new RangeError("Callsign category filter must contain 1 to 4 entries");
  }
  const result = new Set<BaseCallsignCategory>();
  for (const value of values) {
    if (!baseCallsignCategories.includes(value)) {
      throw new RangeError(`Unknown callsign category: ${String(value)}`);
    }
    if (result.has(value)) throw new RangeError("Callsign category filter contains duplicates");
    result.add(value);
  }
  return result;
}

function canonicalStates(
  values: readonly CallsignAvailabilityState[] | undefined,
): Set<CallsignAvailabilityState> | null {
  if (values === undefined) return null;
  if (!Array.isArray(values) || values.length < 1 || values.length > callsignAvailabilityStates.length) {
    throw new RangeError("Callsign state filter must contain 1 to 5 entries");
  }
  const result = new Set<CallsignAvailabilityState>();
  for (const value of values) {
    if (!callsignAvailabilityStates.includes(value)) {
      throw new RangeError(`Unknown callsign availability state: ${String(value)}`);
    }
    if (result.has(value)) throw new RangeError("Callsign state filter contains duplicates");
    result.add(value);
  }
  return result;
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  assertSafeText(value, "Callsign catalog cursor");
  if ([...value].length > limits.cursor) {
    throw new RangeError(`Callsign catalog cursor must be at most ${limits.cursor} characters`);
  }
  const match = cursorPattern.exec(value.trim());
  if (!match?.[1]) throw new RangeError("Callsign catalog cursor is malformed");
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("Callsign catalog cursor is malformed");
  }
  return offset;
}

function boundedPageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > limits.pageSize) {
    throw new RangeError(`Callsign catalog limit must be an integer from 1 to ${limits.pageSize}`);
  }
  return value;
}

function boundedWorkspace(value: string): string {
  assertSafeText(value, "Workspace");
  const normalized = value.trim().toLowerCase();
  if ([...normalized].length > limits.workspace) {
    throw new RangeError(`Workspace must be at most ${limits.workspace} characters`);
  }
  if (!workspacePattern.test(normalized)) {
    throw new RangeError("Workspace must be a lowercase slug");
  }
  return normalized;
}

function boundedCallsign(value: string): string {
  assertSafeText(value, "Callsign");
  const normalized = value.normalize("NFKC").trim().replace(/ {2,}/g, " ");
  if ([...normalized].length > limits.callsign) {
    throw new RangeError(`Callsign must be at most ${limits.callsign} characters`);
  }
  callsignCollisionKey(normalized);
  return normalized;
}

function boundedIdentifier(
  value: string,
  label: string,
  maximumLength: number,
  pattern: RegExp,
): string {
  assertSafeText(value, label);
  const normalized = value.trim();
  if ([...normalized].length > maximumLength) {
    throw new RangeError(`${label} must be at most ${maximumLength} characters`);
  }
  if (!pattern.test(normalized)) throw new RangeError(`${label} contains unsupported characters`);
  return normalized;
}

function canonicalTimestamp(value: string, label: string): string {
  assertSafeText(value, label);
  const normalized = value.trim();
  if (!timestampPattern.test(normalized)) {
    throw new RangeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const canonical = new Date(milliseconds).toISOString();
  const comparableInput = normalized.includes(".")
    ? normalized
    : normalized.replace(/Z$/, ".000Z");
  if (canonical !== comparableInput) {
    throw new RangeError(`${label} must be a valid calendar timestamp`);
  }
  return canonical;
}

function positiveGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Expected generation must be a positive safe integer");
  }
  return value;
}

function canonicalInheritance(
  value: CallsignReservationRequestInput["inheritance"],
  runId: string,
): CallsignReservationRequest["inheritance"] {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("Callsign inheritance must be an object");
  }
  const fromRunId = boundedIdentifier(
    value.fromRunId,
    "Inheritance source run ID",
    limits.runId,
    runIdPattern,
  );
  if (fromRunId === runId) {
    throw new RangeError("Inheritance source run must differ from the requesting run");
  }
  const transferReference = boundedIdentifier(
    value.transferReference,
    "Inheritance transfer reference",
    limits.relationId,
    identifierPattern,
  );
  return { fromRunId, transferReference };
}

function compareCatalogEntries(left: CallsignCatalogEntry, right: CallsignCatalogEntry): number {
  const leftDisplay = left.callsign.toLowerCase();
  const rightDisplay = right.callsign.toLowerCase();
  if (leftDisplay < rightDisplay) return -1;
  if (leftDisplay > rightDisplay) return 1;
  if (left.category < right.category) return -1;
  if (left.category > right.category) return 1;
  return left.collisionKey < right.collisionKey ? -1 : left.collisionKey > right.collisionKey ? 1 : 0;
}

function assertSafeText(value: string, label: string): void {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError(`${label} contains unsupported control characters`);
  }
}
