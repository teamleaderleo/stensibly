# Current dogfood wave: Production MCP connection

**Status:** active execution focus  
**Date established:** 2026-07-27  
**Tracking issue:** #286  
**Wave:** `W01`  
**Wave revision:** `2`  
**Operating protocol:** `stensibly-agent-ops/0.2.0`  
**Current pod projection:** Foundry (`docs/pods/foundry/charter.md`)  
**Primary outcome:** connect ChatGPT to the hosted Stensibly MCP server through OAuth and complete one real read/write dogfood cycle.

This file is a compact current-focus projection. GitHub issues, pull requests, exact revisions, deployed configuration, and Stensibly records remain canonical. Update or replace this file when the wave changes. Increment the wave revision when its gates, lanes, or accepted test effects change materially; do not reuse a revision after external review or execution has cited it.

## Wave

**W01 — Production MCP Connection**

The wave is complete only when a fresh ChatGPT conversation can:

1. discover OAuth from `https://api.stensibly.com/mcp`;
2. complete GitHub-backed Stensibly consent;
3. scan the live MCP tools;
4. call a bounded read tool such as `get_brief` or `survey_workspace`;
5. perform the predeclared, explicitly approved low-risk write below;
6. leave a durable event or item proving the connection;
7. reconnect through refresh-token flow or an equivalent verified renewal path;
8. document rollback and operator recovery.

A successful code merge without the real ChatGPT flow is not wave completion.

## Current blocker chain

- #220 owns the remaining dynamic-client lifecycle, capacity recovery, idempotency policy, combined load verification, and final production-gate sign-off.
- PR #256 already added Worker-side registration rate limiting and exact redirect-origin gating.
- PR #251 was independently accepted at exact head `5735abda87eeeacaef442fc7655bf807a1f24d8f` and merged as `ad65af47b7e1e3cbf65ec734a43d786cb311c421`. Its dormant legacy-family outcome resolves #289's implementation gate.
- PR #299 provides a mutation-free hosted OAuth metadata and challenge verifier for Lane C. It remains draft pending independent exact-head review and does not replace the real login, consent, tool-scan, read, write, or reconnect acceptance.
- Production OAuth discovery remains absent until the OAuth configuration and signing secret are enabled on the deployed Worker.

The remaining implementation and rollout chain is:

```text
Lane A #220 implementation -> independent exact-head acceptance -> guarded rollout
                                                            -> real ChatGPT read/write/reconnect evidence
```

Lane B may prepare the acceptance matrix while avoiding implementation ownership for the final revision it accepts. Lane C may prepare rollout work but must not execute production enablement until the remaining gate is satisfied.

## Lane A — Finish dynamic-client lifecycle

**Single implementation owner.** Do not open competing code branches against the same schema and registration mutations.

Deliver:

- explicit unused-client expiry policy;
- bounded cleanup and registration-capacity recovery;
- exact workspace isolation;
- an explicit identical-registration/idempotency decision;
- focused Convex and HTTP tests;
- migration and legacy-record behaviour;
- updated production-gate documentation;
- one coherent PR linked to #220.

Required handoff:

- exact head SHA;
- changed files;
- tests and results;
- security invariants;
- unresolved risks;
- deployment implications.

## Completed adjacent refresh-family gate

PR #251 remains a separate merged refresh-family hardening slice. Any regression or follow-up must preserve its exact accepted invariants and must not be silently folded into Lane A merely because both areas involve OAuth.

Its accepted contract includes:

- immutable accepted refresh-family deadlines;
- workspace-scoped family reads, writes, revocation, scheduling, and deletion;
- bounded 100-row cleanup continuations;
- deduplicated current and compatible rooted legacy scheduling;
- fail-closed handling for rootless or ambiguous legacy calls;
- no dependency on later refresh traffic for pending dormant legacy jobs.

## Lane B — Independent acceptance

This lane must be performed by a worker that did not author the final code being accepted.

Review Lane A for:

