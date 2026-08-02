# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-02 after production-presence verification and exact-ref CI receipts  
**Current main:** `22495e429b70a290ca1680518e169dbe573b44ca`  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `10`  
**Operating protocol:** `stensibly-agent-ops/0.5.0` plus standing policy `stensibly-internal-dogfood/v2`

## In simple words / purpose

Make GitHub and Stensibly remain executable together through sustained ChatGPT use, repeated reads and writes, reconnect, and recovery.

GitHub remains the independent public project and recovery record. Stensibly adds durable responsibility, authority, continuation, provider receipts, and execution history when its connector is available.

## Required lifecycle

```text
GitHub repository and issue reads
  → Stensibly survey
  → create
  → claim
  → progress event
  → artifact attachment
  → read back
  → complete with exact continuation
  → reread
  → governed Stensibly-to-GitHub write
  → provider receipt reconciliation
  → further GitHub read/write
  → disconnect/reconnect
  → repeat bounded read/write
```

A single successful login, discovery call, read, or write is useful evidence. W01 completes only after repeated same-conversation execution and reconnect recovery pass.

## Current verified reality

### Sustained-use incident

The initial hosted coexistence path succeeded: GitHub and Stensibly were discovered in one authenticated conversation, repository state was read, the workspace was surveyed, and one idempotent item was created and claimed.

Continued use later failed: Stensibly mutations disappeared or returned no useful result, artifact attachment and completion became unreliable, rediscovery did not reliably restore execution, and connector availability changed during incident recording. Issue #490 owns this sustained-use failure. Initial authentication evidence remains in #220 and #286.

### Production presence is no longer the blocker

The production deployment record is READY at GitHub revision `babc725f3e685db6c3890a20a85caad15c6e7ac4`. Both production aliases returned HTTP 200 with the expected Stensibly dashboard shell, and no Vercel runtime error clusters were reported in the preceding 24 hours.

That deployed revision contains all three P0 repository releases:

- governed GitHub issue writes from `a14133c6f2096a803b1e6ac503241dca9322251e`;
- scoped hosted GitHub project context from `d8417bb073f2374025c2fa43cc78744e68c6f3ea`;
- opt-in Actions job step and log reads from `d1a90b2d8eecb1ee09a39d7d99f9564d340aec30`.

Code presence and basic deployment health are therefore proven. The remaining gates are authenticated product receipts and sustained use, not another rollout investigation.

### Governed GitHub issue writes

The typed Stensibly-to-GitHub issue-write chain is merged end to end:

1. PR #934 merged durable hosted `GitHubProviderReceiptStore` persistence as `0853d23ebc8b876e0267d7e485d184a51b8e6613`.
2. PR #937 merged private hosted create/update/comment execution as `c3a0079f7e9232a07976bf112c327f8db750d80e`.
3. PR #938 merged public typed MCP actions as `a14133c6f2096a803b1e6ac503241dca9322251e`.

The public release contains 37 tools with manifest fingerprint:

```text
sha256:a503c88468a85884ee10b72e0a3d6df47afa8eba95dfe599e9c1c48f59874b70
```

The added actions are `github_create_issue`, `github_update_issue`, `github_add_issue_comment`, and read-only `get_github_provider_receipt`.

Every write derives actor/client identity from the authenticated MCP principal, requires write scope and project access, binds the exact repository, and requires one explicit idempotency key. Updates require the last SHA-256 provider source revision. Receipt lookup returns a row only when project, repository, actor, and client all match.

Hosted execution remains gated by `STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED=true` and the complete accepted repository binding. Ambiguous provider outcomes remain `pending_reconciliation`; exact replay must not redispatch.

#921 now needs one authorised create → update → comment journey, durable receipt lookup, reconnect, and exact replay proving no duplicate GitHub mutation.

### GitHub project context

Hosted issue-context persistence landed through #908 as `d2880ea9f7efe6ad8f29107acde9db79bc0faed9`. PR #933 exposed project-scoped read-only `get_github_project_context` as `d8417bb073f2374025c2fa43cc78744e68c6f3ea`.

Deployment presence is proven. #492 now needs one authorised hosted context receipt and use of that accepted context during the sustained #490 lifecycle and reconnect sequence.

### GitHub Actions job details

Eight guarded GitHub reads remain mounted by default. Exact `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED=true` adds `fetch_workflow_job_steps` and `fetch_workflow_job_logs`, producing the ten-tool declaration.

The job-detail path uses repository-scoped `actions:read`, binds provider request identity to the producing request, omits installation credentials from log downloads, retains bounded UTF-8 evidence, and keeps artifact bytes and writes unavailable.

Deployment presence is proven. #697 now needs one authenticated hosted step or log receipt and discovery proof for the exact ten-tool declaration.

### Exact-ref validation

PR #940 merged reusable read-only exact-ref validation as `22495e429b70a290ca1680518e169dbe573b44ca`.

Canonical CI can now validate one exact source revision through `full_parallel` or `serial_full` and emit a machine-readable terminal receipt that distinguishes source, event, and workflow revision plus each job outcome. This is the preferred evidence path for clean source candidates. It does not grant source-generation or repository-write authority.

### OpenAI Agents runner adapter

Parent #659 is a stale historical candidate. The strongest carrier-free current-main convergence is PR #945 at head `25121b3e0c03f4ec9e2d75723f7cdca063fb82f9`.

#945 preserves the reviewed adapter behind a guarded public wrapper, applies future-replay chronology, checks holder attribution before checkpoint disclosure, binds checkpoint and cancellation controls to adapter/profile/run/generation identity through an unambiguous JSON tuple key, and adds cross-profile plus internal-import controls.

