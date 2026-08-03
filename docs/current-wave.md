# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-03 after current-main receipt privacy, context re-admission, write transport, outbound-route, Merkle-identity, and formal-model review  
**Current main:** `854b528bdb8380071244dfba799ff91d5d1403e0`  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**GitHub context integration:** #492  
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

Current exact head: `27a4f81af8ba2b7f80fd06c475c748ce677f0161`.

The three-file current-main candidate screens the complete admitted canonical receipt for realistic GitHub, OpenAI, Stensibly, Slack-at-16, Bearer-at-12, credential-reference, JWT, authorization-header, and private-key families. Benign short aliases remain accepted.

Source review is complete and #997 is absorbed and closed. Canonical run `30800434660` remains pending with no jobs exposed. Integration requires one unchanged-head canonical execution plus final ancestry, mergeability, thread, and terminal review gates.

### Provider-context reconciliation and instruction observation — #961, #998, #1008

Current #961 head: `10b755d275ba57fd91bb425c3a48bf4a3ecadf42`.

The parent lifecycle, operation-target, issue-number, snapshot, fingerprint, already-current, and zero-authority semantics remain accepted. Its latest source commit repairs embedded credentials only in producer-side `current.sourceRevision`.

The public structural observation compiler remains blocked:

- #998 at `2ee75f3b8a666691649491a56b8e55d6ddbd6bfb` pins refingerprinted receipt, actor, attachment, current-revision, and workspace identities;
- #1008 at `1d9e5a2326b58546893290665675dbb713251fdb` extends the matrix to project, canonical repository, and provider-source revision;
- proposal fingerprints prove byte integrity, not privacy or producer authenticity.

Required order:

1. integrate or replay #983;
2. apply the same realistic anywhere-in-text policy to workspace/project slugs, repository components, and every free proposal identity;
3. absorb #998 and #1008 into #961 and close both children without merge;
4. rerun the complete current-main parent.

### Context-acceptance composition — #975 and #999

#975 remains stacked behind the unfinished #961 privacy parent.

#999 pins two chronology rules before nullable binding access:

- `github_create_issue` implies `currentSourceRevision === null`;
- actionable current revision must be null or differ from provider readback; equality belongs only to `already_current`.

Repair and restack #975 only after final #961 convergence. Absorb #999 and close it without independent integration.

### Private label and assignee writes — #972

Current exact head: `34e7c1490627a571bdf3ce0b02ac37984e7ee8f0`.

The parent now contains call-local settlement, hostile request-ID rejection, exact replay/no-redispatch, assignee count limits, and bounded label/assignee response streaming with:

- 512 KiB delivered-byte ceiling;
- 4,096-chunk work ceiling including zero-byte chunks;
- immediate chunk detachment;
- fatal UTF-8 decode;
- non-awaited best-effort cancellation;
- admitted provider request identity through post-effect ambiguity.

Two blockers remain:

1. label/assignee status and missing-request-ID early exits do not initiate body cancellation;
2. create, update, and comment still delegate to the old `GitHubRestIssueWriteAdapter`, which uses `response.text()` before status/request-ID admission and lacks the new byte, chunk, ownership, cancellation, and request-attribution contract.

One shared bounded provider-response reader must cover all seven mutations while keeping read-only GET errors distinct. Do not absorb #972 into #968 or advance #970 until that complete source/test packet passes unchanged-head gates.

### Public label and assignee actions — #970

#970 remains the typed 41-tool public stack behind the private parent.

Keep it blocked until:

- #972 and #968 converge on one complete seven-mutation private boundary;
- the exact 41-tool fingerprint is reconciled across runtime, tests, diagnostics, action snapshot, and recovery guidance;
- current-main canonical execution and terminal review pass.

### Outbound preflight boundary consolidation — #987 and #1005

Current #987 head: `6689ca35f4078b769b235fe3e80ce2851bb8bc9c`.

The parent has absorbed #1002's immediate post-identity `%HH` guard and retains its Unicode, byte-exact, credential-shaped repository, and hidden-fingerprint repairs.

#1005 at `2b6679ead505a1d53903edb34dc4641f2a9bd116` pins the remaining complete URL boundary:

- percent escapes in owner, repository, route kind, and final item/commit identity;
- normalized default ports and trailing-dot GitHub hosts;
- fixed authority rejection for userinfo and non-default ports;
- preserved canonical query/fragment behavior.

The parent must identify candidate GitHub HTTP(S) URLs before specialized extraction, normalize host/default port, reject invalid authority and encoded identity-bearing path bytes, then emit one exact bounded route identity. Absorb #1005 and close it without independent integration.

### Observation Merkle checkpoints — #1000 and #1010

Current #1000 head: `5b2b24200be17a9011fd35670946998d1d7fae2a`.

