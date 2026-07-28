from pathlib import Path

pending: dict[str, str] = {}


def read(path: str) -> str:
    return pending.get(path, Path(path).read_text())


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    current = read(path)
    count = current.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} matches, found {count}: {old[:140]!r}")
    pending[path] = current.replace(old, new)


source = "src/hosted-auth.ts"
hosted_test = "test/hosted-auth.test.ts"
preflight_test = "test/hosted-auth-github-preflight.test.ts"

replace(source, '''type GitHubProviderFailureDetail =
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
}''', '''type GitHubProviderFailureDetail =
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
}''')

replace(source, '''    if (normalized.githubClient.prepareExchange) {
      try {
        await normalized.githubClient.prepareExchange();
      } catch (error) {
        return providerBackendError(
          context,
          providerFailureDetails(error, "token_exchange"),
        );
      }
    }''', '''    if (normalized.githubClient.prepareExchange) {
      try {
        await normalized.githubClient.prepareExchange();
      } catch (error) {
        return providerBackendError(
          context,
          { ...providerFailureDetails(error, "token_exchange"), operation: "preflight" },
        );
      }
    }''')

replace(source, '''    let accessToken: string;
    try {
      accessToken = await normalized.githubClient.exchangeCode({
        code,
        redirectUri: normalized.redirectUri,
        codeVerifier: stateCookie.codeVerifier,
      });
    } catch (error) {
      return providerBackendError(
        context,
        providerFailureDetails(error, "token_exchange"),
      );
    }''', '''    let accessToken: string;
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
    }''')

replace(source, '''    let providerIdentity: GitHubIdentity;
    try {
      providerIdentity = await normalized.githubClient.readIdentity(accessToken);
    } catch (error) {
      return providerBackendError(
        context,
        providerFailureDetails(error, "identity_request"),
      );
    }''', '''    let providerIdentity: GitHubIdentity;
    try {
      providerIdentity = await normalized.githubClient.readIdentity(accessToken);
    } catch (error) {
      return providerBackendError(
        context,
        { ...providerFailureDetails(error, "identity_request"), operation: "identity" },
      );
    }''')

replace(source, '''    let identity: GitHubIdentity;
    try {
      identity = normalizeGitHubIdentity(providerIdentity);
    } catch (error) {
      return providerBackendError(
        context,
        providerFailureDetails(error, "identity_payload"),
      );
    }''', '''    let identity: GitHubIdentity;
    try {
      identity = normalizeGitHubIdentity(providerIdentity);
    } catch (error) {
      return providerBackendError(
        context,
        { ...providerFailureDetails(error, "identity_payload"), operation: "identity" },
      );
    }''')

replace(source, '''        cache: "no-store",
        redirect: "manual",
''', "", expected=2)

replace(source, '''    ...(failure.reason ? { reason: failure.reason } : {}),
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(colo ? { colo } : {}),''', '''    ...(failure.reason ? { reason: failure.reason } : {}),
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(failure.operation ? { operation: failure.operation } : {}),
    ...(colo ? { colo } : {}),''')

replace(preflight_test, '''    expect(requests[0]?.init?.cache).toBe("no-store");
    expect(requests[0]?.init?.redirect).toBe("manual");''', '''    expect(requests[0]?.init?.cache).toBeUndefined();
    expect(requests[0]?.init?.redirect).toBeUndefined();''', expected=2)

replace(hosted_test, '''      code: "provider_failure",
      stage: "token_exchange",
    }));''', '''      code: "provider_failure",
      stage: "token_exchange",
      operation: "exchange",
    }));''')

replace(hosted_test, '''      code: "provider_failure",
      stage: "token_exchange",
      reason: "bad_verification_code",
    }));''', '''      code: "provider_failure",
      stage: "token_exchange",
      reason: "bad_verification_code",
      operation: "exchange",
    }));''')

for path, value in pending.items():
    Path(path).write_text(value)
