import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  type AccountRole,
  type HostedAccountService,
  type HostedSessionContext,
} from "./hosted-account-service.js";
import type { StensiblyEnv } from "./http-auth.js";
import {
  FAILURE_CATEGORY_HEADER,
  REQUEST_ID_HEADER,
} from "./worker-observability.js";

const SESSION_COOKIE = "__Host-stensibly-session";
const OAUTH_STATE_COOKIE = "__Secure-stensibly-oauth-state";
const SESSION_COOKIE_PATH = "/";
const OAUTH_COOKIE_PATH = "/auth/github/callback";
const DEFAULT_SESSION_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_STATE_SECONDS = 10 * 60;
const MAX_SESSION_SECONDS = 60 * 60 * 24 * 90;
const GITHUB_TOKEN_PREFLIGHT_TIMEOUT_MS = 5_000;
const GITHUB_TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_IDENTITY_REQUEST_TIMEOUT_MS = 15_000;

export interface GitHubIdentity {
  subject: string;
  username: string;
  displayName: string;
  email?: string;
  emailVerified: boolean;
  avatarUrl?: string;
}

export type GitHubProviderFailureStage =
  | "token_exchange"
  | "unexpected_scope"
  | "identity_request"
  | "identity_payload";

export type GitHubProviderFailureReason =
  | "incorrect_client_credentials"
  | "redirect_uri_mismatch"
  | "bad_verification_code"
  | "unverified_user_email"
  | "network_timeout"
  | "network_exception"
  | "provider_rejection"
  | "malformed_response"
  | "missing_access_token";

type GitHubProviderFailureDetail =
  | "timeout_error"
  | "abort_error"
  | "subrequest_limit"
  | "request_context"
  | "connection_lost"
  | "dns_failure"
  | "tls_failure"
  | "type_error"
  | "error"
  | "non_error";

type GitHubProviderFailureOperation = "preflight" | "exchange" | "identity";

interface GitHubProviderFailureDetails {
  stage: GitHubProviderFailureStage;
  reason?: GitHubProviderFailureReason;
  detail?: GitHubProviderFailureDetail;
  operation?: GitHubProviderFailureOperation;
}

export interface GitHubOAuthClient {
  prepareExchange?(): Promise<void>;
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<string>;
  readIdentity(accessToken: string): Promise<GitHubIdentity>;
}

