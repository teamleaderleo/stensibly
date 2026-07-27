# W01 hosted-auth recovery and reconfiguration packet

**Packet version:** `w01-hosted-auth-phase1/v4`  
**Prepared after public observation:** `2026-07-27T17:41:52Z`  
**Replayed on source main:** `fbe821370efdda007a5a3b5e37a6b6a656b6b105`  
**Tracks:** #220, #286, #301, #360, #361, #374, #382  
**Integrated dependencies:** provider-membership audit from PR #384 and copy-safe audit CLI from PR #387  
**Scope:** observe the enabled hosted-auth/OAuth deployment and prepare a separately approved recovery to hosted-auth-only disabled OAuth

This is a content-minimised operator packet. It grants no credential access,
configuration, deployment, rollback, login, membership change, or OAuth authority.

## Current observed state

Read-only verifier run `30290380944` observed the canonical and Worker-fallback
origins at **5/5 enabled**:

- canonical origin at `2026-07-27T17:41:52Z`;
- Worker fallback at `2026-07-27T17:41:49Z`;
- health reported `auth,oauth`;
- protected-resource and authorization-server metadata matched the canonical
  resource and issuer;
- required-token and invalid-token MCP challenges matched the enabled OAuth
  contract.

Production OAuth remains enabled under the operator's current decision. This
packet is therefore **not an immediate execution instruction**.

Use one of two paths:

1. **Observe the enabled deployment:** leave configuration unchanged and collect
   bounded read-only evidence.
2. **Reconfigure to hosted-auth-only disabled OAuth:** obtain a fresh Tier 3
   approval that names the exact current deployment, source revision, binding
   names, removal or version-restore mechanism, rollback target, and this packet
   version.

If the current state, deployment identity, approval, membership result, or
removal mechanism is unknown, return `HOLD` without mutation.

## Hard boundary

A reconfiguration run may pass only when all of the following are true:

- the exact source revision, source tree, production Convex deployment, and
  Worker version are recorded;
- the exact current configuration **names** are recorded without values;
- the exact production `https://*.convex.cloud` origin is recorded as a reviewed
  public configuration value;
- the integrated provider-membership audit returns the clean-bootstrap result
  defined below through the integrated copy-safe CLI;
- the approval explicitly authorises the transition from enabled OAuth to
  hosted-auth-only disabled OAuth;
- the approval names the exact binding-removal, version-restore, or deployment
  mechanism and rollback target;
- all four MCP OAuth bindings are proved absent after the approved change;
- hosted GitHub auth and API-token compatibility pass on both fixed origins;
- the public OAuth verifier passes the complete disabled contract on both origins;
- no GitHub login occurs.

The four OAuth bindings are:

```text
STENSIBLY_OAUTH_SIGNING_SECRET
STENSIBLY_OAUTH_ACCESS_TOKEN_SECONDS
STENSIBLY_OAUTH_AUTHORIZATION_CODE_SECONDS
STENSIBLY_OAUTH_REFRESH_TOKEN_SECONDS
```

Do not infer secret removal from an omitted deployment input. Cloudflare may
preserve omitted secret bindings. The approved procedure must name an exact
mechanism that proves removal or restores a captured version whose bindings are
known.

Do not restore scheduled or push-triggered production mutation. Any future
automation remains governed by #374's one-time generation and completion
boundary and requires separate review.

## Fixed production identity and proposed bootstrap policy

| Field | Required value |
| --- | --- |
| Cloudflare Worker | `stensibly-api` |
| Canonical origin | `https://api.stensibly.com` |
| Worker fallback | `https://stensibly-api.leoli-082000.workers.dev` |
| Dashboard return origin | `https://www.stensibly.com` |
| GitHub OAuth callback | `https://api.stensibly.com/auth/github/callback` |
| Canonical MCP resource | `https://api.stensibly.com/mcp` |
| Workspace | `default` |
| Provider | `github` |
| Initial provider subject | `13091533` |
| Proposed bootstrap role | `viewer` |
| Proposed project scope | `oauth-dogfood` |

Project scoping limits projects but does not reduce role scopes. `viewer` remains
the required read-only bootstrap role for this packet.

Bootstrap settings apply only when the provider identity is wholly absent. They
do not rewrite an existing account or membership. No login may occur until the
exact audit gate passes.

## Integrated copy-safe provider-membership audit gate

The deployed Convex revision must contain the accepted integrated query:

```text
providerMembershipAudit:auditProviderMembership
```

The local source revision must contain the integrated CLI command:

```text
bun run audit:membership
```

Before invocation, record and validate:

```yaml
production_convex_url: <exact reviewed https://deployment.convex.cloud origin>
query_source_revision: <exact integrated source SHA>
query_deployed_revision: <exact production Convex deployment identifier>
cli_source_revision: <exact current source SHA>
```

The production Convex URL is public configuration, but it must be copied from a
reviewed deployment record or protected environment. Do not infer it from a
project name, a stale local file, or another deployment. It must be HTTPS,
credential-free, port-free, path-free, query-free, fragment-free, and end in
`.convex.cloud`.

