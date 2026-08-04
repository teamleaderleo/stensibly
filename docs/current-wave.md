# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 convergence and execution  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-04 UTC after exact-head context, transport, credential, outbound, Merkle, storage, and ancestry repair  
**Current main:** `e4ffc6a44818f62ef3770ccdcd4d5d5707a30bc2`  
**Tracking incident:** #490  
**Programme:** #491  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `23`

## Purpose

Prove that GitHub and Stensibly can support sustained authenticated work with durable receipts, exact accepted context, bounded ambiguity recovery, reconnect, and independent GitHub recovery during degradation.

Repository source, integration state, deployed capability, and authenticated hosted proof are separate facts. This record names only evidence reviewed against the exact heads below.

## Current verified reality

Current `main` includes the GitHub issue-write foundation, backlink-safe outbound preflight, receipt-wide credential admission, atomic repository-write receipts, the cancellation-settlement model, and canonical repository-write receipt admission.

Production Worker/MCP revision, refreshed ChatGPT app state, hosted feature flags, and the complete authenticated W01 journey remain unproved by repository state.

Fresh hosted evidence is still required for:

- #697: one authenticated hosted Actions job-detail receipt;
- #492: one authorised hosted project-context read used in a sustained journey;
- #921: one authorised idempotent write, durable receipt lookup, reconnect, and exact replay without duplicate provider mutation;
- #490: repeated same-conversation lifecycle execution and reconnect while GitHub remains independently available.

## Exact active lanes

### Provider receipt to accepted context

```text
#961 proposal/request admission
  ├─→ #1013 stateless instruction resolution
  └─→ #975 context acceptance composition
```

- **#961** — exact head `dc067aeed7a88cd749ffd3bd8a38b34cbfe778b5`, one commit above current `main`; twenty-one workflow-free files. CodeRabbit is successful. Canonical run `30937412781` remains pending.
- **#1013** — exact head `32fe9d5160061813f0ff3330adc788b3709e68a3`, two commits above exact #961; five workflow-free files. The public resolver now has stateless exact-proposal origin, detached evidence, and a production import guard. Canonical run `30939995595` remains pending.
- **#975** — exact head `7687133f0d077cb915a5a42237e045577397009d`, five commits above exact #961; six workflow-free files. Shared retained-credential policy, provider item ceiling, and early create/equal-revision rejection are source-reviewed at review `4858076658`. Canonical run `30941903209` remains pending.

Integrate #961 first. Replay and renew #1013 and #975 only after the unchanged parent lands.

### GitHub issue-write parity and bounded provider responses

```text
#968 private composition
  → #972 call-local settlement
  → #1012 shared bounded response admission
  → #1050 bounded issue/comment readback
  → #970 public registration
```

- **#1050** — exact head `93cea5c74a8ba8c53e326493206c0a21db82d94d`, five commits above #1012; thirteen workflow-free files. One total deadline, Fetch-compatible caller-signal precedence, prompt abort settlement, bounded metadata and route ceilings, direct stream-result descriptors, incremental fatal UTF-8 decoding, and cleanup after hostile request inspection are source-reviewed at review `4857801098`. Canonical run `30939626626` remains pending.
- **#1012** remains `084530b2e6ba8e273928e72f239d63e74a9e6de3`. Absorb only an unchanged workflow-free green #1050 head, then rerun the complete parent before touching #972/#968/#970.

### Native repository-write admission and credential seam

```text
#1020 native transport base
  → #1065 shared admission and provider-state identity
  → #1022 exact contents-token minting
```

- **#1065** — exact head `6704c2c519777fa0f1e499b2cff78e09067de759`, three commits above #1020; nine workflow-free files. Shared repository/ref/path/object-ID admission and exact provider-state URL spelling are source-reviewed at review `4858072525`. Canonical run `30941017656` remains pending.
- **#1022** — exact head `7ef9369c5fe732ea3782743a8faaebe90cc115c9`, one commit above exact #1065 and zero behind; seven workflow-free files covering exact contents scope, synchronous fetch failures, one total token-response lifetime, late response disposal, fixed status/header/body metadata admission, byte/chunk bounds, and direct stream-result descriptors. CodeRabbit and threads are clean; source review `4858183245` accepted the exact current-parent stack. Canonical run `30943152588` remains pending.
- #1084 remains a workflow-bearing effect carrier on the old #1065 head and is also stale-parent. Do not integrate it until the carrier disappears and the intended effect packet is replayed onto `6704c2c5…`.

Atomic expected-parent publication, canonical post-write file/tree settlement, post-effect request attribution, and one total native transport response lifetime remain separate #1020-family work.

### Outbound GitHub reference admission

- **#987** — exact head `9aa349c804c5214a5bad37f149ce74bcd5091cfe`, two commits above current `main`; twelve workflow-free files. The wrapper binds base and supplemental analysis to one detached input/policy/text snapshot, projects declared controlled-repository indices without caller key enumeration, covers normalized GitHub URL spellings, and prevents production imports of the private detector. CodeRabbit and threads are clean; source review `4858079925` accepted the head. Canonical run `30941210866` remains pending.
- #1046 was not absorbed because its branch is materially diverged from this parent. Replay its authority-first route-prefix semantics cleanly before consideration.

