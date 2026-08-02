# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-02 after dashboard verification, Worker-evidence correction, exact-ref CI receipts, and repair-lane convergence  
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

Parent #659 remains a stale historical candidate. PR #945 is now the sole executable current-main integration lane.

Its source-only head `55deb1b0c691d01d7a76bf7e25e81efb3f37fb5b` preserves the reviewed #659 implementation byte-for-byte as `openai-agents-base.ts` and adds one bounded public wrapper plus focused controls. The nine-file candidate:

- rejects future-dated replay records while preserving exact equality for fresh append receipts;
- binds checkpoint and cancellation controls to exact adapter, version, profile, run, and generation identity;
- validates active holder authority before process-local checkpoint disclosure;
- rejects padded authority/effect identity aliases;
- admits benign short token-like prose while rejecting realistic and embedded credential families;
- preserves admitted resume checkpoints and guards repository imports of the reviewed base.

Exact-head review found one test-construction blocker: `test/openai-agents-runner-adapter-resume-cache.test.ts` supplies prose in the neutral closed resume-reason field, so it fails before exercising the cache. Repair child #951 at `b567f4a56435612d33e326310bd8ec78f30ff446` changes only that value to `continuation`; CodeRabbit is green, review threads are empty, and canonical run `30756463449` has jobs queued. Parent run `30755997904` is not integration evidence once the repair is absorbed. After #951 lands, #945 needs a fresh unchanged exact-head comparison, CodeRabbit/thread refresh, full canonical CI, runtime parity, browser evidence, and exact-revision serial validation.

Incomplete reconstruction PRs #942, #947, and #949 are closed and contributed no candidate bytes. Do not revive or integrate both architectures.

### Long review-thread comments

Issue #943 tracks a demonstrated native GitHub review-thread defect: one thread with more than 20 comments currently fails the complete read.

PR #944 is a workflow-free exact three-file candidate at `184d3b4cdd34673016162313ad2caf6032b4b515`. It retains the admitted first 20 comments, exposes exact per-thread `commentsTotalCount` and `commentsTruncated`, raises the aggregate retained-entry ceiling to 2,000, rejects contradictory pagination evidence, and proves the additive evidence survives hosted and public projections.

CodeRabbit is green, review threads are empty, the complete Tier 2 content and provider-contract reviews found no blocker, and the effective branch diff is three files and zero commits behind current `main`. Canonical run `30755171898` remains pending runner allocation; no integration claim is accepted before that unchanged run passes.

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
| P1 | #943 review-thread truncation | #944 is a workflow-free three-file current-main candidate with content review complete; canonical CI is pending | Let run `30755171898` finish unchanged, refresh exact-head gates, then squash-integrate | Long threads return bounded truncation evidence and contradictory pagination fails closed |
| P1 | #591 / #744 signed observations | Operational lane owns signed receipt and replay/conflict evidence | Complete exact live receipt, replay, and conflict proof without overlapping provider-write or secret work | Signed observation lifecycle has attributable live evidence and deterministic conflict handling |
| P1 | #659 runner adapter | #945 is the sole current-main candidate, but its resume-cache control is blocked on test-only repair #951 | Absorb #951, register fresh exact-head CI, refresh source/review gates, then squash-integrate and retire historical parents | One adapter integrates with chronology, profile, authority, privacy, and recovery controls intact |

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
- Finish unchanged exact-head CI and integration for #944.
- Absorb #951 into #945, register fresh exact-head CI, refresh all gates, then integrate and retire the historical #659/#763/#875 lanes.
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
