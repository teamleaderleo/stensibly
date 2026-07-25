import { Hono, type Context } from "hono";
import type { McpOAuthClientRecord, McpOAuthGrant, McpOAuthRefreshExchange } from "./mcp-oauth-service.js";
import type { HostedSessionContext } from "./hosted-account-service.js";
import type { StensiblyEnv } from "./http-auth.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";
import {
  base64Url,
  createAccessToken,
  createOpaqueCredential,
  parseOpaqueCredential,
  sha256Base64Url,
  signDetached,
  verifyAccessToken,
  verifyDetached,
} from "./mcp-oauth-crypto.js";
import {
  MAX_REGISTRATION_BODY_BYTES,
  authorizationInputError,
  authorizationServerMetadata,
  consentPage,
  message,
  normalizeOptions,
  normalizeRedirectUri,
  oauthBackendError,
  oauthJsonError,
  parseAuthorizationRequest,
  parseClientRegistration,
  parseSignedAuthorizationRequest,
  protectedResourceMetadata,
  redirectAuthorizationError,
  requiredForm,
  resolveHostedSession,
  validCodeVerifier,
  type AuthorizationRequest,
  type McpOAuthOptions,
  type NormalizedMcpOAuthOptions,
} from "./mcp-oauth-protocol.js";

export type { McpOAuthOptions } from "./mcp-oauth-protocol.js";

