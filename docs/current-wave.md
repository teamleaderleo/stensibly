# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-03 after receipt-threshold, retained-identity, acceptance-chronology, response-resource, and Merkle-proof privacy controls  
**Current main:** `854b528bdb8380071244dfba799ff91d5d1403e0`  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `14`  
**Operating protocol:** `stensibly-agent-ops/0.5.0` plus standing policy `stensibly-internal-dogfood/v2`

## Purpose

Keep GitHub and Stensibly executable together through sustained ChatGPT use, repeated reads and writes, exact provider receipts, reconnect, and recovery.

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

## Verified repository reality

These foundations are merged on current `main`:

| Outcome | Integration |
| --- | --- |
| Reusable exact-ref CI receipts | #940 → `22495e429b70a290ca1680518e169dbe573b44ca` |
| Exact CI workflow-trigger receipts | #953 → `b891f1d5a10c75dddb7f24cbae6ecfa74f0541a5` |
| Private hosted GitHub context binding reader | #967 → `494c96372bd45d205907dcb8c1fc9aabdaabe269` |
| Bounded truncated review-thread comments | #944 → `3f75baf8fee9640957dbd98a85f442da2a38b9ba` |
| Bounded short nonterminal review-comment pages | #981 → `279b370f71f3fbdc3933c5dca2a3378674d62c6f` |
| Guarded model-free OpenAI Agents adapter | #945 → `9d0462e8861002eacfaeaf2415728fe2f9559d95` |
| Backlink-safe outbound GitHub text preflight | #971 → `854b528bdb8380071244dfba799ff91d5d1403e0` |

The 37-tool governed issue-write path remains merged through #934, #937, and #938. Hosted writes still require authenticated principal identity, write scope, project access, exact repository binding, explicit idempotency, and the private write feature flag. Ambiguous outcomes remain `pending_reconciliation`; exact replay must not redispatch.

Merged code is not live product proof. Exact Worker revision, feature flags, public declarations, app refresh, authenticated receipts, reconnect, and no-duplicate replay remain separate gates.

## Deployment and live-proof boundary

The Vercel dashboard deployment and the Cloudflare Worker/API deployment are separate systems. A READY Vercel revision or healthy shell alias does not prove the Worker revision, MCP manifest, project binding, or feature-flag state.

The API/MCP hosts remain:

- `https://api.stensibly.com`;
- `https://stensibly-api.leoli-082000.workers.dev`.

Required live proof remains:

- exact deployed Worker revision and release identity;
- expected public tool declaration after app refresh;
- one authenticated governed write journey with durable receipt lookup;
- one authenticated Actions job-detail receipt;
- one accepted-context reconciliation journey;
- disconnect/reconnect followed by exact receipt recovery and replay without duplicate mutation;
- repeated GitHub and Stensibly use in one conversation rather than one isolated success.

## Active integration and repair lanes

### Private label and assignee writes — #972

#972 remains the call-local settlement and provider-request-evidence child at `3f0aeee17bca0c104f55c5d2b463d83f5399c0b7`.

The live diff still contains `.github/workflows/rook-972-request-id-admission.yml`. That workflow rewrites files only inside the runner workspace and uploads patched bytes; it does not publish those bytes to the branch or remove itself. Materialize the reviewed source/test bytes, remove the workflow, and publish one source-only parent before canonical or stacked evidence can be renewed. The current PR body statement that temporary workflows were removed is stale.

### Provider-response transport — #976, #977, #995, and #996

The response boundary is not terminal.

#977 at `44f56c865c89db3204525b5eed7ff26ba75e7b4e` adds an adapter-local 512 KiB stream bound. Review `4842018301` found that delivered chunks were retained by mutable reference and early declared-length rejection did not cancel the body.

#996 at `51d95b72278e1bb3f8b995919fe19e6b65a7909e` is the ownership/disposal red-control child. It requires immediate chunk detachment and cancellation of malformed or over-limit declared-length bodies.

#995 at `b5b9a56591b43c2bdca04fb8977614d323ff6c23` is the independent work/cancellation red-control child. Control blob `9ca34b23cce87ec819f24fac88c6ff55b8161bb7` requires:

- a closed chunk count that includes zero-length chunks;
- cancellation once the work bound is crossed;
- fixed post-effect ambiguity without awaiting an attacker-controlled cancellation promise that never settles;
- exact provider-request identity retention.

#976 at `5d8cd2bdce72d8b298f8c91429dfc62bc1635642` contains a shared reader that already detaches chunks and disposes early declared-length failures, but remains a 26-commit, ten-file transition. Review `4842144993` requires the final source-only parent to:

- choose a coherent compressed-response contract instead of comparing decoded Fetch bytes directly with encoded `Content-Length` without forcing identity encoding;
- restore configured GitHub API-host binding instead of hardcoding `https://api.github.com`;
- reject URL credentials, query, fragment, and malformed provider URLs through fixed provider-owned diagnostics;
- absorb both #995 and #996;
- initiate best-effort cancellation without awaiting hostile settlement.