The proof mathematics remain accepted. The parent now rejects URI-scheme identities, canonical GitHub shorthand/external-ID aliases, and realistic embedded credential families while preserving internal namespaces.

#1010 at `6435576592bc19a373604aacae27f8bd9ca4fb97` pins the residual schemeless public-route class:

- `github.com/owner/repository/issues/number`;
- `www.github.com/owner/repository/pull/number`;
- GitHub discussion and commit routes;
- all three public proof identity positions.

Add one narrow case-insensitive schemeless GitHub host-route matcher, absorb #1010, and renew the complete nine-file parent. Do not broaden rejection to arbitrary internal strings containing `github.com`.

### Cancellation settlement model — #1009

Current exact head: `8ef89c9591973c6feafa04785df5e31814bb1bd9`.

The clean formal-only current-main replay is statically accepted. It repairs the prior malformed stale-publication assignment and models:

- one authoritative close;
- child settlement before and during close;
- visible successful outputs after aggregate failure;
- reconciliation after partial failure;
- prior-generation fencing and unsafe replacement controls;
- repeated terminal close and cancelled-wait retry after settlement.

Integration requires fresh exact-head execution with a pinned official TLC distribution, recorded checksum/version and Java identity, safe state-space completion, both expected unsafe invariant counterexamples, all four witness traces, and mapping to #574 implementation tests or explicit no-change decisions. Ordinary repository CI is not the formal proof.

## P0 execution gates

### #490 sustained use

Initial coexistence passed; repeated execution and reconnect remain unproved. Run the complete uniquely identified lifecycle with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.

### #921 governed writes

The 37-tool create/update/comment path is merged. Complete the seven-mutation private transport boundary, then the 41-tool public stack. Independently verify Worker revision, app refresh, one authorized create → update → comment journey, durable receipt lookup, reconnect, and exact replay with no duplicate mutation.

### #492 hosted context

Integrate #983, converge #961 with #998/#1008, then repair/restack #975 with #999. Verify one authenticated hosted reconciliation and accepted-context receipt against the exact private binding reader merged in #967.

### #697 Actions job details

The bounded step/log code is merged. Verify exact Worker revision and feature flag, expected discovery, and one authenticated hosted step or log receipt.

## Active queue

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained use | Initial coexistence passed; repeated lifecycle and reconnect remain unproved | Execute the complete uniquely identified lifecycle with GitHub checkpoints | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed writes | #972 protects set writes but not the create/update/comment transport; #970 waits | Materialize one shared bounded response reader across all seven mutations, then reconcile the 41-tool release | Durable receipt survives reconnect and exact replay performs no duplicate mutation |
| P0 | #492 hosted context | #983 source is accepted but lacks CI; #961 re-admission remains incomplete; #975 waits | Complete #983 → absorb #998/#1008 into #961 → repair/restack #975 with #999 | Receipt, exact binding, composition, persistence, and readback agree |
| P0 | #697 Actions details | Implementation merged; Worker/flag/authenticated receipt remain unverified | Verify deployment identity and one authenticated step/log receipt | Live attributable receipt passes |
| P1 | #573 outbound text | #987 absorbed the suffix guard; #1005 exposes complete route/authority gaps | Build the complete URL parser/guard and absorb #1005 | No valid GitHub route can fail open or produce a truncated identity |
| P1 | #955 observation proofs | #1000 absorbed first privacy repair; #1010 exposes schemeless routes | Add narrow host-route rejection and absorb #1010 | Current-main packet passes privacy, runtime parity, and executable proof gates |
| P2 | #954 cancellation model | #1009 is a clean static candidate | Run pinned safe/unsafe/witness TLC proof | Safe model passes and required unsafe/witness traces are recorded |

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
9. reconnect restores authorized functionality and receipt lookup;
10. diagnostics identify the rejecting, lost, timed-out, or ambiguous layer without secrets;
11. GitHub remains independently readable and writable during Stensibly degradation.

Merged code, dashboard presence, metadata checks, or one successful operation do not complete the wave.

## Immediate next actions

- Obtain unchanged-head canonical execution for source-accepted #983, then integrate or replay it.
- Absorb #998 and #1008 into #961 after #983 and renew the complete parent.
- Repair/restack #975 after final #961 and absorb #999.
- Build one shared seven-mutation provider-response reader for #972; keep #970 blocked.
- Repair #987's complete URL route/authority boundary and absorb #1005.
- Repair #1000's schemeless GitHub route privacy and absorb #1010.
- Execute pinned TLC proof for #1009.
- Independently complete Worker, authenticated receipt, reconnect, and no-duplicate live gates.

## Boundary

This document records repository and execution truth only. It grants no authority and does not prove deployment, authentication, provider settlement, reconnect recovery, or completed dogfood.