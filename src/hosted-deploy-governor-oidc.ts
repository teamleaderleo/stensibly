import {
  GitHubActionsAuthenticationError,
  GitHubActionsOidcVerifier,
} from "./github-actions-oidc.js";
import {
  createHostedDeployGovernorDispatcherFromEnv,
  HostedDeployGovernorDispatchError,
  type HostedDeployGovernorOverrides,
} from "./hosted-deploy-governor-worker.js";

export const deployGovernorOidcAudience =
  "https://api.stensibly.com/internal/deploy-governor/candidate";

export interface HostedDeployGovernorOidcOverrides extends HostedDeployGovernorOverrides {
  audience?: string;
  jwksUrl?: string;
}

export interface HostedDeployGovernorOidcHandler {
  handle(request: Request): Promise<Response>;
}

type DeployGovernorUnavailableStage =
  | "oidc-verification"
  | "governor-dispatch"
  | "governor-token-mint"
  | "governor-repository-dispatch";

export function createHostedDeployGovernorOidcHandlerFromEnv(
  env: Record<string, string | undefined>,
  overrides: HostedDeployGovernorOidcOverrides = {},
): HostedDeployGovernorOidcHandler | undefined {
  const dispatcher = createHostedDeployGovernorDispatcherFromEnv(env, overrides);
  if (!dispatcher) return undefined;
  const verifier = new GitHubActionsOidcVerifier({
    audience: overrides.audience ?? deployGovernorOidcAudience,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.jwksUrl ? { jwksUrl: overrides.jwksUrl } : {}),
  });

  return Object.freeze({
    handle: async (request: Request) => {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }

      let identity;
      try {
        identity = await verifier.verifyAuthorizationHeader(
          request.headers.get("authorization"),
        );
      } catch (error) {
        if (error instanceof GitHubActionsAuthenticationError) {
          return new Response("Unauthorized", { status: 401 });
        }
        return unavailable("oidc-verification");
      }

      try {
        const result = await dispatcher.dispatch({
          repository: identity.repository,
          branch: identity.branch,
          sha: identity.sha,
          deliveryId: identity.jti,
        });
        if (result.status === "ignored") {
          return new Response("Forbidden", { status: 403 });
        }
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof HostedDeployGovernorDispatchError) {
          return unavailable(
            error.stage === "token-mint"
              ? "governor-token-mint"
              : "governor-repository-dispatch",
            error.code,
          );
        }
        return unavailable("governor-dispatch");
      }
    },
  });
}

function unavailable(
  stage: DeployGovernorUnavailableStage,
  code?: string,
): Response {
  const detail = code ? `${stage}:${code}` : stage;
  const headers: Record<string, string> = {
    "Retry-After": "30",
    "X-Stensibly-Deploy-Governor-Stage": stage,
  };
  if (code) headers["X-Stensibly-Deploy-Governor-Code"] = code;
  return new Response(`Service Unavailable: ${detail}`, {
    status: 503,
    headers,
  });
}
