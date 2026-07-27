const DEFAULT_REQUESTS = 12;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_REQUESTS = 2;
const MIN_REGISTRATION_REQUESTS = 11;
const MAX_REQUESTS = 50;
const MAX_CONCURRENCY = 10;
const MAX_OAUTH_ERROR_BODY_BYTES = 2 * 1024;
const EXPECTED_RETRY_AFTER_SECONDS = 60;
const CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector/oauth/callback";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_TAG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const KNOWN_PRODUCTION_ENDPOINT_KEYS = new Set([
  endpointPolicyKey("https://api.stensibly.com"),
  endpointPolicyKey("https://stensibly-api.leoli-082000.workers.dev"),
]);

export type OAuthAbuseMode = "registration-burst" | "authorization-invalid";
export type OAuthErrorClass = "temporarily_unavailable" | "invalid_request";
export type OAuthEvidenceFailure =
  | "missing_request_id"
  | "invalid_content_type"
  | "invalid_oauth_error"
  | "body_too_large"
  | "body_unavailable";

export interface OAuthAbuseOptions {
  endpoint: string;
  issuer: string;
  mode: OAuthAbuseMode;
  requests: number;
  concurrency: number;
  timeoutMs?: number;
  execute: boolean;
  runTag?: string;
}

export interface ParsedOAuthAbuseArgs {
  help: boolean;
  options?: OAuthAbuseOptions;
}

export interface OAuthAbuseOutcome {
  index: number;
  status: number | null;
  retryAfter: number | null;
  requestId: string | null;
  locationPresent: boolean;
  oauthError: OAuthErrorClass | null;
  jsonContentType: boolean;
  evidenceFailure: OAuthEvidenceFailure | null;
  transportFailure: "timeout" | "request_failed" | "redirect" | "origin_mismatch" | null;
}

export interface OAuthAbuseResult {
  executed: boolean;
  ok: boolean;
  mode: OAuthAbuseMode;
  endpoint: string;
  issuer: string;
  runTag: string;
  requests: number;
  concurrency: number;
  detail: string;
  counts: Record<string, number>;
  outcomes: OAuthAbuseOutcome[];
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface NormalizedOAuthAbuseOptions extends OAuthAbuseOptions {
  timeoutMs: number;
  runTag: string;
}

interface ResponseEvidence {
  oauthError: OAuthErrorClass | null;
  jsonContentType: boolean;
  evidenceFailure: OAuthEvidenceFailure | null;
}

export function parseOAuthAbuseArgs(
  rawArgs: string[],
  env: Record<string, string | undefined> = process.env,
): ParsedOAuthAbuseArgs {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
  let endpoint = env.STENSIBLY_OAUTH_ABUSE_ENDPOINT;
  let issuer = env.STENSIBLY_OAUTH_ABUSE_ISSUER;
  let mode: string = env.STENSIBLY_OAUTH_ABUSE_MODE ?? "registration-burst";
  let requests = integerValue(
    env.STENSIBLY_OAUTH_ABUSE_REQUESTS ?? String(DEFAULT_REQUESTS),
    "requests",
  );
  let concurrency = integerValue(
    env.STENSIBLY_OAUTH_ABUSE_CONCURRENCY ?? String(DEFAULT_CONCURRENCY),
    "concurrency",
  );
  let timeoutMs = integerValue(
    env.STENSIBLY_OAUTH_ABUSE_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),
    "timeout-ms",
  );
  let runTag = env.STENSIBLY_OAUTH_ABUSE_RUN_TAG;
  let execute = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--endpoint") {
      endpoint = requireValue(args, ++index, "--endpoint");
      continue;
    }
    if (argument === "--issuer") {
      issuer = requireValue(args, ++index, "--issuer");
      continue;
    }
    if (argument === "--mode") {
      mode = requireValue(args, ++index, "--mode");
      continue;
    }
    if (argument === "--requests") {
      requests = integerValue(requireValue(args, ++index, "--requests"), "requests");
      continue;
    }
    if (argument === "--concurrency") {
      concurrency = integerValue(
        requireValue(args, ++index, "--concurrency"),
        "concurrency",
      );
      continue;
    }
    if (argument === "--timeout-ms") {
      timeoutMs = integerValue(
        requireValue(args, ++index, "--timeout-ms"),
        "timeout-ms",
      );
      continue;
    }
    if (argument === "--run-tag") {
      runTag = requireValue(args, ++index, "--run-tag");
      continue;
    }
    if (argument === "--execute-non-production") {
      execute = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!endpoint) throw new Error("--endpoint is required");
  const normalizedEndpoint = normalizeHttpsOrigin(endpoint, "endpoint");
  const normalizedIssuer = normalizeHttpsOrigin(issuer ?? normalizedEndpoint, "issuer");
  const normalizedMode = normalizeMode(mode);
  const normalizedRunTag = normalizeRunTag(runTag);
  validateBounds(normalizedMode, requests, concurrency, timeoutMs);
  rejectKnownProductionEndpoint(normalizedEndpoint);

  return {
    help: false,
    options: {
      endpoint: normalizedEndpoint,
      issuer: normalizedIssuer,
      mode: normalizedMode,
      requests,
      concurrency,
      timeoutMs,
      execute,
      runTag: normalizedRunTag,
    },
  };
}

