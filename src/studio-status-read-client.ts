/**
 * Read-only ledger status reader for studio monitors (#1632 monitor path).
 *
 * Structural boundary: this module can only issue one request shape,
 * `GET /api/v1/items`. Any other method or path is refused before a
 * connection is opened. Mutation surfaces (create, claim, renew, handoff,
 * block, unblock, release, complete, events, artifacts) are deliberately
 * not modeled here and cannot be reached through this client.
 *
 * Input hardening (#1632 monitor polish): every read runs under a deadline,
 * a streamed response-byte bound, and an item-count bound. The envelope and
 * each item are validated into the narrow `LedgerStatusItem` vocabulary, and
 * failures are classified without echoing the endpoint, project, token,
 * response body, or any private item content.
 */

export const LEDGER_STATUS_READ_METHODS = ["GET"] as const;
export type LedgerStatusReadMethod = (typeof LEDGER_STATUS_READ_METHODS)[number];

export const LEDGER_STATUS_READ_PATHS = ["/api/v1/items"] as const;
export type LedgerStatusReadPath = (typeof LEDGER_STATUS_READ_PATHS)[number];

/** Default hosted ledger endpoint used when no explicit endpoint is given. */
export const DEFAULT_LEDGER_STATUS_ENDPOINT = "https://api.stensibly.com";

/** Deterministic input bounds; every one is overridable per reader. */
export const DEFAULT_LEDGER_STATUS_TIMEOUT_MS = 10_000;
export const DEFAULT_LEDGER_STATUS_MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_LEDGER_STATUS_MAX_ITEM_COUNT = 1_000;

const MAX_ENDPOINT_LENGTH = 2_000;
const MAX_PROJECT_LENGTH = 200;

const ITEM_FIELD_LIMITS = {
  id: 240,
  project: 200,
  kind: 120,
  title: 1_000,
  status: 40,
  claimedBy: 200,
  nextAction: 2_000,
  updatedAt: 40,
} as const;

const LEDGER_ITEM_STATUSES = ["ready", "active", "blocked", "done", "archived"] as const;

export class LedgerStatusReadBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerStatusReadBoundaryError";
  }
}

export type LedgerStatusResponseKind = "timeout" | "http" | "network" | "malformed" | "oversize";

/**
 * Classified read failure. Messages stay content-free: no endpoint, project,
 * token, response body, or item content ever appears in `message`.
 */
export class LedgerStatusResponseError extends Error {
  readonly kind: LedgerStatusResponseKind;
  readonly status?: number;

