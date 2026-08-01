# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-02 after protocol 0.5.0, hosted GitHub-context persistence, and native Actions job-detail provider-identity repair  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**GitHub context integration:** #492  
**Wave:** `W01`  
**Wave revision:** `7`  
**Operating protocol:** `stensibly-agent-ops/0.5.0` plus standing policy `stensibly-internal-dogfood/v2`

## In simple words / purpose

Make GitHub and Stensibly remain executable together through a sustained ChatGPT session, repeated reads and writes, disconnect, reconnect, and recovery.

GitHub stays independently usable as the public project and recovery record. Stensibly adds durable responsibility, authority, continuation, and execution history when its connector is available.

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
  → survey
  → further GitHub read/write
  → disconnect/reconnect
  → repeat bounded read/write
```

One successful login, discovery call, read, or initial write is useful evidence. W01 completes after repeated same-conversation execution and reconnect recovery pass.

## Current verified reality

### Hosted coexistence

The hosted OAuth and MCP path reached initial success:

- GitHub and Stensibly were discovered and used in one authenticated ChatGPT conversation;
- repository instructions and open issues were read;
- the Stensibly workspace was surveyed;
- one idempotent item was created and claimed;
- bearer and OAuth public verification remained healthy.

Continued use then failed:

- later Stensibly mutations disappeared or returned no useful result;
- artifact attachment and completion became unreliable;
- subsequent Stensibly reads and writes stopped executing;
- rediscovery returned schemas without reliably restoring execution;
- GitHub disappeared from the connector registry and later hit a developer-MCP-only restriction;
- the Stensibly connector later became unavailable while the incident was being recorded.

Issue #490 owns this sustained-use failure. Initial authentication evidence remains in #220 and #286.

### GitHub recovery surface

The guarded public GitHub path exposes eight repository-scoped reads:

1. `get_repo`;
2. immutable-commit `fetch_file`;
3. `get_pr_info`;
4. bounded `get_pr_diff` / patch;
5. bounded `list_pull_request_review_threads`;
6. exact `get_commit_combined_status`;
7. exact-commit `fetch_commit_workflow_runs`;
8. exact-run `fetch_workflow_run_jobs`.

Each mounted read is bound to the accepted project attachment, exact repository identity, minimum GitHub App permission, bounded result contract, and credential-safe receipt.

Native bounded `fetch_workflow_job_steps` and `fetch_workflow_job_logs` landed in #913. PR #920 then required exact provider request identity from the job response for step receipts and from the authenticated logs response for log receipts. The repaired native boundary is on `main` as `4b94c3f4243a435fab52f5ad625e04d3f21134ba`. Hosted and public mounting of those two tools is the remaining #697 step.

### GitHub project context

Hosted GitHub issue-context persistence landed through PR #908 as `d2880ea9f7efe6ad8f29107acde9db79bc0faed9`.

The merged boundary now enforces:

- durable workspace/project ownership for stored rows and selected attachments;
- deterministic public record identity;
- bounded acceptance chronology;
- issue-scoped current-row identity and one current generation;
- unique canonical `(acceptedAt, externalId)` history ordering;
- recursively frozen public projections;
- trusted acceptance and read composition through `ConvexWorkLedger`.

PRs #909 and #912 are closed as superseded and absorbed. Public `get_github_project_context` registration in #560 is now the next #492 delivery slice.

### Operating protocol

PR #917 merged as `a5444dce7d076335b5d6d9a49ee3fb832550921a`:

- operating protocol `stensibly-agent-ops/0.5.0`;
- ChatGPT bootstrap `stensibly-project-bootstrap/v3`;
- existing work remains required context for dependencies, continuations, and overlap;
- valuable bounded new lanes may start whenever they advance the current outcome;
- selection uses expected value, coherence, collision risk, and recoverability.

## Temporary degraded mode

While #490 remains open:

- GitHub owns repository instructions, issues, priorities, discussion, source, commits, pull requests, reviews, checks, deployments, public evidence, blockers, and handoffs;
- Stensibly adds claims, leases, responsibility, run identity, generations, blockers, continuations, approvals, grants, budgets, artifacts, and attributable execution history;
- ordinary implementation and review work stays fully recoverable through GitHub;
- Stensibly mutations occur only inside an explicitly identified reliability run or another bounded test lane;
- ambiguous writes are reconciled by unique operation or idempotency identity before replay;
- only one worker mutates one dedicated lifecycle record at a time;
- OAuth remains enabled unless concrete hosted evidence supports rollback or disablement.

A connector or chat outage must never hide the backlog or repository instructions.

## Definition of done

W01 completes when fresh authenticated ChatGPT conversations repeatedly prove:

1. repository instructions and the current GitHub backlog remain readable;
2. OAuth discovery, GitHub-backed login, consent, token exchange, refresh, and reconnect succeed;
3. Stensibly tools remain discovered and executable after several calls;
4. the complete create/claim/event/artifact/read/complete/reread lifecycle succeeds;
5. every mutation returns typed success, actionable failure, or explicit ambiguity with deterministic reconciliation;
6. GitHub and Stensibly remain usable together throughout the conversation;
7. disconnect and reconnect restore authorised functionality;
8. the lifecycle passes repeatedly in one conversation and across reconnects;
9. automated coverage exercises repeated same-session operations and reconnects;
10. diagnostics identify which layer rejected, timed out, lost, or ambiguously completed a call without exposing secrets;
11. GitHub remains independently readable and writable during Stensibly degradation.

A merged PR, setup document, dashboard sign-in, metadata check, or single successful write does not complete the wave.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained-use incident | Initial coexistence passed; continued execution and reconnect remain unproved | Run the complete uniquely identified lifecycle in one fresh authenticated conversation, checkpointing GitHub between segments | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #560 public GitHub context | Hosted persistence and projection are merged through #908 | Restack the read-only MCP packet on current `main`, add hosted execution coverage, and revalidate manifest identity | Authorised hosted `get_github_project_context` succeeds and the packet merges |
| P0 | #697 Actions step/log mounting | Native reads and exact provider identity are merged on `main@4b94c3f4…` | Extend the hosted declaration from eight to ten tools, route step/log calls through the repaired adapter, and prove public dispatch | Authenticated hosted step/log receipt passes; ten-tool guarded path merges and deploys |
| P1 | #591 / #744 signed observations | Operational lane owns signed receipt and replay/conflict evidence | Complete exact live receipt, replay, and conflict proof without overlapping provider-write or secret work | Signed observation lifecycle has attributable live evidence and deterministic conflict handling |
| P1 | #659 runner adapter | Parent candidate remains open; accepted #875 chronology/holder repair stayed carrier-only | Apply the exact four-file source/test repair directly on a current-main candidate | Focused adapter suites, canonical CI, review, and integration pass |

## Supporting product chain

The first visible guarded feature chain remains:

```text
#149 causal event envelopes and sequence
  → #273 authorised external chat and runner surfaces
  → #403 attributable response thread
