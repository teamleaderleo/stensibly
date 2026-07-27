# Hosted OAuth rollout verification

## Purpose

Use the hosted OAuth verifier to collect repeatable evidence before enablement, after
enablement, and after rollback. The verifier is unauthenticated and read-only. It
checks the public hosted surface and two invalid MCP initialise requests; it does
not require a valid API or OAuth token.

The canonical issuer is:

```text
https://api.stensibly.com
```

The canonical MCP endpoint is:

```text
https://api.stensibly.com/mcp
```

## Checks

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

Every request:

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

## Disabled-state evidence

Before OAuth is enabled, or after rollback:

```bash
bun run verify:oauth -- --expect disabled
```

The disabled contract requires:

- healthy hosted GitHub authentication without the OAuth surface;
- both OAuth metadata endpoints return `404`;
- both MCP responses use an exact bare `Bearer` challenge with no OAuth discovery
  or token-error parameters.

This state is a rollout gate, not the W01 completion target.

## Enabled-state evidence

After the approved production configuration and deployment:

```bash
bun run verify:oauth
```

For the Worker fallback while retaining the canonical issuer:

```bash
bun run verify:oauth -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev \
  --issuer https://api.stensibly.com
```

The fallback must serve the requested checks directly. A redirect to the canonical
origin is not sufficient evidence.

## Rollout sequence

After the lifecycle and verifier candidates are accepted:

1. confirm the GitHub OAuth application callback and allowed subject policy;
2. configure the required Worker variables and encrypted secrets through the
   production control path;
3. deploy Convex schema and functions;
4. deploy the Worker;
5. run the enabled verifier against the canonical origin and Worker fallback;
6. create or refresh the ChatGPT app and scan tools;
7. complete a bounded read;
8. obtain the contemporaneous approval for the predeclared low-risk write and
   confirm it through a subsequent read;
9. verify refresh-token or reconnect behaviour;
10. attach exact deployment and verification evidence to W01.

## Rollback verification

A controlled rollback disables the complete OAuth configuration set rather than
leaving a partial configuration. After rollback:

```bash
bun run verify:oauth -- --expect disabled
```

Also rerun the existing hosted API-token checks to confirm the independent
`stn.tok_...` path remains healthy.

## Failure handling

A failed check is evidence that the observed hosted state does not satisfy the
selected contract. Preserve the exact command, endpoint, issuer, expectation,
check results, request IDs, deployment revisions, and observation time. Do not
paste credentials or private upstream payloads into the retained record.