### Observation Merkle checkpoints

- **#1000** — exact head `2133eead3af656e43da229ec322d6cc6117839db`, three commits above current `main`; eighteen workflow-free files. The public wrapper snapshots compile/prove/verify inputs once, rejects retained public GitHub identities, bounds declared array length before enumeration, projects declared dense indices without retaining decorations, and prevents production imports of the private proof engine. CodeRabbit and threads are clean; source review `4858083303` accepted the head. Canonical run `30940156781` remains pending.

The Merkle packet proves only exact inclusion and append-only prefix consistency for one admitted ledger view. It grants no provider truth, authorization, approval, settlement, signing, persistence, or deployment authority.

### Durable repository-write storage

```text
#1056 runtime-private store dependencies
  → #1049 stored external-identity admission
```

- **#1056** — exact head `3fed2d6063b9a90a5041b1ea0d793ff642a0d2c3`, one commit above current `main`; exact two-file fence. Canonical run `30931706311` has successful test, browser-evidence, and runtime-parity jobs; `serial-full` job `92090946183` remains queued. CodeRabbit and threads are clean.
- **#1049** — exact head `55bb3f8770ccc74fe7123d85001844535d3751df`, one commit above exact #1056; nine files covering unique stored external-ID ownership and lookup admission. Source review `4857750411` accepted the exact stack. Parent integration and renewed execution remain required.

## Closed superseded evidence

The following test-only or predecessor packets were absorbed into the live parents above and closed without independent merge during this reconciliation: #1029, #1075, #1093, #1094, #1095, #1097, #1098, and #1099.

## Integration gates

A candidate may advance only when all are true on one unchanged exact head:

1. declared file fence and ancestry match GitHub comparison;
2. no workflow carrier or unrelated file is present;
3. CodeRabbit is successful and inline review threads are empty;
4. canonical CI, strict TypeScript, focused/full tests, runtime parity, browser/artifact evidence, serial-full, and exact-ref receipt complete successfully where required;
5. parent dependencies have integrated in order and children are replayed onto the exact landed parent;
6. terminal review names the exact head and current merge base;
7. GitHub reports clean mergeability immediately before the expected-head-pinned merge.

Queued, pending, cancelled, stale-parent, or predecessor-head execution never authorises integration.

## Priority queue

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 / #921 / #492 / #697 hosted proof | Repository capability exceeds hosted proof | Verify exact deployed revision and run one uniquely identified authenticated lifecycle with GitHub checkpoints | Hosted receipts, reconnect, exact replay, and repeated lifecycle pass |
| P0 | #961 → #1013 / #975 | Exact workflow-free source packets are reviewed; canonical runs are pending | Complete #961 gates, integrate unchanged, then replay and renew both children | Proposal, instruction evidence, and acceptance compose deterministically on landed ancestry |
| P0 | #1050 → #1012 → #972 → #970 | #1050 is source-reviewed and workflow-free | Complete exact-head execution and terminal review before parent absorption | Seven typed mutations pass source, canonical, manifest, and terminal gates |
| P0 | #1065 → #1022 → #1020 family | Shared admission and exact token packet are correctly stacked and source-reviewed | Complete #1065 gates, integrate unchanged, then replay/retarget #1022 and effect/settlement children onto the landed parent | Exact token scope and provider effects remain bounded, attributed, and reconcilable |
| P1 | #987 | Exact source and architecture are reviewed | Complete exact-head canonical and terminal gates | External GitHub routes never pass through supported normalization or producer-mutation variants |
| P1 | #1000 | Exact proof/privacy source is reviewed | Complete exact-head canonical and terminal gates | Inclusion/consistency evidence passes without retained public identity or array key-budget gaps |
| P1 | #1056 → #1049 | Parent has three green parallel jobs; serial-full is queued | Complete #1056 terminal gates, merge unchanged, then replay/renew #1049 | Runtime-private credentials and unique stored identity pass on landed ancestry |

## Definition of done

W01 completes only when fresh authenticated sessions repeatedly prove:

1. GitHub instructions, backlog, source evidence, and provider state remain readable;
2. the complete create/claim/event/artifact/read/complete/reread lifecycle remains executable across several calls;
3. governed GitHub writes return actor-bound durable receipts and exact replay produces no duplicate effect;
4. accepted context and repository instructions bind to the exact project, issue, attachment generation, and provider revision;
5. disconnect/reconnect restores authorised functionality and receipt lookup;
6. each failure is typed as rejection, ambiguity, or reconciliation with bounded non-secret evidence;
7. the lifecycle passes repeatedly in one conversation and again after reconnect;
8. GitHub remains independently usable during Stensibly degradation.

A merged PR, green repository run, dashboard sign-in, single provider write, or one successful connector call does not complete the wave.
