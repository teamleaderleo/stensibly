import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { HostedAccountService, HostedSessionContext } from "./hosted-account-service.js";
import { HOSTED_SESSION_COOKIE, parseHostedSessionCredential } from "./hosted-session-credential.js";
import type {
  McpOAuthClientRecord,
  McpOAuthScope,
  McpOAuthService,
} from "./mcp-oauth-service.js";
import type { StensiblyEnv } from "./http-auth.js";
import {
  base64UrlDecode,
  secureRandomBytes,
} from "./mcp-oauth-crypto.js";
import { FAILURE_CATEGORY_HEADER } from "./worker-observability.js";

const DEFAULT_ACCESS_TOKEN_SECONDS = 10 * 60;
const DEFAULT_AUTHORIZATION_CODE_SECONDS = 5 * 60;
const DEFAULT_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const CONSENT_REQUEST_SECONDS = 10 * 60;
export const MAX_REGISTRATION_BODY_BYTES = 32 * 1024;
const OAUTH_SCOPES = ["read", "write", "offline_access"] as const;

export interface McpOAuthOptions {
  service: McpOAuthService;
  accountService: Pick<HostedAccountService, "authenticateSession">;
  issuer: string;
  resource: string;
  signingSecret: string;
  workspace: string;
  accessTokenSeconds?: number;
  authorizationCodeSeconds?: number;
  refreshTokenSeconds?: number;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

export interface NormalizedMcpOAuthOptions {
  service: McpOAuthService;
  accountService: Pick<HostedAccountService, "authenticateSession">;
  issuer: string;
  resource: string;
  resourceMetadataUrl: string;
  workspace: string;
  signingSecret: Uint8Array;
  accessTokenSeconds: number;
  authorizationCodeSeconds: number;
  refreshTokenSeconds: number;
  now: () => number;
  randomBytes: (length: number) => Uint8Array;
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: McpOAuthScope[];
  resource: string;
  state?: string;
  accountId?: string;
  issuedAt: number;
  expiresAt: number;
}

export function protectedResourceMetadata(options: NormalizedMcpOAuthOptions) {
  return {
    resource: options.resource,
    authorization_servers: [options.issuer],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(options: NormalizedMcpOAuthOptions) {
  return {
    issuer: options.issuer,
    authorization_endpoint: `${options.issuer}/oauth/authorize`,
    token_endpoint: `${options.issuer}/oauth/token`,
    registration_endpoint: `${options.issuer}/oauth/register`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

export function normalizeOptions(options: McpOAuthOptions): NormalizedMcpOAuthOptions {
  const issuer = normalizeOrigin(options.issuer, "OAuth issuer");
  const workspace = normalizeWorkspace(options.workspace);
  const resource = normalizeResource(options.resource, issuer);
  const signingSecret = new TextEncoder().encode(options.signingSecret.trim());
  if (signingSecret.length < 32) throw new Error("OAuth signing secret must contain at least 32 bytes");
  return {
    service: options.service,
    accountService: options.accountService,
    issuer,
    resource,
    resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource/mcp`,
    workspace,
    signingSecret,
    accessTokenSeconds: boundedInteger(
      options.accessTokenSeconds,
      DEFAULT_ACCESS_TOKEN_SECONDS,
      300,
      3600,
      "Access token lifetime",
    ),
    authorizationCodeSeconds: boundedInteger(
      options.authorizationCodeSeconds,
      DEFAULT_AUTHORIZATION_CODE_SECONDS,
      60,
      600,
      "Authorization code lifetime",
    ),
    refreshTokenSeconds: boundedInteger(
      options.refreshTokenSeconds,
      DEFAULT_REFRESH_TOKEN_SECONDS,
      3600,
      90 * 24 * 60 * 60,
      "Refresh token lifetime",
    ),
    now: options.now ?? Date.now,
    randomBytes: options.randomBytes ?? secureRandomBytes,
  };
}

export function parseClientRegistration(value: unknown) {
  if (!isRecord(value)) throw new Error("Registration request must be an object");
  const clientName = value.client_name === undefined
    ? "MCP client"
    : boundedString(value.client_name, 160, "client_name");
  const redirectUris = stringArray(value.redirect_uris, "redirect_uris").map(normalizeRedirectUri);
  if (!redirectUris.length || redirectUris.length > 20) {
    throw new Error("redirect_uris must contain 1-20 values");
  }
  const tokenMethod = value.token_endpoint_auth_method ?? "none";
  if (tokenMethod !== "none") throw new Error("Only public clients are supported");
  const grantTypes = value.grant_types === undefined
    ? ["authorization_code", "refresh_token"]
    : supportedGrantTypes(value.grant_types);
  const responseTypes = value.response_types === undefined
    ? ["code"]
    : exactStringSet(value.response_types, ["code"], "response_types");
  return {
    clientName,
    redirectUris: [...new Set(redirectUris)],
    grantTypes,
    responseTypes,
  };
}

export async function parseAuthorizationRequest(
  context: Context<StensiblyEnv>,
  options: NormalizedMcpOAuthOptions,
): Promise<{ request: AuthorizationRequest; client: McpOAuthClientRecord }> {
  if (context.req.query("response_type") !== "code") throw new Error("response_type must be code");
  const clientId = boundedString(requiredQuery(context, "client_id"), 160, "client_id");
  const redirectUri = normalizeRedirectUri(requiredQuery(context, "redirect_uri"));
  const codeChallenge = requiredQuery(context, "code_challenge");
  if (context.req.query("code_challenge_method") !== "S256") {
    throw new Error("code_challenge_method must be S256");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error("PKCE challenge is invalid");
  const resource = context.req.query("resource")?.trim() || options.resource;
  if (resource !== options.resource) throw new Error("Requested resource is invalid");
  const scopes = parseScopes(context.req.query("scope"));
  const state = optionalBounded(context.req.query("state"), 1024, "state");
  let client: McpOAuthClientRecord | null;
  try {
    client = await options.service.getClient(clientId);
  } catch {
    throw new OAuthBackendFailure();
  }
  if (!client || !client.redirectUris.includes(redirectUri)) {
    throw new Error("OAuth client or redirect URI is invalid");
  }
  if (scopes.includes("offline_access") && !client.grantTypes.includes("refresh_token")) {
    throw new Error("OAuth client is not registered for refresh tokens");
  }
  const issuedAt = options.now();
  return {
    client,
    request: {
      clientId,
      redirectUri,
      codeChallenge,
      scopes,
      resource,
      state,
      issuedAt,
      expiresAt: issuedAt + CONSENT_REQUEST_SECONDS * 1000,
    },
  };
}

export function parseSignedAuthorizationRequest(
  payload: string,
  options: NormalizedMcpOAuthOptions,
): AuthorizationRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    throw new Error("Consent payload is invalid");
  }
  if (!isRecord(parsed)) throw new Error("Consent payload is invalid");
  const clientId = boundedString(parsed.clientId, 160, "client id");
  const redirectUri = normalizeRedirectUri(boundedString(parsed.redirectUri, 2048, "redirect URI"));
  const codeChallenge = boundedString(parsed.codeChallenge, 80, "PKCE challenge");
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error("PKCE challenge is invalid");
  const scopes = Array.isArray(parsed.scopes) ? parseScopeArray(parsed.scopes) : parseScopes(undefined);
  if (parsed.resource !== options.resource) throw new Error("OAuth resource is invalid");
  const state = parsed.state === undefined ? undefined : boundedString(parsed.state, 1024, "state");
  const accountId = boundedString(parsed.accountId, 160, "account id");
  const issuedAt = integerClaim(parsed.issuedAt, "consent issue time");
  const expiresAt = integerClaim(parsed.expiresAt, "consent expiry");
  const now = options.now();
  if (
    issuedAt > now + 60_000
    || expiresAt <= now
    || expiresAt > issuedAt + CONSENT_REQUEST_SECONDS * 1000
  ) {
    throw new Error("Consent request expired");
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    scopes,
    resource: options.resource,
    state,
    accountId,
    issuedAt,
    expiresAt,
  };
}

export async function resolveHostedSession(
  context: Context<StensiblyEnv>,
  options: NormalizedMcpOAuthOptions,
): Promise<HostedSessionContext | null> {
  const credential = await parseHostedSessionCredential(
    getCookie(context, HOSTED_SESSION_COOKIE),
  );
  if (!credential) return null;
  return await options.accountService.authenticateSession({
    id: credential.id,
    secretHash: credential.secretHash,
    now: options.now(),
  });
}

export function parseScopes(value: string | undefined): McpOAuthScope[] {
  if (!value?.trim()) return ["read", "offline_access"];
  return parseScopeArray(value.trim().split(/\s+/));
}

export function parseScopeArray(values: unknown[]): McpOAuthScope[] {
  const scopes = [...new Set(values.map((value) => {
    if (typeof value !== "string" || !OAUTH_SCOPES.includes(value as McpOAuthScope)) {
      throw new Error("Requested OAuth scope is unsupported");
    }
    return value as McpOAuthScope;
  }))];
  if (!scopes.includes("read")) throw new Error("OAuth scope must include read");
  return OAUTH_SCOPES.filter((scope) => scopes.includes(scope));
}

export function consentPage(input: {
  clientName: string;
  accountName: string;
  scopes: McpOAuthScope[];
  projects: string[] | null;
  payload: string;
  signature: string;
}): string {
  const scopeItems = input.scopes
    .filter((scope) => scope !== "offline_access")
    .map((scope) => `<li>${scope === "write"
      ? "Read and modify authorised Stensibly work"
      : "Read authorised Stensibly work"}</li>`)
    .join("");
  const projectText = input.projects === null
    ? "All projects in your current workspace"
    : input.projects.length
      ? `Projects: ${input.projects.map(escapeHtml).join(", ")}`
      : "No projects";
  const offlineText = input.scopes.includes("offline_access")
    ? '<p class="muted">A refresh token keeps the connection active until it is revoked or expires.</p>'
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorise Stensibly</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 20px;color:#171717}main{border:1px solid #ddd;border-radius:16px;padding:28px}button{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #aaa;cursor:pointer}.approve{background:#171717;color:white;border-color:#171717}.actions{display:flex;gap:10px;margin-top:24px}.muted{color:#666}</style></head>
<body><main><h1>Authorise ${escapeHtml(input.clientName)}</h1><p>Signed in as <strong>${escapeHtml(input.accountName)}</strong>.</p><p>This client is requesting:</p><ul>${scopeItems}</ul><p class="muted">${escapeHtml(projectText)}</p>${offlineText}
<form method="post" action="/oauth/consent"><input type="hidden" name="request" value="${escapeHtml(input.payload)}"><input type="hidden" name="signature" value="${escapeHtml(input.signature)}"><div class="actions"><button class="approve" name="decision" value="approve">Authorise</button><button name="decision" value="deny">Cancel</button></div></form></main></body></html>`;
}

export function redirectAuthorizationError(
  redirectUri: string,
  state: string | undefined,
  error: string,
  description: string,
): Response {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", error);
  redirect.searchParams.set("error_description", description);
  if (state) redirect.searchParams.set("state", state);
  return Response.redirect(redirect.toString(), 302);
}

export function authorizationInputError(
  context: Context<StensiblyEnv>,
  error: unknown,
) {
  if (error instanceof OAuthBackendFailure) return oauthBackendError(context);
  return oauthJsonError(context, 400, "invalid_request", message(error));
}

export function oauthJsonError(
  context: Context<StensiblyEnv>,
  status: 400 | 403 | 413 | 500 | 502,
  error: string,
  description: string,
) {
  context.header(
    FAILURE_CATEGORY_HEADER,
    status >= 500 ? "convex_failure" : "auth_failure",
  );
  return context.json({ error, error_description: description }, status);
}

export function oauthBackendError(context: Context<StensiblyEnv>) {
  return oauthJsonError(
    context,
    502,
    "server_error",
    "OAuth service is temporarily unavailable",
  );
}

export function requiredForm(form: URLSearchParams, name: string): string | null {
  const value = form.get(name)?.trim();
  return value || null;
}

export function stringFormValue(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeRedirectUri(value: string): string {
  const parsed = new URL(boundedString(value, 2048, "redirect_uri"));
  const local = parsed.protocol === "http:"
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (
    (parsed.protocol !== "https:" && !local)
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw new Error("redirect_uri must use HTTPS and contain no credentials or fragment");
  }
  return parsed.toString();
}

export function validCodeVerifier(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9._~-]{43,128}$/.test(value));
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : "OAuth request failed";
}

function requiredQuery(context: Context<StensiblyEnv>, name: string): string {
  const value = context.req.query(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalBounded(
  value: string | undefined,
  maximum: number,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, maximum, label);
}

function integerClaim(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid`);
  return normalized;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => boundedString(entry, 2048, label));
}

function supportedGrantTypes(value: unknown): string[] {
  const values = [...new Set(stringArray(value, "grant_types"))];
  if (
    !values.includes("authorization_code")
    || values.some((entry) => entry !== "authorization_code" && entry !== "refresh_token")
  ) {
    throw new Error("grant_types is unsupported");
  }
  return ["authorization_code", "refresh_token"].filter((entry) => values.includes(entry));
}

function exactStringSet(value: unknown, expected: string[], label: string): string[] {
  const values = [...new Set(stringArray(value, label))].sort();
  const wanted = [...expected].sort();
  if (
    values.length !== wanted.length
    || values.some((entry, index) => entry !== wanted[index])
  ) {
    throw new Error(`${label} is unsupported`);
  }
  return values;
}

function normalizeOrigin(value: string, label: string): string {
  const parsed = new URL(value.trim());
  const local = parsed.protocol === "http:"
    && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !local) throw new Error(`${label} must use HTTPS`);
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) throw new Error(`${label} must be an origin`);
  return parsed.origin;
}

function normalizeWorkspace(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(normalized) || normalized.length > 80) {
    throw new Error("OAuth workspace must be a lowercase slug up to 80 characters");
  }
  return normalized;
}

function normalizeResource(value: string, issuer: string): string {
  const parsed = new URL(value.trim());
  if (
    parsed.origin !== issuer
    || parsed.pathname !== "/mcp"
    || parsed.search
    || parsed.hash
  ) throw new Error("OAuth resource must be the canonical /mcp URL on the issuer origin");
  return parsed.toString();
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum} seconds`);
  }
  return normalized;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class OAuthBackendFailure extends Error {}