Provide the service secret only through the protected environment. The exact
copy-safe operator form is:

```bash
CONVEX_URL="$PRODUCTION_CONVEX_URL" \
STENSIBLY_SERVICE_SECRET="$PROTECTED_SERVICE_SECRET" \
bun run audit:membership -- \
  --workspace default \
  --provider github \
  --subject 13091533
```

`PRODUCTION_CONVEX_URL` and `PROTECTED_SERVICE_SECRET` must already be populated
by the protected runner or operator shell. Do not place either value in command
history, positional JSON, GitHub comments, retained files, or evidence.

The fixed reviewed subject may be supplied to the protected command. The CLI's
canonical result and retained evidence omit the subject, account IDs, identity
IDs, profile fields, sessions, credentials, and provider payloads.

The clean-bootstrap path requires this complete result:

```yaml
version: 1
workspace: default
provider: github
status: identity_absent
membership: null
cleanBootstrapEligible: true
requiresSeparateMembershipPlan: false
containsSecrets: false
readOnly: true
grantsMembershipChange: false
grantsMembership: false
grantsLogin: false
grantsOAuthEnablement: false
```

Every other status is an unconditional `HOLD`, including:

- `workspace_conflict`;
- `identity_conflict`;
- `account_missing` or `account_disabled`;
- `workspace_absent` for an existing identity;
- `membership_absent` for an existing identity;
- `membership_conflict`;
- `membership_active`;
- `membership_revoked`;
- `membership_uninspectable`.

A query error, unavailable deployment, stale revision, authentication failure,
malformed output, extra field, unexpected authority flag, noncanonical project
order, unknown result, generic CLI failure, or non-zero exit is also an
unconditional `HOLD`.

Only the CLI's single canonical stdout JSON line may enter the evidence record.
Exclude stderr, environment values, process state, shell history, upstream error
text, arbitrary response bodies, and raw command output.

When the result is anything except `identity_absent`, create or reference a
separate reviewed membership plan. Do not rely on
`STENSIBLY_AUTH_BOOTSTRAP_ROLE` or `STENSIBLY_AUTH_BOOTSTRAP_PROJECTS` for that
identity.

## Protected environment prerequisites

Use only the GitHub `production` environment, another permission-restricted
production environment, or an explicitly approved secret-management surface.

Required protected names:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CONVEX_DEPLOY_KEY
STENSIBLY_READ_TOKEN
STENSIBLY_SERVICE_SECRET
STENSIBLY_GITHUB_OAUTH_CLIENT_ID
STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET
```

Required reviewed public configuration:

```text
PRODUCTION_CONVEX_URL=<exact https://*.convex.cloud origin>
```

GitHub-safe aliases map only inside the protected runner:

| Protected name | Worker binding |
| --- | --- |
| `STENSIBLY_GITHUB_OAUTH_CLIENT_ID` | `GITHUB_OAUTH_CLIENT_ID` |
| `STENSIBLY_GITHUB_OAUTH_CLIENT_SECRET` | `GITHUB_OAUTH_CLIENT_SECRET` |

Never print, summarise, upload, or retain secret values. Readiness checks may
report only fixed missing-name classifications.

The proposed hosted-auth-only binding set is:

```text
GITHUB_OAUTH_CLIENT_ID=<mapped protected value>
GITHUB_OAUTH_CLIENT_SECRET=<mapped protected value>
STENSIBLY_AUTH_ORIGIN=https://api.stensibly.com
STENSIBLY_AUTH_RETURN_ORIGINS=https://www.stensibly.com
STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS=13091533
STENSIBLY_AUTH_BOOTSTRAP_ROLE=viewer
STENSIBLY_AUTH_BOOTSTRAP_PROJECTS=oauth-dogfood
```

No additional origin, subject, role, project, session override, or free-form
target is included.

## Preflight before any approved reconfiguration

Record every item before mutation:

1. exact repository revision and tree;
2. green full repository gate bound to that revision;
3. exact production Convex URL and deployment identifier;
4. exact deployed membership-audit query revision;
5. exact current Worker version and a tested rollback target;
6. current public-state observation on both origins;
7. current Worker binding names, with values omitted;
8. exact canonical membership-audit result and CLI source revision;
9. confirmation that the GitHub OAuth App callback is exactly
   `https://api.stensibly.com/auth/github/callback`;
10. confirmation that subject `13091533`, role `viewer`, and project
    `oauth-dogfood` are the reviewed policy values;
11. a contemporaneous approval naming the enabled-to-disabled transition,
    binding names changed or removed, exact mechanism, Worker, source revision,
    and rollback target.

