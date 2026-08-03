# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-03 after receipt-privacy job allocation, context-parent convergence, total response-deadline controls, instruction-resolution chronology review, and outbound/Merkle normalization review  
**Current main:** `854b528bdb8380071244dfba799ff91d5d1403e0`  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**Hosted GitHub context:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `15`  
**Operating protocol:** `stensibly-agent-ops/0.5.0` plus standing policy `stensibly-internal-dogfood/v2`

## Purpose

Keep GitHub and Stensibly executable together through sustained use, repeated reads and writes, exact provider receipts, accepted context, reconnect, and recovery.

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

## Merged repository foundations

These outcomes are on current `main`:

| Outcome | Integration |
| --- | --- |
| Reusable exact-ref CI receipts | #940 → `22495e429b70a290ca1680518e169dbe573b44ca` |
| Exact CI workflow-trigger receipts | #953 → `b891f1d5a10c75dddb7f24cbae6ecfa74f0541a5` |
| Private hosted GitHub context binding reader | #967 → `494c96372bd45d205907dcb8c1fc9aabdaabe269` |
| Bounded truncated review-thread comments | #944 → `3f75baf8fee9640957dbd98a85f442da2a38b9ba` |
| Bounded short nonterminal review-comment pages | #981 → `279b370f71f3fbdc3933c5dca2a3378674d62c6f` |
| Guarded model-free OpenAI Agents adapter | #945 → `9d0462e8861002eacfaeaf2415728fe2f9559d95` |
| Backlink-safe outbound GitHub text preflight | #971 → `854b528bdb8380071244dfba799ff91d5d1403e0` |

The 37-tool governed create/update/comment path remains merged through #934, #937, and #938. Hosted writes require authenticated principal identity, write scope, project access, exact repository binding, explicit idempotency, and the private write feature flag. Ambiguous outcomes remain `pending_reconciliation`; exact replay must not redispatch.

Merged code is not live product proof.

## Deployment and live-proof boundary

A READY Vercel deployment or healthy shell alias does not prove the Cloudflare Worker revision, MCP declaration, project binding, or feature-flag state.

The API/MCP hosts remain:

- `https://api.stensibly.com`;
- `https://stensibly-api.leoli-082000.workers.dev`.

Required live proof remains:

- exact deployed Worker revision and release identity;
- expected public tool declaration after app refresh;
- one authenticated governed write journey with durable receipt lookup;
- one authenticated Actions step or log receipt;
- one accepted-context reconciliation journey;
- disconnect/reconnect followed by exact receipt recovery and replay without duplicate mutation;
- repeated GitHub and Stensibly use in one conversation.

These gates cannot be completed in a GitHub-only session.

## Active source and proof gates

### Provider-receipt credential admission — #983

Exact head: `27a4f81af8ba2b7f80fd06c475c748ce677f0161`.

The three-file current-main candidate screens the complete admitted canonical receipt for realistic GitHub, OpenAI, Stensibly, Slack-at-16, Bearer-at-12, credential-reference, JWT, authorization-header, and private-key families. Benign short aliases remain accepted.

Source review is complete and #997 is absorbed and closed. Canonical run `30800434660` has allocated three jobs—test, runtime parity, and browser evidence—but all remain queued. Integration still requires unchanged-head completion, exact-ref receipt, empty threads, current-main ancestry, clean mergeability, and terminal review.

### Provider-context reconciliation and instruction-observation request — #961

Exact head: `0475dcbbde43c0cfe26e4cd7696a009a39e51e75`.

The 13-file current-main parent now includes:

- complete receipt lifecycle and operation-target classification;
- issue-number and provider-snapshot binding;
- already-current, identity-conflict, and acceptance-proposal semantics;
- authority-free repository-instruction observation requests;
- realistic retained-identity screening for workspace, project, repository, receipt, actor, attachment, current/provider revisions, and external issue identity;
- external-ID privacy and repository equality on snapshot-free identity-conflict evidence.

#998, #1008, and #1015 are absorbed and closed. Receipt-wide privacy remains sequenced behind #983 because this branch imports current-main receipt admission. Every predecessor review and run is expired; renew the complete parent after #983 integrates or its exact policy is replayed.

### Instruction-observation resolution — #1013 and #1023

Current #1013 head: `96592903ad3589680e063c4f9c466cdd76399c05` on repaired #961.

The pure resolution compiler binds one instruction-observation request to an accepted project attachment generation and a canonical instruction-source set without provider read/write or persistence authority.

Open source repairs:

1. retain attachment acceptance time and require
   `attachment.acceptedAt <= request.providerObservedAt <= observation.observedAt`;
2. reapply actionable chronology before attachment access:
   create implies no previous revision, and a non-null previous revision must differ from provider readback;
