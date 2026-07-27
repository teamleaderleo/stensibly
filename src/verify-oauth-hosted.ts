const DEFAULT_ENDPOINT = "https://api.stensibly.com";
const DEFAULT_ISSUER = "https://api.stensibly.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_RESPONSE_BODY_BYTES = 32 * 1024;
const MAX_CHALLENGE_LENGTH = 2_048;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type OAuthExpectation = "enabled" | "disabled";

export interface VerifyOAuthHostedOptions {
  endpoint: string;
  issuer: string;
  expectation: OAuthExpectation;
  timeoutMs?: number;
}

export interface ParsedVerifyOAuthHostedArgs {
  help: boolean;
  options?: VerifyOAuthHostedOptions;
}

export interface OAuthCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ResponseDocument {
  response: Response;
  body: unknown;
}

class VerificationError extends Error {}

export function parseVerifyOAuthHostedArgs(
  rawArgs: string[],
  env: Record<string, string | undefined> = process.env,
): ParsedVerifyOAuthHostedArgs {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
  let endpoint = env.STENSIBLY_ENDPOINT ?? DEFAULT_ENDPOINT;
  let issuer = env.STENSIBLY_OAUTH_ISSUER ?? DEFAULT_ISSUER;
  let expectation = env.STENSIBLY_OAUTH_EXPECTATION ?? "enabled";

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
    if (argument === "--expect") {
      expectation = requireValue(args, ++index, "--expect");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    help: false,
    options: {
      endpoint: normalizeOrigin(endpoint, "endpoint"),
      issuer: normalizeOrigin(issuer, "issuer"),
      expectation: normalizeExpectation(expectation),
    },
  };
}

