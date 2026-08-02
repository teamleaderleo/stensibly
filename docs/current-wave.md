# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-03 after provider-context composition, governed set-write, outbound-text, and observation-proof review  
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
  → accepted-context reconciliation
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

The first typed Stensibly-to-GitHub issue-write chain is merged:

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

#### Label and assignee parity stack

#968 adds private label and assignee writes. Child #972 owns the call-local settlement repair. The call-local design is accepted, but current head `b5353af0384e6c3add1d9671269ce29f7396484f` remains a six-file carrier state:

- one temporary write-capable workflow still owns the intended provider-request-retention rewrite;
- direct source still discards a known provider request ID when final verification fails;
- direct endpoint-response reversal tests remain incomplete;
- the PR body still describes an expired three-file fence.

#972 must publish a carrier-free source/test head that retains known request IDs through pending reconciliation and directly reverses label/assignee response admission before absorption into #968.

#970 stacks the four public label/assignee MCP actions on that private work. Its typed handlers and capability policies have no independent authority blocker, but the release metadata still pairs a 41-tool declaration with the old 37-tool fingerprint. It stays draft behind repaired #968/#972 and one exact 41-tool manifest identity across runtime, tests, diagnostics, action snapshot, and recovery guidance.

#921 still needs exact Worker deployment evidence, app refresh to the deployed declaration, one authorised create → update → comment journey, durable receipt lookup, reconnect, and exact replay proving no duplicate GitHub mutation. Label/assignee live proof follows only after the private/public parity stack integrates and deploys.

### GitHub project context and provider-write reconciliation

Hosted issue-context persistence landed through #908. #933 exposed project-scoped read-only `get_github_project_context`.

#492 still needs exact Worker revision evidence, one authorised hosted context receipt, and use of that context during the sustained #490 lifecycle and reconnect sequence.

#### Provider receipt reconciliation

#958 owns the pure outbound-receipt-to-context reconciliation compiler. PR #961 is the sole combined candidate at `fa510dc0c7a189d09d46ac9c2f00385177482050`. It admits only provider-write receipts, enforces lifecycle coherence, binds production target grammar and exact repository identity, re-admits issue snapshots, retains actor/attachment/verification identity, returns the provider snapshot only for a proposed acceptance, and grants no provider mutation, context acceptance, or authority.

Complete exact-head source review accepts #961. Canonical run `30760524249` exists but currently exposes no jobs. Closed repair children are history and must not integrate beside the combined parent.

#### Private accepted binding

#965 owns the private accepted-binding read. Parent #967 at `b4bb9cce30b4c18f890177094a43d174f7ce8677` now uses private runtime fields, exact caller admission, bounded project-scope proof, canonical stored-context validation, and a genuine missing-row-only null path.

Child #974 at `c2756c9595980ea899cc3506057cae4bf21bfc77` binds the durable record ID to exact workspace/project/observation identity and rejects reversed project-scope chronology. Source review accepts the child; canonical run `30761056074` is queued. After unchanged-head CI succeeds, absorb #974 into #967, retire the child, and rerun the complete parent.

#### Acceptance composition

#973 is implemented by draft #975 at `c3a2d7ff4cecf766c800acd9ebea3909b2ee1f0e`. Its existing-issue versus fresh-instruction fallback is useful, but exact review found three admission gaps:

- a refingerprinted comment proposal can be made actionable even though #961 never proposes context acceptance for comments;
- an `isCurrent: true` binding may still carry the impossible `stale` outcome that #967 rejects;
- the durable binding `recordId` is admitted as arbitrary safe text instead of the canonical workspace/project/observation-derived identity.

#975 must align actionable operations with #961, reject current stale bindings, and verify deterministic binding record identity before canonical acceptance.

### Backlink-safe outbound text

#573 owns a pure pre-dispatch text-policy compiler. PR #971 is the exact four-file candidate at `8bccb6bec27c86cb0cdb854f7882abff06b460a4`.

It detects external GitHub issue, pull-request, discussion, commit URL, repository shorthand, commit shorthand, and closing-keyword references in the exact final outbound text. Controlled repositories pass. Other findings produce `reject` or `requires_authority` without granting provider interaction or authority.

Public diagnostics retain separated owner/repository fields, bounded item identity or a non-reconstructing commit prefix, field/line/column, rule, and fingerprints. Raw text, complete URLs, shorthand, closing expressions, full commits, and backlink-capable policy IDs remain private. Hidden exact reference digests prevent collisions after public minimisation, and controlled-repository arrays require exact `Array.prototype`.

