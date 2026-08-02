# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-02 after dashboard verification, Worker-evidence correction, and exact-ref CI receipts  
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

### Dashboard presence is proven; Worker presence is not

Vercel dashboard deployment `dpl_BAUuuBJUcaeCpfV3WH1cMXSJkdiY` is READY at repository revision `babc725f3e685db6c3890a20a85caad15c6e7ac4`. The dashboard aliases returned HTTP 200 with the expected shell, and Vercel reported no runtime error clusters in the preceding 24 hours.

This is dashboard-only evidence. `/mcp` on the Vercel alias returns `404 NOT_FOUND`. Repository operations guidance identifies the active API/MCP hosts as `https://api.stensibly.com` and fallback `https://stensibly-api.leoli-082000.workers.dev`, deployed separately through **Deploy Worker Production**.

The exact Cloudflare Worker revision, public manifest headers, accepted project/repository binding, and feature-flag state remain unverified. Vercel source ancestry does not prove that Worker/MCP releases are live.

### Governed GitHub issue writes

The typed Stensibly-to-GitHub issue-write chain is merged end to end:

1. PR #934 merged durable hosted `GitHubProviderReceiptStore` persistence as `0853d23ebc8b876e0267d7e485d184a51b8e6613`.
2. PR #937 merged private hosted create/update/comment execution as `c3a0079f7e9232a07976bf112c327f8db750d80e`.
3. PR #938 merged public typed MCP actions as `a14133c6f2096a803b1e6ac503241dca9322251e`.

The repository release contains 37 tools with manifest fingerprint:

```text
sha256:a503c88468a85884ee10b72e0a3d6df47afa8eba95dfe599e9c1c48f59874b70
```

The added actions are `github_create_issue`, `github_update_issue`, `github_add_issue_comment`, and read-only `get_github_provider_receipt`.

Every write derives actor/client identity from the authenticated MCP principal, requires write scope and project access, binds the exact repository, and requires one explicit idempotency key. Updates require the last SHA-256 provider source revision. Receipt lookup returns a row only when project, repository, actor, and client all match.

Hosted execution remains gated by exact `STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED=true` and the complete accepted repository binding. Ambiguous provider outcomes remain `pending_reconciliation`; exact replay must not redispatch.

#921 still needs exact Worker deployment evidence, app refresh to the 37-tool declaration, one authorised create → update → comment journey, durable receipt lookup, reconnect, and exact replay proving no duplicate GitHub mutation.

### GitHub project context

Hosted issue-context persistence landed through #908 as `d2880ea9f7efe6ad8f29107acde9db79bc0faed9`. PR #933 exposed project-scoped read-only `get_github_project_context` as `d8417bb073f2374025c2fa43cc78744e68c6f3ea`.

Worker deployment presence remains unverified. #492 needs the exact Worker revision, one authorised hosted context receipt, and use of that accepted context during the sustained #490 lifecycle and reconnect sequence.

### GitHub Actions job details

Eight guarded GitHub reads remain mounted by default in repository code. Exact `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED=true` adds `fetch_workflow_job_steps` and `fetch_workflow_job_logs`, producing the ten-tool declaration.

The job-detail path uses repository-scoped `actions:read`, binds provider request identity to the producing request, omits installation credentials from log downloads, retains bounded UTF-8 evidence, and keeps artifact bytes and writes unavailable.

Worker deployment and flag state remain unverified. #697 needs exact Worker deployment evidence, the ten-tool discovery declaration, and one authenticated hosted step or log receipt.

### Exact-ref validation

PR #940 merged reusable read-only exact-ref validation as `22495e429b70a290ca1680518e169dbe573b44ca`.

Canonical CI can validate one exact source revision through `full_parallel` or `serial_full` and emit a machine-readable terminal receipt that distinguishes source, event, and workflow revision plus each job outcome. This is the preferred evidence path for clean source candidates. It grants no source-generation or repository-write authority.

### OpenAI Agents runner adapter

Parent #659 is a stale historical candidate. No current convergence PR is accepted for integration yet.