- storage exhaustion and ceiling recovery;
- active-client deletion safety;
- retry and replay behaviour;
- cross-workspace isolation;
- scheduler or cleanup amplification;
- idempotency and metadata matching;
- secret and callback-data logging;
- legacy compatibility;
- exact production-gate acceptance;
- compatibility with the merged PR #251 refresh-family contract.

Every verdict must name the exact reviewed revision and contain either:

- `accepted` with residual risks; or
- `blocked` with demonstrated findings and required repairs.

## Lane C — Guarded rollout and real ChatGPT verification

Prepare before enabling OAuth:

- required Cloudflare secrets and variables;
- GitHub OAuth callback and allowed-subject configuration;
- exact ChatGPT redirect-origin admission;
- monitoring for registration rejection and client-count pressure;
- one-command or one-step rollback by disabling OAuth configuration;
- metadata and unauthenticated challenge checks, using PR #299 after independent acceptance;
- a bounded test account and dedicated OAuth dogfood project;
- confirmation that the deployed Convex revision includes merged PR #251.

Execute production rollout only after Lane A receives independent exact-head acceptance and the operator approves the consequential configuration and secret changes.

Then:

1. deploy Convex and Worker changes in the required order;
2. enable the OAuth signing secret and hosted-auth configuration;
3. verify:
   - `/.well-known/oauth-protected-resource/mcp`;
   - `/.well-known/oauth-authorization-server`;
   - unauthenticated `/mcp` returns a valid OAuth challenge;
4. create or refresh the Stensibly ChatGPT app and scan tools;
5. complete a read-only test;
6. perform the predeclared low-risk write below;
7. verify refresh or reconnect behaviour;
8. attach evidence and close or update #220 and #286.

## Predeclared low-risk write

Do not improvise the production write test.

The authorised test action is:

> Create one uniquely named test item in a dedicated OAuth dogfood project using an explicit idempotency key and a human approval recorded immediately before execution. Confirm the item appears through a subsequent bounded read.

The test must not claim, complete, delete, merge, deploy, spend money, contact an external system, or mutate unrelated work. Record the project, item name, idempotency key reference, approval record, write result, and confirming read.

## Pod context for this wave

The temporary pod bootstrap uses Foundry as the broad default collective context. Workers may declare run-scoped pod participation through `docs/pods/enrolment.md`.

A worker-enrolment request and a pod-participation declaration are different records: the former identifies a disposable worker session; the latter is descriptive collective context. Neither creates authority by itself.

Pod participation does not replace W01 lanes, exact work ownership, independent acceptance, or operator approval.

Do not create another pod solely for one W01 lane. Propose a fork only if the wave retrospective shows recurring multi-run context or obligations that deserve separate continuity.

## Work-selection policy for this wave

Until the real connection works:

1. finish or review the blocker chain before starting unrelated Stensibly features;
2. keep one implementation owner per overlapping subsystem;
3. direct spare workers to acceptance, reproduction, rollout preparation, documentation, or evidence reconciliation;
4. convert long discussion into exact findings, decisions, patches, tests, or handoffs;
5. stop creating adjacent OAuth issues unless an independently buildable boundary is demonstrated.

## Project-instruction prompt

A ChatGPT Project using this repository should use the compact bootstrap in `docs/chatgpt-project-instructions.md`. The Project setting should not duplicate this wave's lanes, pod practices, or detailed gates.

Fresh chats should inspect existing work and select a useful non-conflicting action from this wave before proposing new roadmap work.

## Wave retrospective

After connection succeeds, record:

- which instructions fresh agents actually followed;
- whether the wave/lane/action and pod vocabulary helped;
- duplicated work or comments that could have been avoided;
- missing observability or API tools;
- whether more or less startup context would have helped;
- missed or excessive parallelism;
- useful pod notes or resource requests;
- which pod, participation, memory, and lifecycle steps should become typed Stensibly-enforced records;
- whether Foundry should remain broad, fork, merge, enter dormancy, or be replaced;
- what can be removed from these temporary files;
- at least one accepted, rejected, or no-change instruction proposal under #293.