CodeRabbit and complete source review are green; both inline repair threads are resolved. Canonical run `30761126802` exists but currently exposes no jobs. Integration remains blocked on unchanged-head canonical execution and terminal gate refresh.

### GitHub Actions job details

Eight guarded GitHub reads remain mounted by default. Exact `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED=true` adds `fetch_workflow_job_steps` and `fetch_workflow_job_logs`, producing the ten-tool declaration.

The path uses repository-scoped `actions:read`, binds provider request identity to the producing request, omits installation credentials from log downloads, retains bounded UTF-8 evidence, and keeps artifact bytes and writes unavailable.

Worker deployment and flag state remain unverified. #697 needs exact Worker deployment evidence, the ten-tool discovery declaration, and one authenticated hosted step or log receipt.

### Exact-ref and trigger evidence

#940 merged reusable read-only exact-ref validation as `22495e429b70a290ca1680518e169dbe573b44ca`.

Canonical CI can validate one exact source revision through `full_parallel` or `serial_full` and emit a machine-readable terminal receipt. This path grants no source-generation or repository-write authority.

#700 adds the preceding workflow-lookup evidence. PR #953 is the active two-file trigger-receipt candidate at `d8da96a5106d2de0c9146fd1821827a48a6506d5`. Source review accepts its repaired repository, pull-request, workflow-attempt, and run-ID domains. It distinguishes:

- complete empty lookup → `trigger_absent`;
- incomplete empty lookup → `provider_state_unknown`;
- admitted run/attempt references → `run_observed`.

It does not infer runner allocation, queue reason, execution state, failure, position, or ETA. Exact-head run `30759262459` exists but currently exposes no jobs; source integration remains pending canonical execution and terminal gate refresh.

### OpenAI Agents runner adapter

Parent #659 remains historical. #945 is the current-main integration parent at `65d5754d15ef2b560983a6219d273eeb87dd1f5d`.

The wrapper/base packet adds replay chronology, profile-bound checkpoint/cancellation identity, stale-holder denial before local disclosure, realistic credential rejection, resume checkpoint retention, and repository import fencing.

The parent’s wrapper-local negative-zero guard is correct but incomplete by itself. Child #959 is the accepted shared-contract repair at `e81eee75584e925002dadfa3a98d1bb427e02567`:

- `runner-adapter-v1.ts::nonNegativeInteger()` rejects JavaScript `-0`;
- external-reference and capability-probe controls reject the alias;
- ordinary numeric `0` remains admitted and is proved to remain positive zero.

Child run `30759263045` exists but currently exposes no jobs. After unchanged-head CI succeeds, #959 must be absorbed into #945, the child retired, and the complete parent rerun on the new exact head. Existing parent evidence cannot authorize the unabsorbed final source.

### Long review-thread comments

Issue #943 tracks a demonstrated native GitHub review-thread defect: one thread with more than 20 comments currently fails the complete read.

#944 is the workflow-free exact three-file candidate at `184d3b4cdd34673016162313ad2caf6032b4b515`. It retains the admitted first 20 comments, exposes `commentsTotalCount` and `commentsTruncated`, raises the aggregate retained-entry ceiling to 2,000, rejects contradictory pagination evidence, and proves the fields survive hosted/public projections.

CodeRabbit and independent content review are green. Canonical run `30755171898` exposes three queued jobs but has not executed. Integration remains blocked until the unchanged exact head passes every canonical gate and receives terminal refresh.

### Observation integrity and cancellation exploration

#955 explores append-only observation Merkle checkpoints. PR #962 is now a carrier-free eight-file source candidate at `5cca3f33ebca08dbdb192ca665a237b5d85ced8e`. It adds a closed ASCII retained-ID grammar, realistic credential screening, proof matrices, parity vectors, and exact sequence binding.

One privacy blocker remains: the retained grammar still admits complete GitHub URLs and backlink-capable issue/commit aliases such as `https://github.com/example/project/issues/123`, `example/project#123`, and `github:example/project#123`. These values are republished verbatim in checkpoints or inclusion proofs. #962 must reject URI and GitHub-reference forms while preserving internal IDs before canonical acceptance.

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
7. accepted provider readback can be reconciled through one exact private binding without granting authority implicitly;
8. GitHub and Stensibly remain usable together throughout the conversation;
9. disconnect and reconnect restore authorised functionality and receipt lookup;
10. diagnostics identify the rejecting, timing-out, lost, or ambiguous layer without exposing secrets;
11. GitHub remains independently readable and writable during Stensibly degradation.

