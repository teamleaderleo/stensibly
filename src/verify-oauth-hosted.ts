const DEFAULT_ENDPOINT = "https://api.stensibly.com";
const DEFAULT_ISSUER = "https://api.stensibly.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CHALLENGE_HEADER_CHARS = 4_096;
const UNSAFE_HEADER_CHARACTERS = /[\u0000-\u0008\u000A-\u001F\u007F]/;

export const MAX_OAUTH_VERIFY_RESPONSE_BYTES = 64 * 1024;

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

interface CheckedResponse {
  response: Response;
  body: unknown;
}

class VerifierFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierFailure";
  }
}

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
    const { response, body } = await requestJson(
      fetchImpl,
      url(normalized.endpoint, "/health"),
      { method: "GET" },
      normalized.timeoutMs,
      200,
    );
    if (
      !isRecord(body)
      || body.ok !== true
      || body.backend !== "convex"
      || !Array.isArray(body.surfaces)
    ) {
      throw responseFailure(response, "Hosted health contract is incomplete");
    }
    const surfaces = body.surfaces.filter((value): value is string => typeof value === "string");
    if (!surfaces.includes("auth")) {
      throw responseFailure(response, "Hosted GitHub auth surface is not enabled");
    }
    if (normalized.expectation === "enabled" && !surfaces.includes("oauth")) {
      throw responseFailure(response, "Expected OAuth surface to be enabled");
    }
    if (normalized.expectation === "disabled" && surfaces.includes("oauth")) {
      throw responseFailure(response, "Expected OAuth surface to be disabled");
    }
    return "200 healthy hosted surfaces verified";
  }));

  results.push(await runCheck("protected-resource metadata", async () => {
    const expectedStatus = normalized.expectation === "disabled" ? 404 : 200;
    const { response, body } = await requestJson(
      fetchImpl,
      url(normalized.endpoint, "/.well-known/oauth-protected-resource/mcp"),
      { method: "GET" },
      normalized.timeoutMs,
      expectedStatus,
    );
    if (normalized.expectation === "disabled") return "404 OAuth metadata disabled";
    if (
      !isRecord(body)
      || body.resource !== `${normalized.issuer}/mcp`
      || !arrayEquals(body.authorization_servers, [normalized.issuer])
      || !arrayIncludesAll(body.scopes_supported, ["read", "write"])
      || !arrayIncludesAll(body.bearer_methods_supported, ["header"])
    ) {
      throw responseFailure(response, "Protected-resource metadata does not match the canonical issuer");
    }
    return `200 resource=${normalized.issuer}/mcp`;
  }));

  results.push(await runCheck("authorization-server metadata", async () => {
    const expectedStatus = normalized.expectation === "disabled" ? 404 : 200;
    const { response, body } = await requestJson(
      fetchImpl,
      url(normalized.endpoint, "/.well-known/oauth-authorization-server"),
      { method: "GET" },
      normalized.timeoutMs,
      expectedStatus,
    );
    if (normalized.expectation === "disabled") return "404 OAuth metadata disabled";
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
      throw responseFailure(response, "Authorization-server metadata does not match the required code flow");
    }
    return `200 issuer=${normalized.issuer}`;
  }));

  results.push(await runCheck("required-token MCP challenge", async () => {
    const { response } = await mcpInitialize(fetchImpl, normalized, undefined);
    const challenge = boundedChallenge(response);
    requireBearerChallenge(response, challenge);
    if (normalized.expectation === "enabled") {
      requireChallengePart(
        response,
        challenge,
        `resource_metadata="${normalized.issuer}/.well-known/oauth-protected-resource/mcp"`,
        "required resource metadata",
      );
      requireChallengePart(response, challenge, 'scope="read write"', "required read/write scope");
    } else if (/resource_metadata=/i.test(challenge)) {
      throw responseFailure(response, "Disabled OAuth challenge still advertises resource metadata");
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
    const challenge = boundedChallenge(response);
    requireBearerChallenge(response, challenge);
    if (normalized.expectation === "enabled") {
      requireChallengePart(
        response,
        challenge,
        `resource_metadata="${normalized.issuer}/.well-known/oauth-protected-resource/mcp"`,
        "required resource metadata",
      );
      requireChallengePart(response, challenge, 'error="invalid_token"', "invalid-token classification");
    } else if (/resource_metadata=|error="invalid_token"/i.test(challenge)) {
      throw responseFailure(response, "Disabled OAuth challenge still advertises OAuth token handling");
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

All checks are unauthenticated and read-only. The verifier does not register a client,
start a login, exchange a token, or mutate Convex state.`;
}

async function mcpInitialize(
  fetchImpl: FetchLike,
  options: Required<VerifyOAuthHostedOptions>,
  authorization: string | undefined,
): Promise<CheckedResponse> {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  });
  if (authorization) headers.set("Authorization", authorization);
  return await requestJson(
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
          clientInfo: { name: "stensibly-oauth-verifier", version: "0.0.2" },
        },
      }),
    },
    options.timeoutMs,
    401,
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
      detail: error instanceof VerifierFailure ? error.message : "Unexpected verifier failure",
    };
  }
}

async function requestJson(
  fetchImpl: FetchLike,
  input: URL,
  init: RequestInit,
  timeoutMs: number,
  expectedStatus: number,
): Promise<CheckedResponse> {
  const controller = new AbortController();
  const timeoutFailure = new VerifierFailure(`Request timed out after ${timeoutMs}ms`);
  let response: Response | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutFailure);
    }, timeoutMs);
  });

  try {
    response = await Promise.race([
      fetchImpl(input, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      }),
      deadline,
    ]);
    assertNoRedirect(response, input);
    if (response.status !== expectedStatus) {
      throw responseFailure(
        response,
        `Expected HTTP ${expectedStatus}; received HTTP ${response.status}`,
      );
    }
    const body = await Promise.race([readJsonBounded(response), deadline]);
    return { response, body };
  } catch (error) {
    if (timedOut) {
      void response?.body?.cancel().catch(() => undefined);
      throw timeoutFailure;
    }
    if (error instanceof VerifierFailure) throw error;
    throw new VerifierFailure("Request failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertNoRedirect(response: Response, requested: URL): void {
  if (response.status >= 300 && response.status < 400) {
    throw responseFailure(response, `Unexpected redirect response HTTP ${response.status}`);
  }
  if (response.redirected) {
    throw responseFailure(response, "Unexpected redirected response");
  }
  if (response.url) {
    let finalUrl: URL;
    try {
      finalUrl = new URL(response.url);
    } catch {
      throw responseFailure(response, "Response URL is invalid");
    }
    if (finalUrl.origin !== requested.origin) {
      throw responseFailure(response, "Response origin differs from the requested endpoint");
    }
  }
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > MAX_OAUTH_VERIFY_RESPONSE_BYTES) {
      throw responseFailure(response, "Response body exceeds the verifier byte limit");
    }
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_OAUTH_VERIFY_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw responseFailure(response, "Response body exceeds the verifier byte limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw responseFailure(response, "Response body is not valid UTF-8 JSON");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw responseFailure(response, "Response body is not valid JSON");
  }
}

function boundedChallenge(response: Response): string {
  const challenge = response.headers.get("www-authenticate") ?? "";
  if (!challenge) throw responseFailure(response, "Bearer challenge is missing");
  if (challenge.length > MAX_CHALLENGE_HEADER_CHARS) {
    throw responseFailure(response, "Bearer challenge exceeds the verifier character limit");
  }
  if (UNSAFE_HEADER_CHARACTERS.test(challenge)) {
    throw responseFailure(response, "Bearer challenge contains invalid characters");
  }
  return challenge;
}

function requireBearerChallenge(response: Response, challenge: string): void {
  if (!/^\s*Bearer\b/i.test(challenge)) {
    throw responseFailure(response, "Expected a Bearer challenge");
  }
}

function requireChallengePart(
  response: Response,
  challenge: string,
  expected: string,
  classification: string,
): void {
  if (!challenge.includes(expected)) {
    throw responseFailure(response, `Bearer challenge is missing ${classification}`);
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

function responseFailure(response: Response, message: string): VerifierFailure {
  const requestId = responseRequestId(response);
  return new VerifierFailure(requestId ? `${message}; requestId=${requestId}` : message);
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
