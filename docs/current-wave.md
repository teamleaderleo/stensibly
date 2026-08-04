# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 convergence and execution  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-04 UTC after exact-head context, transport, outbound, Merkle, and storage review  
**Current main:** `e4ffc6a44818f62ef3770ccdcd4d5d5707a30bc2`  
**Tracking incident:** #490  
**Programme:** #491  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `20`

## Purpose

Prove that GitHub and Stensibly can support sustained authenticated work with durable receipts, exact accepted context, bounded ambiguity recovery, reconnect, and independent GitHub recovery during degradation.

Repository source, integration state, deployed capability, and authenticated hosted proof are separate facts. This record names only evidence reviewed against the exact heads below.

## Current verified reality

Current `main` includes the merged GitHub issue-write foundation, backlink-safe outbound preflight, receipt-wide credential admission, atomic repository-write receipts, the cancellation-settlement model, and canonical repository-write receipt admission.

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

- **#961** — exact head `dc067aeed7a88cd749ffd3bd8a38b34cbfe778b5`, one commit above current `main`; twenty-one workflow-free files covering detached proposal admission, primitive enum handling, provider issue-number ceiling, and shared retained-credential policy. CodeRabbit is successful. Canonical run `30937412781` is pending. Fresh thread reconciliation and terminal unchanged-head review remain required.
- **#1013** — exact head `73b03fa9da79d66b1254f7d2463e7a15ceca793f`, one commit above exact #961; four workflow-free files requiring the exact proposal on every call, removing process-local origin authority, and snapshotting proposal/request/attachment/observation evidence once. CodeRabbit is successful. Canonical run `30937646200` is pending. Parent completion and fresh terminal gates remain required.
- **#975** — exact head `6ce87b9ca4a45d67ef604746fdb6f1b4356a6588`, one commit above exact #961; five workflow-free files completing acceptance composition with primitive outcome/next-action admission. CodeRabbit is successful. Canonical run `30937667273` is pending. Parent completion and fresh terminal gates remain required.

Integrate #961 first. Restack and renew #1013 and #975 only after the unchanged parent lands.

### GitHub issue-write parity and bounded provider responses

```text
#968 private composition
  → #972 call-local settlement
  → #1012 shared bounded response admission
  → #1050 bounded issue/comment readback
  → #970 public registration
```

- **#1050** — exact head `0a7d19a259f97ce4ba6564f7142aabb4f94ac5e1`, one commit above #1012; eleven workflow-free files. The contract includes one total deadline, Fetch-compatible caller-signal precedence, prompt abort settlement, immediate timer/listener cleanup, request attribution, route-specific ceilings, bounded `Link` metadata, direct `done`/`value` descriptor admission without per-chunk key enumeration, immediate chunk detachment, and incremental fatal UTF-8 decoding without a second complete byte buffer. CodeRabbit is successful. Canonical run `30938152478` is pending.
- **#1012** remains unchanged at `084530b2e6ba8e273928e72f239d63e74a9e6de3`. Absorb only a workflow-free, unchanged, green #1050 head, then rerun the complete parent before touching #972/#968/#970.

### Outbound GitHub reference admission

- **#987** — exact head `24cf765b97ce8813593c555ceed91de80caf9e28`, three commits above current `main`; ten workflow-free files. The packet covers canonical, encoded-authority, backslash, control, port, trailing-dot, IDNA-dot, dot-segment, HTTP/`www`, and uppercase scheme/host admission. The public wrapper now snapshots top-level input, nested policy, and controlled repositories once so supplemental findings cannot drift from retained text and policy fingerprints. CodeRabbit is successful, review threads are empty, and source review `4857696607` accepted the exact head pending execution. Canonical run `30938518720` is pending before job allocation.

### Observation Merkle checkpoints

- **#1000** — exact head `0e07820bba76dbbc5ab290040312ea43ce03c4aa`, six commits above current `main`; sixteen-file workflow-free fence. The private proof engine remains byte-identical; the public wrapper snapshots inputs once, rejects retained public GitHub identities during creation and verification, and validates oversized array length before caller-owned key enumeration. CodeRabbit is successful. Canonical run `30935478441` is pending. Fresh complete proof/privacy and terminal review remain required.

The Merkle packet proves only exact inclusion and append-only prefix consistency for one admitted ledger view. It grants no provider truth, authorization, settlement, signing, persistence, or deployment authority.

### Durable repository-write storage

```text
#1056 runtime-private store dependencies
  → #1049 stored external-identity admission
```

- **#1056** — exact head `3fed2d6063b9a90a5041b1ea0d793ff642a0d2c3`, one commit above current `main`; exact two-file fence. ECMAScript private fields and a private argument builder prevent credential-bearing Convex dependencies from being reflected or publicly substituted while preserving the exact call contract. CodeRabbit is successful, review threads are empty, and source review `4857647686` accepted the exact head pending execution. Canonical run `30931706311` remains queued.
- **#1049** — exact head `55bb3f8770ccc74fe7123d85001844535d3751df`, one commit above exact #1056; nine files covering stored external-ID ownership and lookup admission. It remains blocked on #1056 integration and requires complete fresh exact-head gates.

## Lanes requiring fresh status confirmation

The following lanes were not re-authorised by this reconciliation. Read their exact current PR heads, ancestry, review threads, and canonical execution before any write or integration decision:

- native repository-file writes: #1020, #1065, #1028, #1075, #1022, #1083, #1084, #1085, #1087, and #1088;
- cancellation proof receipt: #1057 transferring evidence to #1009;
- hosted composition, public manifests, deployment, and authenticated product proof.

Prior documentation head values for these lanes are historical hints only.

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
| P0 | #961 → #1013 / #975 | Exact source packets are reviewed; canonical runs are pending | Complete #961 exact-head gates, integrate unchanged, then replay and renew both children | Proposal, instruction evidence, and acceptance compose deterministically on landed ancestry |
| P0 | #1050 → #1012 → #972 → #970 | #1050 is one workflow-free commit above #1012 with current controls | Complete exact-head execution and terminal review before parent absorption | Seven typed mutations pass source, canonical, manifest, and terminal gates |
| P1 | #987 | Single-snapshot repair is source-accepted; execution is pending | Complete exact-head canonical and terminal gates | External GitHub routes never pass through supported normalization or producer-mutation variants |
| P1 | #1000 | Workflow-free bounded Merkle packet is pending | Complete exact-head canonical and proof/privacy review gates | Inclusion/consistency evidence passes without retained public identity or prelimit work gaps |
| P1 | #1056 → #1049 | Parent source is accepted; CI is queued; child is exact-stacked | Complete #1056 execution and terminal gates, integrate, then restack/renew #1049 | Runtime-private credentials and unique stored identity both pass on landed ancestry |
| P1 | Unreviewed native/proof lanes | Prior documentation is stale | Re-read exact live heads before action | One current verified record replaces historical assumptions |

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
