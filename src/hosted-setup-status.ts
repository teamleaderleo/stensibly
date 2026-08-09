import type { ProjectSetupStatusObserver } from "./setup-status-api.js";
import type { SetupStepStates } from "./setup-status.js";

export interface HostedSetupStatusObserverOptions {
  serviceOrigin: string;
  workspaceConfigured: boolean;
  oauthConfigured: boolean;
  now?: () => number;
}

export function createHostedSetupStatusObserver(
  options: HostedSetupStatusObserverOptions,
): ProjectSetupStatusObserver {
  const serviceOrigin = hostedServiceOrigin(options.serviceOrigin);
  const mcpEndpoint = `${serviceOrigin}/mcp`;
  const now = options.now ?? Date.now;

  return {
    observe({ principalKind, hasAcceptedAttachment }) {
      const observedAt = observedTimestamp(now());
      const steps: SetupStepStates = {
        deployment: "ready",
        backend: "ready",
        account: principalKind === "account" ? "ready" : "missing",
        workspace: options.workspaceConfigured ? "ready" : "missing",
        project: "ready",
        oauth_discovery: options.oauthConfigured ? "ready" : "missing",
        mcp_connection: "missing",
        first_read: "missing",
        repository: hasAcceptedAttachment ? "ready" : "missing",
        proofwake: "deferred",
      };
      return {
        setup: {
          mode: "production",
          observedAt,
          serviceOrigin,
          mcpEndpoint,
          steps,
          lastVerifiedStep: "project",
        },
      };
    },
  };
}

function hostedServiceOrigin(value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 2048
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError("Hosted setup service origin is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new RangeError("Hosted setup service origin is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw new RangeError("Hosted setup service origin must be a credential-free HTTPS origin");
  }
  return parsed.origin;
}

function observedTimestamp(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError("Hosted setup observation time is invalid");
  }
  try {
    return new Date(value).toISOString();
  } catch {
    throw new RangeError("Hosted setup observation time is invalid");
  }
}
