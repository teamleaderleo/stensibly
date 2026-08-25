/**
 * Read-only ledger status reader for studio monitors (#1632 monitor path).
 *
 * Structural boundary: this module can only issue one request shape,
 * `GET /api/v1/items`. Any other method or path is refused before a
 * connection is opened. Mutation surfaces (create, claim, renew, handoff,
 * block, unblock, release, complete, events, artifacts) are deliberately
 * not modeled here and cannot be reached through this client.
 */

export const LEDGER_STATUS_READ_METHODS = ["GET"] as const;
export type LedgerStatusReadMethod = (typeof LEDGER_STATUS_READ_METHODS)[number];

export const LEDGER_STATUS_READ_PATHS = ["/api/v1/items"] as const;
export type LedgerStatusReadPath = (typeof LEDGER_STATUS_READ_PATHS)[number];

/** Default hosted ledger endpoint used when no explicit endpoint is given. */
export const DEFAULT_LEDGER_STATUS_ENDPOINT = "https://api.stensibly.com";

export class LedgerStatusReadBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerStatusReadBoundaryError";
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
  status: "ready" | "active" | "blocked" | "done" | "archived";
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
}

export function createLedgerStatusReader(options: LedgerStatusReaderOptions = {}): LedgerStatusReader {
  const endpoint = (options.endpoint ?? DEFAULT_LEDGER_STATUS_ENDPOINT).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const recorded: RecordedLedgerStatusRequest[] = [];

  async function listProjectItems(project: string): Promise<LedgerStatusItem[]> {
    assertLedgerStatusRead("GET", ITEMS_PATH);
    const url = `${endpoint}/api/v1/items?project=${encodeURIComponent(project)}`;
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    recorded.push({ method: "GET", url });
    const response = await doFetch(url, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`Ledger status read failed for ${url} (HTTP ${response.status})`);
    }
    const data = (await response.json()) as { items?: unknown };
    return Array.isArray(data.items) ? (data.items as LedgerStatusItem[]) : [];
  }

  return {
    listProjectItems,
    recordedRequests: () => [...recorded],
  };
}
