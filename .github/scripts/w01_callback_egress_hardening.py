from pathlib import Path

pending: dict[str, str] = {}


def read(path: str) -> str:
    return pending.get(path, Path(path).read_text())


def replace_once(path: str, old: str, new: str) -> None:
    current = read(path)
    count = current.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    pending[path] = current.replace(old, new, 1)


source = "src/hosted-auth.ts"

replace_once(
    source,
    '''const GITHUB_TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_IDENTITY_REQUEST_TIMEOUT_MS = 15_000;''',
    '''const GITHUB_TOKEN_PREFLIGHT_TIMEOUT_MS = 5_000;
const GITHUB_TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_IDENTITY_REQUEST_TIMEOUT_MS = 15_000;''',
)

replace_once(
    source,
    '''interface GitHubProviderFailureDetails {
  stage: GitHubProviderFailureStage;
  reason?: GitHubProviderFailureReason;
}''',
    '''type GitHubProviderFailureDetail =
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

interface GitHubProviderFailureDetails {
  stage: GitHubProviderFailureStage;
  reason?: GitHubProviderFailureReason;
  detail?: GitHubProviderFailureDetail;
}''',
)

replace_once(
    source,
    '''export interface GitHubOAuthClient {
  exchangeCode(input: {''',
    '''export interface GitHubOAuthClient {
  prepareExchange?(): Promise<void>;
  exchangeCode(input: {''',
)

replace_once(
    source,
    '''    const stateCookie = parseOAuthStateCookie(getCookie(context, OAUTH_STATE_COOKIE) ?? "");
    clearOAuthStateCookie(context);

    const parsedState = stateCookie''',
    '''    const stateCookie = parseOAuthStateCookie(getCookie(context, OAUTH_STATE_COOKIE) ?? "");

    const parsedState = stateCookie''',
)

replace_once(
    source,
    '''    ) {
      return authError(context, new AuthInputError("OAuth callback validation failed"), 400);
    }

    let consumed;''',
    '''    ) {
      clearOAuthStateCookie(context);
      return authError(context, new AuthInputError("OAuth callback validation failed"), 400);
    }

    if (normalized.githubClient.prepareExchange) {
      try {
        await normalized.githubClient.prepareExchange();
      } catch (error) {
        return providerBackendError(
          context,
          providerFailureDetails(error, "token_exchange"),
        );
      }
    }
    clearOAuthStateCookie(context);

    let consumed;''',
)

replace_once(
    source,
    '''  async exchangeCode(input: {
    code: string;''',
    '''  async prepareExchange(): Promise<void> {
    try {
      await this.fetchImpl("https://github.com/login/oauth/access_token", {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "Stensibly",
        },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(GITHUB_TOKEN_PREFLIGHT_TIMEOUT_MS),
      });
    } catch (error) {
      throw providerNetworkFailure("token_exchange", error);
    }
  }

  async exchangeCode(input: {
    code: string;''',
)

replace_once(
    source,
    '''        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }),
        signal: AbortSignal.timeout(GITHUB_TOKEN_REQUEST_TIMEOUT_MS),''',
    '''        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }).toString(),
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(GITHUB_TOKEN_REQUEST_TIMEOUT_MS),''',
)

replace_once(
    source,
    '''    } catch (error) {
      throw new ProviderFailure(
        "token_exchange",
        providerNetworkFailureReason(error),
      );
    }

    const payload = await response.json()''',
    '''    } catch (error) {
      throw providerNetworkFailure("token_exchange", error);
    }

    const payload = await response.json()''',
)

replace_once(
    source,
    '''    } catch (error) {
      throw new ProviderFailure(
        "identity_request",
        providerNetworkFailureReason(error),
      );
    }
    if (!userResponse.ok)''',
    '''    } catch (error) {
      throw providerNetworkFailure("identity_request", error);
    }
    if (!userResponse.ok)''',
)

replace_once(
    source,
    '''function providerNetworkFailureReason(error: unknown): GitHubProviderFailureReason {
  const name = typeof error === "object" && error !== null && "name" in error
    ? (error as { name?: unknown }).name
    : undefined;
  return name === "TimeoutError" ? "network_timeout" : "network_exception";
}''',
    '''const providerFailureDetailsByError = new WeakMap<object, GitHubProviderFailureDetail>();

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
}''',
)

replace_once(
    source,
    '''  context.header(FAILURE_CATEGORY_HEADER, "request_failure");
  return context.json({
    error: "GitHub authentication failed",
    code: "provider_failure",
    stage: failure.stage,
    ...(failure.reason ? { reason: failure.reason } : {}),
  }, 502);''',
    '''  context.header(FAILURE_CATEGORY_HEADER, "request_failure");
  const colo = workerColo(context.req.raw);
  return context.json({
    error: "GitHub authentication failed",
    code: "provider_failure",
    stage: failure.stage,
    ...(failure.reason ? { reason: failure.reason } : {}),
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(colo ? { colo } : {}),
  }, 502);''',
)

replace_once(
    source,
    '''  return error instanceof ProviderFailure
    ? { stage: error.stage, ...(error.reason ? { reason: error.reason } : {}) }
    : { stage: fallback };
}

class AuthInputError extends Error {}''',
    '''  if (!(error instanceof ProviderFailure)) return { stage: fallback };
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

class AuthInputError extends Error {}''',
)

for path, value in pending.items():
    Path(path).write_text(value)

Path("test/hosted-auth-github-preflight.test.ts").write_text('''import { describe, expect, test } from "bun:test";
import { HttpGitHubOAuthClient } from "../src/hosted-auth.ts";

const EXCHANGE_INPUT = {
  code: "authorization-code-sentinel",
  redirectUri: "https://api.stensibly.com/auth/github/callback",
  codeVerifier: "a".repeat(43),
};

describe("HttpGitHubOAuthClient callback egress hardening", () => {
  test("preflights the exact token endpoint without sending an authorization code", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(null, { status: 405 });
    }) as typeof fetch;
    const client = githubClient(fetchImpl);

    await expect(client.prepareExchange()).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.input)).toBe("https://github.com/login/oauth/access_token");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.cache).toBe("no-store");
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  test("serializes the one-shot token exchange form body explicitly", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        access_token: "github-token-sentinel",
        scope: "",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = githubClient(fetchImpl);

    await expect(client.exchangeCode(EXCHANGE_INPUT)).resolves.toBe("github-token-sentinel");
    expect(requests).toHaveLength(1);
    expect(typeof requests[0]?.init?.body).toBe("string");
    expect(requests[0]?.init?.cache).toBe("no-store");
    expect(requests[0]?.init?.redirect).toBe("manual");
    const body = new URLSearchParams(String(requests[0]?.init?.body));
    expect(body.get("code")).toBe(EXCHANGE_INPUT.code);
    expect(body.get("redirect_uri")).toBe(EXCHANGE_INPUT.redirectUri);
    expect(body.get("code_verifier")).toBe(EXCHANGE_INPUT.codeVerifier);
  });
});

function githubClient(fetchImpl: typeof fetch): HttpGitHubOAuthClient {
  return new HttpGitHubOAuthClient({
    clientId: "github-client-id-sentinel",
    clientSecret: "github-client-secret-sentinel",
    fetch: fetchImpl,
  });
}
''')