export async function verifyOAuthHosted(
  options: VerifyOAuthHostedOptions,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthCheckResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("timeoutMs must be an integer between 100 and 60000");
  }
  const normalized: Required<VerifyOAuthHostedOptions> = {
    endpoint: normalizeOrigin(options.endpoint, "endpoint"),
    issuer: normalizeOrigin(options.issuer, "issuer"),
    expectation: normalizeExpectation(options.expectation),
    timeoutMs,
  };
  const results: OAuthCheckResult[] = [];

  results.push(await runCheck("health surfaces", async () => {
    const { response, body } = await requestDocument(
      fetchImpl,
      url(normalized.endpoint, "/health"),
      { method: "GET" },
      normalized.timeoutMs,
    );
    expectStatus(response, 200);
    if (
      !isRecord(body)
      || body.ok !== true
      || body.service !== "stensibly"
      || body.backend !== "convex"
      || !Array.isArray(body.surfaces)
    ) {
      throw responseError(response, "Hosted health contract is invalid");
    }
    const surfaces = body.surfaces.filter((value): value is string => typeof value === "string");
    if (!surfaces.includes("auth")) {
      throw responseError(response, "Hosted GitHub auth surface is not enabled");
    }
    if (normalized.expectation === "enabled" && !surfaces.includes("oauth")) {
      throw responseError(response, "Expected OAuth surface to be enabled");
    }
    if (normalized.expectation === "disabled" && surfaces.includes("oauth")) {
      throw responseError(response, "Expected OAuth surface to be disabled");
    }
    return normalized.expectation === "enabled"
      ? "200 required hosted surfaces present"
      : "200 hosted auth present and OAuth disabled";
  }));

  results.push(await runCheck("protected-resource metadata", async () => {
    const { response, body } = await requestDocument(
      fetchImpl,
      url(normalized.endpoint, "/.well-known/oauth-protected-resource/mcp"),
      { method: "GET" },
      normalized.timeoutMs,
    );
    if (normalized.expectation === "disabled") {
      expectStatus(response, 404);
      return "404 OAuth metadata disabled";
    }
    expectStatus(response, 200);
    if (
      !isRecord(body)
      || body.resource !== `${normalized.issuer}/mcp`
      || !arrayEquals(body.authorization_servers, [normalized.issuer])
      || !arrayIncludesAll(body.scopes_supported, ["read", "write"])
      || !arrayIncludesAll(body.bearer_methods_supported, ["header"])
    ) {
      throw responseError(response, "Protected-resource metadata is invalid");
    }
    return `200 resource=${normalized.issuer}/mcp`;
  }));

  results.push(await runCheck("authorization-server metadata", async () => {
    const { response, body } = await requestDocument(
      fetchImpl,
      url(normalized.endpoint, "/.well-known/oauth-authorization-server"),
      { method: "GET" },
      normalized.timeoutMs,
    );
    if (normalized.expectation === "disabled") {
      expectStatus(response, 404);
      return "404 OAuth metadata disabled";
    }
    expectStatus(response, 200);
    if (
      !isRecord(body)
      || body.issuer !== normalized.issuer
      || body.authorization_endpoint !== `${normalized.issuer}/oauth/authorize`
      || body.token_endpoint !== `${normalized.issuer}/oauth/token`
      || body.registration_endpoint !== `${normalized.issuer}/oauth/register`
      || !arrayIncludesAll(body.scopes_supported, ["read", "write", "offline_access"])
      || !arrayIncludesAll(body.response_types_supported, ["code"])
      || !arrayIncludesAll(body.grant_types_supported, ["authorization_code", "refresh_token"])
      || !arrayIncludesAll(body.code_challenge_methods_supported, ["S256"])
      || !arrayIncludesAll(body.token_endpoint_auth_methods_supported, ["none"])
    ) {
      throw responseError(response, "Authorization-server metadata is invalid");
    }
    return `200 issuer=${normalized.issuer}`;
  }));

  results.push(await runCheck("required-token MCP challenge", async () => {
    const { response } = await mcpInitialize(fetchImpl, normalized, undefined);
    expectStatus(response, 401);
    const challenge = readBearerChallenge(response);
    if (normalized.expectation === "enabled") {
      requireChallengePart(
        response,
        challenge,
        `resource_metadata="${normalized.issuer}/.well-known/oauth-protected-resource/mcp"`,
        "resource metadata",
      );
      requireChallengePart(response, challenge, 'scope="read write"', "read/write scope");
    } else if (/resource_metadata=/i.test(challenge)) {
      throw responseError(response, "Disabled OAuth challenge advertises resource metadata");
    }
    return normalized.expectation === "enabled"
      ? "401 OAuth discovery challenge"
      : "401 bearer-only challenge";
  }));

  results.push(await runCheck("invalid-token MCP challenge", async () => {
    const { response } = await mcpInitialize(
      fetchImpl,
      normalized,
      "Bearer verifier.invalid.token",
    );
    expectStatus(response, 401);
    const challenge = readBearerChallenge(response);
    if (normalized.expectation === "enabled") {
      requireChallengePart(
        response,
        challenge,
        `resource_metadata="${normalized.issuer}/.well-known/oauth-protected-resource/mcp"`,
        "resource metadata",
      );
      requireChallengePart(response, challenge, 'error="invalid_token"', "invalid-token error");
    } else if (/resource_metadata=|error="invalid_token"/i.test(challenge)) {
      throw responseError(response, "Disabled OAuth challenge advertises OAuth token handling");
    }
    return normalized.expectation === "enabled"
      ? "401 error=invalid_token"
      : "401 bearer-only invalid token";
  }));

  return results;
}

export function formatOAuthResults(results: OAuthCheckResult[]): string {
  const lines = results.map((result) =>
    `[${result.ok ? "PASS" : "FAIL"}] ${result.name}: ${result.detail}`
  );
  const passed = results.filter((result) => result.ok).length;
  lines.push(`${passed}/${results.length} OAuth hosted checks passed`);
  return lines.join("\n");
}

export function oauthUsage(): string {
  return `Stensibly OAuth hosted verifier

Usage:
  bun run verify:oauth -- [options]

Options:
  --endpoint URL             Worker origin to request (default: ${DEFAULT_ENDPOINT})
  --issuer URL               Canonical OAuth issuer (default: ${DEFAULT_ISSUER})
  --expect enabled|disabled  Expected OAuth state (default: enabled)
  -h, --help                 Show this help

Environment aliases:
  STENSIBLY_ENDPOINT
  STENSIBLY_OAUTH_ISSUER
  STENSIBLY_OAUTH_EXPECTATION

All checks are unauthenticated and read-only. Redirects are rejected. Response bodies
and challenge headers are bounded, validated, and never copied into diagnostics. The
verifier does not register a client, start a login, exchange a token, or mutate Convex state.`;
}

