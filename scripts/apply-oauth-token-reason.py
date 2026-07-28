from pathlib import Path
from textwrap import dedent


def block(value: str) -> str:
    return dedent(value).lstrip("\n")


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"expected one match in {path}, found {count}: {old[:160]!r}"
        )
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/hosted-auth.ts",
    block(
        """
        export type GitHubProviderFailureStage =
          | "token_exchange"
          | "unexpected_scope"
          | "identity_request"
          | "identity_payload";
        """
    ),
    block(
        """
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
          | "network_failure"
          | "provider_rejection"
          | "malformed_response"
          | "missing_access_token";

        interface GitHubProviderFailureDetails {
          stage: GitHubProviderFailureStage;
          reason?: GitHubProviderFailureReason;
        }
        """
    ),
)

for stage in ("token_exchange", "identity_request", "identity_payload"):
    replace_once(
        "src/hosted-auth.ts",
        f'providerFailureStage(error, "{stage}")',
        f'providerFailureDetails(error, "{stage}")',
    )

replace_once(
    "src/hosted-auth.ts",
    block(
        r"""
            } catch {
              throw new ProviderFailure("token_exchange");
            }
            if (!response.ok) throw new ProviderFailure("token_exchange");

            const payload = await response.json().catch(() => null) as {
              access_token?: unknown;
              scope?: unknown;
            } | null;
            const grantedScopes = readGrantedScopes(payload?.scope);
            if (grantedScopes === null) throw new ProviderFailure("token_exchange");
            if (grantedScopes.length > 0) throw new ProviderFailure("unexpected_scope");

            const rawAccessToken = typeof payload?.access_token === "string"
              ? payload.access_token
              : "";
            const accessToken = rawAccessToken.trim();
            if (
              !accessToken
              || accessToken !== rawAccessToken
              || /\s/.test(accessToken)
            ) {
              throw new ProviderFailure("token_exchange");
            }
        """
    ),
    block(
        r"""
            } catch {
              throw new ProviderFailure("token_exchange", "network_failure");
            }

            const payload = await response.json().catch(() => null) as {
              access_token?: unknown;
              scope?: unknown;
              error?: unknown;
            } | null;
            const providerReason = tokenExchangeFailureReason(payload?.error);
            if (providerReason) throw new ProviderFailure("token_exchange", providerReason);
            if (!response.ok) throw new ProviderFailure("token_exchange", "provider_rejection");
            if (!payload) throw new ProviderFailure("token_exchange", "malformed_response");

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
        """
    ),
)

replace_once(
    "src/hosted-auth.ts",
    block(
        """
        function readGrantedScopes(value: unknown): string[] | null {
          if (typeof value !== "string") return null;
          return value
            .split(",")
            .map((scope) => scope.trim())
            .filter(Boolean);
        }
        """
    ),
    block(
        """
        function readGrantedScopes(value: unknown): string[] | null {
          if (typeof value !== "string") return null;
          return value
            .split(",")
            .map((scope) => scope.trim())
            .filter(Boolean);
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
        """
    ),
)

replace_once(
    "src/hosted-auth.ts",
    block(
        """
        function providerBackendError(
          context: Context<StensiblyEnv>,
          stage: GitHubProviderFailureStage,
        ) {
          context.header(FAILURE_CATEGORY_HEADER, "request_failure");
          return context.json({
            error: "GitHub authentication failed",
            code: "provider_failure",
            stage,
          }, 502);
        }

        function providerFailureStage(
          error: unknown,
          fallback: GitHubProviderFailureStage,
        ): GitHubProviderFailureStage {
          return error instanceof ProviderFailure ? error.stage : fallback;
        }

        class AuthInputError extends Error {}
        class ProviderFailure extends Error {
          readonly stage: GitHubProviderFailureStage;

          constructor(stage: GitHubProviderFailureStage) {
            super("GitHub provider failure");
            Object.defineProperty(this, "name", { value: "ProviderFailure" });
            this.stage = stage;
          }
        }
        """
    ),
    block(
        """
        function providerBackendError(
          context: Context<StensiblyEnv>,
          failure: GitHubProviderFailureDetails,
        ) {
          context.header(FAILURE_CATEGORY_HEADER, "request_failure");
          return context.json({
            error: "GitHub authentication failed",
            code: "provider_failure",
            stage: failure.stage,
            ...(failure.reason ? { reason: failure.reason } : {}),
          }, 502);
        }

        function providerFailureDetails(
          error: unknown,
          fallback: GitHubProviderFailureStage,
        ): GitHubProviderFailureDetails {
          return error instanceof ProviderFailure
            ? { stage: error.stage, ...(error.reason ? { reason: error.reason } : {}) }
            : { stage: fallback };
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
        """
    ),
)

