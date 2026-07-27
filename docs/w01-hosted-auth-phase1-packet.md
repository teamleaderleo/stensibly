# W01 hosted-auth Phase 1 operator packet

**Packet version:** `w01-hosted-auth-phase1/v2`  
**Prepared from:** `4e8564d1edd7ed0812bd28958f451534b23b30b2`  
**Tracks:** #220, #286, #301, #360, #361  
**Supersedes draft:** PR #366  
**Scope:** configure and verify hosted GitHub authentication while MCP OAuth remains disabled

This packet is a reviewable execution checklist. It contains no credential values and grants no deployment, configuration, credential, login, membership, or OAuth authority.

A contemporaneous Tier 3 approval is required immediately before any production change. The approval must name the exact source revision, the `stensibly-api` Worker, every binding name changed, the rollback target, and this packet version.

## Hard boundary

Phase 1 ends only when hosted GitHub auth and existing API-token access pass on both production origins while public MCP OAuth remains disabled.

The following bindings must remain absent throughout this packet:

```text
STENSIBLY_OAUTH_SIGNING_SECRET
STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS
STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS
STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS
```

Do not complete a GitHub login during Phase 1. The bootstrap role and project list affect only the first membership created for an allowed identity; changing them later does not modify an existing membership.

Do not continue to OAuth enablement from this packet. Guarded non-production abuse evidence, run-tag cohort inspection, cleanup/retry evidence, lifecycle-row audit and repair, evidence attachment, and a fresh contemporaneous approval remain separate gates.

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
| Phase 1 bootstrap role | `viewer` |
| W01 project scope | `oauth-dogfood` |

Record the exact deployment revision immediately before execution. It must contain the accepted hosted verifier, strict challenge parsing, deploy-state gate, dynamic-client lifecycle controls, guarded abuse harness, automatic-rollout containment, deterministic setup-status projection, and project-scoped bootstrap support.

```text
DEPLOY_REVISION=<exact accepted commit SHA>
DEPLOY_TREE=<exact tree SHA>
CI_RUN=<green full-gate run bound to DEPLOY_REVISION>
```

Do not substitute moving `main` without a fresh comparison and review.

## Protected production-environment prerequisites

Configure values only through the protected GitHub `production` environment or another explicitly approved secret-management surface.

Required protected secret names:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CONVEX_DEPLOY_KEY
STENSIBLY_READ_TOKEN
STENSIBLY_GITHUB_OAUTH_CLIENT_ID
STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET
```

GitHub reserves the `GITHUB_` prefix for Actions-managed names. Map the two GitHub-safe aliases only inside the protected execution environment:

| Protected environment name | Worker binding |
| --- | --- |
| `STENSIBLY_GITHUB_OAUTH_CLIENT_ID` | `GITHUB_OAUTH_CLIENT_ID` |
| `STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET` | `GITHUB_OAUTH_CLIENT_SECRET` |

Never print, summarise, upload, or retain either value. A readiness check may report only a fixed missing-name classification.

`CONVEX_DEPLOY_KEY` must be production-scoped. `STENSIBLY_READ_TOKEN` must be a bounded read token suitable for the existing hosted verifier.

## Complete Phase 1 hosted-auth binding set

Apply this complete set in one Worker deployment:

```text
GITHUB_OAUTH_CLIENT_ID=<mapped protected value>
GITHUB_OAUTH_CLIENT_SECRET=<mapped protected value>
STENSIBLY_AUTH_ORIGIN=https://api.stensibly.com
STENSIBLY_AUTH_RETURN_ORIGINS=https://www.stensibly.com
STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS=13091533
STENSIBLY_AUTH_BOOTSTRAP_ROLE=viewer
STENSIBLY_AUTH_BOOTSTRAP_PROJECTS=oauth-dogfood
```

Before approval, the operator must explicitly confirm:

- the GitHub OAuth App belongs to the intended production account;
- its callback is exactly `https://api.stensibly.com/auth/github/callback`;
- `https://www.stensibly.com` is the intended browser return origin;
- GitHub subject `13091533` is the intended initial allowlisted identity;
- `viewer` is the intended Phase 1 read-only bootstrap role;
- `oauth-dogfood` is the intended dedicated project slug;
- no additional return origin, subject, role, project, session override, or free-form target is included;
- no GitHub login will be completed during Phase 1.

Project scoping limits projects but does not reduce scopes granted by a role. `viewer` remains read-only. Before any later write-capable login, obtain separate approval for the exact role and project list and confirm no existing membership would bypass the bootstrap settings.

If any value differs, stop and review the changed policy as a new configuration proposal.

## Preflight

Complete and record every item before production mutation.

1. Check out `DEPLOY_REVISION` by exact SHA and confirm the expected tree.
2. Run the complete repository gate:

   ```bash
   bun install --frozen-lockfile
   bun run typecheck
   bun run test
   bun run test:convex
   bun run worker:check
   ```

