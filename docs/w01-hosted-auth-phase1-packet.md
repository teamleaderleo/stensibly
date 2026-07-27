# W01 hosted-auth Phase 1 operator packet

**Packet version:** `w01-hosted-auth-phase1/v2`  
**Prepared from:** `65fb54d58d69b99dba902f2e2824e1847c4f3d4c`  
**Tracks:** #220, #286, #301, #360, #361  
**Scope:** configure and verify hosted GitHub authentication while MCP OAuth remains disabled

This is a reviewable execution checklist. It contains no credential values and grants no deployment, configuration, credential, login, membership, or OAuth authority.

A contemporaneous Tier 3 approval is required immediately before any production configuration or deployment. The approval must name the exact source revision, the `stensibly-api` Worker, the binding names changed, the rollback target, and this packet version.

## Hard boundary

Phase 1 configures the hosted-auth surface with a read-only bootstrap policy while public MCP OAuth remains disabled. Do not complete a GitHub login during Phase 1.

These four bindings must remain absent throughout this packet:

```text
STENSIBLY_OAUTH_SIGNING_SECRET
STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS
STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS
STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS
```

Phase 1 does not create a hosted account or membership. A later login, role change, project restriction, OAuth enablement, or write test is a separate reviewed and approved action.

## Fixed production identity

| Field | Required value |
| --- | --- |
| Cloudflare Worker | `stensibly-api` |
| Canonical origin | `https://api.stensibly.com` |
| Worker fallback | `https://stensibly-api.leoli-082000.workers.dev` |
| Dashboard return origin | `https://www.stensibly.com` |
| GitHub OAuth callback | `https://api.stensibly.com/auth/github/callback` |
| Canonical MCP resource | `https://api.stensibly.com/mcp` |
| Workspace | `default` |

Record the exact accepted deployment revision immediately before execution:

```text
DEPLOY_REVISION=<exact accepted commit SHA>
DEPLOY_TREE=<exact tree SHA>
CI_RUN=<green full-gate run bound to DEPLOY_REVISION>
```

Do not substitute moving `main` without a fresh exact review.

## Protected environment prerequisites

Use the protected GitHub `production` environment or another explicitly approved secret-management surface.

Required protected names:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CONVEX_DEPLOY_KEY
STENSIBLY_READ_TOKEN
STENSIBLY_GITHUB_OAUTH_CLIENT_ID
STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET
```

GitHub reserves the `GITHUB_` prefix. Map the protected aliases only at execution time:

| Protected name | Worker binding |
| --- | --- |
| `STENSIBLY_GITHUB_OAUTH_CLIENT_ID` | `GITHUB_OAUTH_CLIENT_ID` |
| `STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET` | `GITHUB_OAUTH_CLIENT_SECRET` |

Never print, summarise, upload, or retain either credential value. Readiness output may report only fixed missing-name classifications.

`CONVEX_DEPLOY_KEY` must be production-scoped. `STENSIBLY_READ_TOKEN` must be a bounded read token suitable for the existing hosted verifier.

## Exact Phase 1 binding set

Apply this complete hosted-auth set in one Worker deployment:

```text
GITHUB_OAUTH_CLIENT_ID=<mapped protected value>
GITHUB_OAUTH_CLIENT_SECRET=<mapped protected value>
STENSIBLY_AUTH_ORIGIN=https://api.stensibly.com
STENSIBLY_AUTH_RETURN_ORIGINS=https://www.stensibly.com
STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS=13091533
STENSIBLY_AUTH_BOOTSTRAP_ROLE=viewer
```

`STENSIBLY_AUTH_BOOTSTRAP_PROJECTS` remains absent in Phase 1. `viewer` is read-only, and no login occurs, so no initial membership is created.

Before approval, confirm explicitly:

- the GitHub OAuth App belongs to the intended production account;
- its callback is exactly `https://api.stensibly.com/auth/github/callback`;
- `https://www.stensibly.com` is the intended browser return origin;
- GitHub subject `13091533` is the intended allowlisted identity;
- `viewer` is the intended Phase 1 bootstrap role;
- `STENSIBLY_AUTH_BOOTSTRAP_PROJECTS` is absent;
- no session override, additional return origin, additional subject, or free-form target is included;
- no GitHub login will be completed during Phase 1.