replace_once(
    "test/hosted-auth-github-http-client.test.ts",
    block(
        """
        import {
          HttpGitHubOAuthClient,
          type GitHubProviderFailureStage,
        } from "../src/hosted-auth.ts";
        """
    ),
    block(
        """
        import {
          HttpGitHubOAuthClient,
          type GitHubProviderFailureReason,
          type GitHubProviderFailureStage,
        } from "../src/hosted-auth.ts";
        """
    ),
)

replace_once(
    "test/hosted-auth-github-http-client.test.ts",
    '    expectFailure(error, "token_exchange", ["provider-body-sentinel", EXCHANGE_INPUT.code]);\n',
    block(
        """
            expectFailure(
              error,
              "token_exchange",
              ["provider-body-sentinel", EXCHANGE_INPUT.code],
              "bad_verification_code",
            );
        """
    ),
)

replace_once(
    "test/hosted-auth-github-http-client.test.ts",
    '  test("classifies malformed token JSON and a missing token", async () => {\n',
    block(
        """
          test("classifies the fixed GitHub token rejection reasons", async () => {
            const reasons: GitHubProviderFailureReason[] = [
              "incorrect_client_credentials",
              "redirect_uri_mismatch",
              "bad_verification_code",
              "unverified_user_email",
            ];
            for (const reason of reasons) {
              const client = githubClient(singleUseFetch(new Response(JSON.stringify({
                error: reason,
                error_description: `provider-${reason}-sentinel`,
              }), { status: 401 })));
              expectFailure(
                await captureFailure(client.exchangeCode(EXCHANGE_INPUT)),
                "token_exchange",
                [`provider-${reason}-sentinel`, EXCHANGE_INPUT.code],
                reason,
              );
            }

            const unknown = githubClient(singleUseFetch(new Response(JSON.stringify({
              error: "application_suspended",
              error_description: "provider-unknown-sentinel",
            }), { status: 403 })));
            expectFailure(
              await captureFailure(unknown.exchangeCode(EXCHANGE_INPUT)),
              "token_exchange",
              ["application_suspended", "provider-unknown-sentinel", EXCHANGE_INPUT.code],
              "provider_rejection",
            );
          });

          test("classifies malformed token JSON and a missing token", async () => {
        """
    ),
)

replace_once(
    "test/hosted-auth-github-http-client.test.ts",
    block(
        """
          test("classifies malformed token JSON and a missing token", async () => {
            const malformed = githubClient(singleUseFetch(
              new Response("{", { status: 200 }),
            ));
            expectFailure(
              await captureFailure(malformed.exchangeCode(EXCHANGE_INPUT)),
              "token_exchange",
              [EXCHANGE_INPUT.code],
            );

            const missing = githubClient(singleUseFetch(tokenResponse({ scope: "" })));
            expectFailure(
              await captureFailure(missing.exchangeCode(EXCHANGE_INPUT)),
              "token_exchange",
              [EXCHANGE_INPUT.code],
            );
          });
        """
    ),
    block(
        """
          test("classifies malformed token JSON and a missing token", async () => {
            const malformed = githubClient(singleUseFetch(
              new Response("{", { status: 200 }),
            ));
            expectFailure(
              await captureFailure(malformed.exchangeCode(EXCHANGE_INPUT)),
              "token_exchange",
              [EXCHANGE_INPUT.code],
              "malformed_response",
            );

            const missing = githubClient(singleUseFetch(tokenResponse({ scope: "" })));
            expectFailure(
              await captureFailure(missing.exchangeCode(EXCHANGE_INPUT)),
              "token_exchange",
              [EXCHANGE_INPUT.code],
              "missing_access_token",
            );
          });
        """
    ),
)

replace_once(
    "test/hosted-auth-github-http-client.test.ts",
    block(
        """
            expectFailure(
              await captureFailure(exchangeClient.exchangeCode(EXCHANGE_INPUT)),
              "token_exchange",
              [networkFailure, EXCHANGE_INPUT.code],
            );
        """
    ),
    block(
        """
            expectFailure(
              await captureFailure(exchangeClient.exchangeCode(EXCHANGE_INPUT)),
              "token_exchange",
              [networkFailure, EXCHANGE_INPUT.code],
              "network_failure",
            );
        """
    ),
)