export interface HostedAuthOptions {
  accountService: HostedAccountService;
  githubClient: GitHubOAuthClient;
  githubClientId: string;
  authOrigin: string;
  allowedReturnOrigins: string[];
  allowedGitHubSubjects: string[];
  bootstrapRole?: AccountRole;
  sessionMaxAgeSeconds?: number;
  oauthStateMaxAgeSeconds?: number;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

interface NormalizedHostedAuthOptions {
  accountService: HostedAccountService;
  githubClient: GitHubOAuthClient;
  githubClientId: string;
  authOrigin: string;
  redirectUri: string;
  allowedReturnOrigins: string[];
  allowedReturnOriginSet: Set<string>;
  allowedGitHubSubjectSet: Set<string>;
  bootstrapRole: AccountRole;
  sessionMaxAgeSeconds: number;
  oauthStateMaxAgeSeconds: number;
  now: () => number;
  randomBytes: (length: number) => Uint8Array;
}

export function createHostedAuth(options: HostedAuthOptions): Hono<StensiblyEnv> {
  const normalized = normalizeOptions(options);
  const app = new Hono<StensiblyEnv>();

  app.use("*", credentialedCors(normalized.allowedReturnOriginSet));
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    await next();
  });

  app.get("/github/start", async (context) => {
    let returnTo: string;
    try {
      returnTo = normalizeReturnTo(
        context.req.query("returnTo"),
        normalized.allowedReturnOrigins,
        normalized.allowedReturnOriginSet,
      );
    } catch (error) {
      return authError(context, error, 400);
    }

    const state = await createCredential("oauth", normalized.randomBytes);
    const codeVerifier = base64Url(normalized.randomBytes(32));
    const pkceVerifierHash = await sha256(codeVerifier);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    try {
      await normalized.accountService.createOAuthState({
        id: state.id,
        secretHash: state.secretHash,
        pkceVerifierHash,
        returnTo,
        expiresAt: normalized.now() + normalized.oauthStateMaxAgeSeconds * 1000,
      });
    } catch {
      return authBackendError(context);
    }
    setOAuthStateCookie(
      context,
      serializeOAuthStateCookie(state.raw, codeVerifier),
      normalized.oauthStateMaxAgeSeconds,
    );

    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", normalized.githubClientId);
    authorize.searchParams.set("redirect_uri", normalized.redirectUri);
    authorize.searchParams.set("state", state.id);
    authorize.searchParams.set("code_challenge", codeChallenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("allow_signup", "false");
    return context.redirect(authorize.toString(), 302);
  });

  app.get("/github/callback", async (context) => {
    const state = context.req.query("state") ?? "";
    const code = context.req.query("code") ?? "";
    const stateCookie = parseOAuthStateCookie(getCookie(context, OAUTH_STATE_COOKIE) ?? "");

    const parsedState = stateCookie
      ? await parseCredential(stateCookie.credential, "oauth")
      : null;
    if (
      !code
      || !state
      || !stateCookie
      || !parsedState
      || !constantTimeEqual(state, parsedState.id)
    ) {
      clearOAuthStateCookie(context);
      return authError(context, new AuthInputError("OAuth callback validation failed"), 400);
    }

    if (normalized.githubClient.prepareExchange) {
      try {
        await normalized.githubClient.prepareExchange();
      } catch (error) {
        return providerBackendError(
          context,
          { ...providerFailureDetails(error, "token_exchange"), operation: "preflight" },
        );
      }
    }
    clearOAuthStateCookie(context);

    let consumed;
    try {
      consumed = await normalized.accountService.consumeOAuthState({
        id: parsedState.id,
        secretHash: parsedState.secretHash,
        pkceVerifierHash: await sha256(stateCookie.codeVerifier),
      });
    } catch {
      return authBackendError(context);
    }
    if (!consumed) {
      return authError(context, new AuthInputError("OAuth state is invalid, expired, or already used"), 400);
    }

    let accessToken: string;
    try {
      accessToken = await normalized.githubClient.exchangeCode({
        code,
        redirectUri: normalized.redirectUri,
        codeVerifier: stateCookie.codeVerifier,
      });
    } catch (error) {
      return providerBackendError(
        context,
        { ...providerFailureDetails(error, "token_exchange"), operation: "exchange" },
      );
    }

    let providerIdentity: GitHubIdentity;
    try {
      providerIdentity = await normalized.githubClient.readIdentity(accessToken);
    } catch (error) {
      return providerBackendError(
        context,
        { ...providerFailureDetails(error, "identity_request"), operation: "identity" },
      );
    }

    let identity: GitHubIdentity;
    try {
      identity = normalizeGitHubIdentity(providerIdentity);
    } catch (error) {
      return providerBackendError(
        context,
        { ...providerFailureDetails(error, "identity_payload"), operation: "identity" },
      );
    }

    if (!normalized.allowedGitHubSubjectSet.has(identity.subject)) {
      context.header(FAILURE_CATEGORY_HEADER, "authorization_failure");
      return context.json({ error: "GitHub account is not authorized", code: "forbidden" }, 403);
    }

    try {
      const accountContext = await normalized.accountService.upsertProviderIdentity({
        provider: "github",
        subject: identity.subject,
        username: identity.username,
        displayName: identity.displayName,
        email: identity.email,
        emailVerified: identity.emailVerified,
        avatarUrl: identity.avatarUrl,
        bootstrapRole: normalized.bootstrapRole,
      });
      const session = await createCredential("ses", normalized.randomBytes);
      await normalized.accountService.createSession({
        accountId: accountContext.account.id,
        id: session.id,
        secretHash: session.secretHash,
        expiresAt: normalized.now() + normalized.sessionMaxAgeSeconds * 1000,
        userAgent: context.req.header("user-agent"),
      });
      setSessionCookie(context, session.raw, normalized.sessionMaxAgeSeconds);
      return context.redirect(consumed.returnTo, 302);
    } catch {
      return authBackendError(context);
    }
  });

  app.get("/session", async (context) => {
    let resolved;
    try {
      resolved = await resolveSession(context, normalized);
    } catch {
      return authBackendError(context);
    }
    if (!resolved) {
      clearSessionCookie(context);
      context.header(FAILURE_CATEGORY_HEADER, "auth_failure");
      return context.json({ authenticated: false }, 401);
    }
    let touched;
    try {
      touched = await normalized.accountService.touchSession({
        id: resolved.credential.id,
        secretHash: resolved.credential.secretHash,
      });
    } catch {
      return authBackendError(context);
    }
    if (!touched) {
      clearSessionCookie(context);
      context.header(FAILURE_CATEGORY_HEADER, "auth_failure");
      return context.json({ authenticated: false }, 401);
    }
    return context.json({ authenticated: true, ...resolved.session, session: touched });
  });

  app.post("/logout", async (context) => {
    const origin = context.req.header("Origin");
    if (!origin || !normalized.allowedReturnOriginSet.has(origin)) {
      context.header(FAILURE_CATEGORY_HEADER, "cors_rejection");
      return context.json({ error: "Origin is not allowed" }, 403);
    }

    let resolved;
    try {
      resolved = await resolveSession(context, normalized);
    } catch {
      return authBackendError(context);
    }
    if (!resolved) {
      clearSessionCookie(context);
      return context.body(null, 204);
    }
    try {
      await normalized.accountService.revokeSession({
        accountId: resolved.session.account.id,
        id: resolved.credential.id,
      });
    } catch {
      return authBackendError(context);
    }
    clearSessionCookie(context);
    return context.body(null, 204);
  });

  return app;
}

type GitHubFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpGitHubOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  fetch?: GitHubFetch;
}

export class HttpGitHubOAuthClient implements GitHubOAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: GitHubFetch;

  constructor(options: HttpGitHubOAuthClientOptions) {
    this.clientId = required(options.clientId, "GitHub OAuth client id");
    this.clientSecret = required(options.clientSecret, "GitHub OAuth client secret");
    const fetchImpl = options.fetch;
    this.fetchImpl = fetchImpl
      ? (input, init) => fetchImpl(input, init)
      : (input, init) => globalThis.fetch(input, init);
  }

  async prepareExchange(): Promise<void> {
    try {
      await this.fetchImpl("https://github.com/login/oauth/access_token", {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "Stensibly",
        },
        signal: AbortSignal.timeout(GITHUB_TOKEN_PREFLIGHT_TIMEOUT_MS),
      });
    } catch (error) {
      throw providerNetworkFailure("token_exchange", error);
    }
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "Stensibly",
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(GITHUB_TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw providerNetworkFailure("token_exchange", error);
    }

    const payload = await response.json().catch(() => null) as {
      access_token?: unknown;
      scope?: unknown;
      error?: unknown;
    } | null;
    const providerReason = tokenExchangeFailureReason(payload?.error);
    if (providerReason) throw new ProviderFailure("token_exchange", providerReason);
    if (!response.ok) throw new ProviderFailure("token_exchange", "provider_rejection");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ProviderFailure("token_exchange", "malformed_response");
    }

    const grantedScopes = readGrantedScopes(payload.scope);
    if (grantedScopes === null) {
      throw new ProviderFailure("token_exchange", "malformed_response");
    }
    if (grantedScopes.length > 0) throw new ProviderFailure("unexpected_scope");

    const rawAccessToken = typeof payload.access_token === "string"
      ? payload.access_token
      : "";
    const accessToken = rawAccessToken.trim();
    if (
      !accessToken
      || accessToken !== rawAccessToken
      || /\s/.test(accessToken)
    ) {
      throw new ProviderFailure("token_exchange", "missing_access_token");
    }
    return accessToken;
  }

  async readIdentity(accessToken: string): Promise<GitHubIdentity> {
    const token = validProviderAccessToken(accessToken);
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "Stensibly",
      "x-github-api-version": "2026-03-10",
    };
    let userResponse: Response;
    try {
      userResponse = await this.fetchImpl("https://api.github.com/user", {
        headers,
        signal: AbortSignal.timeout(GITHUB_IDENTITY_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw providerNetworkFailure("identity_request", error);
    }
    if (!userResponse.ok) throw new ProviderFailure("identity_request");

    const responseScopes = readGrantedScopes(
      userResponse.headers.get("x-oauth-scopes"),
    );
    if (responseScopes === null) throw new ProviderFailure("identity_payload");
    if (responseScopes.length > 0) throw new ProviderFailure("unexpected_scope");

    const user = await userResponse.json().catch(() => null) as {
      id?: unknown;
      login?: unknown;
      name?: unknown;
      avatar_url?: unknown;
    } | null;
    if (
      (typeof user?.id !== "number" && typeof user?.id !== "string")
      || (typeof user.id === "number" && (!Number.isSafeInteger(user.id) || user.id <= 0))
      || typeof user?.login !== "string"
      || !user.login.trim()
    ) {
      throw new ProviderFailure("identity_payload");
    }

    return normalizeGitHubIdentity({
      subject: String(user.id),
      username: user.login,
      displayName: typeof user.name === "string" ? user.name : user.login,
      emailVerified: false,
      avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : undefined,
    });
  }
}

function normalizeGitHubSubject(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[1-9][0-9]{0,39}$/.test(normalized)) {
    throw new Error(`${label} must be a canonical numeric GitHub user ID`);
  }
  return normalized;
}

