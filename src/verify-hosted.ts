import { parseToken } from "./token-provider.js";

const DEFAULT_ENDPOINT = "https://api.stensibly.com";
const DEFAULT_ORIGIN = "https://www.stensibly.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const TOKEN_PATTERN = /stn\.tok_[a-f0-9]{32}\.[A-Za-z0-9_-]{40,}/g;

export interface VerifyHostedOptions {
  endpoint: string;
  token: string;
  origin: string;
  project?: string;
  timeoutMs?: number;
}

export interface ParsedVerifyHostedArgs {
  help: boolean;
  options?: VerifyHostedOptions;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function parseVerifyHostedArgs(
  rawArgs: string[],
  env: Record<string, string | undefined> = process.env,
): ParsedVerifyHostedArgs {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
  let endpoint = env.STENSIBLY_ENDPOINT ?? DEFAULT_ENDPOINT;
  let token = env.STENSIBLY_TOKEN ?? "";
  let origin = env.STENSIBLY_ORIGIN ?? DEFAULT_ORIGIN;
  let project = env.STENSIBLY_PROJECT;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--endpoint") {
      endpoint = requireValue(args, ++index, "--endpoint");
      continue;
    }
    if (argument === "--token") {
      token = requireValue(args, ++index, "--token");
      continue;
    }
    if (argument === "--origin") {
      origin = requireValue(args, ++index, "--origin");
      continue;
    }
    if (argument === "--project") {
      project = requireValue(args, ++index, "--project");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  endpoint = normalizeOrigin(endpoint, "endpoint");
  origin = normalizeOrigin(origin, "origin");
  token = token.trim();
  if (!token) {
    throw new Error("A token is required through --token or STENSIBLY_TOKEN");
  }
  if (!parseToken(token)) {
    throw new Error("The token must use the generated stn.tok_… format");
  }

  const normalizedProject = project?.trim();
  if (normalizedProject && !/^[a-z0-9][a-z0-9-_]*$/.test(normalizedProject)) {
    throw new Error("--project must be a lowercase project slug");
  }

  return {
    help: false,
    options: {
      endpoint,
      token,
      origin,
      ...(normalizedProject ? { project: normalizedProject } : {}),
    },
  };
}

export async function verifyHosted(
  options: VerifyHostedOptions,
  fetchImpl: FetchLike = fetch,
): Promise<CheckResult[]> {
  const normalized: VerifyHostedOptions = {
    ...options,
    endpoint: normalizeOrigin(options.endpoint, "endpoint"),
    origin: normalizeOrigin(options.origin, "origin"),
    token: options.token.trim(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (!parseToken(normalized.token)) {
    throw new Error("The token must use the generated stn.tok_… format");
  }

  const results: CheckResult[] = [];
  results.push(await runCheck("health", normalized, async () => {
    const response = await request(fetchImpl, url(normalized.endpoint, "/health"), {
      method: "GET",
    }, normalized.timeoutMs);
    const body = await readJson(response);
    expectStatus(response, 200, body);
    if (!isRecord(body) || body.backend !== "convex") {
      throw new Error(`Expected backend=convex; received ${jsonPreview(body)}`);
    }
    return "200 backend=convex";
  }));

  results.push(await runCheck("unauthenticated REST", normalized, async () => {
    const response = await request(fetchImpl, itemsUrl(normalized), {
      method: "GET",
    }, normalized.timeoutMs);
    const body = await readJson(response);
    expectStatus(response, 401, body);
    const challenge = response.headers.get("www-authenticate") ?? "";
    if (!/\bbearer\b/i.test(challenge)) {
      throw new Error("Expected a Bearer WWW-Authenticate challenge");
    }
    return "401 Bearer challenge";
  }));

  results.push(await runCheck("REST CORS preflight", normalized, async () => {
    const response = await request(fetchImpl, itemsUrl(normalized), {
      method: "OPTIONS",
      headers: {
        Origin: normalized.origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    }, normalized.timeoutMs);
    const body = await readJson(response);
    expectStatus(response, 204, body);
    const allowedOrigin = response.headers.get("access-control-allow-origin");
    if (allowedOrigin !== normalized.origin) {
      throw new Error(`Expected Access-Control-Allow-Origin ${normalized.origin}; received ${allowedOrigin ?? "missing"}`);
    }
    requireHeaderToken(response, "access-control-allow-headers", "authorization");
    requireHeaderToken(response, "access-control-allow-methods", "get");
    return `204 origin=${normalized.origin}`;
  }));

  results.push(await runCheck("authenticated REST", normalized, async () => {
    const response = await request(fetchImpl, itemsUrl(normalized), {
      method: "GET",
      headers: { Authorization: `Bearer ${normalized.token}` },
    }, normalized.timeoutMs);
    const body = await readJson(response);
    expectStatus(response, 200, body);
    if (!isRecord(body) || !Array.isArray(body.items)) {
      throw new Error(`Expected an items array; received ${jsonPreview(body)}`);
    }
    return `200 items=${body.items.length}${normalized.project ? ` project=${normalized.project}` : ""}`;
  }));

  results.push(await runCheck("remote MCP initialize", normalized, async () => {
    const response = await request(fetchImpl, url(normalized.endpoint, "/mcp"), {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${normalized.token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        Origin: normalized.origin,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "stensibly-hosted-verifier", version: "0.0.1" },
        },
      }),
    }, normalized.timeoutMs);
    const body = await readJson(response);
    expectStatus(response, 200, body);
    const serverInfo = isRecord(body)
      && isRecord(body.result)
      && isRecord(body.result.serverInfo)
      ? body.result.serverInfo
      : null;
    if (serverInfo?.name !== "stensibly") {
      throw new Error(`Expected MCP serverInfo.name=stensibly; received ${jsonPreview(body)}`);
    }
    return `200 protocol=${MCP_PROTOCOL_VERSION} server=stensibly`;
  }));

  return results;
}

export function redactSecrets(value: unknown, token?: string): string {
  let output = value instanceof Error ? value.message : String(value);
  if (token) output = output.split(token).join("[REDACTED]");
  return output.replace(TOKEN_PATTERN, "[REDACTED]");
}

export function formatResults(results: CheckResult[]): string {
  const lines = results.map((result) =>
    `[${result.ok ? "PASS" : "FAIL"}] ${result.name}: ${result.detail}`
  );
  const passed = results.filter((result) => result.ok).length;
  lines.push(`${passed}/${results.length} hosted checks passed`);
  return lines.join("\n");
}

export function usage(): string {
  return `Stensibly hosted verifier

Usage:
  STENSIBLY_TOKEN=stn.tok_… bun run verify:hosted -- [options]
  bun run verify:hosted -- --token stn.tok_… [options]

Options:
  --endpoint URL   API origin (default: ${DEFAULT_ENDPOINT})
  --token TOKEN    Read token; STENSIBLY_TOKEN is preferred for shell history safety
  --origin URL     Browser origin for CORS and MCP checks (default: ${DEFAULT_ORIGIN})
  --project SLUG   Restrict the authenticated items request to one project
  -h, --help       Show this help

Environment aliases:
  STENSIBLY_ENDPOINT
  STENSIBLY_TOKEN
  STENSIBLY_ORIGIN
  STENSIBLY_PROJECT

All checks are read-only. The verifier never prints the token.`;
}

async function runCheck(
  name: string,
  options: VerifyHostedOptions,
  check: () => Promise<string>,
): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: redactSecrets(await check(), options.token) };
  } catch (error) {
    return { name, ok: false, detail: redactSecrets(error, options.token) };
  }
}