Merged code, dashboard deployment presence, metadata checks, or one successful operation do not complete the wave.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained-use incident | Repository paths are stronger; repeated execution and reconnect remain unproved | Run the complete uniquely identified lifecycle in one fresh authenticated conversation, checkpointing GitHub between segments | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed GitHub writes | First 37-tool write path is merged; label/assignee parity is blocked in #972/#970; Worker revision and flags remain unverified | Finish carrier-free #972 request-ID/response proof, absorb into #968, repair #970 manifest identity, then verify Worker and live write/replay | Receipt survives reconnect, exact replay does not duplicate, and accepted-context reconciliation is visible |
| P0 | #492 hosted GitHub context | #961 source is accepted; #967 needs #974; #975 has three composer admission blockers | Let #961 run execute; finish #974 CI/absorption and #967 rerun; repair #975; then verify Worker and one hosted context receipt | Reconciliation, private binding, and composition integrate; hosted receipt plus repeated lifecycle use pass |
| P0 | #697 Actions step/log mounting | Opt-in ten-read code is merged; Worker revision and flag remain unverified | Verify Worker revision/flag, then record one authenticated hosted step/log receipt and exact discovery declaration | Live attributable receipt passes and #697 closes |
| P1 | #573 outbound text | #971 source and review threads are green; exact run has no jobs | Let run `30761126802` execute, refresh terminal gates, then squash-integrate | External references are rejected or explicitly routed without backlink-capable diagnostics or authority grant |
| P1 | #943 review-thread truncation | #944 source review is complete; exact-head jobs are queued | Let run `30755171898` finish unchanged, refresh gates, then squash-integrate | Long threads return bounded truncation evidence and contradictory pagination fails closed |
| P1 | #700 trigger receipts | #953 source is accepted; exact-head run exists without jobs | Let run `30759262459` execute, then refresh exact-head gates and integrate | Trigger absence, unknown coverage, and observed-run evidence remain distinct |
| P1 | #659 runner adapter | #945 requires accepted shared child #959 before final parent proof | Complete #959 CI, absorb it into #945, retire the child, and rerun the full parent | One adapter integrates with chronology, profile, authority, privacy, recovery, and shared numeric identity intact |
| P1 | #591 / #744 signed observations | Operational lane owns live signed receipt evidence; #962 is a pure proof experiment with one backlink privacy blocker | Repair #962 retained URL/reference admission separately from the live receipt lane | Live signed lifecycle passes; experimental proofs retain no arbitrary prose, backlink, or credential text |
| P2 | #954 cancellation model | #960 is statically coherent but unexecuted | Run pinned official TLC safe/unsafe configurations and record proof artifacts | Safe model has no invariant violation and unsafe model yields the expected counterexample |

## Work selection

Use this value order among eligible lanes:

1. reproduce or repair the exact #490 failure;
2. verify the actual Worker deployment and finish authenticated live proof for #921, #492, and #697;
3. integrate active work that removes a demonstrated blocker;
4. keep GitHub instructions, queue, issues, pull requests, and evidence accurate;
5. advance bounded non-overlapping runner, provider-reconciliation, outbound-text, or observation slices;
6. advance the #149/#273/#403 feature chain without claiming sustained reliability;
7. continue broader autonomy work from measured foundations.

Before committing to a lane, inspect dependencies, useful continuations, and overlap. Start bounded work when it advances W01 and leaves an exact recoverable handoff.

## Immediate next actions

- Obtain exact **Deploy Worker Production** evidence for the official/fallback API/MCP hosts, including deployed revision and enabled feature set.
- Finish #972 as a carrier-free direct source packet, absorb it into #968, and rerun the private set-write parent.
- Repair #970 to one exact 41-tool manifest identity after the repaired private parent is fixed.
- Let #961 exact-head CI execute; complete #974 CI/absorption and rerun #967; repair #975’s actionable-operation, stale-current, and record-ID admission.
- Record one authorised hosted `get_github_project_context` receipt for #492 and one authenticated step/log receipt for #697.
- Execute one fresh #490 lifecycle run with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.
- Finish unchanged exact-head CI and integration for #971, #944, and #953.
- Finish #959 CI, absorb it into #945, rerun the complete parent, then retire historical runner lanes.
- Repair #962 retained URL/reference privacy before renewed proof claims.
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
