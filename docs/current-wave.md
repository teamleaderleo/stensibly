# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 convergence and execution  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-04 UTC after current-main context, transport, outbound, and Merkle review  
**Current main:** `e4ffc6a44818f62ef3770ccdcd4d5d5707a30bc2`  
**Tracking incident:** #490  
**Programme:** #491  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `19`

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

- **#961** — exact head `0ef220ca62b36e35ceaf4322d12074e69127a599`, one commit above current `main`; complete detached proposal admission, primitive enum handling, provider item ceiling, and shared retained-credential policy. CodeRabbit and threads are clean. Canonical run `30933293570` is queued.
- **#1013** — exact head `a2685d8c91f7d839f21236244aeb3df5086ffe3c`, one commit above #961; requires the exact proposal on every call, removes process-local origin authority, and snapshots proposal/request/attachment/observation evidence once. CodeRabbit and threads are clean. Canonical run `30933659435` is queued.
- **#975** — exact head `dba6142390f36cbe02b8c926fc624fc8fadeee7e`, one commit above #961; complete acceptance composition with primitive outcome/next-action admission. CodeRabbit and threads are clean. Canonical run `30933857502` is queued.

Integrate #961 first. Restack and renew #1013 and #975 only after the unchanged parent lands.

### GitHub issue-write parity and bounded provider responses

```text
#968 private composition
  → #972 call-local settlement
  → #1012 shared bounded response admission
  → #1050 bounded issue/comment readback
  → #970 public registration
```

- **#1050 is actively moving under new executable controls.** Last reviewed workflow-free source head: `15dd3014d73ffdccd78f669b101f7584b36d2e40`; canonical run `30936720442` was registered on that head. The reviewed contract includes one total deadline, prompt caller-abort settlement, immediate timer/listener cleanup after abort, request attribution, route-specific response ceilings, bounded `Link` metadata, direct `done`/`value` descriptor admission with zero per-chunk key enumeration, immediate chunk detachment, and incremental fatal UTF-8 decoding without a second complete byte buffer. Re-read the live PR head, file fence, workflow presence, review state, and canonical run immediately before any action.
- **#1012** remains unchanged at `084530b2e6ba8e273928e72f239d63e74a9e6de3`. Absorb only a workflow-free, unchanged, green #1050 head, then rerun the complete parent before touching #972/#968/#970.

### Outbound GitHub reference admission

- **#987** — exact head `7d0e32f4834e89d9ddc4f1a660171b8f482aa18b`, one commit above current `main`; complete canonical, encoded-authority, backslash, control, port, trailing-dot, IDNA-dot, dot-segment, HTTP/`www`, and uppercase scheme/host URL admission. #1021 is absorbed. CodeRabbit and threads are clean. Canonical run `30935036875` is queued.

### Observation Merkle checkpoints

- **#1000** — exact head `0e07820bba76dbbc5ab290040312ea43ce03c4aa`, current-main ancestry, sixteen-file workflow-free fence. The private proof engine remains byte-identical; the public wrapper snapshots inputs once, rejects retained public GitHub identities during creation and verification, and validates oversized array length before caller-owned key enumeration. #1078 is absorbed. CodeRabbit and threads are clean. Canonical run `30935478441` is pending.

The Merkle packet proves only exact inclusion and append-only prefix consistency for one admitted ledger view. It grants no provider truth, authorization, settlement, signing, persistence, or deployment authority.

## Lanes requiring fresh status confirmation

The following lanes were not re-authorised by this reconciliation. Read their exact current PR heads, ancestry, review threads, and canonical execution before any write or integration decision:

- durable repository-write storage: #1038 → #1056 → #1049;
- native repository-file writes: #1020, #1065, #1028, #1075, #1022;
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
| P0 | #961 → #1013 / #975 | Current-main source packets are reviewed; runs are queued | Complete #961 exact-head gates, integrate unchanged, then replay and renew both children | Proposal, instruction evidence, and acceptance compose deterministically on landed ancestry |
| P0 | #1050 → #1012 → #972 → #970 | #1050 is actively moving under executable boundary controls | Re-read the live #1050 head; accept only one workflow-free unchanged green candidate before parent absorption | Seven typed mutations pass source, canonical, manifest, and terminal gates |
| P1 | #987 | Complete current-main outbound URL admission is queued | Complete exact-head canonical and terminal gates | External GitHub routes never pass through supported normalization variants |
| P1 | #1000 | Workflow-free bounded Merkle packet is pending | Complete exact-head canonical and proof/privacy review gates | Inclusion/consistency evidence passes without retained public identity or prelimit work gaps |
| P1 | Unreviewed storage/native/proof lanes | Prior documentation is stale | Re-read exact live heads before action | One current verified record replaces historical assumptions |

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