export async function verifyOAuthAbuse(
  options: OAuthAbuseOptions,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthAbuseResult> {
  const normalized = normalizeOptions(options);
  if (!normalized.execute) {
    return {
      executed: false,
      ok: true,
      mode: normalized.mode,
      endpoint: normalized.endpoint,
      issuer: normalized.issuer,
      runTag: normalized.runTag,
      requests: normalized.requests,
      concurrency: normalized.concurrency,
      detail: "Dry run only; add --execute-non-production to send requests",
      counts: {},
      outcomes: [],
    };
  }
  return normalized.mode === "registration-burst"
    ? await verifyRegistrationBurst(normalized, fetchImpl)
    : await verifyInvalidAuthorizationLoad(normalized, fetchImpl);
}

export function formatOAuthAbuseResult(result: OAuthAbuseResult): string {
  const lines = [
    `[${result.executed ? (result.ok ? "PASS" : "FAIL") : "PLAN"}] ${result.mode}: ${result.detail}`,
    `endpoint=${result.endpoint}`,
    `issuer=${result.issuer}`,
    `runTag=${result.runTag}`,
    `requests=${result.requests}`,
    `concurrency=${result.concurrency}`,
  ];
  const countEntries = Object.entries(result.counts).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (countEntries.length) {
    lines.push(`counts=${countEntries.map(([name, value]) => `${name}:${value}`).join(",")}`);
  }
  for (const outcome of result.outcomes) {
    lines.push([
      `request=${outcome.index + 1}`,
      `status=${outcome.status ?? "none"}`,
      `retryAfter=${outcome.retryAfter ?? "none"}`,
      `requestId=${outcome.requestId ?? "none"}`,
      `oauthError=${outcome.oauthError ?? "none"}`,
      `json=${outcome.jsonContentType ? "yes" : "no"}`,
      `evidence=${outcome.evidenceFailure ?? "ok"}`,
      `location=${outcome.locationPresent ? "present" : "absent"}`,
      `transport=${outcome.transportFailure ?? "ok"}`,
    ].join(" "));
  }
  return lines.join("\n");
}

export function oauthAbuseUsage(): string {
  return `Stensibly guarded OAuth abuse evidence harness

Usage:
  bun run verify:oauth-abuse -- --endpoint URL [options]

Options:
  --endpoint URL                  Non-production Worker origin (required)
  --issuer URL                    Canonical issuer for authorization requests
  --mode MODE                     registration-burst | authorization-invalid
  --requests NUMBER               registration: ${MIN_REGISTRATION_REQUESTS}-${MAX_REQUESTS}; authorization: ${MIN_REQUESTS}-${MAX_REQUESTS}
  --concurrency NUMBER            1-${MAX_CONCURRENCY} in-flight requests (default: ${DEFAULT_CONCURRENCY})
  --timeout-ms NUMBER             100-30000 per request (default: ${DEFAULT_TIMEOUT_MS})
  --run-tag TAG                   1-32 safe characters for retained run correlation
  --execute-non-production        Send requests; otherwise print a dry-run plan
  -h, --help                      Show this help

The command refuses DNS-equivalent spellings of the known production endpoints.
Registration mode creates bounded non-production dynamic-client records. The retained
run tag correlates those rows without exposing client IDs or submitted metadata.
Authorization mode uses a nonexistent client and performs no valid login or consent flow.`;
}

async function verifyRegistrationBurst(
  options: NormalizedOAuthAbuseOptions,
  fetchImpl: FetchLike,
): Promise<OAuthAbuseResult> {
  const outcomes = await runPool(options.requests, options.concurrency, async (index) => {
    const body = JSON.stringify({
      client_name: `Stensibly abuse verifier ${options.runTag}-${index + 1}`,
      redirect_uris: [CHATGPT_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    return await boundedRequest(
      fetchImpl,
      new URL("/oauth/register", `${options.endpoint}/`),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body,
      },
      options,
      index,
    );
  });

  const accepted = outcomes.filter((entry) =>
    entry.status === 201
    && entry.requestId !== null
    && entry.jsonContentType
    && entry.evidenceFailure === null
    && entry.transportFailure === null
  ).length;
  const rateLimited = outcomes.filter((entry) =>
    entry.status === 429
    && entry.retryAfter === EXPECTED_RETRY_AFTER_SECONDS
    && entry.requestId !== null
    && entry.oauthError === "temporarily_unavailable"
    && entry.jsonContentType
    && entry.evidenceFailure === null
    && entry.transportFailure === null
  ).length;
  const counts = {
    accepted,
    rateLimited,
    invalid: outcomes.filter((entry) => entry.status === 400 && !entry.transportFailure).length,
    unavailable: outcomes.filter((entry) =>
      (entry.status === 502 || entry.status === 503) && !entry.transportFailure
    ).length,
    evidenceFailed: outcomes.filter((entry) => entry.evidenceFailure !== null).length,
    unexpected: outcomes.filter((entry) =>
      !isAcceptedRegistration(entry) && !isExpectedRateLimit(entry)
    ).length,
  };
  const ok = accepted > 0 && rateLimited > 0 && counts.unexpected === 0;
  return result(options, outcomes, counts, ok,
    ok
      ? "Observed accepted registration and bounded Stensibly OAuth rate limiting"
      : "Expected at least one classified 201 and one classified 429 with Retry-After 60, with no other outcomes");
}

async function verifyInvalidAuthorizationLoad(
  options: NormalizedOAuthAbuseOptions,
  fetchImpl: FetchLike,
): Promise<OAuthAbuseResult> {
  const outcomes = await runPool(options.requests, options.concurrency, async (index) => {
    const requestUrl = new URL("/oauth/authorize", `${options.endpoint}/`);
    requestUrl.searchParams.set("response_type", "code");
    requestUrl.searchParams.set("client_id", "oauth_client_abuseverify01");
    requestUrl.searchParams.set("redirect_uri", CHATGPT_REDIRECT_URI);
    requestUrl.searchParams.set("code_challenge", "a".repeat(43));
    requestUrl.searchParams.set("code_challenge_method", "S256");
    requestUrl.searchParams.set("scope", "read offline_access");
    requestUrl.searchParams.set("resource", `${options.issuer}/mcp`);
    requestUrl.searchParams.set("state", `abuse-${options.runTag}-${index + 1}`);
    return await boundedRequest(
      fetchImpl,
      requestUrl,
      { method: "GET", headers: { Accept: "application/json" } },
      options,
      index,
    );
  });

  const rejected = outcomes.filter(isExpectedInvalidAuthorization).length;
  const counts = {
    rejected,
    redirected: outcomes.filter((entry) => entry.locationPresent || entry.transportFailure === "redirect")
      .length,
    unavailable: outcomes.filter((entry) =>
      (entry.status === 502 || entry.status === 503) && !entry.transportFailure
    ).length,
    evidenceFailed: outcomes.filter((entry) => entry.evidenceFailure !== null).length,
    unexpected: outcomes.filter((entry) => !isExpectedInvalidAuthorization(entry)).length,
  };
  const ok = rejected === options.requests && counts.unexpected === 0;
  return result(options, outcomes, counts, ok,
    ok
      ? "All invalid-client authorization requests returned the classified Stensibly invalid_request response without redirects"
      : "Expected every invalid-client authorization request to return classified JSON invalid_request without redirect");
}

function result(
  options: NormalizedOAuthAbuseOptions,
  outcomes: OAuthAbuseOutcome[],
  counts: Record<string, number>,
  ok: boolean,
  detail: string,
): OAuthAbuseResult {
  return {
    executed: true,
    ok,
    mode: options.mode,
    endpoint: options.endpoint,
    issuer: options.issuer,
    runTag: options.runTag,
    requests: options.requests,
    concurrency: options.concurrency,
    detail,
    counts,
    outcomes,
  };
}

function isAcceptedRegistration(entry: OAuthAbuseOutcome): boolean {
  return entry.status === 201
    && entry.requestId !== null
    && entry.jsonContentType
    && entry.evidenceFailure === null
    && entry.transportFailure === null;
}

function isExpectedRateLimit(entry: OAuthAbuseOutcome): boolean {
  return entry.status === 429
    && entry.retryAfter === EXPECTED_RETRY_AFTER_SECONDS
    && entry.requestId !== null
    && entry.oauthError === "temporarily_unavailable"
    && entry.jsonContentType
    && entry.evidenceFailure === null
    && entry.transportFailure === null;
}

function isExpectedInvalidAuthorization(entry: OAuthAbuseOutcome): boolean {
  return entry.status === 400
    && !entry.locationPresent
    && entry.requestId !== null
    && entry.oauthError === "invalid_request"
    && entry.jsonContentType
    && entry.evidenceFailure === null
    && entry.transportFailure === null;
}

async function boundedRequest(
  fetchImpl: FetchLike,
  input: URL,
  init: RequestInit,
  options: NormalizedOAuthAbuseOptions,
  index: number,
): Promise<OAuthAbuseOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("timeout"));
    }, options.timeoutMs);
  });

  const operation = async (): Promise<OAuthAbuseOutcome> => {
    const response = await fetchImpl(input, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    const base = baseOutcome(index, response);
    if (response.status >= 300 && response.status < 400 || response.redirected) {
      await cancelBody(response);
      return { ...base, transportFailure: "redirect" };
    }
    if (response.url) {
      try {
        if (new URL(response.url).origin !== options.endpoint) {
          await cancelBody(response);
          return { ...base, transportFailure: "origin_mismatch" };
        }
      } catch {
        await cancelBody(response);
        return { ...base, transportFailure: "origin_mismatch" };
      }
    }
    const evidence = await inspectResponseEvidence(response, controller.signal);
    return { ...base, ...evidence };
  };

  try {
    return await Promise.race([operation(), timeout]);
  } catch {
    return failureOutcome(index, timedOut ? "timeout" : "request_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function baseOutcome(index: number, response: Response): OAuthAbuseOutcome {
  return {
    index,
    status: response.status,
    retryAfter: boundedRetryAfter(response.headers.get("retry-after")),
    requestId: boundedRequestId(response.headers.get("x-request-id")),
    locationPresent: response.headers.has("location"),
    oauthError: null,
    jsonContentType: false,
    evidenceFailure: null,
    transportFailure: null,
  };
}

function failureOutcome(
  index: number,
  transportFailure: "timeout" | "request_failed",
): OAuthAbuseOutcome {
  return {
    index,
    status: null,
    retryAfter: null,
    requestId: null,
    locationPresent: false,
    oauthError: null,
    jsonContentType: false,
    evidenceFailure: null,
    transportFailure,
  };
}

async function inspectResponseEvidence(
  response: Response,
  signal: AbortSignal,
): Promise<ResponseEvidence> {
  const jsonContentType = response.headers.get("content-type")
    ?.toLowerCase().startsWith("application/json") ?? false;
  const requestId = boundedRequestId(response.headers.get("x-request-id"));
  if (response.status === 201) {
    await cancelBody(response);
    if (!requestId) return { oauthError: null, jsonContentType, evidenceFailure: "missing_request_id" };
    if (!jsonContentType) return { oauthError: null, jsonContentType, evidenceFailure: "invalid_content_type" };
    return { oauthError: null, jsonContentType, evidenceFailure: null };
  }
  if (response.status !== 400 && response.status !== 429) {
    await cancelBody(response);
    return { oauthError: null, jsonContentType, evidenceFailure: null };
  }
  if (!requestId) {
    await cancelBody(response);
    return { oauthError: null, jsonContentType, evidenceFailure: "missing_request_id" };
  }
  if (!jsonContentType) {
    await cancelBody(response);
    return { oauthError: null, jsonContentType, evidenceFailure: "invalid_content_type" };
  }
  const parsed = await readBoundedOAuthError(response, signal);
  return { oauthError: parsed.error, jsonContentType, evidenceFailure: parsed.failure };
}

async function readBoundedOAuthError(
  response: Response,
  signal: AbortSignal,
): Promise<{ error: OAuthErrorClass | null; failure: OAuthEvidenceFailure | null }> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_OAUTH_ERROR_BODY_BYTES) {
    await cancelBody(response);
    return { error: null, failure: "body_too_large" };
  }
  if (!response.body) return { error: null, failure: "body_unavailable" };
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_OAUTH_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { error: null, failure: "body_too_large" };
      }
      chunks.push(next.value);
    }
  } catch {
    if (signal.aborted) throw new Error("aborted");
    return { error: null, failure: "body_unavailable" };
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!isRecord(value)) return { error: null, failure: "invalid_oauth_error" };
    if (value.error === "temporarily_unavailable" || value.error === "invalid_request") {
      return { error: value.error, failure: null };
    }
    return { error: null, failure: "invalid_oauth_error" };
  } catch {
    return { error: null, failure: "invalid_oauth_error" };
  }
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body) await response.body.cancel().catch(() => undefined);
}