3. retain the exact request fingerprint in resolution identity;
4. bind the accepted request to canonical #961 output rather than treating a self-fingerprint as producer authenticity.

#1023 at `ba1e91a5bb756d83acccfe91182b2c94f98edf71` pins the first chronology item, including equality boundaries. Absorb it after source repair; do not integrate independently.

### Context-acceptance composition — #975 and #999

Keep #975 behind final #961 and #1013 convergence.

#999 pins:

- create proposals cannot carry a prior accepted revision;
- actionable current revision must differ from provider readback; equality belongs only to `already_current`.

Repair/restack only after the request and resolution layers are final.

### Private label and assignee writes — #972, #1012, #1017, #1019

Current private consolidation #972: `052b4ff9d1ca506d852a4a3101b41d93208979b0`.

It contains call-local settlement, request-ID retention/privacy, exact replay/no-redispatch, assignee limits, and bounded label/assignee response handling.

Shared seven-mutation response reader #1012: `e27cf115698c7dede6ad3b6eebdbe1bfbffc1b79`.

The eight-file child applies one byte/work/copy/UTF-8/status/URL/request-ID contract to create, update, comment, label, and assignee writes. It bounds decoded bodies at 512 KiB and stream work at 4,096 chunks, detaches delivered bytes, disposes rejected provider prose, and preserves admitted request identity through post-effect ambiguity.

One total response-lifetime blocker remains:

- #1017 at `0bc4767545546ba947c1076799aaf165aa4fc2ff` pins a successful response whose first body read never settles;
- #1019 at `be61a2bdf2566082d570760ae170d116995c0467` pins response acquisition when fetch ignores `AbortSignal` and never returns headers.

The final source must use one validated total deadline beginning before fetch and continuing through complete body consumption. Expiry before response remains unattributed ambiguity; expiry after an admitted request ID preserves that ID. Abort/cancel is best-effort and never awaited. Absorb both children into #1012, then absorb #1012 into #972 and rerun the complete private parent.

### Public label and assignee actions — #970

The nine-file 41-tool public layer is source-accepted on its current private-parent restack. It includes exact add/remove actions, destructive annotations, authenticated principal/write/project checks, receipt re-admission, capability and ambiguity registration, and reconciled fingerprint `sha256:b96543225bc17a1ffc6d85c62a4f8637b25cf8c89a19b7f11155f83a85e0ac76`.

Do not integrate or publish the 41-tool release until #1012/#1017/#1019 converge into #972, #972 is absorbed into #968, and the complete private/public stack passes unchanged-head gates.

### Outbound preflight boundary consolidation — #987, #1005, #1018

Current #987 head: `6689ca35f4078b769b235fe3e80ce2851bb8bc9c`.

The parent contains the Unicode, byte-exact, hidden-identity, credential-shaped repository, long-reference, and immediate post-identity `%HH` repairs.

#1005 at `2b6679ead505a1d53903edb34dc4641f2a9bd116` pins complete route/authority handling:

- percent escapes in owner, repository, route kind, and final item/commit identity;
- normalized default ports and trailing-dot GitHub hosts;
- fixed authority rejection for userinfo and non-default ports;
- canonical query/fragment behavior.

#1018 at `4d5588f3815db5cd3ad7a85e917cd2fb4ca3f727` extends the matrix to WHATWG-normalized routes. It still needs percent-encoded dot-segment cases and tab/LF/CR normalization outside hostname text.

The final parent must scan candidate special URLs before regex extraction, parse and normalize once, then emit one exact bounded route or one fixed non-echoing rejection. Absorb both children; neither integrates independently.

### Observation Merkle checkpoints — #1000 and #1010

Current #1000 head: `5b2b24200be17a9011fd35670946998d1d7fae2a`.

The proof mathematics remain accepted. The parent rejects URI-scheme identities, canonical GitHub shorthand/external-ID aliases, and realistic embedded credential families while preserving internal namespaces.

#1010 at `6435576592bc19a373604aacae27f8bd9ca4fb97` pins the residual schemeless issue, pull-request, discussion, and commit routes in ledger, compiler, and observation identities.

Add one narrow case-insensitive schemeless GitHub host-route matcher, absorb #1010, and renew the complete parent. Do not broaden rejection to arbitrary internal strings containing `github.com`.

### Cancellation settlement model — #1009

Exact head: `8ef89c9591973c6feafa04785df5e31814bb1bd9`.

The clean formal-only current-main replay is statically accepted. It repairs the prior malformed stale-publication assignment and models one authoritative close, child settlement before/during close, preserved successes after aggregate failure, reconciliation, generation fencing, repeated terminal close, and cancelled-wait retry after settlement.