function readGrantedScopes(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  return value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

const providerFailureDetailsByError = new WeakMap<object, GitHubProviderFailureDetail>();

function providerNetworkFailure(
  stage: "token_exchange" | "identity_request",
  error: unknown,
): ProviderFailure {
  const failure = new ProviderFailure(stage, providerNetworkFailureReason(error));
  providerFailureDetailsByError.set(failure, providerNetworkFailureDetail(error));
  return failure;
}

function providerNetworkFailureReason(error: unknown): GitHubProviderFailureReason {
  return providerErrorName(error) === "TimeoutError"
    ? "network_timeout"
    : "network_exception";
}

function providerNetworkFailureDetail(error: unknown): GitHubProviderFailureDetail {
  const name = providerErrorName(error);
  const message = providerErrorMessage(error).toLowerCase();
  if (name === "TimeoutError") return "timeout_error";
  if (name === "AbortError") return "abort_error";
  if (message.includes("too many subrequests")) return "subrequest_limit";
  if (message.includes("different request") || message.includes("request context")) {
    return "request_context";
  }
  if (message.includes("connection reset") || message.includes("connection lost")) {
    return "connection_lost";
  }
  if (message.includes("dns") || message.includes("resolve") || message.includes("getaddrinfo")) {
    return "dns_failure";
  }
  if (message.includes("tls") || message.includes("ssl") || message.includes("certificate")) {
    return "tls_failure";
  }
  if (name === "TypeError") return "type_error";
  if (name === "Error") return "error";
  return "non_error";
}

function providerErrorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : undefined;
}

function providerErrorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    && typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "";
}

function tokenExchangeFailureReason(value: unknown): GitHubProviderFailureReason | null {
  if (typeof value !== "string") return null;
  switch (value) {
    case "incorrect_client_credentials":
    case "redirect_uri_mismatch":
    case "bad_verification_code":
    case "unverified_user_email":
      return value;
    default:
      return "provider_rejection";
  }
}

function validProviderAccessToken(value: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized !== value
    || normalized.length > 4096
    || /\s/.test(normalized)
  ) {
    throw new ProviderFailure("identity_request");
  }
  return normalized;
}

function normalizeGitHubIdentity(value: GitHubIdentity): GitHubIdentity {
  let subject: string;
  try {
    subject = normalizeGitHubSubject(value.subject, "GitHub identity subject");
  } catch {
    throw new ProviderFailure("identity_payload");
  }
  const username = boundedProviderText(value.username, "GitHub username", 160);
  const displayName = boundedProviderText(
    value.displayName.trim() ? value.displayName : username,
    "GitHub display name",
    160,
  );
  const email = normalizeProviderEmail(value.email);
  const avatarUrl = normalizeProviderUrl(value.avatarUrl, "GitHub avatar URL");
  return {
    subject,
    username,
    displayName,
    email,
    emailVerified: Boolean(email && value.emailVerified),
    avatarUrl,
  };
}

function boundedProviderText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ProviderFailure("identity_payload");
  }
  return normalized;
}

function normalizeProviderEmail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ProviderFailure("identity_payload");
  }
  return normalized;
}

function normalizeProviderUrl(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 2048) {
    throw new ProviderFailure("identity_payload");
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ProviderFailure("identity_payload");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ProviderFailure("identity_payload");
  }
  return parsed.toString();
}

