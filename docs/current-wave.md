# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-02 after governed GitHub issue writes merged  
**Current main:** `a14133c6f2096a803b1e6ac503241dca9322251e`  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `9`  
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

A single successful login, discovery call, read, or write is useful evidence. W01 completes after repeated same-conversation execution and reconnect recovery pass.

## Current verified reality

### Sustained-use incident

The initial hosted coexistence path succeeded: GitHub and Stensibly were discovered in one authenticated conversation, repository state was read, the workspace was surveyed, and one idempotent item was created and claimed.

Continued use later failed: Stensibly mutations disappeared or returned no useful result, artifact attachment and completion became unreliable, rediscovery did not reliably restore execution, and connector availability changed during incident recording. Issue #490 owns this sustained-use failure. Initial authentication evidence remains in #220 and #286.

### Guarded GitHub reads

The repository contains a guarded ten-tool GitHub read path.

Eight tools remain mounted by default:

1. `get_repo`;
2. immutable-commit `fetch_file`;
3. `get_pr_info`;
4. bounded `get_pr_diff` / patch;
5. bounded `list_pull_request_review_threads`;
6. exact `get_commit_combined_status`;
7. exact-commit `fetch_commit_workflow_runs`;
8. exact-run `fetch_workflow_run_jobs`.

PR #931 merged as `d1a90b2d8eecb1ee09a39d7d99f9564d340aec30`. Exact `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED=true` adds:

9. `fetch_workflow_job_steps`;
10. `fetch_workflow_job_logs`.

The two job-detail reads use repository-scoped `actions:read`, bind provider request identity to the producing request, omit installation credentials from the download request, retain bounded UTF-8 text, and keep artifact bytes and writes unavailable. Canonical CI `30723519846` passed every repository, runtime, browser, artifact, and exact-revision serial gate.

#697 remains open until the deployed revision and one authenticated hosted step/log receipt prove the exact ten-tool declaration in the live environment.

### GitHub project context

Hosted GitHub issue-context persistence landed through #908 as `d2880ea9f7efe6ad8f29107acde9db79bc0faed9`.

PR #933 merged the project-scoped read-only `get_github_project_context` action as `d8417bb073f2374025c2fa43cc78744e68c6f3ea`. The action uses SQLite or hosted `ConvexWorkLedger`, follows the capability policy, and is part of the current public manifest.

Historical carrier PRs #560 and #926 are closed. #492 now needs one authorised hosted context read and subsequent use inside the sustained W01 lifecycle.

### Governed GitHub issue writes

The first typed Stensibly-to-GitHub issue-write chain is now merged end to end.

1. PR #934 merged durable hosted `GitHubProviderReceiptStore` persistence as `0853d23ebc8b876e0267d7e485d184a51b8e6613`.
2. PR #937 merged private hosted create/update/comment execution as `c3a0079f7e9232a07976bf112c327f8db750d80e`.
3. PR #938 merged public typed MCP actions as `a14133c6f2096a803b1e6ac503241dca9322251e`.

The public release now contains 37 tools with manifest fingerprint:

```text
sha256:a503c88468a85884ee10b72e0a3d6df47afa8eba95dfe599e9c1c48f59874b70
```

The new actions are:

- `github_create_issue`;
- `github_update_issue`;
- `github_add_issue_comment`;
- read-only `get_github_provider_receipt`.

Every write derives actor/client identity from the authenticated MCP principal, requires write scope and project access, binds the exact repository, and requires one explicit idempotency key. Updates require the last SHA-256 provider source revision. Receipt lookup returns a row only when project, repository, actor, and client all match.

Hosted execution remains disabled unless `STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED=true` is configured with the complete accepted repository binding and durable receipt store. Initial labels, assignees, label-set writes, assignee-set writes, generic write tunnels, and live configuration are outside the public packet.

Mutations use repository-scoped `issues:write`; independent verification uses `issues:read`. Transport loss, 5xx, throttling, malformed mutation responses, or failed post-mutation readback remain `pending_reconciliation`; exact replay does not redispatch.

#921 remains open until the deployed 37-tool release is refreshed in the ChatGPT app and one authorised create/update/comment journey returns a durable receipt, survives reconnect, and reconciles accepted GitHub context without duplicate mutation.

### OpenAI Agents runner adapter

Parent PR #659 remains a stale-base draft. Its model-free four-file adapter candidate passed historical gates, and #875 documented two accepted repairs:

- replayed checkpoint receipts must satisfy `record.createdAt <= proposedCreatedAt`, while fresh receipts retain exact equality;
- checkpoint holder authority must be validated before consulting the process-local latest-reference cache.

The executable #659 action is a trusted source commit containing the documented substitutions, followed by a carrier-free current-main replay, focused adapter suites, canonical CI, complete review, and mergeability proof. No provider request, model execution, credential, dependency, deployment, public MCP/REST surface, or canonical Stensibly transition belongs in that packet.

### Operating protocol

Protocol `stensibly-agent-ops/0.5.0` and bootstrap `stensibly-project-bootstrap/v3` keep existing work visible for dependencies, useful continuations, and overlap while allowing valuable bounded lanes to start according to expected value, coherence, collision risk, and recoverability.