Run the full source gate:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:convex
bun run worker:check
```

Return `HOLD` when any fact is missing, stale, contradictory, malformed, or
inferred rather than observed.

## Approved execution boundary

This packet deliberately does not invent a credential-removal command. The
operator must use only the exact binding-removal, version-restore, or deployment
mechanism named in the contemporaneous approval.

The execution surface may:

- map the two protected GitHub aliases to their Worker binding names;
- use one permission-restricted temporary file for the complete hosted-auth
  binding set;
- deploy the exact accepted source revision;
- remove or restore OAuth bindings only through the approved mechanism;
- delete the temporary file through an exit trap;
- record fixed result classifications and exact deployment identifiers.

It may not:

- enable OAuth;
- create or rotate credentials outside the named change;
- complete a GitHub login;
- create or edit a membership;
- restore recurring rollout automation;
- use shell tracing;
- print temporary-file contents or secret values;
- retain arbitrary provider or response bodies.

## Required post-change verification

Use the protected read token only through the environment.

API-token compatibility:

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

Both origins must pass the complete disabled contract:

- health reachable;
- hosted GitHub auth healthy;
- OAuth metadata absent;
- required-token MCP challenge exact bare `Bearer`;
- invalid-token MCP challenge exact bare `Bearer`.

A 4/5 result, redirect, generic proxy response, malformed challenge, origin
mismatch, timeout, or verifier uncertainty is failure.

Do not test login. Creating the first membership would consume the bootstrap
policy and end the clean preflight state.

## Failure and compensation

On any failed post-change check:

1. stop before login or any OAuth enablement;
2. retain only bounded fixed classifications and exact deployment identifiers;
3. execute only the compensation named in the approval;
4. rerun API-token and public-state verification on both origins;
5. rerun the provider-membership audit when the failure might have created
   identity or membership state;
6. record `HOLD` with the failed condition and rollback result.

Worker rollback does not reverse Convex data or membership creation. Any Convex
or membership repair is a separate reviewed action.

## Evidence record

Attach one content-minimised record to #220 and #286:

```yaml
packet: w01-hosted-auth-phase1/v4
status: observed_enabled | passed | hold | rolled_back
executed_at: <UTC timestamp>
actor: <attributable operator or run>
approval_ref: <exact approval or null for observation-only>
source_revision: <exact SHA>
source_tree: <exact tree SHA>
ci_run: <exact green run>
production_convex_url: <exact reviewed origin or not_run>
convex_deployment_before: <identifier or not_run>
convex_deployment_after: <identifier | unchanged | not_run>
worker_version_before: <identifier or not_run>
worker_version_after: <identifier | unchanged | not_run>
public_state_before: enabled | disabled | inconsistent
configuration_names_before: <bounded names-only list>
configuration_names_after: <bounded names-only list | not_run>
membership_audit_cli_revision: <exact SHA or not_run>
membership_audit_query_revision: <exact deployed revision or not_run>
membership_audit_status: identity_absent | <other bounded status> | not_run
membership_audit_clean_bootstrap_eligible: true | false | not_run
membership_audit_read_only: true | false | not_run
membership_audit_grants_membership_change: false | true | not_run
bootstrap_role: viewer | not_run
bootstrap_projects:
  - oauth-dogfood
login_performed: false
oauth_bindings_absent_after: true | false | not_run
github_callback_confirmed: true | false | not_run
canonical_bearer: passed | failed | not_run
fallback_bearer: passed | failed | not_run
canonical_disabled_5_of_5: passed | failed | not_run
fallback_disabled_5_of_5: passed | failed | not_run
rollback_target: <worker version identifier or not_run>
rollback_result: not_needed | passed | failed | not_run
hold_reason: <bounded fixed classification or null>
failed_condition: <bounded field name or null>
omissions:
  - credential values
  - raw tokens
  - provider subject in retained result evidence
  - temporary-file content
  - raw provider payloads
  - arbitrary response bodies
next_gate: guarded_non_production_evidence | approved_reconfiguration | human_decision
```

A `passed` record requires the exact `identity_absent` audit result, every
authority flag at its fixed safe value, every verification passed, OAuth absence
proved, fixed role/project values matched, and `login_performed: false`.

A `hold` or `rolled_back` record must report the actual bounded audit state,
failed condition, OAuth-binding result, and verification result. It must never
claim `identity_absent`, clean-bootstrap eligibility, or binding absence when
those facts were not observed.

An observation-only record for the current enabled deployment uses
`status: observed_enabled`, records the bounded public-state evidence, and leaves
mutation-only fields as `not_run`.

## Stop line and next gates

A passed disabled-state run proves only that hosted GitHub auth and API-token
compatibility work while public OAuth is disabled and no identity or membership
has been created for the initial subject.

It does not satisfy or waive:

- guarded non-production abuse evidence;
- run-tag cohort, cleanup, and retry inspection;
- production lifecycle-row audit and malformed-row repair;
- approval for a write-capable membership role;
- approval for OAuth enablement;
- real ChatGPT login, consent, tool scan, bounded read, separately approved
  project-scoped write, refresh, or reconnect;
- #374's one-time authority design for any future automation.

— Cinder · Stensibly dogfood
  Intention: make hosted-auth recovery executable only from observed state and the integrated copy-safe audit boundary