3. Confirm the current production Convex deployment identity and intended deploy order.
4. Capture the current Worker version or deployment ID as the rollback target.
5. List production Worker binding **names only** and confirm the complete Phase 1 set is either absent or will be replaced atomically.
6. Confirm all four `STENSIBLY_OAUTH_*` binding names are absent. Cloudflare preserves omitted secrets, so absence must be demonstrated rather than inferred.
7. Confirm the protected environment contains every prerequisite name without exposing values.
8. Confirm `STENSIBLY_AUTH_BOOTSTRAP_ROLE=viewer` and `STENSIBLY_AUTH_BOOTSTRAP_PROJECTS=oauth-dogfood` are the reviewed fixed policy values.
9. Confirm no active membership already exists for the initial subject, or record a separate reviewed existing-membership plan. Bootstrap settings do not modify existing memberships.
10. Confirm the approval names this packet, exact revision, binding-name set, Worker, fixed policy values, and captured rollback target.

Return `HOLD` without mutation when any preflight fact is missing, stale, ambiguous, or inconsistent.

## Controlled deployment shape

The execution surface may map protected aliases into application binding names, create one temporary permission-restricted file, and deploy the complete Phase 1 set alongside the accepted Worker code.

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
  --arg projects "oauth-dogfood" \
  '{
    GITHUB_OAUTH_CLIENT_ID: $clientId,
    GITHUB_OAUTH_CLIENT_SECRET: $clientSecret,
    STENSIBLY_AUTH_ORIGIN: $authOrigin,
    STENSIBLY_AUTH_RETURN_ORIGINS: $returnOrigins,
    STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS: $subjects,
    STENSIBLY_AUTH_BOOTSTRAP_ROLE: $role,
    STENSIBLY_AUTH_BOOTSTRAP_PROJECTS: $projects
  }' > "$secrets_file"

bunx wrangler deploy --secrets-file "$secrets_file"
rm -f "$secrets_file"
trap - EXIT
```

Do not use shell tracing. Do not display the temporary file. Do not place secret values in workflow inputs, summaries, artifacts, issue comments, retained logs, or command arguments visible outside the protected runner.

If Convex functions for `DEPLOY_REVISION` are not already production-current, deploy Convex first through the explicit production path and record its deployment identity before the Worker deployment.

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

Both origins must produce the complete **5/5 disabled** contract:

- health is reachable;
- hosted GitHub auth is healthy;
- OAuth metadata is absent;
- the required-token MCP challenge is exact bare `Bearer`;
- the invalid-token MCP challenge is exact bare `Bearer`.

A 4/5 result, redirect, generic proxy response, malformed challenge, missing request ID, origin mismatch, timeout, or verifier uncertainty is a failure.

Do not test login in this phase. Hosted-auth health is sufficient for this packet; creating the first membership would consume the bootstrap role and project policy.

## Failure and compensation

On any failed post-deployment check:

1. stop before adding any `STENSIBLY_OAUTH_*` binding or completing a GitHub login;
2. retain only bounded fixed verification classifications and exact deployment identifiers;
3. execute only the compensation named in the contemporaneous approval—normally restore the captured prior Worker version;
4. rerun bearer verification and disabled-state verification on both origins;
5. record `HOLD` with the failed condition and observed rollback result.

Worker rollback does not reverse Convex data or an accidentally created membership. Any membership or Convex recovery is a separate reviewed action.

## Evidence record

Attach one content-minimised record to #220 and #286:

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
  - STENSIBLY_AUTH_BOOTSTRAP_PROJECTS
bootstrap_role: viewer
bootstrap_projects:
  - oauth-dogfood
existing_membership_absent: true | false | unknown
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

Do not mark the packet passed unless every required verification passes, both OAuth-absence fields are true, the role and project values match this packet, and `login_performed` is false.

## Stop line and next gates

A passed Phase 1 packet proves only that hosted GitHub auth is configured safely while OAuth remains disabled and no membership has intentionally been created.

The next sequence remains:

1. run the merged guarded registration-limit and invalid-authorization harness in an approved non-production environment;
2. inspect the exact run-tag cohort, bounded cleanup, and retry recovery;
3. audit production lifecycle rows and explicitly repair quarantined malformed rows;
4. attach exact deployment, configuration-name, verification, and rollback evidence;
5. confirm the dedicated project and obtain fresh approval for the exact write-capable bootstrap role or separately reviewed existing-membership change;
6. obtain a fresh contemporaneous Tier 3 approval for OAuth enablement;
7. add the signing secret and all three lifetime bindings as one controlled change;
8. complete the real ChatGPT login, consent, tool scan, bounded read, separately approved project-scoped low-risk write, refresh, and reconnect journey.

Nothing in this packet satisfies or waives those gates.

— Teacup
  Intention: replay the Phase 1 packet with project-scoped, read-only bootstrap semantics