## Temporary degraded mode

While #490 remains open:

- GitHub owns repository instructions, issues, priorities, source, pull requests, reviews, checks, deployments, evidence, blockers, and handoffs;
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
2. OAuth discovery, GitHub-backed login, consent, token exchange, refresh, and reconnect succeed;
3. Stensibly tools remain discovered and executable after several calls;
4. the complete create/claim/event/artifact/read/complete/reread lifecycle succeeds;
5. every mutation returns typed success, actionable failure, or explicit ambiguity with deterministic reconciliation;
6. a governed Stensibly-to-GitHub create/update/comment operation returns a durable actor-bound receipt;
7. GitHub and Stensibly remain usable together throughout the conversation;
8. disconnect and reconnect restore authorised functionality and receipt lookup;
9. the lifecycle passes repeatedly in one conversation and across reconnects;
10. automated coverage exercises repeated same-session operations and reconnects;
11. diagnostics identify which layer rejected, timed out, lost, or ambiguously completed a call without exposing secrets;
12. GitHub remains independently readable and writable during Stensibly degradation.

A merged PR, setup document, dashboard sign-in, metadata check, or single successful write does not complete the wave.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained-use incident | Code paths and diagnostics are stronger; continued execution and reconnect remain unproved | Run the complete uniquely identified lifecycle in one fresh authenticated conversation, checkpointing GitHub between segments | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed GitHub writes | Durable receipts, private hosted execution, and public typed MCP actions are merged in #934/#937/#938 | Confirm deployed `a14133c6…`, refresh the ChatGPT app to the 37-tool manifest, then perform one authorised idempotent create/update/comment and reconnect receipt lookup | Live verified receipt survives reconnect, exact replay does not duplicate, and accepted context reconciliation is visible |
| P0 | #492 hosted GitHub context | Persistence #908 and public MCP #933 are merged | Record one authorised hosted `get_github_project_context` read, then use it during a sustained lifecycle run | Hosted receipt and repeated lifecycle use pass |
| P0 | #697 Actions step/log mounting | PR #931 merged the exact opt-in ten-tool path | Verify deployed revision and record one authenticated hosted step/log receipt | Live ten-tool receipt passes and #697 closes |
| P1 | #591 / #744 signed observations | Operational lane owns signed receipt and replay/conflict evidence | Complete exact live receipt, replay, and conflict proof without overlapping provider-write or secret work | Signed observation lifecycle has attributable live evidence and deterministic conflict handling |
| P1 | #659 runner adapter | Parent implementation exists; accepted #875 repairs remain uncommitted source bytes | Publish the documented repair through a trusted source commit, replay the clean files on current main, and run canonical proof | Focused adapter suites, canonical CI, review, and integration pass |

## Supporting product chain

The first visible guarded feature chain remains:

```text
#149 causal event envelopes and sequence
  → #273 authorised external chat and runner surfaces
  → #403 attributable response thread
```

Advance #403 after #490 and the bounded #492/#921 live proofs pass their gates. Broader autonomy work continues from reliable measured foundations.

## Work selection

Use this value order when choosing among eligible lanes:

1. reproduce or repair the exact #490 failure;
2. finish live verification for merged #921, #492, and #697 work;
3. integrate active work that removes a demonstrated blocker;
4. keep GitHub instructions, queue, issues, pull requests, and evidence accurate;
5. advance a bounded non-overlapping runner or observation slice;
6. advance the #149/#273/#403 feature chain without claiming sustained reliability;
7. continue broader autonomy work from measured foundations.

Before committing to a lane, inspect dependencies, useful continuations, and overlap. Start bounded work when it advances W01 and leaves an exact recoverable handoff.

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

## Immediate next actions

- Confirm the deployed revision includes `a14133c6f2096a803b1e6ac503241dca9322251e`, refresh or recreate the ChatGPT app against the 37-tool manifest, and record one authorised `github_create_issue` plus `get_github_provider_receipt` replay/reconnect proof under #921.
- Verify the production rollout of `d1a90b2d8eecb1ee09a39d7d99f9564d340aec30` and record one authenticated hosted step/log receipt under #697.
- Record one authorised hosted `get_github_project_context` receipt for #492/#933.
- Execute one fresh #490 lifecycle run with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.
- Publish the accepted #659 chronology and holder-authority repair through a trusted source commit, then replay the carrier-free adapter packet on current main.
- Complete the live #591/#744 signed-observation receipt and conflict evidence.

## Retrospective questions

After #490 passes, record:

- which layer caused each lost, rejected, or ambiguous call;
- whether GitHub remained usable throughout degradation;
- whether provider receipt reconciliation prevented duplicate effects;
- which instructions accelerated delivery or caused stalls;
- whether self-review preserved quality while reducing operator interruption;
- defects found only through sustained same-conversation use;
- duplicated, abandoned, or successfully recovered work;
- the next accepted, rejected, or no-change proposal under #293.

— Kestrel · W01 revision 9 reconciliation  
  Intention: keep one concise verified campaign record with exact live verification steps
