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
export const MCP_OAUTH_CONSENT_REQUEST_SECONDS = 10 * 60;
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

  let scopes: McpOAuthScope[];
  try {
    scopes = parseScopes(context.req.query("scope"));
  } catch (error) {
    throw new OAuthAuthorizationRedirectFailure(
      redirectUri,
      state,
      "invalid_scope",
      message(error),
    );
  }
  if (scopes.includes("offline_access") && !client.grantTypes.includes("refresh_token")) {
    throw new OAuthAuthorizationRedirectFailure(
      redirectUri,
      state,
      "invalid_scope",
      "OAuth client is not registered for refresh tokens",
    );
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
      expiresAt: issuedAt + MCP_OAUTH_CONSENT_REQUEST_SECONDS * 1000,
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
    || expiresAt > issuedAt + MCP_OAUTH_CONSENT_REQUEST_SECONDS * 1000
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
  const clientName = escapeHtml(input.clientName);
  const accountName = escapeHtml(input.accountName);
  const scopeItems = input.scopes
    .filter((scope) => scope !== "offline_access")
    .map((scope) => `<li><span class="permission-mark" aria-hidden="true">✓</span><span>${scope === "write"
      ? "Read and update authorised work"
      : "Read authorised work"}</span></li>`)
    .join("");
  const projectText = input.projects === null
    ? "All projects in your current workspace"
    : input.projects.length
      ? `Projects: ${input.projects.map(escapeHtml).join(", ")}`
      : "No projects";
  const offlineText = input.scopes.includes("offline_access")
    ? '<div class="detail"><span>Session</span><strong>Stays connected until revoked or expired</strong></div>'
    : "";
  const consentFields = (decision: "approve" | "deny") =>
    `<input type="hidden" name="request" value="${escapeHtml(input.payload)}">`
    + `<input type="hidden" name="signature" value="${escapeHtml(input.signature)}">`
    + `<input type="hidden" name="decision" value="${decision}">`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${clientName} · Stensibly</title><style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--wall:#e9e3ec;--paper:#f8f5f8;--paper-soft:#f0eaf2;--ink:#2d2931;--muted:#716a76;--faint:#8f8794;--line:#cfc5d3;--line-soft:#ddd5e0;--lavender:#b7a4c8;--lavender-strong:#705b83;--lavender-soft:#e4d9ec;--blush:#d8aab4;--tape:#d9c7df;--shadow:rgba(48,38,54,.12)}
@media(prefers-color-scheme:dark){:root{--wall:#1c1920;--paper:#29252d;--paper-soft:#312c35;--ink:#f4eef6;--muted:#c1b6c6;--faint:#9a8fa0;--line:#514958;--line-soft:#443d49;--lavender:#ad96c2;--lavender-strong:#d3c1e1;--lavender-soft:#44384f;--blush:#d49aa8;--tape:#67566f;--shadow:rgba(0,0,0,.28)}}
*{box-sizing:border-box}body{min-height:100vh;margin:0;padding:24px;background:var(--wall);color:var(--ink)}.shell{width:min(100%,640px);margin:clamp(28px,8vh,76px) auto}.connection-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:0 8px 24px}.eyebrow{margin:0;color:var(--faint);font-size:.72rem;font-weight:750;letter-spacing:.15em;text-transform:uppercase}h1{margin:5px 0 0;font-size:clamp(2rem,7vw,2.65rem);line-height:1.05;letter-spacing:-.045em}.signed-in{display:flex;align-items:center;gap:8px;margin:10px 0 0;color:var(--muted);font-size:.82rem}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--lavender-strong)}.identity{color:var(--ink);font-weight:700}.companion{flex:0 0 auto;width:92px;height:62px;margin-top:2px}.paper{position:relative;border:1px solid var(--line);border-radius:10px;padding:26px;background:var(--paper);box-shadow:0 12px 32px var(--shadow)}.paper::before{content:"";position:absolute;top:-8px;left:50%;width:66px;height:15px;border:1px solid color-mix(in srgb,var(--tape) 78%,var(--line));background:var(--tape);opacity:.82;transform:translateX(-50%) rotate(-2deg)}#consent-summary{max-width:34rem;margin:0;color:var(--muted);font-size:.96rem;line-height:1.55}.section-label{margin:24px 0 6px;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.66rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.permissions{margin:0;padding:0;list-style:none}.permissions li{display:flex;align-items:center;gap:11px;min-height:46px;border-top:1px solid var(--line-soft);font-size:.93rem}.permissions li:last-child{border-bottom:1px solid var(--line-soft)}.permission-mark{display:grid;place-items:center;flex:0 0 23px;height:23px;border:1px solid var(--lavender);border-radius:5px;background:var(--lavender-soft);color:var(--lavender-strong);font-size:.74rem;font-weight:900}.details{border-bottom:1px solid var(--line-soft)}.detail{display:grid;grid-template-columns:minmax(7rem,.45fr) minmax(0,1fr);gap:18px;min-height:46px;align-items:center;border-top:1px solid var(--line-soft);font-size:.84rem}.detail span{color:var(--faint)}.detail strong{text-align:right;font-weight:650}.actions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;margin-top:26px}.consent-control{display:flex;align-items:center;justify-content:center;min-height:50px;padding:12px 18px;border:1px solid var(--line);border-radius:8px;background:var(--paper-soft);color:var(--ink);font:inherit;font-weight:750;text-decoration:none;cursor:pointer;touch-action:manipulation;box-shadow:0 2px 0 var(--line);transition:transform .1s ease,box-shadow .1s ease,background-color .1s ease}.consent-control:hover{background:var(--lavender-soft)}.consent-control:focus-visible{outline:3px solid color-mix(in srgb,var(--lavender-strong) 42%,transparent);outline-offset:3px}.consent-control:active{transform:translateY(2px);box-shadow:0 0 0 var(--line)}.consent-control[aria-disabled="true"]{pointer-events:none;opacity:.62}.approve{border-color:var(--lavender-strong);background:var(--lavender);color:#241d29;box-shadow:0 3px 0 var(--lavender-strong)}.approve:hover{background:color-mix(in srgb,var(--lavender) 88%,white)}.fallback-form{display:none}.native-fallback{width:100%}.fine-print{margin:16px 0 0;color:var(--faint);font-size:.76rem;line-height:1.45}@media(max-width:540px){body{padding:14px}.shell{margin:24px auto}.connection-header{padding:0 3px 20px}.companion{width:76px;height:52px}.paper{padding:22px 18px}.actions{grid-template-columns:1fr}.detail{grid-template-columns:1fr;gap:3px;padding:10px 0}.detail strong{text-align:left}}@media(prefers-reduced-motion:reduce){.consent-control{transition:none}}
.actions form{margin:0}.actions form:first-child{min-width:0}.actions .consent-control{width:100%}
</style></head>
<body><main class="shell"><header class="connection-header"><div><p class="eyebrow">Stensibly · connection</p><h1>Connect ${clientName}</h1><p class="signed-in"><span class="status-dot" aria-hidden="true"></span>Signed in as <span class="identity">${accountName}</span></p></div><svg class="companion" viewBox="0 0 72 48" role="img" aria-label="Scraplet is watching the connection"><path d="M24 23 4 26l17 8 7-4Z" fill="#b7adbf" stroke="#4d4852" stroke-width="2" stroke-linejoin="round"/><path d="m7 26 15 3" fill="none" stroke="#6b6470" stroke-width="1.2" stroke-linecap="round"/><path d="M22.5 18 27.5 11.5 32 18ZM29.5 18 35.5 7.5 41 18ZM37.5 18 43 10.5 48 18Z" fill="#eee7f1" stroke="#4d4852" stroke-width="1.8" stroke-linejoin="round"/><path d="M22 17h25c9 0 15 6 15 14v2H20v-6c0-4 1-7 2-10Z" fill="#cec4d6" stroke="#4d4852" stroke-width="2" stroke-linejoin="round"/><path d="M42 8h14c6 0 10 4 10 10v10H43l-5-7 4-13Z" fill="#e4dce9" stroke="#4d4852" stroke-width="2" stroke-linejoin="round"/><path d="M28 32v8h8v-8M49 32v8h8v-8" fill="none" stroke="#4d4852" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="56" cy="17" r="2.2" fill="#262329"/><path d="M57 24c2 1 4 1 6-1" fill="none" stroke="#4d4852" stroke-width="1.8" stroke-linecap="round"/><circle cx="51" cy="24" r="2.4" fill="#d6a7ae" opacity=".7"/></svg></header><section class="paper" aria-label="Connection permissions"><p id="consent-summary">${clientName} is asking to work with Stensibly. Review the exact boundary below.</p><p class="section-label">Access requested</p><ul class="permissions">${scopeItems}</ul><p class="section-label">Boundary</p><div class="details"><div class="detail"><span>Workspace</span><strong>${escapeHtml(projectText)}</strong></div>${offlineText}</div>
<div class="actions"><form method="post" action="/oauth/consent">${consentFields("approve")}<button class="consent-control approve" type="submit" aria-describedby="consent-summary">Connect ${clientName}</button></form><form method="post" action="/oauth/consent">${consentFields("deny")}<button class="consent-control" type="submit">Not now</button></form></div><p class="fine-print">Stensibly will return you to ${clientName} after this decision.</p></section></main></body></html>`;
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
  if (error instanceof OAuthAuthorizationRedirectFailure) {
    return redirectAuthorizationError(
      error.redirectUri,
      error.state,
      error.oauthError,
      error.message,
    );
  }
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

class OAuthAuthorizationRedirectFailure extends Error {
  readonly redirectUri: string;
  readonly state: string | undefined;
  readonly oauthError: string;

  constructor(
    redirectUri: string,
    state: string | undefined,
    oauthError: string,
    description: string,
  ) {
    super(description);
    this.redirectUri = redirectUri;
    this.state = state;
    this.oauthError = oauthError;
  }
}