async function runPool<T>(
  count: number,
  concurrency: number,
  work: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await work(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
  return results;
}

function normalizeOptions(options: OAuthAbuseOptions): NormalizedOAuthAbuseOptions {
  const endpoint = normalizeHttpsOrigin(options.endpoint, "endpoint");
  const issuer = normalizeHttpsOrigin(options.issuer, "issuer");
  const mode = normalizeMode(options.mode);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  validateBounds(mode, options.requests, options.concurrency, timeoutMs);
  rejectKnownProductionEndpoint(endpoint);
  return {
    ...options,
    endpoint,
    issuer,
    mode,
    timeoutMs,
    runTag: normalizeRunTag(options.runTag),
  };
}

function normalizeHttpsOrigin(value: string, label: string): string {
  const normalized = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw new Error(`${label} must be a valid HTTPS origin`);
  }
  return parsed.origin;
}

function endpointPolicyKey(origin: string): string {
  const parsed = new URL(origin);
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  const port = parsed.port || "443";
  return `${parsed.protocol}//${hostname}:${port}`;
}

function rejectKnownProductionEndpoint(endpoint: string): void {
  if (KNOWN_PRODUCTION_ENDPOINT_KEYS.has(endpointPolicyKey(endpoint))) {
    throw new Error("The OAuth abuse harness refuses known production endpoints");
  }
}