async function resolveSession(
  context: Context<StensiblyEnv>,
  options: NormalizedHostedAuthOptions,
): Promise<{
  credential: ParsedCredential;
  session: HostedSessionContext;
} | null> {
  const raw = getCookie(context, SESSION_COOKIE);
  const credential = raw ? await parseCredential(raw, "ses") : null;
  if (!credential) return null;
  const session = await options.accountService.authenticateSession({
    id: credential.id,
    secretHash: credential.secretHash,
    now: options.now(),
  });
  return session ? { credential, session } : null;
}

function credentialedCors(allowedOrigins: Set<string>): MiddlewareHandler<StensiblyEnv> {
  return async (context, next) => {
    const origin = context.req.header("Origin");
    if (!origin) {
      await next();
      return;
    }
    if (!allowedOrigins.has(origin)) {
      context.header(FAILURE_CATEGORY_HEADER, "cors_rejection");
      return context.json({ error: "Origin is not allowed" }, 403);
    }
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Access-Control-Allow-Credentials", "true");
    context.header("Access-Control-Allow-Headers", "Content-Type, X-Request-ID");
    context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    context.header("Access-Control-Expose-Headers", REQUEST_ID_HEADER);
    context.header("Access-Control-Max-Age", "600");
    context.header("Vary", "Origin");
    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
  };
}

function normalizeOptions(options: HostedAuthOptions): NormalizedHostedAuthOptions {
  const authOrigin = normalizeOrigin(options.authOrigin, "Auth origin");
  const allowedReturnOrigins = [...new Set(options.allowedReturnOrigins.map((origin) =>
    normalizeOrigin(origin, "Return origin"),
  ))];
  if (!allowedReturnOrigins.length) throw new Error("At least one return origin is required");
  const allowedGitHubSubjects = [...new Set(options.allowedGitHubSubjects.map((subject) =>
    normalizeGitHubSubject(subject, "Allowed GitHub subject"),
  ))];
  if (!allowedGitHubSubjects.length) throw new Error("At least one GitHub subject is required");
  const sessionMaxAgeSeconds = boundedInteger(
    options.sessionMaxAgeSeconds,
    DEFAULT_SESSION_SECONDS,
    300,
    MAX_SESSION_SECONDS,
    "Session lifetime",
  );
  const oauthStateMaxAgeSeconds = boundedInteger(
    options.oauthStateMaxAgeSeconds,
    DEFAULT_STATE_SECONDS,
    60,
    15 * 60,
    "OAuth state lifetime",
  );
  return {
    accountService: options.accountService,
    githubClient: options.githubClient,
    githubClientId: required(options.githubClientId, "GitHub OAuth client id"),
    authOrigin,
    redirectUri: `${authOrigin}/auth/github/callback`,
    allowedReturnOrigins,
    allowedReturnOriginSet: new Set(allowedReturnOrigins),
    allowedGitHubSubjectSet: new Set(allowedGitHubSubjects),
    bootstrapRole: options.bootstrapRole ?? "owner",
    sessionMaxAgeSeconds,
    oauthStateMaxAgeSeconds,
    now: options.now ?? (() => Date.now()),
    randomBytes: options.randomBytes ?? secureRandomBytes,
  };
}