A later write-capable bootstrap must name an exact role and an explicit project list, normally:

```text
STENSIBLY_AUTH_BOOTSTRAP_ROLE=member
STENSIBLY_AUTH_BOOTSTRAP_PROJECTS=oauth-dogfood
```

That example is not authorised by this packet. The exact project slug, role, existing-membership state, and approval must be reviewed immediately before use.

## Preflight

Complete and record every item before production mutation.

1. Check out `DEPLOY_REVISION` by exact SHA and confirm `DEPLOY_TREE`.
2. Run the complete repository gate:

   ```bash
   bun install --frozen-lockfile
   bun run typecheck
   bun run test
   bun run test:convex
   bun run worker:check
   ```

3. Confirm the current production Convex deployment identity and deploy order.
4. Capture the current Worker version/deployment ID as the rollback target.
5. List production Worker binding names only.
6. Confirm the complete hosted-auth set is either absent or will be replaced atomically.
7. Confirm all four `STENSIBLY_OAUTH_*` names are absent; omission from a deployment command is not proof because Cloudflare can preserve existing secrets.
8. Confirm `STENSIBLY_AUTH_BOOTSTRAP_PROJECTS` is absent.
9. Confirm every protected prerequisite name exists without exposing its value.
10. Confirm the approval record names this packet, exact revision/tree, binding-name set, Worker, and rollback target.

Return `HOLD` without mutation when any fact is missing, stale, ambiguous, or inconsistent.

## Controlled deployment shape

The protected execution surface may map aliases into application binding names, create one permission-restricted temporary file, and deploy the complete Phase 1 set alongside the accepted Worker code.

Illustrative shape:

```bash
set -euo pipefail

GITHUB_OAUTH_CLIENT_ID="$STENSIBLY_GITHUB_OAUTH_CLIENT_ID"
GITHUB_OAUTH_CLIENT_SECRET="$STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET"

secrets_file="$(mktemp)"
chmod 600 "$secrets_file"
trap 'rm -f "$secrets_file"' EXIT

jq -n \
  --arg clientId "$GITHUB_OAUTH_CLIENT_ID" \
  --arg clientSecret "$GITHUB_OAUTH_CLIENT_SECRET" \
  --arg authOrigin "https://api.stensibly.com" \
  --arg returnOrigins "https://www.stensibly.com" \
  --arg subjects "13091533" \
  --arg role "viewer" \
  '{
    GITHUB_OAUTH_CLIENT_ID: $clientId,
    GITHUB_OAUTH_CLIENT_SECRET: $clientSecret,
    STENSIBLY_AUTH_ORIGIN: $authOrigin,
    STENSIBLY_AUTH_RETURN_ORIGINS: $returnOrigins,
    STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS: $subjects,
    STENSIBLY_AUTH_BOOTSTRAP_ROLE: $role
  }' > "$secrets_file"

bunx wrangler deploy --secrets-file "$secrets_file"
rm -f "$secrets_file"
trap - EXIT
```

Do not use shell tracing. Do not display the temporary file. Do not place secret values in workflow inputs, summaries, artifacts, issue comments, retained logs, or externally visible command arguments.

If Convex functions for `DEPLOY_REVISION` are not already production-current, deploy Convex first through the separately approved production path and record its deployment identity before the Worker deployment.

## Required disabled-state verification

Use the protected read token only through the environment.

Legacy bearer compatibility:

```bash
STENSIBLY_TOKEN="$STENSIBLY_READ_TOKEN" bun run verify:hosted
STENSIBLY_TOKEN="$STENSIBLY_READ_TOKEN" \
  bun run verify:hosted -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev
```

