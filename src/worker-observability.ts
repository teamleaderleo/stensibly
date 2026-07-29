export const FAILURE_CATEGORY_HEADER = "x-stensibly-failure-category";
export const PROCESSING_STAGE_HEADER = "x-stensibly-processing-stage";
export const REQUEST_ID_HEADER = "x-request-id";
export const WORKER_VERSION_CREATED_AT_HEADER = "x-stensibly-worker-version-created-at";
export const WORKER_VERSION_ID_HEADER = "x-stensibly-worker-version-id";
export const WORKER_VERSION_TAG_HEADER = "x-stensibly-worker-version-tag";

export type FailureCategory =
  | "auth_failure"
  | "authorization_failure"
  | "cors_rejection"
  | "convex_failure"
  | "mcp_failure"
  | "gateway_failure"
  | "request_failure";

export type RouteClass = "health" | "rest_v1" | "mcp" | "other";

export interface WorkerVersionReceipt {
  id: string;
  tag?: string;
  createdAt?: string;
}

export interface RequestLogRecord {
  event: "request.complete";
  requestId: string;
  method: string;
  route: RouteClass;
  status: number;
  durationMs: number;
  outcome: "success" | "failure";
  processingStage: "response_produced";
  failureCategory?: FailureCategory;
  workerVersionId?: string;
  workerVersionTag?: string;
  workerVersionCreatedAt?: string;
}

export interface ObserveRequestOptions {
  allowedOrigins?: string[];
  createRequestId?: () => string;
  log?: (record: RequestLogRecord) => void;
  now?: () => number;
  workerVersion?: WorkerVersionReceipt;
}

export async function observeWorkerRequest(
  request: Request,
  handle: (request: Request) => Promise<Response>,
  options: ObserveRequestOptions = {},
): Promise<Response> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const requestId = acceptedRequestId(request.headers.get(REQUEST_ID_HEADER))
    ?? (options.createRequestId ?? (() => crypto.randomUUID()))();
  const workerVersion = normalizeWorkerVersionReceipt(options.workerVersion);
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  const observedRequest = new Request(request, { headers });

  let response: Response;
  try {
    response = await handle(observedRequest);
  } catch {
    response = new Response(JSON.stringify({
      error: "Unexpected gateway error",
      code: "gateway_failure",
    }), {
      status: 500,
      headers: {
        "content-type": "application/json",
        [FAILURE_CATEGORY_HEADER]: "gateway_failure",
      },
    });
  }

  const responseHeaders = new Headers(response.headers);
  const explicitCategory = parseFailureCategory(
    responseHeaders.get(FAILURE_CATEGORY_HEADER),
  );
  responseHeaders.delete(FAILURE_CATEGORY_HEADER);
  responseHeaders.set(REQUEST_ID_HEADER, requestId);
  responseHeaders.set(PROCESSING_STAGE_HEADER, "response_produced");
  if (workerVersion?.id) {
    responseHeaders.set(WORKER_VERSION_ID_HEADER, workerVersion.id);
  }
  if (workerVersion?.tag) {
    responseHeaders.set(WORKER_VERSION_TAG_HEADER, workerVersion.tag);
  }
  if (workerVersion?.createdAt) {
    responseHeaders.set(WORKER_VERSION_CREATED_AT_HEADER, workerVersion.createdAt);
  }

  const route = classifyRoute(new URL(request.url).pathname);
  const failureCategory = response.status >= 400
    ? explicitCategory ?? inferFailureCategory(
      request,
      response.status,
      route,
      options.allowedOrigins ?? [],
    )
    : undefined;
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  const record: RequestLogRecord = {
    event: "request.complete",
    requestId,
    method: request.method,
    route,
    status: response.status,
    durationMs,
    outcome: response.status < 400 ? "success" : "failure",
    processingStage: "response_produced",
    ...(failureCategory ? { failureCategory } : {}),
    ...(workerVersion?.id ? { workerVersionId: workerVersion.id } : {}),
    ...(workerVersion?.tag ? { workerVersionTag: workerVersion.tag } : {}),
    ...(workerVersion?.createdAt
      ? { workerVersionCreatedAt: workerVersion.createdAt }
      : {}),
  };
  try {
    (options.log ?? defaultLog)(record);
  } catch {
    // Observability failures must never replace an application response.
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export function acceptedRequestId(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) return null;
  return normalized;
}

export function classifyRoute(pathname: string): RouteClass {
  if (pathname === "/health") return "health";
  if (pathname === "/mcp") return "mcp";
  if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) return "rest_v1";
  return "other";
}

function normalizeWorkerVersionReceipt(
  receipt: WorkerVersionReceipt | undefined,
): WorkerVersionReceipt | undefined {
  if (!receipt) return undefined;
  const id = acceptedDiagnosticValue(receipt.id);
  if (!id) return undefined;
  const tag = acceptedDiagnosticValue(receipt.tag);
  const createdAt = acceptedDiagnosticValue(receipt.createdAt);
  return {
    id,
    ...(tag ? { tag } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function acceptedDiagnosticValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(normalized)) return undefined;
  return normalized;
}

function inferFailureCategory(
  request: Request,
  status: number,
  route: RouteClass,
  allowedOrigins: string[],
): FailureCategory {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.includes(origin)) return "cors_rejection";
  if (status === 401) return "auth_failure";
  if (status === 403) return "authorization_failure";
  if (route === "mcp") return "mcp_failure";
  if (route === "rest_v1" && status >= 500) return "convex_failure";
  if (route === "rest_v1") return "request_failure";
  return "gateway_failure";
}

function parseFailureCategory(value: string | null): FailureCategory | undefined {
  if (!value) return undefined;
  const categories: FailureCategory[] = [
    "auth_failure",
    "authorization_failure",
    "cors_rejection",
    "convex_failure",
    "mcp_failure",
    "gateway_failure",
    "request_failure",
  ];
  return categories.includes(value as FailureCategory)
    ? value as FailureCategory
    : undefined;
}

function defaultLog(record: RequestLogRecord): void {
  console.log(JSON.stringify(record));
}