One public-boundary repair remains: its wrapper trims identity-bearing control strings before validation. Supplied command, adapter, profile, run, holder, and authority-resource identities must equal their trimmed forms and remain unchanged. The focused suite should also pin a delimiter-collision case so future key refactors cannot replace the unambiguous tuple with ambiguous string concatenation.

PR #942 is an incomplete diagnostic replay at head `cc3984ee404bf581c3806f6202b5b2445ddfd5c2`: the source still lacks the accepted replay chronology, profile-bound control key, and holder-before-cache ordering, while the diagnostic-only source-export helper remains in the diff. PR #941 is an older duplicate wrapper architecture. Do not integrate either duplicate unless it first becomes materially stronger than #945.

## Temporary degraded mode

While #490 remains open:

- GitHub owns repository instructions, priorities, source, pull requests, reviews, checks, deployments, evidence, blockers, and handoffs;
- Stensibly adds claims, leases, responsibility, run identity, generations, approvals, grants, budgets, artifacts, provider receipts, and attributable execution history;
- ordinary implementation and review work stays recoverable through GitHub;
- Stensibly mutations occur only inside an explicitly identified reliability run or another bounded test lane;
- ambiguous writes are reconciled by unique operation or idempotency identity before replay;
- only one worker mutates one dedicated lifecycle record at a time;
- OAuth remains enabled unless concrete hosted evidence supports another decision.

A connector or chat outage must never hide the backlog or repository instructions.

## Definition of done

W01 completes when fresh authenticated ChatGPT conversations repeatedly prove:

1. repository instructions and the current GitHub backlog remain readable;
2. OAuth discovery, login, consent, token exchange, refresh, and reconnect succeed;
3. Stensibly tools remain discovered and executable after several calls;
4. the complete create/claim/event/artifact/read/complete/reread lifecycle succeeds;
5. every mutation returns typed success, actionable failure, or explicit ambiguity with deterministic reconciliation;
6. a governed GitHub create/update/comment journey returns a durable actor/client-bound receipt;
7. GitHub and Stensibly remain usable together throughout the conversation;
8. disconnect and reconnect restore authorised functionality and receipt lookup;
9. the lifecycle passes repeatedly in one conversation and across reconnects;
10. diagnostics identify the rejecting, timing-out, lost, or ambiguous layer without exposing secrets;
11. GitHub remains independently readable and writable during Stensibly degradation.

Merged code, deployment presence, dashboard health, metadata checks, or one successful operation do not complete the wave.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained-use incident | Repository paths are stronger; repeated execution and reconnect remain unproved | Run the complete uniquely identified lifecycle in one fresh authenticated conversation, checkpointing GitHub between segments | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed GitHub writes | 37-tool release is deployed and basically healthy | Refresh/recreate the app, perform authorised create/update/comment, look up the durable receipt, reconnect, then replay the same identities | Receipt survives reconnect, exact replay does not duplicate, and accepted context reconciliation is visible |
| P0 | #492 hosted GitHub context | Persistence and public MCP action are deployed | Record one authorised `get_github_project_context` receipt and use it during the sustained lifecycle | Hosted receipt and repeated lifecycle use pass |
| P0 | #697 Actions step/log mounting | Opt-in ten-read code is deployed | Record one authenticated hosted step/log receipt and exact discovery declaration | Live attributable receipt passes and #697 closes |
| P1 | #591 / #744 signed observations | Operational lane owns signed receipt and replay/conflict evidence | Complete exact live receipt, replay, and conflict proof without overlapping provider-write or secret work | Signed observation lifecycle has attributable live evidence and deterministic conflict handling |
| P1 | #659 runner adapter | #945 is the strongest carrier-free candidate; exact control identity and collision proof remain | Reject trimmed identity aliases, add delimiter-collision controls, run focused suites and canonical exact-ref CI, then complete review | #945 integrates and duplicate #941/#942 plus stale parent #659 retire |

## Work selection

Use this value order among eligible lanes:

1. reproduce or repair the exact #490 failure;
2. finish authenticated live verification for merged #921, #492, and #697 work;
3. integrate active work that removes a demonstrated blocker;
4. keep GitHub instructions, queue, issues, pull requests, and evidence accurate;
5. advance a bounded non-overlapping runner or observation slice;
6. advance the #149/#273/#403 feature chain without claiming sustained reliability;
7. continue broader autonomy work from measured foundations.

Before committing to a lane, inspect dependencies, useful continuations, and overlap. Start bounded work when it advances W01 and leaves an exact recoverable handoff.

## Immediate next actions

- Run one authorised #921 create/update/comment and receipt replay/reconnect journey against the deployed 37-tool release.
- Record one authorised hosted `get_github_project_context` receipt for #492 and one authenticated step/log receipt for #697.
- Execute one fresh #490 lifecycle run with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.
- Repair #945 by rejecting trimmed authority/effect identity aliases and pinning unambiguous tuple-key behavior; then use #940 exact-ref receipts for terminal proof and retire #941/#942.
- Complete the live #591/#744 signed-observation receipt and conflict evidence.

## Failure handling

When a step fails:

- identify the exact failing stage and responsible surface where possible;
- preserve bounded evidence, operation identity, and ambiguity identity;
- reconcile a possible successful mutation before retrying;
- repair and deploy when fix-forward is safe;
- roll back after a demonstrated regression or unsafe partial state;
- resume the failing segment and then repeat the whole lifecycle;
- leave GitHub with the current fact, evidence, and one executable next action.

A failed dogfood attempt is product evidence and should produce a sharper test, diagnostic, or repair.

— Morrow · W01 revision 10 reconciliation  
  Intention: distinguish proven deployment presence from the authenticated product evidence still required