function normalizeMode(value: string): OAuthAbuseMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "registration-burst" || normalized === "authorization-invalid") {
    return normalized;
  }
  throw new Error("mode must be registration-burst or authorization-invalid");
}

function validateBounds(
  mode: OAuthAbuseMode,
  requests: number,
  concurrency: number,
  timeoutMs: number,
): void {
  const minimum = mode === "registration-burst" ? MIN_REGISTRATION_REQUESTS : MIN_REQUESTS;
  if (!Number.isInteger(requests) || requests < minimum || requests > MAX_REQUESTS) {
    throw new Error(`${mode} requests must be an integer between ${minimum} and ${MAX_REQUESTS}`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("timeout-ms must be an integer between 100 and 30000");
  }
}

function normalizeRunTag(value: string | undefined): string {
  const candidate = value?.trim() || crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  if (!RUN_TAG_PATTERN.test(candidate)) throw new Error("runTag is invalid");
  return candidate;
}

function boundedRetryAfter(value: string | null): number | null {
  if (!value || !/^\d{1,4}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 3600 ? parsed : null;
}

function boundedRequestId(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized && REQUEST_ID_PATTERN.test(normalized) ? normalized : null;
}

function integerValue(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  return Number(value);
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  try {
    const parsed = parseOAuthAbuseArgs(Bun.argv.slice(2));
    if (parsed.help) {
      console.log(oauthAbuseUsage());
    } else if (parsed.options) {
      const result = await verifyOAuthAbuse(parsed.options);
      console.log(formatOAuthAbuseResult(result));
      if (result.executed && !result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OAuth abuse verification failed");
    process.exitCode = 1;
  }
}