Integration requires fresh pinned official TLC execution with recorded artifact checksum/version, Java identity, model/config hashes, safe state-space completion, two expected unsafe invariant counterexamples, four witness traces, and mapping to #574 implementation tests or explicit no-change decisions.

#1014's same-caller active-rejoin witness is a valid optional lifecycle expansion, not a blocker on #954's eight agreed invariants. Reframe separately before altering the model.

### Human-readable development log — #994

The merged-capability narrative is accepted. Its active-draft section is stale and must be reconciled from this wave record before integration. Do not keep closed repair children as current product lanes.

## P0 execution gates

### #490 sustained use

Initial coexistence passed; repeated execution and reconnect remain unproved. Run the complete uniquely identified lifecycle with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.

### #921 governed writes

The 37-tool create/update/comment path is merged. Complete the total seven-mutation response deadline, then the 41-tool public stack. Independently verify Worker revision, app refresh, one authorized create → update → comment journey, durable receipt lookup, reconnect, and exact replay with no duplicate mutation.

### #492 hosted context

Complete #983, renew #961, repair #1013 with #1023 and its remaining origin/fingerprint/chronology gates, then repair/restack #975. Verify one authenticated hosted reconciliation and accepted-context receipt against the exact private binding reader merged in #967.

### #697 Actions job details

The bounded step/log code is merged. Verify exact Worker revision and feature flag, expected discovery, and one authenticated hosted step or log receipt.

## Active queue

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained use | Initial coexistence passed; repeated lifecycle and reconnect remain unproved | Execute the complete uniquely identified lifecycle with GitHub checkpoints | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed writes | #1012 closes byte/work/identity bounds; #1017/#1019 expose total lifetime gaps | Add one pre-fetch-through-body deadline, absorb both controls, then rerun #972/#968/#970 | Durable receipt survives reconnect and exact replay performs no duplicate mutation |
| P0 | #492 hosted context | #983 jobs are queued; #961 converged; #1013 has four explicit source repairs | Complete #983, renew #961, repair #1013/#1023, then restack #975 | Receipt, exact request, attachment generation, instruction observation, composition, persistence, and readback agree |
| P0 | #697 Actions details | Implementation merged; Worker/flag/authenticated receipt remain unverified | Verify deployment identity and one authenticated step/log receipt | Live attributable receipt passes |
| P1 | #573 outbound text | #987 absorbed suffix guard; #1005/#1018 expose complete parser normalization | Build one parsed special-URL route boundary and absorb both children | No GitHub-targeting normalized route can fail open or truncate identity |
| P1 | #955 observation proofs | #1000 absorbed first privacy repair; #1010 exposes schemeless routes | Add narrow host-route rejection and absorb #1010 | Current-main packet passes privacy, runtime parity, and executable proof gates |
| P2 | #954 cancellation model | #1009 is statically accepted | Run pinned safe/unsafe/witness TLC proof | Safe model passes and required unsafe/witness traces are recorded |

## Definition of done

W01 completes when fresh authenticated conversations repeatedly prove:

1. repository instructions and backlog remain readable;
2. OAuth discovery, login, consent, refresh, and reconnect succeed;
3. Stensibly tools remain executable after several calls;
4. create/claim/event/artifact/read/complete/reread succeeds;
5. every mutation returns success, actionable failure, or explicit ambiguity with deterministic reconciliation;
6. governed GitHub writes return durable actor/client-bound receipts;
7. provider readback reconciles through one exact private binding and accepted instruction generation without implicit authority;
8. GitHub and Stensibly remain usable together;
9. reconnect restores authorized functionality and receipt lookup;
10. diagnostics identify the rejecting, lost, timed-out, or ambiguous layer without secrets;
11. GitHub remains independently readable and writable during Stensibly degradation.

Merged code, dashboard presence, metadata checks, or one successful operation do not complete the wave.

## Immediate next actions

- Let unchanged-head #983 jobs execute; integrate only after all canonical gates pass.
- Renew #961 after #983 lands or its exact policy is replayed.
- Repair #1013's four explicit request/attachment chronology and identity gates; absorb #1023.
- Add one total response deadline to #1012; absorb #1017 and #1019; rerun #972/#968/#970.
- Complete #1018's normalization matrix, repair #987, and absorb #1005/#1018.
- Repair #1000's schemeless GitHub-route privacy and absorb #1010.
- Run pinned TLC proof for #1009.
- Reconcile #994's active-draft section from this record.
- Independently complete Worker, authenticated receipt, reconnect, and no-duplicate live gates.

## Boundary

This document records repository and execution truth only. It grants no authority and does not prove deployment, authentication, provider settlement, reconnect recovery, or completed dogfood.