# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-03 after governed-write integration, exact-ref and trigger receipts, and active repair review convergence  
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

### Dashboard and Worker evidence remain separate

Vercel dashboard deployment `dpl_BAUuuBJUcaeCpfV3WH1cMXSJkdiY` is READY at repository revision `babc725f3e685db6c3890a20a85caad15c6e7ac4`. Dashboard aliases returned HTTP 200 with the expected shell. `/mcp` on that Vercel alias returns `404 NOT_FOUND`.

Repository operations guidance identifies the API/MCP hosts as `https://api.stensibly.com` and fallback `https://stensibly-api.leoli-082000.workers.dev`, deployed separately through **Deploy Worker Production**.

The exact Cloudflare Worker revision, public manifest headers, accepted project/repository binding, and feature-flag state remain unverified. Vercel source ancestry does not prove that Worker/MCP releases are live.

### Governed GitHub issue writes

The typed Stensibly-to-GitHub issue-write chain is merged end to end:

1. #934 merged durable hosted provider receipts as `0853d23ebc8b876e0267d7e485d184a51b8e6613`.
2. #937 merged private hosted create/update/comment execution as `c3a0079f7e9232a07976bf112c327f8db750d80e`.
3. #938 merged public typed MCP actions as `a14133c6f2096a803b1e6ac503241dca9322251e`.

Repository code declares 37 tools with fingerprint:

```text
sha256:a503c88468a85884ee10b72e0a3d6df47afa8eba95dfe599e9c1c48f59874b70
```

The added actions are `github_create_issue`, `github_update_issue`, `github_add_issue_comment`, and read-only `get_github_provider_receipt`.

Every write derives actor/client identity from the authenticated MCP principal, requires write scope and project access, binds the exact repository, and requires one explicit idempotency key. Updates require the last provider source revision. Receipt lookup is actor/client/project/repository bound.

Hosted execution remains gated by exact `STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED=true` and a complete accepted repository binding. Ambiguous outcomes remain `pending_reconciliation`; exact replay must not redispatch.

#921 still needs exact Worker deployment evidence, app refresh to the 37-tool declaration, one authorised create → update → comment journey, durable receipt lookup, reconnect, and exact replay proving no duplicate GitHub mutation.

### GitHub project context and provider-write reconciliation

Hosted issue-context persistence landed through #908. #933 exposed project-scoped read-only `get_github_project_context`.

#492 still needs exact Worker revision evidence, one authorised hosted context receipt, and use of that context during the sustained #490 lifecycle and reconnect sequence.

#958 now owns the pure outbound-receipt-to-context reconciliation compiler. Parent #961 is the active four-file candidate. Its current source re-admits both the provider receipt and embedded issue snapshot, retains actor/attachment/verification identity, returns the provider snapshot only for a proposed acceptance, and grants no provider mutation, context acceptance, or authority.

Two source repairs remain before #961 can enter canonical integration:

- accepted child #964 supplies the production target grammar for create, update, label, and assignee mutations;
- #961 must reject contradictory receipt state/result combinations before outcome classification, including reserved/pending/rejected receipts with results and impossible stale operations.

Closed duplicate #963 contributed review findings only and must not be integrated beside #961.

### GitHub Actions job details

Eight guarded GitHub reads remain mounted by default. Exact `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED=true` adds `fetch_workflow_job_steps` and `fetch_workflow_job_logs`, producing the ten-tool declaration.

The path uses repository-scoped `actions:read`, binds provider request identity to the producing request, omits installation credentials from log downloads, retains bounded UTF-8 evidence, and keeps artifact bytes and writes unavailable.

Worker deployment and flag state remain unverified. #697 needs exact Worker deployment evidence, the ten-tool discovery declaration, and one authenticated hosted step or log receipt.

### Exact-ref and trigger evidence

#940 merged reusable read-only exact-ref validation as `22495e429b70a290ca1680518e169dbe573b44ca`.

Canonical CI can validate one exact source revision through `full_parallel` or `serial_full` and emit a machine-readable terminal receipt. This is the preferred validation path for clean source candidates and grants no source-generation or repository-write authority.

#700 adds the preceding workflow-lookup evidence. PR #953 is the active two-file trigger-receipt candidate at `d8da96a5106d2de0c9146fd1821827a48a6506d5`. Source review accepts its repaired repository, pull-request, workflow-attempt, and run-ID domains. It distinguishes:

- complete empty lookup → `trigger_absent`;
- incomplete empty lookup → `provider_state_unknown`;
- admitted run/attempt references → `run_observed`.

It does not infer runner allocation, queue reason, execution state, failure, position, or ETA. Exact-head run `30759262459` exists but currently exposes no jobs; source integration remains pending canonical execution and terminal gate refresh.

### OpenAI Agents runner adapter

Parent #659 remains historical. #945 is the sole current-main integration parent at `65d5754d15ef2b560983a6219d273eeb87dd1f5d`.

The ten-file wrapper/base packet preserves the reviewed model-free adapter while adding replay chronology, profile-bound checkpoint/cancellation identity, stale-holder denial before local disclosure, realistic credential rejection, resume checkpoint retention, and repository import fencing.

The parent’s wrapper-local negative-zero guard is correct but incomplete by itself. Child #959 is the accepted shared-contract repair at `e81eee75584e925002dadfa3a98d1bb427e02567`:

