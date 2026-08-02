# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-03 after provider-context, governed-write, outbound-text, proof, and CI-queue review  
**Current main:** `22495e429b70a290ca1680518e169dbe573b44ca`  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `10`  
**Operating protocol:** `stensibly-agent-ops/0.5.0` plus standing policy `stensibly-internal-dogfood/v2`

## Purpose

Keep GitHub and Stensibly executable together through sustained ChatGPT use, repeated reads and writes, reconnect, and recovery.

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

One successful login, discovery call, read, or write is useful evidence. W01 completes only after repeated same-conversation execution and reconnect recovery pass.

## Verified reality

### Sustained-use incident

Initial hosted coexistence succeeded: GitHub and Stensibly were discovered in one authenticated conversation, repository state was read, the workspace was surveyed, and one idempotent item was created and claimed.

Continued use later failed: Stensibly mutations disappeared or returned no useful result, artifact attachment and completion became unreliable, rediscovery did not reliably restore execution, and connector availability changed during incident recording. #490 owns this failure. Initial authentication evidence remains in #220 and #286.

### Dashboard and Worker evidence remain separate

Vercel dashboard deployment `dpl_BAUuuBJUcaeCpfV3WH1cMXSJkdiY` is READY at repository revision `babc725f3e685db6c3890a20a85caad15c6e7ac4`. Dashboard aliases returned HTTP 200 with the expected shell. `/mcp` on that Vercel alias returns `404 NOT_FOUND`.

The API/MCP hosts are `https://api.stensibly.com` and fallback `https://stensibly-api.leoli-082000.workers.dev`, deployed separately through **Deploy Worker Production**.

The exact Cloudflare Worker revision, public manifest headers, accepted project/repository binding, and feature-flag state remain unverified. Vercel ancestry does not prove Worker/MCP release state.

### Governed issue writes

The first typed issue-write chain is merged:

1. #934 durable hosted provider receipts → `0853d23ebc8b876e0267d7e485d184a51b8e6613`;
2. #937 private hosted create/update/comment → `c3a0079f7e9232a07976bf112c327f8db750d80e`;
3. #938 public typed MCP actions → `a14133c6f2096a803b1e6ac503241dca9322251e`.

Current repository identity is 37 tools with fingerprint:

```text
sha256:a503c88468a85884ee10b72e0a3d6df47afa8eba95dfe599e9c1c48f59874b70
```

Hosted writes require authenticated principal identity, write scope, project access, exact repository binding, explicit idempotency, and the write feature flag. Ambiguous outcomes remain `pending_reconciliation`; exact replay must not redispatch.

#### Label and assignee parity

#968 adds private label/assignee writes. Child #972 owns call-local settlement. The call-local design is accepted, but current head `b5353af0384e6c3add1d9671269ce29f7396484f` remains a six-file transition packet:

- a temporary write-capable workflow still owns the intended request-ID rewrite;
- direct source still discards a known provider request ID when final verification fails;
- direct label/assignee response-admission reversals remain incomplete;
- the PR body still describes an expired three-file fence.

#972 must publish a carrier-free source/test head, retain known request IDs through pending reconciliation, and directly reverse provider response admission before absorption into #968.

#970 stacks four public label/assignee actions. Its handlers and capability policies show no independent authority blocker, but the release snapshot still pairs a 41-tool declaration with the old 37-tool fingerprint. It stays draft behind repaired #968/#972 and one exact 41-tool identity across runtime, tests, diagnostics, action snapshot, and recovery guidance.

#921 still needs exact Worker evidence, app refresh, one authorised create → update → comment journey, durable receipt lookup, reconnect, and exact replay proving no duplicate mutation.

### Provider context reconciliation

#961 is the combined #958 receipt-to-context compiler at `fa510dc0c7a189d09d46ac9c2f00385177482050`. It admits only provider-write receipts, enforces lifecycle coherence, binds production target and repository identity, re-admits issue snapshots, returns a snapshot only for proposed acceptance, and grants no provider mutation, context acceptance, or authority.

Source review accepts #961. Canonical run `30760524249` exists but exposes no jobs.

### Private accepted binding

#967 at `b4bb9cce30b4c18f890177094a43d174f7ce8677` now uses private runtime fields, exact caller admission, bounded project-scope proof, canonical stored-context validation, and a genuine missing-row-only null path.

