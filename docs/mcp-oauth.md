# MCP OAuth

Stensibly supports two parallel authentication paths for remote MCP:

- `stn.tok_...` API tokens for agents, scripts, deployment verification, and other trusted clients.
- GitHub-backed OAuth for interactive human clients such as ChatGPT.

OAuth does not replace API tokens. Both credential types resolve to the same internal principal shape and use the same MCP scope and project checks.

## Trust boundary

GitHub proves the human account identity. Stensibly remains both the OAuth authorization server and the MCP resource server.

The browser receives a GitHub access token only inside the Worker during the login callback. That provider token is used to read the GitHub identity and is never returned to ChatGPT, stored in Convex, or accepted by MCP. Stensibly issues its own authorization codes, access tokens, and refresh tokens.

The first release intentionally has a narrow account boundary:

- only configured numeric GitHub user IDs may sign in;
- each identity maps to an existing Stensibly account and workspace membership;
- membership role determines the maximum grantable scopes;
- membership project restrictions are copied into the OAuth grant;
- there is no public registration, organisation mapping, or tenant creation.

## Protocol surface

The hosted Worker publishes:

| Endpoint | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | MCP protected-resource metadata |
| `/.well-known/oauth-authorization-server` | OAuth authorization-server metadata |
| `/oauth/register` | Dynamic registration for public MCP clients |
| `/oauth/authorize` | Authorization-code request and GitHub-session entry point |
| `/oauth/consent` | Explicit Stensibly grant approval |
| `/oauth/token` | Authorization-code and refresh-token exchange |
| `/mcp` | Protected MCP resource |

The authorization flow requires S256 PKCE and an exact registered redirect URI. The canonical resource is `https://api.stensibly.com/mcp`.

## Credentials

### Access tokens

OAuth access tokens are short-lived HMAC-signed JWTs. They are bound to:

- the Stensibly issuer;
- the canonical MCP resource audience;
- the registered OAuth client;
- one account and workspace;
- effective read/write scopes;
- the membership project allowlist.

The Worker accepts these JWTs only on `/mcp`. REST continues to use existing API tokens or hosted browser sessions.

### Authorization codes and refresh tokens

Authorization codes and refresh tokens are opaque credentials. Convex stores only their SHA-256 hashes and metadata.

- authorization codes are single-use and short-lived;
- refresh tokens rotate on every exchange;
- replaying a consumed refresh token revokes its token family;
- account disablement, membership revocation, or role downgrade prevents future code and refresh exchanges;
- already-issued access tokens remain usable only until their short expiry.

## Configuration

OAuth depends on the existing hosted GitHub authentication settings:

```text
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
STENSIBLY_AUTH_ORIGIN=https://api.stensibly.com
STENSIBLY_AUTH_RETURN_ORIGINS=https://www.stensibly.com
STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS=<numeric GitHub user IDs>
STENSIBLY_AUTH_BOOTSTRAP_ROLE=owner
```

The GitHub OAuth App callback URL is:

```text
https://api.stensibly.com/auth/github/callback
```

Enable MCP OAuth with an independent signing secret:

```text
STENSIBLY_OAUTH_SIGNING_SECRET=<at least 32 random bytes>
```

Optional lifetime settings, in seconds:

```text
STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS=600
STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS=300
STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS=2592000
```

Store `GITHUB_OAUTH_CLIENT_SECRET` and `STENSIBLY_OAUTH_SIGNING_SECRET` as encrypted Worker secrets. The GitHub client ID and non-secret policy values may be Worker variables. Never place any of these credentials in the static dashboard, repository files, URLs, issue comments, or pasted logs.

## Rollout

OAuth adds Convex tables, so deploy the Convex schema and functions before deploying the Worker code.

1. Run the required development checks.
2. Create or confirm the GitHub OAuth App and callback URL.
3. Configure the allowlisted numeric GitHub subjects and workspace bootstrap role.
4. Add the encrypted GitHub client secret and OAuth signing secret.
5. Deploy Convex through the explicit production path.
6. Deploy the Worker through the guarded production workflow.
7. Run the existing official and fallback `verify:hosted` checks with a `stn.tok_...` read token.
8. Verify the OAuth metadata endpoints.
9. Create the ChatGPT plugin with `https://api.stensibly.com/mcp` and select OAuth.
10. Complete GitHub login, review the Stensibly consent page, and confirm tool discovery.
11. Test a read-only grant before approving write access.

No production deployment or secret change should be bundled into a code-review decision.

## Verification

Repository checks:

```bash
bun run typecheck
bun test
bun run test:convex
bun run worker:check
```

Legacy bearer compatibility:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" bun run verify:hosted
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run verify:hosted -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev
```

Public metadata checks after deployment:

```bash
curl -fsS https://api.stensibly.com/.well-known/oauth-protected-resource/mcp
curl -fsS https://api.stensibly.com/.well-known/oauth-authorization-server
```

The unauthenticated MCP response should be `401` and advertise a `WWW-Authenticate: Bearer` challenge containing the protected-resource metadata URL.

## Rollback

The API-token path remains independent of OAuth. To stop new OAuth sessions while preserving existing API-token clients, remove the OAuth signing-secret binding and deploy the previous Worker version. A complete rollback also restores the previous Worker code. The additive Convex tables may remain unused; deleting production authentication data is a separate explicit operation.

After any rollback, rerun both hosted verifier commands and confirm that `stn.tok_...` MCP initialization still passes.