function normalizeOrigin(value: string, label: string): string {
  const parsed = new URL(required(value, label));
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an origin without a path, query, or credentials`);
  }
  if (parsed.protocol !== "https:" && !isLocalHttp(parsed)) {
    throw new Error(`${label} must use HTTPS`);
  }
  return parsed.origin;
}

function normalizeReturnTo(
  value: string | undefined,
  allowedOrigins: string[],
  allowedOriginSet: Set<string>,
): string {
  const candidate = value?.trim() || `${allowedOrigins[0]}/`;
  if (candidate.length > 2048) throw new AuthInputError("Return destination is too long");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AuthInputError("Return destination is invalid");
  }
  if (parsed.username || parsed.password || !allowedOriginSet.has(parsed.origin)) {
    throw new AuthInputError("Return destination is not allowed");
  }
  return parsed.toString();
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
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

function serializeOAuthStateCookie(credential: string, codeVerifier: string): string {
  return `${credential}.${codeVerifier}`;
}

function parseOAuthStateCookie(value: string): {
  credential: string;
  codeVerifier: string;
} | null {
  const split = value.lastIndexOf(".");
  if (split <= 0) return null;
  const credential = value.slice(0, split);
  const codeVerifier = value.slice(split + 1);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier)) return null;
  return { credential, codeVerifier };
}

interface ParsedCredential {
  id: string;
  secretHash: string;
}

async function createCredential(
  prefix: "oauth" | "ses",
  randomBytes: (length: number) => Uint8Array,
): Promise<{ raw: string; id: string; secretHash: string }> {
  const id = `${prefix}_${base64Url(randomBytes(12))}`;
  const secret = base64Url(randomBytes(32));
  return {
    raw: `${id}.${secret}`,
    id,
    secretHash: await sha256(secret),
  };
}

async function parseCredential(
  raw: string,
  prefix: "oauth" | "ses",
): Promise<ParsedCredential | null> {
  const split = raw.indexOf(".");
  if (split <= 0 || split !== raw.lastIndexOf(".")) return null;
  const id = raw.slice(0, split);
  const secret = raw.slice(split + 1);
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{12,80}$`).test(id)) return null;
  if (!/^[A-Za-z0-9_-]{32,120}$/.test(secret)) return null;
  return { id, secretHash: await sha256(secret) };
}

function secureRandomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return value;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await sha256Bytes(value);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(await sha256Bytes(value));
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function setSessionCookie(context: Context<StensiblyEnv>, value: string, maxAge: number): void {
  setCookie(context, SESSION_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: SESSION_COOKIE_PATH,
    maxAge,
  });
}

function clearSessionCookie(context: Context<StensiblyEnv>): void {
  deleteCookie(context, SESSION_COOKIE, {
    secure: true,
    path: SESSION_COOKIE_PATH,
  });
}

function setOAuthStateCookie(context: Context<StensiblyEnv>, value: string, maxAge: number): void {
  setCookie(context, OAUTH_STATE_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: OAUTH_COOKIE_PATH,
    maxAge,
  });
}

function clearOAuthStateCookie(context: Context<StensiblyEnv>): void {
  deleteCookie(context, OAUTH_STATE_COOKIE, {
    secure: true,
    path: OAUTH_COOKIE_PATH,
  });
}

function authError(context: Context<StensiblyEnv>, error: unknown, status: 400 | 401) {
  context.header(FAILURE_CATEGORY_HEADER, "auth_failure");
  const message = error instanceof AuthInputError ? error.message : "Authentication request failed";
  return context.json({ error: message, code: "auth_failure" }, status);
}

function authBackendError(context: Context<StensiblyEnv>) {
  context.header(FAILURE_CATEGORY_HEADER, "convex_failure");
  return context.json({ error: "Hosted authentication service failed", code: "backend_failure" }, 502);
}

function providerBackendError(
  context: Context<StensiblyEnv>,
  failure: GitHubProviderFailureDetails,
) {
  context.header(FAILURE_CATEGORY_HEADER, "request_failure");
  const colo = workerColo(context.req.raw);
  return context.json({
    error: "GitHub authentication failed",
    code: "provider_failure",
    stage: failure.stage,
    ...(failure.reason ? { reason: failure.reason } : {}),
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(failure.operation ? { operation: failure.operation } : {}),
    ...(colo ? { colo } : {}),
  }, 502);
}

function providerFailureDetails(
  error: unknown,
  fallback: GitHubProviderFailureStage,
): GitHubProviderFailureDetails {
  if (!(error instanceof ProviderFailure)) return { stage: fallback };
  const detail = providerFailureDetailsByError.get(error);
  return {
    stage: error.stage,
    ...(error.reason ? { reason: error.reason } : {}),
    ...(detail ? { detail } : {}),
  };
}

function workerColo(request: Request): string | undefined {
  const value = (request as Request & { cf?: { colo?: unknown } }).cf?.colo;
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined;
}

class AuthInputError extends Error {}
class ProviderFailure extends Error {
  readonly stage: GitHubProviderFailureStage;
  readonly reason?: GitHubProviderFailureReason;

  constructor(stage: GitHubProviderFailureStage, reason?: GitHubProviderFailureReason) {
    super("GitHub provider failure");
    Object.defineProperty(this, "name", { value: "ProviderFailure" });
    this.stage = stage;
    if (reason) Object.defineProperty(this, "reason", { value: reason });
  }
}