- `runner-adapter-v1.ts::nonNegativeInteger()` rejects JavaScript `-0`;
- external-reference and capability-probe controls reject the alias;
- ordinary numeric `0` remains admitted and is proved to remain positive zero.

Child run `30759263045` exists but currently exposes no jobs. After unchanged-head CI succeeds, #959 must be absorbed into #945, the child retired, and the complete parent rerun on the new exact head. Existing parent run `30759079701` cannot authorize the unabsorbed final source.

### Long review-thread comments

Issue #943 tracks a demonstrated native GitHub review-thread defect: one thread with more than 20 comments currently fails the complete read.

#944 is the workflow-free exact three-file candidate at `184d3b4cdd34673016162313ad2caf6032b4b515`. It retains the admitted first 20 comments, exposes `commentsTotalCount` and `commentsTruncated`, raises the aggregate retained-entry ceiling to 2,000, rejects contradictory pagination evidence, and proves the fields survive hosted/public projections.

CodeRabbit and content review are green. Canonical run `30755171898` now exposes three queued jobs but has not executed. Integration remains blocked until the unchanged exact head passes every canonical gate and receives terminal refresh.

### Observation integrity and cancellation exploration

#955 explores append-only observation Merkle checkpoints. PR #962 is the active pure implementation, but exact-head review found that its retained `ledgerId`, `compilerId`, and especially `observationId` admission accepts arbitrary printable prose and credential-shaped text that can be republished in inclusion proofs. The candidate must adopt a closed identifier grammar and realistic credential-family rejection before canonical acceptance.

#954 explores cancellation settlement and generation fencing. PR #960 passed static model review: the safe and intentionally unsafe transition systems are coherent on inspection. It remains draft until an independent pinned official `tla2tools.jar` run records version/checksum, a clean safe state space, and the expected unsafe counterexample. Static review is not executable proof.

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
| P0 | #921 governed GitHub writes | Repository implementation is merged; Worker revision and write flag remain unverified | Verify Worker revision/declaration, perform authorised create/update/comment, look up the receipt, reconnect, then replay the same identities | Receipt survives reconnect, exact replay does not duplicate, and accepted-context reconciliation is visible |
| P0 | #492 hosted GitHub context | Persistence/public action are merged; #961 reconciliation compiler remains under repair | Finish #961 target/state semantics, then verify Worker revision and one authorised hosted context receipt | Compiler integrates and hosted receipt plus repeated lifecycle use pass |
| P0 | #697 Actions step/log mounting | Opt-in ten-read code is merged; Worker revision and flag remain unverified | Verify Worker revision/flag, then record one authenticated hosted step/log receipt and exact discovery declaration | Live attributable receipt passes and #697 closes |
| P1 | #943 review-thread truncation | #944 source review is complete; exact-head jobs are queued | Let run `30755171898` finish unchanged, refresh gates, then squash-integrate | Long threads return bounded truncation evidence and contradictory pagination fails closed |
| P1 | #700 trigger receipts | #953 source is accepted; exact-head run exists without jobs | Let run `30759262459` execute, then refresh exact-head gates and integrate | Trigger absence, unknown coverage, and observed-run evidence remain distinct |
| P1 | #659 runner adapter | #945 requires accepted shared child #959 before final parent proof | Complete #959 CI, absorb it into #945, retire the child, and rerun the full parent | One adapter integrates with chronology, profile, authority, privacy, recovery, and shared numeric identity intact |
| P1 | #591 / #744 signed observations | Operational lane owns live signed receipt and replay/conflict evidence; #962 is an exploratory integrity child | Repair #962 retained identity privacy separately from the live receipt lane | Live signed lifecycle passes; experimental proofs retain no arbitrary prose or credential text |
| P2 | #954 cancellation model | #960 is statically coherent but unexecuted | Run pinned official TLC safe/unsafe configurations and record proof artifacts | Safe model has no invariant violation and unsafe model yields the expected counterexample |

## Work selection

Use this value order among eligible lanes:

1. reproduce or repair the exact #490 failure;
2. verify the actual Worker deployment and finish authenticated live proof for #921, #492, and #697;
3. integrate active work that removes a demonstrated blocker;
4. keep GitHub instructions, queue, issues, pull requests, and evidence accurate;
5. advance bounded non-overlapping runner, provider-reconciliation, or observation slices;
6. advance the #149/#273/#403 feature chain without claiming sustained reliability;
7. continue broader autonomy work from measured foundations.

Before committing to a lane, inspect dependencies, useful continuations, and overlap. Start bounded work when it advances W01 and leaves an exact recoverable handoff.

## Immediate next actions

- Obtain exact **Deploy Worker Production** evidence for the official/fallback API/MCP hosts, including deployed revision and enabled feature set.
- After Worker proof, run one authorised #921 create/update/comment and receipt replay/reconnect journey.
- Finish #961 by absorbing #964’s target grammar and adding the exact receipt state/result semantic gate.
- Record one authorised hosted `get_github_project_context` receipt for #492 and one authenticated step/log receipt for #697.
- Execute one fresh #490 lifecycle run with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.
- Finish unchanged exact-head CI and integration for #944 and #953.
- Finish #959 CI, absorb it into #945, rerun the complete parent, then retire historical runner lanes.
- Repair #962 retained identity privacy before any proof publication claim.
- Run the pinned #960 safe/unsafe TLC proof before integration.

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
  Intention: keep deployment truth, exact candidate state, and executable next actions aligned