### Public label and assignee actions — #970

#970 remains one public-only commit stacked on #972 at `26aa862bf95ae012e38efcaefab04029b6e02085`.

It adds four typed MCP actions and advances the intended release from 37 to 41 tools. The checked-in release fingerprint remains intentionally unresolved. Keep #970 behind the private and transport parents; no public integration is valid until the 41-tool identity is reconciled across runtime, tests, diagnostics, action snapshot, and recovery guidance.

### Provider-receipt credential admission — #983 and #997

#983 remains on current main at `a4ce48ee246b5e2d4b26dab6648fb2c1ecd6a211`, one commit ahead and zero behind with a two-file fence. Its broad anywhere-in-retained-receipt privacy repair is directionally correct, but prior source acceptance is expired.

Executable child #997 at `e1ae0319cb1350c4bc6f52a4fda0262b1b361e63` proves that #983's thresholds do not match repository-standard retained-identity policy:

- bearer payload threshold is `8` but must be `12`, causing benign 8–11 character aliases to be rejected;
- Slack payload threshold is `20` but must be `16`, allowing realistic 16–19 character tokens.

Review `4842237292` requires the exact two-value source repair and absorption of `test/github-provider-receipt-admission-realistic-thresholds.test.ts`. The stuck current CI run cannot authorize the unrepaired SHA. After absorption, close #997 without merge and renew every exact-head gate.

### Provider-context reconciliation — #961 and #998

#961 remains on current main at `5a0214f1a9e45d1e116a21b6cac2a3e34dc79b82`, six commits ahead and zero behind with an 11-file additive fence.

Its operation-target parser, issue-number ceiling, settled identity reuse, and equal-current/provider semantic repair remain correct. Prior source acceptance is nevertheless expired because retained-identity privacy is incomplete.

Executable child #998 at `32908f41f1da524ad96a73913249a34d3a3423f1` proves that delimiter-bound screening misses realistic credential families immediately following an alphanumeric character in:

- caller-supplied current source revision;
- refingerprinted proposal receipt, actor, attachment, and current-revision identities;
- observation-request workspace identity, which currently has grammar admission but no credential screening.

Review `4842247654` requires one realistic-length anywhere-in-text policy aligned with repaired #983, applied consistently to every retained identity and workspace with fixed non-echoing diagnostics. Fingerprint verification, grammar, and semantic coherence remain separate gates. #983 must integrate first or its final policy must be absorbed before #961 can renew execution. Close #998 without merge after parent absorption.

### Context-acceptance composition — #975 and #999

#975 remains stacked on an expired #961 predecessor at `21c25ce6d080d96c33ad0472127c65a0d336ab36`.

Executable child #999 at `2db150ad639b60f1d84e2dd0eaf2f17bbabc236c` pins both remaining chronology gaps:

- `github_create_issue` proposals must have `currentSourceRevision === null`, and contradictory proposals must fail before nullable-binding fallback or binding access;
- actionable proposals must have a null or different current revision from provider readback; equality belongs exclusively to `already_current`.

Review `4842251920` accepts the red controls. Repair and restack #975 only after the final #961 privacy parent. Absorb #999 and close it without merge.

### Outbound preflight boundary consolidation — #987

#988 is closed unmerged and superseded. The live post-#971 candidate is #987 at `e17127d6ae2b159e2fcc343eda6dd7af721e0b09`, six commits ahead and zero behind with an exact four-file fence.

The consolidation closes the recorded Unicode connector, Unicode closing-keyword, overlong commit-alias, credential-shaped repository, byte-exact CR/LF, line-position, and unpaired-surrogate boundaries.

Review `4842053039` requires one further repair: an immediate `%HH` sequence can continue a decoded direct URL path while the matcher emits a truncated issue number or commit alias. Require exact decoded route identity or fail closed on encoded continuation, add numeric/hex/slash/query/fragment controls, and prove no truncated-prefix finding is emitted.

## Research and proof lanes

### Observation Merkle checkpoints — #1000 and #1003

#1000 replaces old-base #962 with one exact current-main commit at `1c356c068fca549913a52b1299c31238f93353f7`.

It is one commit ahead, zero behind, with an exact eight-file fence. The packet proves only inclusion of one exact observation identity/fingerprint in one named checkpoint and append-only prefix consistency between two checkpoints of the same ledger. It does not prove provider truth, webhook completeness, timestamp honesty, current state, authorization, approval, settlement, signing, persistence, or deployment.

The checkpoint, inclusion, and consistency construction remains coherent on source review. Runtime parity adds one deterministic vector executed under Bun and Node without removing existing checks.

Executable child #1003 at `b4c9f4264f465286d7f4c8dda912bfb81c6916ea` blocks integration on retained-reference privacy. Current `boundedIdentity()`:

