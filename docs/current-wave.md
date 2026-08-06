# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-06 after fixture-only Work Pulse merged  
**Current main:** `286958de6fd954753ffc8c31a3db7d0d9cc9c4f5`  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**GitHub context integration:** #492  
**Governed GitHub writes:** #921  
**Wave:** `W01`  
**Wave revision:** `28`  
**Operating protocol:** `stensibly-agent-ops/0.5.0` plus standing policy `stensibly-internal-dogfood/v2`

## Purpose

Make GitHub and Stensibly remain executable together through sustained ChatGPT use, repeated reads and writes, reconnect, and recovery.

GitHub is the independent public project and recovery record. Stensibly adds durable responsibility, authority, continuation, provider receipts, and execution history when its connector is available. A connector outage must never hide the backlog, repository instructions, exact source state, or recovery path.

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
  → further GitHub read/write
  → disconnect/reconnect
  → repeat bounded read/write
```

One successful login, discovery call, read, or write is useful evidence. W01 completes only after repeated same-conversation execution and reconnect recovery pass.

## Current verified reality

### Sustained-use incident

Initial hosted coexistence succeeded: GitHub and Stensibly were discovered in one authenticated conversation, repository state was read, the workspace was surveyed, and one idempotent item was created and claimed.

Continued use later failed: Stensibly mutations disappeared or returned no useful result, artifact attachment and completion became unreliable, rediscovery did not reliably restore execution, and connector availability changed during incident recording. #490 owns this sustained-use failure. Initial authentication evidence remains in #220 and #286.

No repository merge, CI receipt, fixture-only UI, or isolated hosted call closes #490. The complete repeated lifecycle and reconnect proof remain open.

### Current mainline capability

Current `main@286958de6fd954753ffc8c31a3db7d0d9cc9c4f5` includes:

- guarded GitHub repository, pull-request, review-thread, commit-status, workflow-run, workflow-job, and bounded job-detail read primitives;
- durable project-scoped GitHub issue-write receipts and one unique stored external owner;
- public typed GitHub issue create, update, and comment actions;
- initial issue labels and assignees;
- exact public issue-number bounds;
- explicit exact-true hosted issue-write activation and exact-false recovery;
- outbound text preflight on issue creation;
- proposal and request compilation for GitHub context reconciliation;
- stateless instruction-observation resolution;
- exact CI topology with serial-full and checksum-valid exact-ref receipts;
- description-edit CI revalidation;
- a fixture-only `/labs/work-pulse/` operator view with browser/accessibility evidence.

The Work Pulse page is a training projection over admitted fixtures. It is not live radar, a source of authority, or proof that provider/runner state is current.

### Hosted GitHub reads

The delegated read implementation remains bounded by authenticated project scope, one repository binding, exact installation permissions, response limits, content minimisation, and fixed diagnostics.

Merged #1141 centralised exact boolean environment parsing without changing activation semantics. Current `main` keeps delegated reads disabled when their exact enablement values are absent, empty, or false.

Current-main #1168 proposes default-on activation when any hosted GitHub configuration signal exists. Its source is technically reviewed, but rollout approval is withheld until explicit operator acceptance and authenticated hosted proof confirm:

- project and repository scope;
- bounded job steps and logs;
- credential rejection;
- content minimisation;
- exact-false recovery.

### Governed GitHub issue writes

The typed create/update/comment implementation is merged. Every write derives actor and client identity from the authenticated principal, requires write scope and project access, binds the repository, and requires an explicit idempotency key. Updates require the last admitted provider source revision. Receipt lookup remains actor/client/project/repository bound.

Hosted execution requires exact `STENSIBLY_GITHUB_ISSUE_WRITES_ENABLED=true`, complete provider configuration, accepted repository binding, and a durable receipt store. Merged #1133 deliberately restored this explicit activation boundary.

Default-on proposals #1148 and #1169 were closed because no new operator decision superseded #1133. Exact false remains the emergency recovery path.

#921 remains open until a deployed, refreshed ChatGPT app proves one authorised create/update/comment journey, durable receipt lookup, exact replay without duplicate mutation, reconnect recovery, and accepted-context reconciliation.

### GitHub context chain

Merged #961 compiles authority-free GitHub provider-receipt reconciliation proposals. Merged #1013 resolves exact instruction-observation requests against accepted attachments without process-local origin state.

Current-main context acceptance recovery remains active in #1135. Its final source packet must contain exactly the composer plus seven focused controls, including the fixed repository-mismatch diagnostic. The workflow carrier is transition machinery and has no integration authority.

The context chain grants no provider mutation, context acceptance, or authority by itself. Live accepted-context writes remain separately governed.

### Automatic activity and Work Pulse direction

Current-main #1150 is a pure authority-free activity observation compiler candidate. Its repaired admission:

- reads only the closed top-level field vocabulary through direct descriptors;
- performs zero caller `ownKeys` work;
- discards unrelated string and symbol decorations;
- preserves credential, lifecycle, chronology, attention, evidence, fingerprint, and deep-freeze boundaries.

#1152 is exactly stacked on #1150 and defines in-memory replay, conflict, semantic deduplication, and workspace/project isolation. It cannot integrate independently; after #1150 lands it must replay onto the landed parent and rerun all gates.

Merged #1134 provides the fixture-only Work Pulse operator view. Live projection, durable ingestion, provider freshness, authority decisions, and restart durability remain outside that merge.

### Current-main pure/internal packets

The following packets are current-main candidates with source review separated from canonical execution:

- #1154 — shared exact UTF-16 code-unit ordering primitive;
- #1138 — descriptor-safe provider method capture;
- #1159 — return-to-work project delta briefs with detached-input credential screening before semantic suppression;
- #1160 — reusable provider-neutral execution recipe plans with all execution and authority flags false;
- #1000 — bounded observation Merkle checkpoints, inclusion proofs, consistency proofs, and runtime vector parity.

Each requires complete canonical execution, serial-full, exact-ref receipt, CodeRabbit, empty threads, unchanged ancestry, and terminal review on its exact head.

### Native repository-write convergence

The native repository-write chain remains private and must not mount publicly before complete convergence.

Current order:

```text
#1065 shared repository/ref/path/object admission
  → #1022 combined bounded installation-token profiles
  → #1163 atomic immutable-parent Git Data publication
  → #1164 total native response lifetime
  → #1167 successful-PATCH attribution + canonical landed-tree settlement
  → #1165 verified post-effect service retention
  → one workflow-free current-main #1020 replay