- PR #945 is a wrapper/base architecture. Its observed head `d5350de4eea2768a08efec5919bca20d4743aaff` still trims authority-bearing identity strings before validation, aliases altered bytes to exact identities, and lacks the required padded-identity reversing controls.
- PR #942 is the smaller direct architecture. Its observed head `cc3984ee404bf581c3806f6202b5b2445ddfd5c2` still contains a diagnostic source-export helper and has not published the complete chronology, profile-bound control-key, and holder-before-cache repairs.
- PR #947 is a temporary read-only reconstruction carrier for #942 and is not an integration candidate.
- PR #941 is closed.

Converge on one workflow-free implementation. Preserve uniquely useful controls, reject trimmed authority/effect identity aliases, bind control/cache identity to the exact profile and run generations, remove diagnostic exporters, and run focused plus canonical exact-ref proof before choosing an integration candidate.

### Long review-thread comments

Issue #943 tracks a demonstrated native GitHub review-thread defect: one thread with more than 20 comments currently fails the complete read.

Draft PR #944 carries five focused controls and a temporary exact-parent finalizer. The intended clean two-file candidate retains the first 20 comments, exposes `commentsTotalCount` and `commentsTruncated`, raises the aggregate retained-entry ceiling to 2,000, and rejects inconsistent provider pagination evidence. The finalizer must disappear before candidate review.

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

Merged code, dashboard deployment presence, metadata checks, or one successful operation do not complete the wave.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained-use incident | Repository paths are stronger; repeated execution and reconnect remain unproved | Run the complete uniquely identified lifecycle in one fresh authenticated conversation, checkpointing GitHub between segments | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed GitHub writes | Repository implementation is merged; Worker revision and write flag remain unverified | Verify the official/fallback Worker revision and 37-tool declaration, refresh the app, perform authorised create/update/comment, look up the receipt, reconnect, then replay the same identities | Receipt survives reconnect, exact replay does not duplicate, and accepted-context reconciliation is visible |
| P0 | #492 hosted GitHub context | Persistence and public action are merged; Worker presence remains unverified | Verify Worker revision, record one authorised `get_github_project_context` receipt, and use it during the sustained lifecycle | Hosted receipt and repeated lifecycle use pass |
| P0 | #697 Actions step/log mounting | Opt-in ten-read code is merged; Worker revision and flag remain unverified | Verify Worker revision and flag, then record one authenticated hosted step/log receipt and exact discovery declaration | Live attributable receipt passes and #697 closes |
| P1 | #943 review-thread truncation | #944 has focused controls and an exact-parent transition carrier; clean source head is unpublished | Publish the workflow-free two-file candidate, run focused and canonical exact-head gates, complete Tier 2 review, and integrate | Long threads return bounded truncation evidence and contradictory pagination fails closed |
| P1 | #591 / #744 signed observations | Operational lane owns signed receipt and replay/conflict evidence | Complete exact live receipt, replay, and conflict proof without overlapping provider-write or secret work | Signed observation lifecycle has attributable live evidence and deterministic conflict handling |
| P1 | #659 runner adapter | #942 and #945 remain competing incomplete architectures | Publish one clean direct candidate with exact control identity, absorb unique controls, run focused/canonical proof, and retire duplicates | One adapter integrates and stale/duplicate candidates close |

## Work selection

Use this value order among eligible lanes:

1. reproduce or repair the exact #490 failure;
2. verify the actual Worker deployment and finish authenticated live proof for #921, #492, and #697;
3. integrate active work that removes a demonstrated blocker;
4. keep GitHub instructions, queue, issues, pull requests, and evidence accurate;
5. advance a bounded non-overlapping runner or observation slice;
6. advance the #149/#273/#403 feature chain without claiming sustained reliability;
7. continue broader autonomy work from measured foundations.

Before committing to a lane, inspect dependencies, useful continuations, and overlap. Start bounded work when it advances W01 and leaves an exact recoverable handoff.

## Immediate next actions

- Obtain exact **Deploy Worker Production** evidence for the official/fallback API/MCP host, including deployed revision and enabled feature set.
- After Worker proof, run one authorised #921 create/update/comment and receipt replay/reconnect journey.
- Record one authorised hosted `get_github_project_context` receipt for #492 and one authenticated step/log receipt for #697.
- Execute one fresh #490 lifecycle run with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.
- Publish and review #944's clean two-file long-thread repair.
- Converge #942/#945 into one workflow-free runner adapter candidate and retire the duplicate.
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

— Lumen · W01 evidence reconciliation  
  Intention: separate dashboard and Worker truth, preserve exact candidate state, and keep the next proof executable