  constructor(kind: LedgerStatusResponseKind, message: string, status?: number) {
    super(message);
    this.name = "LedgerStatusResponseError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

const ITEMS_PATH: LedgerStatusReadPath = "/api/v1/items";

export function assertLedgerStatusRead(method: string, pathTemplate: string): void {
  if (!(LEDGER_STATUS_READ_METHODS as readonly string[]).includes(method)) {
    throw new LedgerStatusReadBoundaryError(
      `studio status readers are GET-only; refused ${method} ${pathTemplate}`,
    );
  }
  if (!(LEDGER_STATUS_READ_PATHS as readonly string[]).includes(pathTemplate)) {
    throw new LedgerStatusReadBoundaryError(
      `${pathTemplate} is outside the status read allowlist (${LEDGER_STATUS_READ_PATHS.join(", ")})`,
    );
  }
}

export interface LedgerStatusItem {
  id: string;
  project: string;
  kind: string;
  title: string;
  status: (typeof LEDGER_ITEM_STATUSES)[number];
  priority: number;
  claimedBy?: string;
  nextAction?: string;
  updatedAt: string;
}

export interface RecordedLedgerStatusRequest {
  readonly method: string;
  readonly url: string;
}

export interface LedgerStatusReader {
  listProjectItems(project: string): Promise<LedgerStatusItem[]>;
  recordedRequests(): readonly RecordedLedgerStatusRequest[];
}

export interface LedgerStatusReaderOptions {
  readonly endpoint?: string;
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  /** Overall deadline for connect plus body read. Default 10s. */
  readonly timeoutMs?: number;
  /** Maximum accepted response body size in bytes. Default 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Maximum accepted item count per response. Default 1000. */
  readonly maxItemCount?: number;
}

function boundaryError(message: string): LedgerStatusReadBoundaryError {
  return new LedgerStatusReadBoundaryError(message);
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw boundaryError(`${label} must be a positive integer.`);
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Normalizes an HTTP(S) origin/base endpoint. Rejects embedded credentials,
 * query strings, fragments, and any preconfigured API path suffix (the read
 * path is always constructed here). Loopback development endpoints may use
 * plain HTTP; everything else requires HTTPS.
 */
export function normalizeLedgerEndpointBase(rawEndpoint: string): string {
  const candidate = String(rawEndpoint ?? "").trim();
  if (!candidate || candidate.length > MAX_ENDPOINT_LENGTH) {
    throw boundaryError("Endpoint must be a non-empty URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw boundaryError("Endpoint must be a valid absolute URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw boundaryError("Endpoint must use HTTPS (loopback HTTP is allowed for development).");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw boundaryError("Plain HTTP endpoints are limited to loopback development hosts.");
  }
  if (parsed.username || parsed.password) {
    throw boundaryError("Endpoint must not embed credentials.");
  }
  if (parsed.search) throw boundaryError("Endpoint must not include a query string.");
  if (parsed.hash) throw boundaryError("Endpoint must not include a fragment.");

  const path = parsed.pathname.replace(/\/+$/, "");
  if (/^\.+$/.test(path.split("/").pop() ?? "")) {
    throw boundaryError("Endpoint path must be a plain base path.");
  }
  if (/\/api\/v\d+(\/|$)/i.test(path)) {
    throw boundaryError("Endpoint must be an origin/base without an API path suffix.");
  }
  return `${parsed.origin}${path}`;
}

function requireBoundedString(
  value: unknown,
  index: number,
  field: keyof typeof ITEM_FIELD_LIMITS,
): string {
  const maxLength = ITEM_FIELD_LIMITS[field];
  if (typeof value !== "string") {
    throw new LedgerStatusResponseError("malformed", `Ledger status item ${index} has a non-string ${field}.`);
  }
  if (!value.length) {
    throw new LedgerStatusResponseError("malformed", `Ledger status item ${index} has an empty ${field}.`);
  }
  if (value.length > maxLength) {
    throw new LedgerStatusResponseError("malformed", `Ledger status item ${index} has an over-long ${field}.`);
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new LedgerStatusResponseError("malformed", `Ledger status item ${index} has control characters in ${field}.`);
  }
  if (value.includes("stn.tok_")) {
    throw new LedgerStatusResponseError("malformed", `Ledger status item ${index} carries a credential-shaped ${field}.`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  index: number,
  field: keyof typeof ITEM_FIELD_LIMITS,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireBoundedString(value, index, field);
}

function validateStatusItem(raw: unknown, index: number): LedgerStatusItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LedgerStatusResponseError("malformed", `Ledger status item ${index} is not an object.`);
  }
  const record = raw as Record<string, unknown>;
  const id = requireBoundedString(record.id, index, "id");
  const project = requireBoundedString(record.project, index, "project");
  const kind = requireBoundedString(record.kind, index, "kind");
  const title = requireBoundedString(record.title, index, "title");
  const statusValue = requireBoundedString(record.status, index, "status");
  if (!(LEDGER_ITEM_STATUSES as readonly string[]).includes(statusValue)) {
    throw new LedgerStatusResponseError("malformed", `Ledger status item ${index} has an invalid status.`);
  }
  if (typeof record.priority !== "number" || !Number.isSafeInteger(record.priority)) {
    throw new LedgerStatusResponseError("malformed", `Ledger status item ${index} needs an integer priority.`);
  }
  const updatedAt = requireBoundedString(record.updatedAt, index, "updatedAt");
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new LedgerStatusResponseError("malformed", `Ledger status item ${index} needs a valid updatedAt timestamp.`);
  }
  const claimedBy = optionalBoundedString(record.claimedBy, index, "claimedBy");
  const nextAction = optionalBoundedString(record.nextAction, index, "nextAction");

  // Projected onto the narrow vocabulary: unknown extra fields never survive.
  return {
    id,
    project,
    kind,
    title,
    status: statusValue as LedgerStatusItem["status"],
    priority: record.priority,
    ...(claimedBy ? { claimedBy } : {}),
    ...(nextAction ? { nextAction } : {}),
    updatedAt,
  };
}

function parseDeclaredContentLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header === null) return null;
  if (!/^\d+$/.test(header.trim())) {
    throw new LedgerStatusResponseError("malformed", "Ledger status response declared an invalid content length.");
  }
  return Number(header);
}

async function cancelQuietly(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Cancellation of an already-aborted stream is irrelevant to the outcome.
  }
}

/**
 * Streams the response body under the byte limit. Oversize responses are
 * aborted mid-stream; declared-but-different lengths are rejected as lying.
 */