```

#1022 has passed repository, browser, and runtime gates on combined head `61e71c606518e5bf0570ac35f269d8f8252dea71`; serial-full and exact-ref completion remain open.

#1163 is being rebuilt on that combined token parent. Older response-lifetime, post-effect, and landed-tree children are invalid when based on the pre-combined parent. Every child must use the final exact parent and publish a workflow-free source head before canonical review.

The final adapter must:

- construct from an immutable expected parent;
- preserve supported file modes;
- publish through a non-forced ref update;
- bound every fetch/body lifetime;
- snapshot request identity once successful PATCH headers are known;
- verify the exact published commit, tree, path, mode, blob identity, size, or deletion absence;
- retain admitted post-effect evidence without redispatch.

No live repository mutation, hosted mount, public action, or deployment is authorised by these private packets.

### Observation and outbound admission

Current-main #1000 replays the complete bounded Merkle proof packet with one public wrapper, single-snapshot input detachment, declared-index array projection, route/credential privacy admission, private-engine import enforcement, and runtime parity vectors.

#987 remains the sole integration owner for outbound GitHub reference admission. Red-control children #1100 and #1101 are absorbed and closed. The final parent packet must publish without a workflow carrier and rerun all exact-head gates.

## Temporary degraded mode

While #490 remains open:

- GitHub owns repository instructions, issues, priorities, source, pull requests, reviews, checks, deployments, evidence, blockers, and handoffs;
- Stensibly adds claims, leases, responsibility, run identity, generations, approvals, grants, budgets, artifacts, provider receipts, and attributable execution history when available;
- ordinary implementation and review work stays recoverable through GitHub;
- Stensibly mutations occur only inside an explicitly identified reliability run or another bounded test lane;
- ambiguous writes are reconciled by unique operation or idempotency identity before replay;
- only one worker mutates one dedicated lifecycle record at a time;
- OAuth remains enabled unless concrete hosted evidence supports another decision.

## Definition of done

W01 completes when fresh authenticated ChatGPT conversations repeatedly prove:

1. repository instructions and the current GitHub backlog remain readable;
2. OAuth discovery, GitHub-backed login, consent, token exchange, refresh, and reconnect succeed;
3. Stensibly tools remain discovered and executable after several calls;
4. the complete create/claim/event/artifact/read/complete/reread lifecycle succeeds;
5. every mutation returns typed success, actionable failure, or explicit ambiguity with deterministic reconciliation;
6. a governed Stensibly-to-GitHub create/update/comment operation returns a durable actor-bound receipt;
7. GitHub and Stensibly remain usable together throughout the conversation;
8. disconnect and reconnect restore authorised functionality and receipt lookup;
9. the lifecycle passes repeatedly in one conversation and across reconnects;
10. automated coverage exercises repeated same-session operations and reconnects;
11. diagnostics identify which layer rejected, timed out, lost, or ambiguously completed a call without exposing secrets;
12. GitHub remains independently readable and writable during Stensibly degradation.

## Active lanes

| Priority | Lane | Current fact | Next executable action | Clearing condition |
| --- | --- | --- | --- | --- |
| P0 | #490 sustained-use incident | Repository controls are stronger; repeated Stensibly execution and reconnect remain unproved | Run the complete uniquely identified lifecycle in one fresh authenticated conversation with GitHub checkpoints | Repeated lifecycle and reconnect pass with typed outcomes and layer-specific diagnostics |
| P0 | #921 governed GitHub writes | Typed write implementation and durable receipts are merged; activation remains exact true | Confirm deployed revision, refresh the app, then execute one authorised idempotent create/update/comment and reconnect receipt lookup | Live verified receipt survives reconnect and replay does not duplicate |
| P0 | #492 hosted GitHub context | Proposal and stateless resolution compilers are merged; final composer remains active | Publish workflow-free #1135, run exact gates, then record one authorised hosted context journey | Accepted context uses current instructions and durable provider evidence |
| P0 | #697 delegated step/log reads | Bounded implementation exists; default-on policy remains gated | Record authenticated hosted step/log evidence under current explicit activation before any policy expansion | Live bounded receipt passes with scope/privacy proof |
| P1 | #1150 / #1152 automatic activity | Parent current-main source is repaired; child is exactly stacked | Complete parent CI and merge, then replay child on landed parent | Exact observation and ingestion semantics pass without authority claims |
| P1 | #1020 native repository writes | Combined token, atomic publication, response lifetime, landed-tree, and post-effect chain is active | Complete exact-parent packets in dependency order, then one current-main replay | Workflow-free chain passes complete gates and settlement evidence |
| P1 | #1000 observation Merkle proofs | Workflow-free current-main replay published | Complete canonical CI, CodeRabbit, thread review, and terminal review | Exact-head packet merges with runtime parity and privacy controls |
| P1 | #987 outbound preflight | Parent recovery owns absorbed privacy and encoded-route controls | Publish workflow-free current-main parent and rerun all controls | Exact-head admission packet merges; children remain closed |

## Work selection

Use this order among eligible, non-overlapping lanes:

1. reproduce or repair the exact #490 failure;
2. finish live verification for merged #921, #492, and #697 capability;
3. integrate current-main work that removes a demonstrated blocker;
4. keep GitHub instructions, queue, issues, pull requests, and evidence accurate;
5. advance bounded activity, recipe, projection, observation, or transport packets;
6. continue broader autonomy work only from measured foundations.

## Immediate next actions

- Complete the active exact-head runs for #1154, #1138, #1159, #1160, #1150, and #1000; merge only unchanged current-main heads with terminal receipts.
- Finish #1022 serial-full and exact-ref validation, then allow #1163 to publish on the combined token parent.
- Publish workflow-free #1135 and #1158 recovery packets; remove their temporary workflow carriers before canonical review.
- Keep #1168 technically reviewed but rollout-blocked until explicit operator acceptance and authenticated hosted proof.
- Execute one fresh #490 lifecycle run with GitHub checkpoints before discovery, between mutation segments, after completion, and after reconnect.
- Record one authorised hosted write receipt/replay/reconnect proof for #921 and one hosted context proof for #492.

## Failure handling

When a step fails:

- identify the exact failing stage and responsible surface;
- preserve bounded evidence, operation identity, and ambiguity identity;
- reconcile a possible successful mutation before retrying;
- repair and deploy when fix-forward is safe;
- roll back after a demonstrated regression or unsafe partial state;
- resume the failing segment and then repeat the whole lifecycle;
- leave GitHub with the current fact, evidence, and one executable next action.

A failed dogfood attempt is product evidence and should produce a sharper test, diagnostic, or repair.

— Ember, Morrow, Lumen, Juniper, Cedar, and Turnstile · W01 revision 28 reconciliation  
  Intention: keep one current, GitHub-verifiable campaign record without overstating hosted proof