replace_once(
    "test/hosted-auth-github-http-client.test.ts",
    block(
        """
        function expectFailure(
          error: unknown,
          stage: GitHubProviderFailureStage,
          excluded: string[],
        ): void {
          expect(error).toBeInstanceOf(Error);
          expect(error).toMatchObject({
            name: "ProviderFailure",
            message: "GitHub provider failure",
            stage,
          });
          const serialized = JSON.stringify(error);
          expect(serialized).toBe(JSON.stringify({ stage }));
          for (const value of excluded) expect(serialized).not.toContain(value);
        }
        """
    ),
    block(
        """
        function expectFailure(
          error: unknown,
          stage: GitHubProviderFailureStage,
          excluded: string[],
          reason?: GitHubProviderFailureReason,
        ): void {
          expect(error).toBeInstanceOf(Error);
          expect(error).toMatchObject({
            name: "ProviderFailure",
            message: "GitHub provider failure",
            stage,
            ...(reason ? { reason } : {}),
          });
          const serialized = JSON.stringify(error);
          expect(serialized).toBe(JSON.stringify({ stage }));
          for (const value of excluded) expect(serialized).not.toContain(value);
        }
        """
    ),
)

replace_once(
    "test/hosted-auth.test.ts",
    block(
        """
        import {
          createHostedAuth,
          type GitHubIdentity,
          type GitHubOAuthClient,
        } from "../src/hosted-auth.ts";
        """
    ),
    block(
        """
        import {
          createHostedAuth,
          HttpGitHubOAuthClient,
          type GitHubIdentity,
          type GitHubOAuthClient,
        } from "../src/hosted-auth.ts";
        """
    ),
)

replace_once(
    "test/hosted-auth.test.ts",
    block(
        """
            expect(body).not.toContain("secret provider failure");
          });
        });
        """
    ),
    block(
        r"""
            expect(body).not.toContain("secret provider failure");
          });

          test("returns a bounded token reason and reuses the exact PKCE verifier", async () => {
            const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
            const github = new HttpGitHubOAuthClient({
              clientId: "github-client-id",
              clientSecret: "github-client-secret",
              fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
                requests.push({ input, init });
                return new Response(JSON.stringify({
                  error: "bad_verification_code",
                  error_description: "provider-description-sentinel",
                }), {
                  status: 401,
                  headers: { "content-type": "application/json" },
                });
              }) as typeof fetch,
            });
            const app = createHostedAuth(options(new FakeAccountService(), github));

            const started = await app.request("/github/start");
            const authorize = new URL(started.headers.get("location") ?? "");
            const state = authorize.searchParams.get("state") ?? "";
            const cookie = cookieValue(started, "__Secure-stensibly-oauth-state");
            const verifier = cookie.slice(cookie.lastIndexOf(".") + 1);
            const challengeBytes = new Uint8Array(await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(verifier),
            ));
            let challengeBinary = "";
            for (const byte of challengeBytes) challengeBinary += String.fromCharCode(byte);
            const expectedChallenge = btoa(challengeBinary)
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/g, "");
            expect(authorize.searchParams.get("code_challenge")).toBe(expectedChallenge);

            const failed = await app.request(
              `/github/callback?code=valid-code&state=${encodeURIComponent(state)}`,
              { headers: { cookie: `__Secure-stensibly-oauth-state=${cookie}` } },
            );
            expect(failed.status).toBe(502);
            expect(requests).toHaveLength(1);
            expect(String(requests[0]?.input)).toBe("https://github.com/login/oauth/access_token");
            const exchangeBody = new URLSearchParams(String(requests[0]?.init?.body));
            expect(exchangeBody.get("code_verifier")).toBe(verifier);
            expect(exchangeBody.get("redirect_uri")).toBe(
              "https://api.stensibly.com/auth/github/callback",
            );

            const body = JSON.stringify(await failed.json());
            expect(body).toBe(JSON.stringify({
              error: "GitHub authentication failed",
              code: "provider_failure",
              stage: "token_exchange",
              reason: "bad_verification_code",
            }));
            expect(body).not.toContain("provider-description-sentinel");
            expect(body).not.toContain(verifier);
            expect(body).not.toContain("valid-code");
          });
        });
        """
    ),
)
