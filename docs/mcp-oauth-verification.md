# Hosted OAuth rollout verification

## Purpose

Use the hosted OAuth verifier to collect repeatable public evidence before enablement,
after enablement, and after rollback. The OAuth verifier is unauthenticated and
read-only. It checks the public hosted surface and two invalid MCP initialise
requests; it does not replace the valid legacy-bearer compatibility gate.

The canonical issuer is:

```text
https://api.stensibly.com
```

The two predeclared Worker origins are:

```text
https://api.stensibly.com
https://stensibly-api.leoli-082000.workers.dev
```

The repository workflow deliberately accepts only these two origins. A broader
public-origin verifier would require a separate reviewed network-target policy.

The canonical MCP endpoint is:

```text
https://api.stensibly.com/mcp
```

## Public OAuth checks

The command runs five independent checks:

1. hosted health reports `ok: true`, the Convex backend, GitHub authentication, and
   the expected OAuth surface state;
2. protected-resource metadata identifies the canonical MCP resource, issuer,
   scopes, and header bearer method;
3. authorization-server metadata identifies the canonical authorization, token,
   and registration endpoints and advertises authorization code, refresh token,
   PKCE S256, and public-client support;
4. an unauthenticated MCP initialise receives the exact expected Bearer challenge;
5. an invalid-bearer MCP initialise receives the exact expected `invalid_token`
   challenge.

All five checks run even when an earlier check fails.

## Safety and evidence bounds

Every public-verifier request:

- uses manual redirect handling;
- has one deadline covering response headers and body consumption;
- reads at most 64 KiB of response body;
- bounds and parses `WWW-Authenticate` as Bearer auth parameters;
- rejects malformed syntax, duplicate parameters, unsupported escaping, trailing
  content, unexpected parameters, and lookalike parameter names;
- retains only fixed failure classifications, HTTP status, and a validated request
  ID of at most 128 safe characters.

Output does not copy response bodies, redirect locations, raw challenge values,
credentials, callback data, or arbitrary upstream error text.

The manual workflow does not accept free-form URLs. It maps a typed target choice
to one of the two predeclared exact HTTPS origins, fixes the issuer to the canonical
origin, and records only those validated constants.

## Disabled-state evidence

Before OAuth is enabled, or after rollback:

```bash
bun run verify:oauth -- --expect disabled
bun run verify:oauth -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev \
  --issuer https://api.stensibly.com \
  --expect disabled
```

The disabled contract requires:

- healthy hosted GitHub authentication without the OAuth surface;
- both OAuth metadata endpoints return `404`;
- both MCP responses use an exact bare `Bearer` challenge with no OAuth discovery
  or token-error parameters.

This state is a rollout gate, not the W01 completion target. A 4/5 result that
reports the hosted GitHub auth surface missing is a failed pre-enable baseline,
even when all four OAuth-disabled checks pass.

## Valid legacy-bearer compatibility

After every Worker deployment and after rollback, verify that existing
`stn.tok_...` clients can still initialise MCP on both hosted origins:

```bash
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" bun run verify:hosted
STENSIBLY_TOKEN="$STENSIBLY_TOKEN" \
  bun run verify:hosted -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev
```

These commands use a valid read token and are deliberately separate from the public
OAuth verifier. A green OAuth metadata/challenge result does not prove that the
legacy bearer path remains healthy.

## Phase 1 — deploy accepted code while OAuth stays disabled

Do not add the OAuth signing secret or optional OAuth lifetime bindings during this
phase.

1. confirm the GitHub OAuth application callback, allowed numeric subjects, auth
   origin, return origins, and bootstrap-role policy;
2. configure or retain hosted GitHub authentication through the approved secret and
   variable path;
3. deploy the accepted Convex schema and functions;
4. wait for required indexes to become available;
5. deploy the accepted Worker build with all four OAuth bindings absent:
   - `STENSIBLY_OAUTH_SIGNING_SECRET`;
   - `STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS`;
   - `STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS`;
   - `STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS`;
6. run both valid `verify:hosted` bearer checks;
7. run both disabled-state public OAuth checks;
8. complete the guarded registration-exhaustion, bounded cleanup/retry, invalid
   authorization, and load/abuse evidence tracked by #220;
9. inspect production lifecycle rows for quarantined malformed records and repair
   any such rows explicitly.

A failed disabled-state check blocks enablement. Preserve the exact deployment,
request IDs, fixed verifier output, and observation time without copying private
response content.

## Phase 2 — approved OAuth enablement

Proceed only after Phase 1 evidence is complete and a contemporaneous Tier 3
approval names the exact configuration, deployment, monitoring, and rollback
boundary.

1. add `STENSIBLY_OAUTH_SIGNING_SECRET` and the three optional lifetime bindings
   together through the approved production path;
2. deploy the Worker revision named by the approval;
3. rerun both valid `verify:hosted` bearer checks;
4. run the canonical enabled OAuth verifier:

   ```bash
   bun run verify:oauth
   ```

5. run the enabled verifier against the Worker fallback while retaining the
   canonical issuer:

   ```bash
   bun run verify:oauth -- \
     --endpoint https://stensibly-api.leoli-082000.workers.dev \
     --issuer https://api.stensibly.com
   ```

6. create or refresh the ChatGPT app and scan tools;
7. complete GitHub-backed login and consent;
8. complete the bounded read;
9. obtain the separate contemporaneous approval for the predeclared low-risk write
   and confirm it through a subsequent read;
10. verify refresh-token or reconnect behaviour;
11. attach exact deployment and verification evidence to #220 and #286.

The fallback must serve the requested checks directly. A redirect to the canonical
origin is not sufficient evidence.

The manual GitHub Actions workflow in `.github/workflows/verify-oauth-hosted.yml`
runs the public verifier for either predeclared origin and retains bounded output.
It does not receive or use the legacy bearer token; run the two bearer commands
through the approved credentialed operator path.

## Rollback verification

To disable OAuth while preserving hosted GitHub authentication and the legacy bearer
path, remove these four bindings together as one controlled configuration change:

```text
STENSIBLY_OAUTH_SIGNING_SECRET
STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS
STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS
STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS
```

Preserve the GitHub OAuth client configuration, allowed GitHub subjects, auth origin,
return origins, and bootstrap-role settings so the hosted `auth` surface remains
healthy. Removing only the signing secret while a lifetime binding remains is an
invalid partial configuration and can make the Worker fail closed.

After the controlled change and Worker deployment or rollback:

1. rerun both valid `verify:hosted` bearer commands;
2. run the disabled verifier against the canonical endpoint;
3. run the disabled verifier against the Worker fallback with the canonical issuer;
4. confirm `stn.tok_...` MCP initialisation remains healthy.

The additive Convex tables may remain unused. Deleting production authentication data
is a separate destructive operation and is not part of rollback.

## Failure handling

A failed check is evidence that the observed hosted state does not satisfy the
selected contract. Preserve the exact command or typed workflow target, endpoint,
issuer, expectation, check results, request IDs, deployment revisions, and
observation time. Do not paste credentials or private upstream payloads into the
retained record.
