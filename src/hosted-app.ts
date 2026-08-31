import { Hono } from "hono";
import { createApiV1 } from "./api-v1.js";
import {
  parseHostedAuthBootstrapProjects,
  withHostedAuthBootstrapProjects,
} from "./hosted-account-bootstrap.js";
import type { ConvexWorkLedger } from "./convex-ledger.js";
import { createConvexProjectAttachmentLedgerFromEnv } from "./project-attachment-convex-ledger.js";
import { createCorsMiddleware } from "./cors.js";
import {
  ConvexHostedAccountService,
  type AccountRole,
} from "./hosted-account-service.js";
import {
  createHostedAuth,
  HttpGitHubOAuthClient,
  type HostedAuthOptions,
} from "./hosted-auth.js";
import type { HostedSessionHttpAuthOptions, StensiblyEnv } from "./http-auth.js";
import {
  registerHostedProviderCapacityRoutes,
  type HostedGitHubMailWebhookConsumer,
  type HostedProviderCapacityOptions,
} from "./hosted-provider-capacity-api.js";
import { createHostedSetupStatusObserver } from "./hosted-setup-status.js";
import type { WorkLedger } from "./ledger.js";
import { compileMcpExposureRegistrationPlan } from "./mcp-exposure-registration.js";
import { handleMcpHttpRequest } from "./mcp-http.js";
import type { McpToolObserver } from "./mcp-tool-observation.js";
import { createMcpServer, createModernMcpServer } from "./mcp.js";
import {
  createMcpOAuth,
  createMcpOAuthAuthenticator,
  mcpOAuthChallenge,
  type McpOAuthOptions,
} from "./mcp-oauth.js";
import { ConvexMcpOAuthService } from "./mcp-oauth-service.js";
import { ConvexMcpSetupEvidenceService } from "./mcp-setup-evidence-convex.js";
import type {
  McpSetupEvidenceReader,
  McpSetupFirstReadRecorder,
} from "./mcp-setup-evidence.js";
import {
  ConvexProjectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation-convex.js";
import type {
  ProjectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation.js";
import { createProjectSetupStatusApi } from "./setup-status-api.js";
import {
  handleRunnerMcpHttpRequest,
  type RunnerMcpHttpOptions,
} from "./runner-mcp-http.js";
import {
  ConvexTokenProvider,
  type ApiTokenAuthenticator,
} from "./token-provider.js";
import { ConvexProviderCapacityService } from "./provider-capacity-convex.js";
import { ConvexGitHubRepositoryObservationService } from "./github-repository-observation-convex.js";
import {
  FAILURE_CATEGORY_HEADER,
  type FailureCategory,
} from "./worker-observability.js";

export interface HostedSetupStatusMountOptions {
  serviceOrigin: string;
  mcpSetupEvidence?: Pick<McpSetupEvidenceReader, "getMcpSetupEvidence">;
  now?: () => number;
}

export interface HostedAppOptions {
  ledger: WorkLedger;
  authenticator: ApiTokenAuthenticator;
  workspace?: string | null;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  runnerMcp?: Omit<
    RunnerMcpHttpOptions,
    "ledger" | "authenticator" | "allowedOrigins" | "allowedHosts"
  >;
  hostedAuth?: HostedAuthOptions;
  mcpOAuth?: McpOAuthOptions;
  mcpSetupFirstReadRecorder?: Pick<McpSetupFirstReadRecorder, "recordSetupFirstRead">;
  onMcpToolCall?: McpToolObserver;
  providerCapacity?: HostedProviderCapacityOptions;
  setupStatus?: HostedSetupStatusMountOptions;
  repositorySetupObservations?: ProjectRepositorySetupObservationLedger;
}

export interface HostedAppFromEnvDependencies {
  githubMailConsumer?: HostedGitHubMailWebhookConsumer;
}

export function createHostedApp(options: HostedAppOptions): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const allowedOrigins = options.allowedOrigins ?? [];
  const sessionOrigins = options.hostedAuth?.allowedReturnOrigins ?? [];
  const hostedSession = hostedSessionOptions(options.hostedAuth);
  const apiAuthOptions = {
    required: true,
    workspace: options.workspace ?? null,
    ...(hostedSession ? { hostedSession } : {}),
  };
  const setupStatusObserver = options.setupStatus
    ? createHostedSetupStatusObserver({
        serviceOrigin: options.setupStatus.serviceOrigin,
        workspaceConfigured: Boolean(options.workspace?.trim()),
        oauthConfigured: Boolean(options.mcpOAuth),
        ...(options.setupStatus.mcpSetupEvidence
          ? { mcpSetupEvidence: options.setupStatus.mcpSetupEvidence }
          : {}),
        ...(options.setupStatus.now ? { now: options.setupStatus.now } : {}),
      })
    : null;
  const mcpAuthenticator = options.mcpOAuth
    ? createMcpOAuthAuthenticator(options.authenticator, options.mcpOAuth)
    : options.authenticator;
  const oauthChallenges = options.mcpOAuth
    ? {
        required: mcpOAuthChallenge(options.mcpOAuth),
        invalidToken: mcpOAuthChallenge(options.mcpOAuth, "invalid_token"),
        insufficientScope: mcpOAuthChallenge(options.mcpOAuth, "insufficient_scope"),
      }
    : null;
  const publishedMcp = compileMcpExposureRegistrationPlan(
    options.ledger,
    "published_default",
  );

  app.onError((_error, context) => {
    const category = failureCategoryForPath(context.req.path);
    context.header(FAILURE_CATEGORY_HEADER, category);
    return context.json({
      error: "Hosted gateway request failed",
      code: category,
    }, 500);
  });

  app.use("/api/*", createCorsMiddleware(allowedOrigins, sessionOrigins));
  app.get("/health", (context) => context.json({
    ok: true,
    service: "stensibly",
    backend: "convex",
    surfaces: hostedSurfaces(options),
  }));
  if (options.hostedAuth) app.route("/auth", createHostedAuth(options.hostedAuth));
  if (options.mcpOAuth) app.route("/", createMcpOAuth(options.mcpOAuth));
  if (options.providerCapacity) {
    registerHostedProviderCapacityRoutes(
      app,
      options.authenticator,
      {
        required: true,
        ...(hostedSession ? { hostedSession } : {}),
      },
      options.providerCapacity,
    );
  }
  app.all("/mcp", async (context) => {
    const response = await handleMcpHttpRequest(context.req.raw, {
      ledger: options.ledger,
      authenticator: mcpAuthenticator,
      allowedOrigins,
      allowedHosts: options.allowedHosts,
      diagnosticManifest: publishedMcp.manifest,
      createServer: (ledger, requestContext) => createMcpServer(
        ledger,
        requestContext,
        { exposureProfile: "published_default" },
      ),
      createModernServer: (ledger, requestContext) => createModernMcpServer(
        ledger,
        requestContext,
        { exposureProfile: "published_default" },
      ),
      waitUntil: (promise) => context.executionCtx.waitUntil(promise),
      ...(options.mcpSetupFirstReadRecorder
        ? { mcpSetupFirstReadRecorder: options.mcpSetupFirstReadRecorder }
        : {}),
      onToolCall: options.onMcpToolCall ?? logMcpToolObservation,
    });
    const challenge = oauthChallenges
      ? oauthChallengeForResponse(context.req.header("authorization"), response, oauthChallenges)
      : null;
    if (challenge) {
      const headers = new Headers(response.headers);
      headers.set("WWW-Authenticate", challenge);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  });
  app.all("/runner/mcp", (context) =>
    handleRunnerMcpHttpRequest(context.req.raw, {
      ...options.runnerMcp,
      ledger: options.ledger,
      authenticator: options.authenticator,
      allowedOrigins,
      allowedHosts: options.allowedHosts,
    }),
  );
  if (setupStatusObserver) {
    app.route(
      "/api/v1",
      createProjectSetupStatusApi(
        options.authenticator,
        options.ledger,
        apiAuthOptions,
        setupStatusObserver,
        options.repositorySetupObservations,
      ),
    );
  }
  app.route(
    "/api/v1",
    createApiV1(options.authenticator, options.ledger, apiAuthOptions),
  );
  app.notFound((context) => context.json({
    error: "Not found",
    code: "not_found",
  }, 404));
  return app;
}

function logMcpToolObservation(observation: Parameters<McpToolObserver>[0]): void {
  console.log(JSON.stringify(observation));
}

export function createHostedAppFromEnv(
  env: Record<string, string | undefined> = process.env,
  dependencies: HostedAppFromEnvDependencies = {},
): Hono<StensiblyEnv> {
  const ledger = createConvexProjectAttachmentLedgerFromEnv(env);
  const authenticator = new ConvexTokenProvider({
    client: ledger.client,
    serviceSecret: ledger.serviceSecret,
    workspace: ledger.workspace,
  });
  const hostedAuth = hostedAuthFromEnv(ledger, env);
  const mcpSetupEvidence = hostedAuth
    ? new ConvexMcpSetupEvidenceService({
        client: ledger.client,
        serviceSecret: ledger.serviceSecret,
        workspace: ledger.workspace,
      })
    : undefined;
  const mcpOAuth = mcpOAuthFromEnv(ledger, hostedAuth, env, mcpSetupEvidence);
  const repositorySetupObservations = new ConvexProjectRepositorySetupObservationLedger({
    client: ledger.client,
    serviceSecret: ledger.serviceSecret,
    workspace: ledger.workspace,
  });
  return createHostedApp({
    ledger,
    authenticator,
    workspace: ledger.workspace,
    allowedOrigins: splitList(env.STENSIBLY_ALLOWED_ORIGINS),
    allowedHosts: splitList(env.STENSIBLY_ALLOWED_HOSTS),
    hostedAuth,
    mcpOAuth,
    ...(mcpOAuth && mcpSetupEvidence
      ? { mcpSetupFirstReadRecorder: mcpSetupEvidence }
      : {}),
    repositorySetupObservations,
    providerCapacity: hostedProviderCapacityFromEnv(ledger, env, dependencies),
    ...(hostedAuth
      ? {
          setupStatus: {
            serviceOrigin: hostedAuth.authOrigin,
            ...(mcpOAuth && mcpSetupEvidence ? { mcpSetupEvidence } : {}),
            ...(hostedAuth.now ? { now: hostedAuth.now } : {}),
          },
        }
      : {}),
  });
}

export function hostedProviderCapacityFromEnv(
  ledger: ConvexWorkLedger,
  env: Record<string, string | undefined>,
  dependencies: HostedAppFromEnvDependencies = {},
): HostedProviderCapacityOptions | undefined {
  const githubWebhookSecret = trimmed(env.STENSIBLY_GITHUB_WEBHOOK_SECRET);
  if (!githubWebhookSecret) {
    if (dependencies.githubMailConsumer) {
      throw new Error("Hosted GitHub mail requires STENSIBLY_GITHUB_WEBHOOK_SECRET");
    }
    return undefined;
  }
  const repositoryObservationService = new ConvexGitHubRepositoryObservationService({
    client: ledger.client,
    serviceSecret: ledger.serviceSecret,
    workspace: ledger.workspace,
  });
  return {
    service: new ConvexProviderCapacityService({
      client: ledger.client,
      serviceSecret: ledger.serviceSecret,
      workspace: ledger.workspace,
    }),
    repositoryObservationSink: repositoryObservationService,
    repositoryObservationReader: repositoryObservationService,
    ...(dependencies.githubMailConsumer
      ? { githubMailConsumer: dependencies.githubMailConsumer }
      : {}),
    githubWebhookSecret,
  };
}

function hostedSessionOptions(
  hostedAuth: HostedAuthOptions | undefined,
): HostedSessionHttpAuthOptions | undefined {
  if (!hostedAuth) return undefined;
  return {
    accountService: hostedAuth.accountService,
    allowedOrigins: hostedAuth.allowedReturnOrigins,
    ...(hostedAuth.now ? { now: hostedAuth.now } : {}),
  };
}

function hostedAuthFromEnv(
  ledger: ConvexWorkLedger,
  env: Record<string, string | undefined>,
): HostedAuthOptions | undefined {
  const clientId = trimmed(env.GITHUB_OAUTH_CLIENT_ID);
  const clientSecret = trimmed(env.GITHUB_OAUTH_CLIENT_SECRET);
  const authOrigin = trimmed(env.STENSIBLY_AUTH_ORIGIN);
  const returnOrigins = splitList(env.STENSIBLY_AUTH_RETURN_ORIGINS);
  const allowedGitHubSubjects = splitList(env.STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS);
  const bootstrapProjects = parseHostedAuthBootstrapProjects(
    env.STENSIBLY_AUTH_BOOTSTRAP_PROJECTS,
  );
  const configured = Boolean(
    clientId
    || clientSecret
    || authOrigin
    || env.STENSIBLY_AUTH_RETURN_ORIGINS
    || env.STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS
    || env.STENSIBLY_AUTH_BOOTSTRAP_ROLE
    || env.STENSIBLY_AUTH_BOOTSTRAP_PROJECTS
    || env.STENSIBLY_SESSION_MAX_AGE_SECONDS
  );
  if (!configured) return undefined;
  if (!clientId || !clientSecret || !authOrigin || !returnOrigins.length || !allowedGitHubSubjects.length) {
    throw new Error(
      "Hosted auth requires GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, "
      + "STENSIBLY_AUTH_ORIGIN, STENSIBLY_AUTH_RETURN_ORIGINS, and "
      + "STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS",
    );
  }

  const accountService = new ConvexHostedAccountService({
    client: ledger.client,
    serviceSecret: ledger.serviceSecret,
    workspace: ledger.workspace,
  });
  return {
    accountService: withHostedAuthBootstrapProjects(accountService, bootstrapProjects),
    githubClient: new HttpGitHubOAuthClient({ clientId, clientSecret }),
    githubClientId: clientId,
    authOrigin,
    allowedReturnOrigins: [...new Set([...returnOrigins, authOrigin])],
    allowedGitHubSubjects,
    bootstrapRole: parseAccountRole(env.STENSIBLY_AUTH_BOOTSTRAP_ROLE),
    sessionMaxAgeSeconds: parseOptionalInteger(
      env.STENSIBLY_SESSION_MAX_AGE_SECONDS,
      "STENSIBLY_SESSION_MAX_AGE_SECONDS",
    ),
  };
}

function mcpOAuthFromEnv(
  ledger: ConvexWorkLedger,
  hostedAuth: HostedAuthOptions | undefined,
  env: Record<string, string | undefined>,
  setupEvidence: ConvexMcpSetupEvidenceService | undefined,
): McpOAuthOptions | undefined {
  const signingSecret = trimmed(env.STENSIBLY_OAUTH_SIGNING_SECRET);
  const configured = Boolean(
    signingSecret
    || env.STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS
    || env.STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS
    || env.STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS
  );
  if (!configured) return undefined;
  if (!hostedAuth || !signingSecret) {
    throw new Error("MCP OAuth requires hosted GitHub auth and STENSIBLY_OAUTH_SIGNING_SECRET");
  }
  const issuer = hostedAuth.authOrigin;
  return {
    service: new ConvexMcpOAuthService({
      client: ledger.client,
      serviceSecret: ledger.serviceSecret,
      workspace: ledger.workspace,
      ...(setupEvidence ? { setupConnectionRecorder: setupEvidence } : {}),
    }),
    accountService: hostedAuth.accountService,
    issuer,
    resource: `${issuer}/mcp`,
    signingSecret,
    workspace: ledger.workspace,
    accessTokenSeconds: parseOptionalInteger(
      env.STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS,
      "STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS",
    ),
    authorizationCodeSeconds: parseOptionalInteger(
      env.STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS,
      "STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS",
    ),
    refreshTokenSeconds: parseOptionalInteger(
      env.STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS,
      "STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS",
    ),
  };
}

function hostedSurfaces(options: HostedAppOptions): string[] {
  const surfaces = ["api-v1", "mcp", "runner-mcp"];
  if (options.hostedAuth) surfaces.push("auth");
  if (options.mcpOAuth) surfaces.push("oauth");
  if (options.providerCapacity) surfaces.push("provider-capacity");
  return surfaces;
}

function oauthChallengeForResponse(
  authorization: string | undefined,
  response: Response,
  challenges: {
    required: string;
    invalidToken: string;
    insufficientScope: string;
  },
): string | null {
  if (response.status === 401) {
    return authorization ? challenges.invalidToken : challenges.required;
  }
  if (
    response.status === 403
    && response.headers.get(FAILURE_CATEGORY_HEADER) === "authorization_failure"
  ) {
    return challenges.insufficientScope;
  }
  return null;
}

function failureCategoryForPath(path: string): FailureCategory {
  if (path === "/mcp") return "mcp_failure";
  if (
    path === "/auth"
    || path.startsWith("/auth/")
    || path === "/oauth"
    || path.startsWith("/oauth/")
    || path.startsWith("/.well-known/oauth-")
  ) return "auth_failure";
  if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    return "convex_failure";
  }
  return "gateway_failure";
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function parseAccountRole(value: string | undefined): AccountRole {
  const normalized = trimmed(value)?.toLowerCase() ?? "owner";
  if (["owner", "admin", "member", "viewer"].includes(normalized)) {
    return normalized as AccountRole;
  }
  throw new Error("STENSIBLY_AUTH_BOOTSTRAP_ROLE must be owner, admin, member, or viewer");
}

function parseOptionalInteger(value: string | undefined, label: string): number | undefined {
  const normalized = trimmed(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}
