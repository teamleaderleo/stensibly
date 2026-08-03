# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution and convergence focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-04 UTC after repository-write storage, bounded readback, context-admission, native transport, and formal-proof reviews  
**Current main:** `cd81a86bad209419a9e5f98db3661aeeb1c5caa2`  
**Tracking incident:** #490  
**Programme:** #491  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `17`  
**Operating protocol:** `stensibly-agent-ops/0.5.0` plus standing policy `stensibly-internal-dogfood/v2`

## Purpose

Make GitHub and Stensibly remain usable together through sustained authenticated ChatGPT work: repeated reads, governed writes, durable receipts, accepted context, reconnect, ambiguity recovery, and continued GitHub access during degradation.

GitHub remains the independent public project and recovery record. Repository integration, deployed capability, and authenticated product proof are separate facts.

## Current verified reality

### Merged foundations

Current `main` contains:

- guarded GitHub repository, pull-request, review, status, Actions run/job, and opt-in job-detail reads;
- durable accepted GitHub issue context and the public `get_github_project_context` read;
- public typed GitHub issue create, update, and comment actions with durable provider receipts;
- backlink-safe outbound GitHub text preflight (#971);
- realistic anywhere-in-text credential screening for durable GitHub provider receipts (#983, merged as `819cdc68a1a795b6737ae7f89976794cac5c5d02`);
- the strict Convex repository-write store client (#1030);
- exact Convex function-name test support (#1035);
- atomic project-scoped repository-write receipts and one active project/repository/ref lane (#1032, merged as current `main@cd81a86bad209419a9e5f98db3661aeeb1c5caa2`).

The public MCP release on `main` still exposes the merged 37-tool issue-write surface. Label/assignee writes, native repository-file writes, and the broader context-reconciliation chain remain unintegrated.

### Live product proof remains open

The repository does not prove that production currently serves the exact Worker/MCP revision, feature flags, public tool declaration, refreshed ChatGPT app, or complete authenticated journey.

W01 still requires fresh hosted evidence for:

- #697: the opt-in Actions step/log declaration and one authenticated hosted receipt;
- #492: one authorised hosted GitHub project-context read used in the sustained journey;
- #921: an authorised idempotent GitHub write, durable receipt lookup, reconnect, and exact replay without duplicate provider mutation;
- #490: repeated same-conversation Stensibly lifecycle execution and reconnect while GitHub remains available.

## Active source and execution lanes

### Durable repository-write storage

Atomic Convex receipt/ref-lane storage is merged. The post-merge admission chain is:

```text
#1038 canonical receipt bytes + retained credential privacy
  → #1056 runtime-private Convex store credentials
  → #1049 stored external-owner and lookup identity admission
```

- **#1038** exact head `4f6154ec6ab1dc62a7d320e24cf055ac39e264ad` is one commit over current main. Source is accepted: strict parse is followed by byte-exact canonical equality, duplicate-key aliases fail, and the landed realistic retained-credential policy is applied to the complete admitted receipt. Canonical run `30849849522` remains pending before job allocation.
- **#1056** exact head `723ed16479b900704a600ed20bc53f4196334c27` is one byte-preserving child over #1038. Convex caller, service secret, workspace, and the secret-producing argument builder are ECMAScript-private. Source is accepted; run `30850846305` remains pending before job allocation.
- **#1049** exact head `03209b2d5ff72188c3e0143f801abe5ea15dbbbf` is stacked on #1056. It reuses one primitive identifier admission for receipt construction and lookup, rejects embedded credentials before server database access or client query, bounds external-owner/lane cardinality with `take(1)`/`take(2)`, preserves distinct missing versus duplicate/substituted errors, and requires exact ownership for replay/get/transition/blocked-lane resolution. Source is accepted; base-sensitive execution must be renewed after the parent chain settles.

Integrate only in this order. No hosted repository-write composition should advance until the exact surviving chain passes canonical, exact-ref, ancestry, mergeability, and terminal-review gates.

### GitHub issue-write parity and bounded provider responses

The private/public label and assignee chain remains:

```text
#968 private hosted composition
  → #972 call-local settlement
  → #1012 shared bounded provider response
  → #1050 bounded legacy issue/comment readback facade
  → #970 public 41-tool registration
```

#1012 owns the shared total response lifetime, decoded-byte ceiling, chunk-work bound, chunk ownership, fatal UTF-8, request attribution, hostile response metadata, and fixed non-echoing failures.

**#1050** has absorbed closed children #1060 and #1067 at exact head `5e85b0e2feb36ed8a3ec53023d28908fb37b0fe0`. It now:

- restores one-shot bounded `text()` through the inherited deadline;
- preserves bounded `Link` metadata and descriptor-safe stream results;
- derives the effective method as `init.method ?? Request.method ?? GET`, case-insensitively;
- grants 24 MiB only to GET issue collection/search routes;
- uses 512 KiB for one issue, issue creation/update, final issue readback, and fallback;
- uses 256 KiB for GET one comment and POST comment creation;
- preserves request identity through stalled final readback.

Fresh run `30853164704` is pending. After unchanged-head acceptance, absorb #1050 into #1012 and rerun #972/#968/#970 on exact ancestry.

### Provider receipt to accepted context

The current sequence is:

```text
#961 reconciliation proposal/request compiler
  → #1064 primitive enum admission
  → #1063 final chronology/item-ceiling/privacy controls
  → #1013 instruction-observation resolution
  → #1055 stateless exactly-once nested-input controls
  → #975 context acceptance composer
  → #1061 primitive composer enum admission
```

- **#961** current parent head is `76a8c41954d34fe1b47218f33e131722bff2f25f`.
- **#1064** exact head `f08b980de00230fc4d7327c18e70cff15a5dd42c` requires primitive `outcome`/`nextAction` admission without conversion hooks and retains only admitted primitive values. Source is accepted; test, runtime-parity, and browser jobs are queued in run `30851471496`.
- **#1063** exact red-control head `6dda2e350074d472421a0fd76240af7e67d95ba4` requires create chronology rejection before any nested snapshot `getPrototypeOf`, key, or descriptor access; provider issue number `<= 2_147_483_647`; and the landed Stensibly token/service plus authorization-header privacy policy across retained identities. It preserves benign short aliases. #961 must absorb this exact control and source repair; the child never merges.
- **#1013** still uses a 256-entry process-local canonical-request registry and proposal-less origin fallback. The wrapper snapshots nested evidence for local checks, then passes original caller-owned request, attachment, and observation objects to the base resolver and later chronology reads.
- **#1055** exact head `49207c61518948b6f7b9a693789b6ea9118b03c0` provides complete red evidence for a stateless repair: compiler history and cache pressure must never authorise proposal-less resolution; proposal/request/attachment/observation must each be detached exactly once; and later self-consistent reversals must not cross wrapper/base/chronology layers. Source review accepts the control; run `30851122300` is pending before job allocation.
- **#1061** exact head `df12a515310b56c5af509891ddd67f437ddb3f9d` applies the same primitive-enum boundary to #975 before hostile binding access. Source is accepted; three parallel jobs are queued in run `30851195955`.

Complete #961 first, replace #1013’s registry with exact proposal-required detached input, then restack and renew #975/#1061. Receipt-reservation chronology remains a separate producer-evidence gate.

### Outbound-reference and proof privacy

- **#987** remains the consolidation parent for complete outbound GitHub URL admission after #971.
- **#1046** exact head `7e7cde8822b9db5ab7ab0e7f17f7716703d8967a` is source-accepted for encoded invalid identity and literal/encoded route-continuation admission. It recognises supported route prefixes before terminal-shape rejection, preserves authority/privacy precedence, and must be absorbed into #987 after canonical execution. Separate descriptor/Proxy, candidate-length, and remaining WHATWG-normalisation work still belongs to the parent.
- **#1000** owns append-only observation Merkle checkpoints and proofs. Its mathematics remain authority-free and prove only inclusion or append-only prefix consistency, not provider truth, completeness, signing, persistence, settlement, or deployment.
- **#1033/#1045** continue to own retained public-route and commit-presentation privacy controls before the Merkle packet can become terminal.

Both parent packets require exact-current-main replay and fresh complete execution after their controls are absorbed.

### Native repository-file writes

#1020 contains a useful native transport core but is not an integration candidate. The shared admission child is now:

- **#1065** live head `2f23e466eb4ba4bd538ead7486f44708dfaf2611`, stacked on #1020. It centralises canonical lowercase repository identity, strict branch names including all `refs/` namespaces, exact ASCII paths, realistic credential rejection, and full lowercase 40/64-hex object admission across the fence and REST adapter.
- **#1070** exact red-control head `8d5151b4324ad11adb2dc1c10fedf185e45ca29e` pins the remaining fence-level object-format gap: the durable fence currently accepts a 64-hex returned/ref-head commit over an exact 40-hex parent because only the adapter checks width coherence. #1065 must apply `sameGitObjectFormat()` inside `verifyRepositoryWriteResult()` before provider-state reads.
- #1065 must also repair the inherited positive fence fixture, which still uses mixed-case repository bytes despite the new exact-lowercase policy.

Even after #1065 repairs, #1020 still requires:

- an atomic exact-parent provider primitive rather than post-effect stale-parent detection;
- exact requested path/bytes or deletion settlement at the returned commit;
- retained request identity through post-effect admission failure;
- one total fetch/body deadline and final response-reader lifetime refinements;
- hosted authority/composition and public actions only after the private transport becomes terminal.

#1022 contents-token scope remains blocked behind the repaired transport and general installation-token response lifetime/resource contract.

### Formal settlement model

#1009 source head `3ecc731caa1a1c513cdb7991c31d34ae09436ea7` is the current-main cancellation-settlement model. The active extension checks retained retry capacity and includes a terminal cancel/rejoin witness without widening cleanup authority.

Read-only proof carrier **#1057** moved to `c7782a3528ac0294cd806399f9bcb099c8b1a463`. Its per-obligation `passed | failed | not_run`, exit-code, state-summary, failure-count, always-upload, and non-authorizing receipt design is stronger than the cancelled predecessor. One semantic receipt defect remains:

- `checks.cancelledWaiterHasRetryCapacity` is derived from the cancelled-retry witness status, although the invariant of that name is checked by the active safe obligation.

Rename the boolean to the witness meaning, derive the invariant boolean from active-safe status, or retain both distinctly. Runs `30853273749` and `30853273736` are queued, but any receipt from this SHA is nonterminal until the mapping is repaired. The carrier never merges.

## Temporary degraded mode

While #490 remains open:

- GitHub owns source, instructions, issues, pull requests, reviews, CI evidence, blockers, recovery, and handoffs;
- Stensibly is used only in an explicitly bounded reliability run when its connector is available;
- ambiguous provider writes are reconciled by durable operation or idempotency identity before replay;
- a connector or chat outage must never hide the backlog or repository instructions;
- repository work remains recoverable from GitHub alone.

## Definition of done

W01 completes only when fresh authenticated ChatGPT sessions repeatedly prove:

1. GitHub instructions, backlog, source evidence, and provider state remain readable;
2. Stensibly discovery and the complete create/claim/event/artifact/read/complete/reread lifecycle remain executable across several calls;
3. governed GitHub writes return actor-bound durable receipts and exact replay does not duplicate effects;
4. accepted GitHub context and repository instructions bind to the exact project, issue, attachment generation, and provider revision;
5. disconnect/reconnect restores authorised functionality and receipt lookup;
6. every failure is typed as rejection, ambiguity, or reconciliation with bounded non-secret evidence;
7. the complete lifecycle passes repeatedly in one conversation and again after reconnect;
8. GitHub remains independently usable during Stensibly degradation.

A merged PR, green repository run, dashboard sign-in, single provider write, or one successful connector call does not complete the wave.

## Priority queue

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained use | Continued lifecycle and reconnect remain unproved | Run one fresh uniquely identified lifecycle with GitHub checkpoints between segments | Repeated lifecycle and reconnect pass with typed outcomes |
| P0 | #921 / #492 / #697 live GitHub proof | Repository capabilities are merged; deployed/authenticated evidence is incomplete | Verify exact Worker/MCP revision, refresh the app, and record hosted write/context/job-detail receipts | Exact hosted receipts, reconnect, and no-duplicate replay pass |
| P0 | #1038 / #1056 / #1049 | Source is accepted in sequence; canonical execution remains incomplete | Complete exact-head parent/child gates and integrate only unchanged stacked candidates | Canonical CI, exact-ref, reviews, ancestry, and terminal gates pass in order |
| P0 | #1050 / #1012 / #972 / #970 | Method-sensitive issue/comment readback controls are absorbed; fresh execution is pending | Complete #1050, absorb through the private response stack, replay the 41-tool parent | Seven typed mutations pass source, canonical, manifest, and terminal gates |
| P0 | #961 / #1064 / #1063 / #1013 / #1055 / #975 / #1061 | Final admission and stateless-origin repairs are pinned | Absorb #1063/#1064, remove registry authority, detach one exact packet, then renew composer | Exact proposal/request/attachment/instruction chronology composes deterministically |
| P1 | #987 / #1046 | Encoded route-prefix repair is source-accepted; parent-wide boundaries remain | Complete #1046 execution, absorb it, and finish descriptor/normalisation gates | External GitHub routes never pass because of encoding or normalisation |
| P1 | #1000 / #1033 / #1045 | Merkle engine is coherent; retained public-route matcher is incomplete | Absorb route-prefix and presentation controls, replay current main, run full proof/privacy gates | Public route identities reject without changing proof mathematics |
| P1 | #1009 / #1057 | Model source is current; proof receipt check mapping is wrong | Correct invariant/witness attribution, rerun proof, inspect artifact and checksums | Trustworthy exact proof receipt plus canonical repository gates pass |
| P1 | #1020 / #1065 / #1070 / #1022 | Shared identity admission is close; fence object-format coherence remains | Absorb #1070, repair fixture, then design atomic parent and exact file-effect settlement | Atomic exact-parent write and exact file effect are proved with bounded settlement |

## Immediate next actions

1. Finish #1038/#1056/#1049 exact-head execution and integrate only unchanged candidates in order.
2. Complete #1050 exact-head gates, absorb into #1012, then rerun #972/#968/#970.
3. Absorb #1063/#1064 into #961; replace #1013’s registry with the stateless exactly-once repair pinned by #1055; renew #975/#1061 only after the parent chain settles.
4. Complete #1046 and absorb it into #987; finish the Merkle retained-route/presentation controls and replay both parents on current main.
5. Absorb #1070 into #1065, repair the inherited fence fixture, then continue #1020’s atomic-parent and exact-effect design.
6. Repair #1057’s invariant/witness check mapping, rerun the exact TLA+ proof, and inspect the uploaded receipt/log/checksum artifact.
7. After repository gates settle, verify production revision/app declaration and run the complete #921/#492/#697/#490 authenticated journey.

## Failure handling

When a step fails:

- identify the exact stage and responsible surface;
- preserve bounded operation, revision, request, and ambiguity identity;
- reconcile a possible successful mutation before retrying;
- keep fixed diagnostics free of provider prose and credential material;
- repair and rerun the failing segment, then repeat the complete lifecycle;
- leave GitHub with the current fact, exact evidence, recovery path, and one executable next action.

— Morrow and Loom · W01 revision 17 reconciliation  
  Intention: keep one current campaign record that separates merged code, source blockers, execution evidence, and live product proof