export function createMcpOAuth(options: McpOAuthOptions): Hono<StensiblyEnv> {
  const normalized = normalizeOptions(options);
  const app = new Hono<StensiblyEnv>();

  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    await next();
  });

  app.get("/.well-known/oauth-protected-resource", (context) =>
    context.json(protectedResourceMetadata(normalized)));
  app.get("/.well-known/oauth-protected-resource/mcp", (context) =>
    context.json(protectedResourceMetadata(normalized)));
  app.get("/.well-known/oauth-authorization-server", (context) =>
    context.json(authorizationServerMetadata(normalized)));

  app.post("/oauth/register", async (context) => {
    const contentLength = Number(context.req.header("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_REGISTRATION_BODY_BYTES) {
      return oauthJsonError(
        context,
        413,
        "invalid_client_metadata",
        "Registration request is too large",
      );
    }
    let body: unknown;
    try {
      const raw = await context.req.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_REGISTRATION_BODY_BYTES) {
        return oauthJsonError(
          context,
          413,
          "invalid_client_metadata",
          "Registration request is too large",
        );
      }
      body = JSON.parse(raw);
    } catch {
      return oauthJsonError(
        context,
        400,
        "invalid_client_metadata",
        "Registration request must be JSON",
      );
    }
    let input: ReturnType<typeof parseClientRegistration>;
    try {
      input = parseClientRegistration(body);
    } catch (error) {
      return oauthJsonError(context, 400, "invalid_client_metadata", message(error));
    }
    const clientId = `oauth_client_${base64Url(normalized.randomBytes(18))}`;
    let client: McpOAuthClientRecord;
    try {
      client = await normalized.service.registerClient({
        clientId,
        clientName: input.clientName,
        redirectUris: input.redirectUris,
        tokenEndpointAuthMethod: "none",
        grantTypes: input.grantTypes,
        responseTypes: input.responseTypes,
      });
    } catch {
      return oauthBackendError(context);
    }
    return context.json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
    }, 201);
  });

  app.get("/oauth/authorize", async (context) => {
    let request: AuthorizationRequest;
    let client: McpOAuthClientRecord;
    try {
      ({ request, client } = await parseAuthorizationRequest(context, normalized));
    } catch (error) {
      return authorizationInputError(context, error);
    }

    let session: HostedSessionContext | null;
    try {
      session = await resolveHostedSession(context, normalized);
    } catch {
      return oauthBackendError(context);
    }
    if (!session) {
      const login = new URL("/auth/github/start", normalized.issuer);
      login.searchParams.set("returnTo", context.req.url);
      return context.redirect(login.toString(), 302);
    }

    const accountScopes = new Set(session.principal.scopes);
    if (request.scopes.includes("write") && !accountScopes.has("write")) {
      return redirectAuthorizationError(
        request.redirectUri,
        request.state,
        "invalid_scope",
        "This account cannot grant write access",
      );
    }

    const consentRequest: AuthorizationRequest = {
      ...request,
      accountId: session.principal.accountId,
    };
    const payload = base64Url(new TextEncoder().encode(JSON.stringify(consentRequest)));
    const signature = await signDetached(
      `consent:${payload}`,
      normalized.signingSecret,
    );
    return context.html(consentPage({
      clientName: client.clientName,
      accountName: session.account.displayName,
      scopes: request.scopes,
      projects: session.membership.projects,
      payload,
      signature,
    }));
  });

  app.post("/oauth/consent", async (context) => {
    if (context.req.header("origin") !== normalized.issuer) {
      return oauthJsonError(context, 403, "access_denied", "Consent origin is not allowed");
    }
    let form: URLSearchParams;
    try {
      const raw = await context.req.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_REGISTRATION_BODY_BYTES) {
        return oauthJsonError(context, 413, "invalid_request", "Consent request is too large");
      }
      form = new URLSearchParams(raw);
    } catch {
      return oauthJsonError(context, 400, "invalid_request", "Consent request is invalid");
    }
    const payload = requiredForm(form, "request");
    const signature = requiredForm(form, "signature");
    const decision = requiredForm(form, "decision");
    if (
      !payload
      || !signature
      || !decision
      || !(await verifyDetached(
        `consent:${payload}`,
        signature,
        normalized.signingSecret,
      ))
    ) {
      return oauthJsonError(
        context,
        400,
        "invalid_request",
        "Consent request validation failed",
      );
    }

    let request: AuthorizationRequest;
    try {
      request = parseSignedAuthorizationRequest(payload, normalized);
    } catch (error) {
      return oauthJsonError(context, 400, "invalid_request", message(error));
    }
    let client: McpOAuthClientRecord | null;
    try {
      client = await normalized.service.getClient(request.clientId);
    } catch {
      return oauthBackendError(context);
    }
    if (!client || !client.redirectUris.includes(request.redirectUri)) {
      return oauthJsonError(context, 400, "invalid_request", "OAuth client is unavailable");
    }

    if (decision !== "approve") {
      return redirectAuthorizationError(
        request.redirectUri,
        request.state,
        "access_denied",
        "The resource owner declined access",
      );
    }

    let session: HostedSessionContext | null;
    try {
      session = await resolveHostedSession(context, normalized);
    } catch {
      return oauthBackendError(context);
    }
    if (!session) {
      return redirectAuthorizationError(
        request.redirectUri,
        request.state,
        "login_required",
        "The hosted session expired",
      );
    }
    if (!request.accountId || request.accountId !== session.principal.accountId) {
      return redirectAuthorizationError(
        request.redirectUri,
        request.state,
        "access_denied",
        "The signed-in account changed during authorisation",
      );
    }

    const code = await createOpaqueCredential("code", normalized.randomBytes);
    try {
      await normalized.service.createAuthorizationCode({
        accountId: session.principal.accountId,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scopes: request.scopes,
        resource: request.resource,
        id: code.id,
        secretHash: code.secretHash,
        expiresAt: normalized.now() + normalized.authorizationCodeSeconds * 1000,
      });
    } catch {
      return oauthBackendError(context);
    }

    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code.raw);
    if (request.state) redirect.searchParams.set("state", request.state);
    return context.redirect(redirect.toString(), 302);
  });

  app.post("/oauth/token", async (context) => {
    let form: URLSearchParams;
    try {
      const contentType = context.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
        throw new Error("Token request must use application/x-www-form-urlencoded");
      }
      const raw = await context.req.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_REGISTRATION_BODY_BYTES) {
        return oauthJsonError(context, 413, "invalid_request", "Token request is too large");
      }
      form = new URLSearchParams(raw);
    } catch (error) {
      return oauthJsonError(context, 400, "invalid_request", message(error));
    }
    const grantType = form.get("grant_type")?.trim();
    if (grantType === "authorization_code") {
      return await exchangeAuthorizationCode(context, form, normalized);
    }
    if (grantType === "refresh_token") {
      return await exchangeRefreshToken(context, form, normalized);
    }
    return oauthJsonError(
      context,
      400,
      "unsupported_grant_type",
      "Grant type is unsupported",
    );
  });

  return app;
}

export function createMcpOAuthAuthenticator(
  apiTokens: ApiTokenAuthenticator,
  options: McpOAuthOptions,
): ApiTokenAuthenticator {
  const normalized = normalizeOptions(options);
  return {
    async authenticate(rawToken: string) {
      if (rawToken.startsWith("eyJ")) {
        return await verifyAccessToken(rawToken, normalized);
      }
      return await apiTokens.authenticate(rawToken);
    },
  };
}