Child #974 at `c2756c9595980ea899cc3506057cae4bf21bfc77` binds the durable record ID to exact workspace/project/observation identity and rejects reversed project chronology. Source review accepts the child; run `30761056074` is queued. After green unchanged-head CI, absorb #974 into #967 and rerun the parent.

### Acceptance composition

#975 at `c3a2d7ff4cecf766c800acd9ebea3909b2ee1f0e` composes provider proposals with nullable accepted bindings. Three admission repairs remain:

- actionable proposals must exclude comments because #961 never proposes context acceptance for comments;
- current bindings must reject the impossible `stale` outcome;
- binding `recordId` must equal the canonical workspace/project/observation-derived identity.

### Backlink-safe outbound text

#971 is the #573 pure pre-dispatch text compiler at `e59708fae0d93651511aba6f632f70fd2278f4c7`.

It detects external GitHub issue, pull-request, discussion, commit URL, repository shorthand, commit shorthand, and closing-keyword references in exact outbound text. Controlled repositories pass. Other findings return `reject` or `requires_authority` without granting provider interaction or authority.

Public findings retain separated owner/repository identity, bounded item identity or a non-reconstructing commit prefix, field/line/column, rule, and fingerprints. Raw text, complete links, shorthand, closing expressions, full commits, long numeric aliases, and backlink-capable policy IDs remain private. Hidden exact reference digests prevent collisions after minimisation. Controlled-repository arrays require exact `Array.prototype`.

CodeRabbit and complete source review are green; both inline threads are resolved. Canonical run `30761810704` exists but exposes no jobs.

### GitHub Actions job details

Eight guarded reads remain mounted by default. Exact `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED=true` adds `fetch_workflow_job_steps` and `fetch_workflow_job_logs`, producing the ten-tool declaration.

The path uses repository-scoped `actions:read`, exact provider request identity, credential-free log download, bounded UTF-8 evidence, and no artifact bytes or writes.

#697 still needs exact Worker revision/flag evidence, ten-tool discovery, and one authenticated hosted step or log receipt.

### Exact-ref and trigger evidence

#940 merged reusable read-only exact-ref validation as `22495e429b70a290ca1680518e169dbe573b44ca`.

#953 is the #700 trigger-receipt candidate at `d8da96a5106d2de0c9146fd1821827a48a6506d5`. It distinguishes complete absence, incomplete coverage, and observed run/attempt evidence without inferring queue reason, execution state, position, or ETA. Source review accepts the repaired identity domains. Run `30759262459` exists but exposes no jobs.

### OpenAI Agents runner adapter

#945 is the current-main parent at `65d5754d15ef2b560983a6219d273eeb87dd1f5d`.

Child #959 at `e81eee75584e925002dadfa3a98d1bb427e02567` supplies the accepted shared numeric-identity repair:

- shared non-negative integer admission rejects JavaScript `-0`;
- external-reference and capability-probe controls reject the alias;
- ordinary `0` remains positive zero.

Run `30759263045` exists but exposes no jobs. After green child CI, absorb #959 into #945, retire the child, and rerun the complete parent.

### Long review threads

#944 at `184d3b4cdd34673016162313ad2caf6032b4b515` retains the first 20 comments of long threads and exposes provider total/truncation evidence. It rejects contradictory pagination and preserves hosted/public projections.

CodeRabbit and independent source review are green. Run `30755171898` exposes three queued jobs but has not executed.

### Observation proofs

#962 is a carrier-free eight-file #955 candidate at `5cca3f33ebca08dbdb192ca665a237b5d85ced8e`. It adds closed ASCII retained IDs, realistic credential screening, proof matrices, parity vectors, and exact sequence binding.

One privacy blocker remains: the retained grammar still admits complete GitHub URLs and backlink-capable issue/commit aliases such as `https://github.com/example/project/issues/123`, `example/project#123`, and `github:example/project#123`. These values are republished verbatim in checkpoints or proofs. URI and GitHub-reference forms must fail while internal IDs remain valid.

### Cancellation model

#960 current head `6daacd76c7ccc063e6242db327d75f3deda34951` is a six-file proof-carrier transition, not the advertised four-file model. The underlying model repair makes pre-close outcomes, repeated terminal observation, cancelled retry, and separate unsafe replacement/publication witnesses reachable.