Public hosted-auth and disabled-OAuth state:

```bash
bun run verify:oauth -- --expect disabled
bun run verify:oauth -- \
  --endpoint https://stensibly-api.leoli-082000.workers.dev \
  --issuer https://api.stensibly.com \
  --expect disabled
```

Both origins must produce the complete 5/5 disabled contract:

- health is reachable;
- hosted GitHub auth is healthy;
- OAuth metadata is absent;
- the required-token MCP challenge is exact bare `Bearer`;
- the invalid-token MCP challenge is exact bare `Bearer`.

A 4/5 result, redirect, generic proxy response, malformed challenge, missing request ID, origin mismatch, timeout, or verifier uncertainty is a failure.

Do not prove hosted auth by completing a GitHub login in Phase 1.

## Failure and compensation

On any failed post-deployment check:

1. stop before adding any `STENSIBLY_OAUTH_*` binding or completing login;
2. retain only bounded fixed verification classifications and exact deployment identifiers;
3. execute only the compensation named in the contemporaneous approval, normally restoring the captured Worker version;
4. rerun bearer and disabled-state verification on both origins;
5. record `HOLD` with the failed condition and rollback result.

Worker rollback does not reverse Convex data changes. Convex recovery is a separate reviewed action.

## Content-minimised evidence record

Attach one record to #220 and #286:

```yaml
packet: w01-hosted-auth-phase1/v2
status: passed | hold | rolled_back
executed_at: <UTC timestamp>
actor: <attributable operator or run>
approval_ref: <exact contemporaneous approval>
source_revision: <exact SHA>
source_tree: <exact tree SHA>
ci_run: <exact green run>
convex_deployment_before: <identifier>
convex_deployment_after: <identifier or unchanged>
worker_version_before: <identifier>
worker_version_after: <identifier or unchanged>
configuration_names:
  - GITHUB_OAUTH_CLIENT_ID
  - GITHUB_OAUTH_CLIENT_SECRET
  - STENSIBLY_AUTH_ORIGIN
  - STENSIBLY_AUTH_RETURN_ORIGINS
  - STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS
  - STENSIBLY_AUTH_BOOTSTRAP_ROLE
bootstrap_role: viewer
bootstrap_projects_absent: true
login_performed: false
oauth_bindings_absent_before: true | false
oauth_bindings_absent_after: true | false
github_callback_confirmed: true | false
canonical_bearer: passed | failed | not_run
fallback_bearer: passed | failed | not_run
canonical_disabled_5_of_5: passed | failed | not_run
fallback_disabled_5_of_5: passed | failed | not_run
rollback_target: <worker version identifier>
rollback_result: not_needed | passed | failed | not_run
omissions:
  - all credential values
  - raw tokens
  - temporary-file content
  - raw provider payloads
  - arbitrary response bodies
next_gate: guarded_non_production_evidence
```

Do not mark the packet passed unless every required verification passes, both OAuth-absence fields are true, the bootstrap role is `viewer`, project bootstrap is absent, and no login occurred.

## Stop line and later gates

A passed Phase 1 packet proves only that the hosted-auth surface is configured with a read-only bootstrap policy while OAuth remains disabled.

Later work remains separate:

1. execute the guarded registration-limit and invalid-authorization harness in an approved non-production environment;
2. inspect the exact run-tag cohort, bounded cleanup, and retry recovery;
3. run the merged bounded lifecycle audit and explicitly repair any quarantined malformed rows through a separately reviewed path;
4. inspect whether an existing hosted membership already exists;
5. obtain a fresh exact decision for the dogfood project slug and write-capable role/project list;
6. obtain contemporaneous Tier 3 approval for any OAuth enablement;
7. enable through a newly reviewed one-time state machine;
8. complete the real ChatGPT login, consent, tool scan, bounded read, separately approved project-scoped write, refresh, and reconnect journey.

Nothing in this packet satisfies or waives those gates.
