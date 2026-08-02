# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-03 after parent consolidation, proof recovery, outbound-text review, and set-write transport repair  
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

#968 owns the private label/assignee write parent. Child #972 owns call-local settlement and provider-request retention.

The reviewed request-ID source state is `824d8149d7a2bc30be5e0472df8bc7fcefa6f151`. It keeps mutation settlement inside the exact call continuation, prevents unrelated reads from consuming another mutation’s ambiguity, retains valid provider request IDs through response admission and final readback failure, limits assignee mutations to ten unique logins, and preserves exact replay.

The live #972 branch still includes a temporary write-capable workflow beyond that source state. It must remove the carrier before parent absorption or integration evidence can be renewed.

#977 is the focused response-bound repair at `44f56c865c89db3204525b5eed7ff26ba75e7b4e`:

- mutation responses are read incrementally instead of through `response.text()`;
- malformed, absent, understated, and oversized length evidence stays bounded at 512 KiB;
- overflow cancels the stream;
- UTF-8 decoding is fatal and bounded;
- an already admitted provider request ID survives bounded-read and decode failure through `GitHubProviderPostEffectError`;
- review `4839488240` accepts source;
- the sole request-ID thread is resolved;
- canonical run `30762297110` is pending.

After #972 removes its carrier, restack or absorb #977, rerun the complete private parent, and only then advance #970.

#970 stacks four public label/assignee actions. Its handlers and capability policy have no independent authority blocker, but it remains behind the private parent and must publish one exact 41-tool identity across runtime, tests, diagnostics, action snapshot, and recovery guidance.

#921 still needs exact Worker evidence, app refresh, one authorised create → update → comment journey, durable receipt lookup, reconnect, and exact replay proving no duplicate mutation.

### Provider context reconciliation

#961 is the combined #958 receipt-to-context compiler at `fa510dc0c7a189d09d46ac9c2f00385177482050`. It admits only provider-write receipts, enforces lifecycle coherence, binds production issue/comment target identity, re-admits issue snapshots, returns a snapshot only for proposed acceptance, and grants no provider mutation, context acceptance, or authority.

Source review accepts #961. Canonical run `30760524249` exists but exposes no jobs. Closed #964 and #969 are recovery history and must not integrate beside the combined parent.

### Private accepted binding

#967 is the complete private binding parent at `c2756c9595980ea899cc3506057cae4bf21bfc77`.

It uses private runtime fields, exact caller admission, bounded project-scope proof, canonical stored-context validation, a genuine missing-row-only null path, deterministic workspace/project/observation record identity, and project chronology admission. Full accepted snapshot and instruction values remain private; the public projection stays content-minimised.

Review `4839451112` accepts the workflow-free parent. CodeRabbit is green, threads are empty, and parent run `30761579473` is pending. Child #974 is closed as absorbed. The former workflow carrier is preserved only on `lumen/967-carrier-recovery-4c6eb410`.

### Acceptance composition

#975 at `c3a2d7ff4cecf766c800acd9ebea3909b2ee1f0e` composes provider proposals with nullable accepted bindings. Three admission repairs remain:

- actionable proposals must exclude comments because #961 never proposes context acceptance for comments;
- current bindings must reject the impossible `stale` outcome;
- binding `recordId` must equal the canonical workspace/project/observation-derived identity.

### Backlink-safe outbound text

#971 current head `e59708fae0d93651511aba6f632f70fd2278f4c7` includes policy-ID privacy, per-reference hidden digests, exact array prototypes, and long-number controls.

One matcher blocker remains. Repository shorthand can still begin inside an unrelated URL or larger token, and item/commit shorthand can terminate before trailing identifier text. Examples that currently create false GitHub findings include:

- `https://example.com/example/project#12`;
- `example/project#12abc`;
- `example/project@abcdef0garbage`.

Review must remain open until the leading and terminal matcher boundaries are repaired and focused pass controls land. Run `30761810704` cannot supersede this source finding.

### GitHub Actions job details

Eight guarded reads remain mounted by default. Exact `STENSIBLY_GITHUB_JOB_DETAIL_READS_ENABLED=true` adds `fetch_workflow_job_steps` and `fetch_workflow_job_logs`, producing the ten-tool declaration.

The path uses repository-scoped `actions:read`, exact provider request identity, credential-free log download, bounded UTF-8 evidence, and no artifact bytes or writes.

#697 still needs exact Worker revision/flag evidence, ten-tool discovery, and one authenticated hosted step or log receipt.

### Exact-ref and trigger evidence

#940 merged reusable read-only exact-ref validation as `22495e429b70a290ca1680518e169dbe573b44ca`.

#953 is the #700 trigger-receipt candidate at `d8da96a5106d2de0c9146fd1821827a48a6506d5`. It distinguishes complete absence, incomplete coverage, and observed run/attempt evidence without inferring queue reason, execution state, position, or ETA. Source review accepts the repaired identity domains. Run `30759262459` exists but exposes no jobs.

### OpenAI Agents runner adapter

#945 is the complete current-main parent at `e81eee75584e925002dadfa3a98d1bb427e02567`.