The carrier must produce an attributable run, remove itself, publish source/evidence only, verify a hard-coded SHA-256 or stronger signed TLC artifact identity, record safe/unsafe/witness traces and state counts, and receive fresh review of the instrumented final model. Static review is not executable proof.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained use | Initial coexistence passed; repeated execution and reconnect remain unproved | Run the complete uniquely identified lifecycle with GitHub checkpoints between segments | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed writes | 37-tool path is merged; #972/#970 parity stack is blocked; Worker state is unverified | Finish carrier-free #972, absorb into #968, repair #970 identity, then verify Worker and live write/replay | Receipt survives reconnect, replay does not duplicate, and accepted-context reconciliation is visible |
| P0 | #492 hosted context | #961 source is accepted; #967 needs #974; #975 needs three admission repairs | Let #961 run; finish #974/967; repair #975; then verify Worker and one hosted context receipt | Reconciliation, binding, composition, and hosted receipt pass |
| P0 | #697 Actions details | Ten-read code is merged; Worker revision and flag remain unverified | Verify Worker, exact declaration, and one authenticated step/log receipt | Live attributable receipt passes and #697 closes |
| P1 | #573 outbound text | #971 source/reviews are green; run has no jobs | Let `30761810704` execute, refresh terminal gates, then integrate | External references are rejected or routed without backlink-capable diagnostics or authority grant |
| P1 | #943 review threads | #944 source is accepted; jobs are queued | Let `30755171898` finish unchanged, refresh gates, then integrate | Long threads return bounded truncation evidence and contradictions fail closed |
| P1 | #700 trigger receipts | #953 source is accepted; run has no jobs | Let `30759262459` execute, refresh gates, then integrate | Absence, unknown coverage, and observed run evidence remain distinct |
| P1 | #659 runner adapter | #945 requires accepted child #959 | Complete #959 CI, absorb, rerun parent | One adapter integrates with chronology, profile, authority, privacy, recovery, and shared numeric identity intact |
| P1 | #955 observation proofs | #962 has one retained-link privacy blocker | Reject URI/reference-shaped IDs and rerun proof tests | Proofs retain no arbitrary prose, backlink, or credential text |
| P2 | #954 cancellation model | #960 is a proof carrier, not final evidence | Produce pinned source/evidence-only TLC packet and fresh review | Safe model passes and unsafe configs yield expected counterexamples |

## Definition of done

W01 completes when fresh authenticated conversations repeatedly prove:

1. repository instructions and backlog remain readable;
2. OAuth discovery, login, consent, refresh, and reconnect succeed;
3. Stensibly tools remain executable after several calls;
4. create/claim/event/artifact/read/complete/reread succeeds;
5. every mutation returns success, actionable failure, or explicit ambiguity with deterministic reconciliation;
6. governed GitHub writes return durable actor/client-bound receipts;
7. provider readback reconciles through one exact private binding without implicit authority;
8. GitHub and Stensibly remain usable together;
9. reconnect restores authorised functionality and receipt lookup;
10. diagnostics identify the rejecting, lost, timed-out, or ambiguous layer without secrets;
11. GitHub remains independently readable and writable during Stensibly degradation.

Merged code, dashboard presence, metadata checks, or one successful operation do not complete the wave.

## Immediate next actions

- Obtain exact **Deploy Worker Production** evidence for official/fallback API/MCP hosts.
- Finish carrier-free #972, absorb into #968, and repair #970’s 41-tool identity.
- Let #961 execute; finish #974/967; repair #975.
- Run one authorised hosted context receipt for #492 and one step/log receipt for #697.
- Execute one fresh #490 lifecycle with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.
- Finish exact-head CI and integration for #971, #944, and #953.
- Finish #959 CI, absorb into #945, and rerun the parent.
- Repair #962 retained-link privacy.
- Complete #960’s pinned source/evidence-only TLC proof.

## Failure handling

When a step fails:

- identify the failing stage and responsible surface;
- preserve bounded evidence, operation identity, and ambiguity identity;
- reconcile a possible successful mutation before retrying;
- repair and deploy when fix-forward is safe;
- roll back after a demonstrated regression or unsafe partial state;
- resume the failing segment and repeat the whole lifecycle;
- leave GitHub with the current fact, evidence, and one executable next action.

A failed dogfood attempt is product evidence and should produce a sharper test, diagnostic, or repair.

— Morrow · W01 revision 10 reconciliation  
  Intention: keep deployment truth, exact candidate state, and executable next actions aligned