export function mcpOAuthChallenge(
  options: McpOAuthOptions,
  error?: "invalid_token" | "insufficient_scope",
) {
  const normalized = normalizeOptions(options);
  const parts = [
    `resource_metadata="${normalized.resourceMetadataUrl}"`,
    'scope="read write"',
  ];
  if (error) parts.push(`error="${error}"`);
  return `Bearer ${parts.join(", ")}`;
}

async function exchangeAuthorizationCode(
  context: Context<StensiblyEnv>,
  form: URLSearchParams,
  options: NormalizedMcpOAuthOptions,
) {
  const clientId = requiredForm(form, "client_id");
  const redirectUriValue = requiredForm(form, "redirect_uri");
  const codeVerifier = requiredForm(form, "code_verifier");
  const rawCode = requiredForm(form, "code");
  const resource = form.get("resource")?.trim() || options.resource;
  let redirectUri: string;
  try {
    if (!redirectUriValue) throw new Error("redirect_uri is required");
    redirectUri = normalizeRedirectUri(redirectUriValue);
  } catch {
    return oauthJsonError(
      context,
      400,
      "invalid_grant",
      "Authorization code exchange failed",
    );
  }
  if (
    !clientId
    || !validCodeVerifier(codeVerifier)
    || !rawCode
    || resource !== options.resource
  ) {
    return oauthJsonError(
      context,
      400,
      "invalid_grant",
      "Authorization code exchange failed",
    );
  }
  const code = await parseOpaqueCredential(rawCode, "code");
  if (!code) {
    return oauthJsonError(
      context,
      400,
      "invalid_grant",
      "Authorization code exchange failed",
    );
  }
  const refresh = await createOpaqueCredential("refresh", options.randomBytes);
  let grant: McpOAuthGrant | null;
  try {
    grant = await options.service.exchangeAuthorizationCode({
      id: code.id,
      secretHash: code.secretHash,
      clientId,
      redirectUri,
      codeChallenge: await sha256Base64Url(codeVerifier),
      refreshId: refresh.id,
      refreshSecretHash: refresh.secretHash,
      refreshExpiresAt: options.now() + options.refreshTokenSeconds * 1000,
    });
  } catch {
    return oauthBackendError(context);
  }
  if (!grant || grant.resource !== options.resource || grant.clientId !== clientId) {
    return oauthJsonError(
      context,
      400,
      "invalid_grant",
      "Authorization code exchange failed",
    );
  }
  return await tokenResponse(context, grant, refresh.raw, options);
}

async function exchangeRefreshToken(
  context: Context<StensiblyEnv>,
  form: URLSearchParams,
  options: NormalizedMcpOAuthOptions,
) {
  const clientId = requiredForm(form, "client_id");
  const rawRefresh = requiredForm(form, "refresh_token");
  const resource = form.get("resource")?.trim() || options.resource;
  if (!clientId || !rawRefresh || resource !== options.resource) {
    return oauthJsonError(
      context,
      400,
      "invalid_grant",
      "Refresh token exchange failed",
    );
  }
  const current = await parseOpaqueCredential(rawRefresh, "refresh");
  if (!current) {
    return oauthJsonError(
      context,
      400,
      "invalid_grant",
      "Refresh token exchange failed",
    );
  }
  const next = await createOpaqueCredential("refresh", options.randomBytes);
  let exchange: McpOAuthRefreshExchange;
  try {
    exchange = await options.service.rotateRefreshToken({
      id: current.id,
      secretHash: current.secretHash,
      clientId,
      nextId: next.id,
      nextSecretHash: next.secretHash,
      nextExpiresAt: options.now() + options.refreshTokenSeconds * 1000,
    });
  } catch {
    return oauthBackendError(context);
  }
  if (exchange.status !== "ok" || exchange.grant.resource !== options.resource) {
    return oauthJsonError(
      context,
      400,
      "invalid_grant",
      "Refresh token exchange failed",
    );
  }
  return await tokenResponse(context, exchange.grant, next.raw, options);
}

async function tokenResponse(
  context: Context<StensiblyEnv>,
  grant: McpOAuthGrant,
  refreshToken: string,
  options: NormalizedMcpOAuthOptions,
) {
  return context.json({
    access_token: await createAccessToken(grant, options),
    token_type: "Bearer",
    expires_in: options.accessTokenSeconds,
    refresh_token: refreshToken,
    scope: grant.scopes.join(" "),
  });
}