async function request(
  fetchImpl: FetchLike,
  input: URL,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function itemsUrl(options: Pick<VerifyHostedOptions, "endpoint" | "project">): URL {
  const output = url(options.endpoint, "/api/v1/items");
  if (options.project) output.searchParams.set("project", options.project);
  return output;
}

function url(endpoint: string, pathname: string): URL {
  return new URL(pathname, `${endpoint}/`);
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

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 300);
  }
}

function expectStatus(response: Response, expected: number, body: unknown): void {
  if (response.status !== expected) {
    throw new Error(`Expected HTTP ${expected}; received HTTP ${response.status}: ${jsonPreview(body)}`);
  }
}

function requireHeaderToken(response: Response, header: string, expected: string): void {
  const raw = response.headers.get(header) ?? "";
  const tokens = raw.split(",").map((entry) => entry.trim().toLowerCase());
  if (!tokens.includes(expected.toLowerCase())) {
    throw new Error(`Expected ${header} to include ${expected}; received ${raw || "missing"}`);
  }
}

function jsonPreview(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (!serialized) return "empty response";
  return serialized.length > 300 ? `${serialized.slice(0, 300)}…` : serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  try {
    const parsed = parseVerifyHostedArgs(Bun.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
    } else if (parsed.options) {
      const results = await verifyHosted(parsed.options);
      console.log(formatResults(results));
      if (results.some((result) => !result.ok)) process.exitCode = 1;
    }
  } catch (error) {
    console.error(redactSecrets(error));
    process.exitCode = 1;
  }
}