async function mcpInitialize(
  fetchImpl: FetchLike,
  options: Required<VerifyOAuthHostedOptions>,
  authorization: string | undefined,
): Promise<ResponseDocument> {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  });
  if (authorization) headers.set("Authorization", authorization);
  return await requestDocument(
    fetchImpl,
    url(options.endpoint, "/mcp"),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "stensibly-oauth-verifier", version: "0.0.1" },
        },
      }),
    },
    options.timeoutMs,
  );
}

async function runCheck(
  name: string,
  check: () => Promise<string>,
): Promise<OAuthCheckResult> {
  try {
    return { name, ok: true, detail: await check() };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof VerificationError ? error.message : "Unexpected verifier failure",
    };
  }
}

async function requestDocument(
  fetchImpl: FetchLike,
  input: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<ResponseDocument> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response);
      throw responseError(response, "Redirects are not allowed");
    }
    const bytes = await readBoundedBody(response, controller.signal, timeoutMs);
    return { response, body: parseJsonBody(response, bytes) };
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    if (controller.signal.aborted) {
      throw new VerificationError(`Request timed out after ${timeoutMs}ms`);
    }
    throw new VerificationError("Request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_RESPONSE_BODY_BYTES) {
      await cancelBody(response);
      throw responseError(response, "Response body exceeds the verifier limit");
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal, timeoutMs);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw responseError(response, "Response body exceeds the verifier limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number,
) {
  if (signal.aborted) throw new VerificationError(`Request timed out after ${timeoutMs}ms`);
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(new VerificationError(`Request timed out after ${timeoutMs}ms`));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function parseJsonBody(response: Response, bytes: Uint8Array): unknown {
  if (!bytes.byteLength) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw responseError(response, "Response body is not valid JSON");
  }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function expectStatus(response: Response, expected: number): void {
  if (response.status !== expected) {
    throw responseError(
      response,
      `Expected HTTP ${expected}; received HTTP ${response.status}`,
    );
  }
}

function readBearerChallenge(response: Response): string {
  const challenge = response.headers.get("www-authenticate") ?? "";
  if (!challenge) throw responseError(response, "Bearer challenge is missing");
  if (
    challenge.length > MAX_CHALLENGE_LENGTH
    || /[^\x20-\x7e]/.test(challenge)
  ) {
    throw responseError(response, "Bearer challenge is invalid or exceeds the verifier limit");
  }
  if (!/^\s*Bearer\b/i.test(challenge)) {
    throw responseError(response, "Expected a Bearer challenge");
  }
  return challenge;
}

function requireChallengePart(
  response: Response,
  challenge: string,
  expected: string,
  label: string,
): void {
  if (!challenge.includes(expected)) {
    throw responseError(response, `Bearer challenge is missing ${label}`);
  }
}

function arrayEquals(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function arrayIncludesAll(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && expected.every((entry) => value.includes(entry));
}

function normalizeExpectation(value: string): OAuthExpectation {
  const normalized = value.trim().toLowerCase();
  if (normalized === "enabled" || normalized === "disabled") return normalized;
  throw new Error("OAuth expectation must be enabled or disabled");
}

function normalizeOrigin(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function url(endpoint: string, pathname: string): URL {
  return new URL(pathname, `${endpoint}/`);
}

function responseError(response: Response, message: string): VerificationError {
  const requestId = responseRequestId(response);
  return new VerificationError(requestId ? `${message}; requestId=${requestId}` : message);
}

function responseRequestId(response: Response): string | null {
  const value = response.headers.get("x-request-id")?.trim();
  if (!value || !REQUEST_ID_PATTERN.test(value)) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  try {
    const parsed = parseVerifyOAuthHostedArgs(Bun.argv.slice(2));
    if (parsed.help) {
      console.log(oauthUsage());
    } else if (parsed.options) {
      const results = await verifyOAuthHosted(parsed.options);
      console.log(formatOAuthResults(results));
      if (results.some((result) => !result.ok)) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Verifier setup failed");
    process.exitCode = 1;
  }
}