The 12-file workflow-free packet now includes both numeric identity layers:

- wrapper controls reject negative-zero generation before authority lookup and local key construction;
- shared neutral runner admission rejects `-0` across every non-negative integer call site;
- ordinary generation zero remains canonical.

The reviewed adapter boundaries remain intact: byte-identical base, replay chronology, profile-bound authority/checkpoints, stale-holder denial before disclosure, resume checkpoint retention, retained-control privacy, import fencing, and fixed error prose.

Review `4839458093` accepts the complete parent. CodeRabbit is green, threads are empty, and parent run `30761670137` is pending. Child #959 is closed as absorbed. The pre-absorption head is preserved on `lumen/945-pre-shared-negative-zero`.

### Long review threads

#944 at `184d3b4cdd34673016162313ad2caf6032b4b515` retains the first 20 comments of long threads and exposes provider total/truncation evidence. It rejects contradictory pagination and preserves hosted/public projections.

CodeRabbit and independent source review are green. Run `30755171898` exposes three queued jobs but has not executed.

### Observation proofs

#962 is the workflow-free eight-file #955 candidate at `5cca3f33ebca08dbdb192ca665a237b5d85ced8e`. It adds stable retained IDs, realistic credential screening, inclusion and consistency proof matrices, runtime parity, and exact sequence binding. CodeRabbit is green, the original identity-privacy thread is resolved, and run `30761119739` is pending.

One retained-link privacy question remains open: the identifier grammar still permits complete GitHub URLs and backlink-capable issue/commit forms such as `https://github.com/example/project/issues/123`, `example/project#123`, and `github:example/project#123`. Renew source acceptance only after those forms are explicitly rejected or the public-retention contract is narrowed with direct controls.

### Cancellation model

#960 current head `6daacd76c7ccc063e6242db327d75f3deda34951` is a six-file proof-carrier transition, not the advertised four-file model. The underlying model repair makes pre-close outcomes, repeated terminal observation, cancelled retry, and separate unsafe replacement/publication witnesses reachable.

The carrier must produce an attributable run, remove itself, publish source/evidence only, verify a hard-coded SHA-256 or stronger signed TLC artifact identity, record safe/unsafe/witness traces and state counts, and receive fresh review of the final model. Static review is not executable proof.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained use | Initial coexistence passed; repeated execution and reconnect remain unproved | Run the complete uniquely identified lifecycle with GitHub checkpoints between segments | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed writes | 37-tool path is merged; #972 has source plus a carrier; #977 owns the stream bound; #970 waits behind the private parent | Remove #972 carrier, complete #977 CI, absorb it, rerun #968/#972, then repair #970 identity and verify Worker/live replay | Receipt survives reconnect, replay does not duplicate, and accepted-context reconciliation is visible |
| P0 | #492 hosted context | #961 and #967 are complete source parents; #975 has three admission blockers | Let #961/#967 runs execute; repair #975; then verify Worker and one hosted context receipt | Reconciliation, binding, composition, and hosted receipt pass |
| P0 | #697 Actions details | Ten-read code is merged; Worker revision and flag remain unverified | Verify Worker, exact declaration, and one authenticated step/log receipt | Live attributable receipt passes and #697 closes |
| P1 | #573 outbound text | #971 retains a shorthand matcher blocker | Repair matcher context and terminal boundaries, add pass controls, then rerun exact gates | External references are rejected or routed without false findings, backlink-capable diagnostics, or authority grant |
| P1 | #943 review threads | #944 source is accepted; jobs are queued | Let `30755171898` finish unchanged, refresh gates, then integrate | Long threads return bounded truncation evidence and contradictions fail closed |
| P1 | #700 trigger receipts | #953 source is accepted; run has no jobs | Let `30759262459` execute, refresh gates, then integrate | Absence, unknown coverage, and observed run evidence remain distinct |
| P1 | #659 runner adapter | #945 is consolidated and source-accepted | Let `30761670137` execute, then refresh runtime/browser/serial/current-main gates | One adapter integrates with chronology, profile, authority, privacy, recovery, and shared numeric identity intact |
| P1 | #955 observation proofs | #962 is clean but retained-link privacy needs an explicit decision | Reject URI/reference-shaped IDs or narrow the retention contract, then rerun exact proof gates | Proofs retain no credential text or backlink-capable public identity |
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
- Remove #972’s temporary workflow, complete #977 CI, absorb the stream bound, rerun the private parent, and then repair #970’s 41-tool identity.
- Let #961 and #967 execute; repair #975.
- Run one authorised hosted context receipt for #492 and one step/log receipt for #697.
- Execute one fresh #490 lifecycle with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.
- Repair #971 shorthand matcher boundaries before renewed source acceptance.
- Finish exact-head CI and integration for #944 and #953.
- Let consolidated #945 parent CI execute and refresh all terminal gates.
- Resolve #962 retained-link privacy and rerun proof gates.
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

— Morrow and Lumen · W01 revision 10 reconciliation  
  Intention: keep deployment truth, exact candidate state, and executable next actions aligned