async function readBoundedBody(
  response: Response,
  limit: number,
  onAbortNeeded: () => void,
): Promise<Uint8Array> {
  const declaredLength = parseDeclaredContentLength(response);
  if (declaredLength !== null && declaredLength > limit) {
    onAbortNeeded();
    await cancelQuietly(response.body);
    throw new LedgerStatusResponseError("oversize", "Ledger status response exceeds the configured byte limit.");
  }
  const body = response.body;
  if (!body) {
    throw new LedgerStatusResponseError("malformed", "Ledger status response has no readable body.");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      total += value.byteLength;
      if (total > limit) {
        onAbortNeeded();
        throw new LedgerStatusResponseError("oversize", "Ledger status response exceeds the configured byte limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await cancelQuietly(body);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== null && total !== declaredLength) {
    throw new LedgerStatusResponseError("malformed", "Ledger status response length did not match its declaration.");
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function createLedgerStatusReader(options: LedgerStatusReaderOptions = {}): LedgerStatusReader {
  const endpoint = normalizeLedgerEndpointBase(options.endpoint ?? DEFAULT_LEDGER_STATUS_ENDPOINT);
  const timeoutMs = positiveIntegerOption(
    options.timeoutMs,
    DEFAULT_LEDGER_STATUS_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxResponseBytes = positiveIntegerOption(
    options.maxResponseBytes,
    DEFAULT_LEDGER_STATUS_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const maxItemCount = positiveIntegerOption(
    options.maxItemCount,
    DEFAULT_LEDGER_STATUS_MAX_ITEM_COUNT,
    "maxItemCount",
  );
  const doFetch = options.fetchImpl ?? fetch;
  const recorded: RecordedLedgerStatusRequest[] = [];

  async function listProjectItems(project: string): Promise<LedgerStatusItem[]> {
    assertLedgerStatusRead("GET", ITEMS_PATH);
    const projectName = String(project ?? "").trim();
    if (
      !projectName ||
      projectName.length > MAX_PROJECT_LENGTH ||
      /[\u0000-\u001F\u007F]/.test(projectName)
    ) {
      throw boundaryError("Project name must be a plain bounded string.");
    }

    const url = `${endpoint}/api/v1/items?project=${encodeURIComponent(projectName)}`;
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    recorded.push({ method: "GET", url });

    const controller = new AbortController();
    let deadlineExceeded = false;
    const timeoutFailure = () =>
      new LedgerStatusResponseError("timeout", "Ledger status read exceeded its time budget.");
    let deadlineReject: ((failure: LedgerStatusResponseError) => void) | undefined;
    // The deadline bounds every phase (connect, headers, streamed body) even
    // when an injected fetch implementation ignores the abort signal.
    const deadline = new Promise<never>((_, reject) => {
      deadlineReject = reject;
    });
    deadline.catch(() => {});
    const timer = setTimeout(() => {
      deadlineExceeded = true;
      try {
        controller.abort();
      } catch {
        // An already-aborted controller stays aborted.
      }
      deadlineReject?.(timeoutFailure());
    }, timeoutMs);

    const markAbortNeeded = () => {
      try {
        controller.abort();
      } catch {
        // An already-aborted controller stays aborted.
      }
    };

    try {
      let response: Response;
      try {
        response = await Promise.race([
          doFetch(url, { method: "GET", headers, signal: controller.signal }),
          deadline,
        ]);
      } catch (error) {
        if (error instanceof LedgerStatusResponseError) throw error;
        if (deadlineExceeded || controller.signal.aborted) throw timeoutFailure();
        throw new LedgerStatusResponseError("network", "Ledger status read failed before a response arrived.");
      }

      if (!response.ok) {
        await cancelQuietly(response.body);
        throw new LedgerStatusResponseError(
          "http",
          `Ledger status read failed (HTTP ${response.status}).`,
          response.status,
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await Promise.race([
          readBoundedBody(response, maxResponseBytes, markAbortNeeded),
          deadline,
        ]);
      } catch (error) {
        if (error instanceof LedgerStatusResponseError) throw error;
        if (deadlineExceeded) throw timeoutFailure();
        throw new LedgerStatusResponseError(
          "network",
          "Ledger status read failed before a complete response arrived.",
        );
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new LedgerStatusResponseError("malformed", "Ledger status response was not valid JSON.");
      }

      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
        throw new LedgerStatusResponseError("malformed", "Ledger status response envelope was malformed.");
      }
      const rawItems = (envelope as Record<string, unknown>).items;
      if (rawItems === undefined) return [];
      if (!Array.isArray(rawItems)) {
        throw new LedgerStatusResponseError("malformed", "Ledger status response items were malformed.");
      }
      if (rawItems.length > maxItemCount) {
        throw new LedgerStatusResponseError("oversize", "Ledger status response exceeds the configured item limit.");
      }
      return rawItems.map((raw, index) => validateStatusItem(raw, index));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listProjectItems,
    recordedRequests: () => [...recorded],
  };
}