- permits direct GitHub URLs and canonical `owner/repository#number`, `owner/repository@commit`, and `github:owner/repository#number` aliases that are republished verbatim in checkpoints or proofs;
- uses delimiter-bound credential detection with stale bearer `8` and Slack `20` thresholds.

Review `4842350876` requires one shared identity repair across checkpoint compilation and proof re-admission: reject URI-scheme and canonical external GitHub reference forms, adopt repaired #983 anywhere-in-text realistic credential admission including bearer `12`, Slack `16`, and underscore-capable GitHub token payloads, preserve internal namespace identities, absorb #1003, and update the documentation privacy paragraph. The queued #1000 CI run cannot authorize the unrepaired SHA.

### Cancellation settlement model — #960

#960 remains a formal-proof transition rather than integration evidence. A final candidate must contain only the reviewed model/configuration/documentation fence plus attributable pinned TLC evidence, exact tool checksum/version, safe-state completion, and the expected unsafe counterexample.

## P0 execution gates

### #490 sustained use

Initial coexistence passed; repeated execution and reconnect remain unproved. Run the complete uniquely identified lifecycle with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.

### #921 governed writes

The 37-tool create/update/comment chain is merged. Complete the private label/assignee and shared response parents, then the 41-tool public stack. Independently verify Worker revision, app refresh, one authorised create → update → comment journey, durable receipt lookup, reconnect, and exact replay with no duplicate mutation.

### #492 hosted context

Repair #983 first, then apply its final privacy policy to #961. After both parents integrate, repair/restack #975. Verify one authenticated hosted reconciliation and accepted-context receipt against the exact private binding reader merged in #967.

### #697 Actions job details

The bounded step/log code is merged. Verify exact Worker revision and feature flag, ten-tool discovery where enabled, and one authenticated hosted step or log receipt.

## Active queue

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained use | Initial coexistence passed; repeated lifecycle and reconnect remain unproved | Execute the complete uniquely identified lifecycle with GitHub checkpoints | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed writes | #972 still carries a workflow-only reconstruction carrier; #976/#977 require a final shared response boundary; #995/#996 pin resource controls; #970 remains stacked | Publish one workflow-free private parent, finalize shared response admission, absorb both controls, then reconcile the 41-tool public release | Durable receipt survives reconnect and replay performs no duplicate mutation |
| P0 | #492 hosted context | #983 has threshold mismatch; #961 has retained-identity privacy gaps; #975 has chronology gaps | Repair #983 → repair #961 with #998 → repair/restack #975 with #999 | Provider receipt, exact binding, composition, persistence, and readback agree |
| P0 | #697 Actions details | Ten-read implementation merged; Worker/flag/receipt remain unverified | Verify deployment identity and one authenticated step/log receipt | Live attributable receipt passes |
| P1 | #573 outbound text | #987 still truncates percent-encoded path continuation | Repair `%HH` continuation and renew the complete four-file candidate | No fail-open or truncated-prefix external reference remains |
| P1 | #955 observation proofs | #1000 is a clean current-main replay but #1003 exposes retained-reference privacy | Repair shared identity admission, absorb #1003, and renew the exact eight-file packet | One current-main commit passes privacy, runtime parity, and executable proof gates |
| P2 | #954 cancellation model | #960 is a broad proof transition | Publish pinned TLC source/evidence-only candidate | Safe model passes and unsafe configuration yields the expected counterexample |

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

- Repair #983's bearer and Slack thresholds, absorb #997, and renew current-main CI/review.
- Apply the final #983 anywhere-in-text policy to every #961 retained identity and workspace, absorb #998, and renew the complete parent.
- Repair/restack #975 after #961, absorb #999, and prove chronology rejection precedes binding access.
- Repair #987's percent-encoded path continuation boundary and renew the four-file review.
- Materialize #972's workflow-only repairs as branch source and remove the carrier.
- Finalize one shared provider-response reader by preserving chunk detachment/body disposal, adding a closed zero-byte chunk count, making cancellation non-blocking, fixing compressed-body semantics, restoring configured-host binding, tightening URL admission, and absorbing #995/#996.
- Repair #1000's shared retained identity admission, absorb #1003, and renew the exact eight-file Merkle packet.
- Reconcile #970's exact 41-tool release identity only after the private and transport parents are final.
- Obtain exact **Deploy Worker Production** evidence for official/fallback API/MCP hosts.
- Run one authorised governed-write journey, durable receipt lookup, reconnect, and no-duplicate replay.
- Run one authenticated Actions step/log receipt.
- Execute one fresh #490 lifecycle with GitHub checkpoints across discovery, mutation segments, completion, and reconnect.
- Reduce #960 to pinned model plus attributable TLC evidence.

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

— Morrow and Loom · W01 revision 14 reconciliation  
  Intention: keep merged foundations, active parents, executable controls, proof transitions, and live-proof gaps aligned