```

Advance #403 after #490 and the bounded #492 context read pass their gates. Broader autonomy work continues from reliable measured foundations.

## Work selection

Use this value order when choosing among eligible lanes; it guides priority while allowing valuable bounded new work:

1. reproduce or repair the exact #490 failure;
2. integrate active work that removes a demonstrated blocker;
3. keep GitHub instructions, queue, issues, pull requests, and evidence accurate;
4. advance a bounded non-overlapping #492 or guarded-read slice;
5. advance the #149/#273/#403 feature chain without claiming sustained reliability;
6. continue broader autonomy work from measured foundations.

Before committing to a lane, inspect dependencies, useful continuations, and overlap. Start new bounded work when it advances W01 and leaves a recoverable exact handoff.

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

- Execute one fresh #490 lifecycle run with GitHub checkpoints before discovery, between Stensibly mutation segments, after completion, and after reconnect.
- Restack and integrate #560 on the merged hosted GitHub-context boundary, then exercise one authorised hosted read.
- Mount the repaired native step/log reads through #697 to complete the ten-tool guarded path and preserve one authenticated hosted receipt.
- Complete the live #591/#744 signed-observation receipt and conflict evidence.
- Apply the accepted checkpoint chronology and holder-authority repair directly to #659.

## Retrospective questions

After #490 passes, record:

- which layer caused each lost, rejected, or ambiguous call;
- whether GitHub remained usable throughout degradation;
- whether read-after-write reconciliation prevented duplicate effects;
- which instructions accelerated delivery or caused stalls;
- whether self-review preserved quality while reducing operator interruption;
- defects found only through sustained same-conversation use;
- duplicated, abandoned, or successfully recovered work;
- the next accepted, rejected, or no-change proposal under #293.

— Cinder · W01 revision 7 reconciliation  
  Intention: keep one concise verified campaign record with exact lanes and clearing conditions
