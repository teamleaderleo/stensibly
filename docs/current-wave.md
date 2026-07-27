# Current dogfood wave: Production MCP connection

**Status:** active execution focus  
**Date established:** 2026-07-27  
**Tracking issue:** #286  
**Wave:** `W01`  
**Wave revision:** `3`  
**Operating protocol:** `stensibly-agent-ops/0.2.0`  
**Current pod projection:** Foundry trial context (`docs/pods/foundry/charter.md`); participation requires an explicit declaration  
**Primary outcome:** connect ChatGPT to the hosted Stensibly MCP server through OAuth and complete one real read/write dogfood cycle.

This file is a compact current-focus projection. GitHub issues, pull requests,
exact revisions, deployed configuration, and Stensibly records remain canonical.
Update or replace this file when the wave changes. Increment the wave revision
when its gates, lanes, or accepted test effects change materially; do not reuse a
revision after external review or execution has cited it.

## Wave

**W01 — Production MCP Connection**

The wave is complete only when a fresh ChatGPT conversation can:

1. discover OAuth from `https://api.stensibly.com/mcp`;
2. complete GitHub-backed Stensibly consent;
3. scan the live MCP tools;
4. call a bounded read tool such as `get_brief` or `survey_workspace`;
5. perform the eligible, separately approved low-risk write below;
6. leave a durable event or item proving the connection;
7. reconnect through refresh-token flow or an equivalent verified renewal path;
8. document rollback and operator recovery.

A successful code merge without the real ChatGPT flow is not wave completion.

## Current blocker chain

- PR #251 was independently accepted at exact head
  `5735abda87eeeacaef442fc7655bf807a1f24d8f` and merged as
  `ad65af47b7e1e3cbf65ec734a43d786cb311c421`.
- PR #308 is the sole dynamic-client lifecycle candidate for #220. Keystone
  independently accepted exact head
  `3a0c3823b50cc347a68b8e8f2e17ea7ea10499bd`; it remains open and draft until
  current merge authority integrates it.
- The original rollout-verifier PR #299 and replacement PRs #313 and #314 overlap
  the same four-file mutation-free verifier slice. They require an independent
  integration decision; no worker who authored a candidate may select its own.
- Production OAuth discovery remains absent until accepted code is integrated,
  deployed in the documented order, and the OAuth configuration and signing
  secret are enabled through explicit human approval.

The remaining implementation and rollout chain is:

```text
merge accepted #308 candidate
        -> independently select one accepted verifier candidate
        -> guarded deployment and configuration approval
        -> real ChatGPT registration/login/tool-scan/read/write/reconnect evidence
```

Lane B may review replacement heads while avoiding implementation ownership for
the final revision it accepts. Lane C may prepare rollout work but must not execute
production enablement until the remaining gates and human approvals are satisfied.

## Lane A — Dynamic-client lifecycle candidate

PR #308 delivers the current implementation candidate:

- explicit unused-client expiry policy;
- bounded cleanup and registration-capacity recovery;
- exact workspace isolation;
- an explicit same-client-ID metadata replay decision;
- focused Convex and HTTP tests;
- migration and legacy-record behaviour;
- updated production-gate documentation.

The exact-head implementation review is complete. Integration must still verify
that the head, main, merge tree, CI, and deployment order remain current. Merge,
deployment, bindings, secrets, and production enablement remain outside the
acceptance review.

## Completed adjacent refresh-family gate

PR #251 remains a separate merged refresh-family hardening slice. Any regression
or follow-up must preserve its exact accepted invariants and must not be silently
folded into Lane A merely because both areas involve OAuth.

Its accepted contract includes:

- immutable accepted refresh-family deadlines;
- workspace-scoped family reads, writes, revocation, scheduling, and deletion;
- bounded 100-row cleanup continuations;
- deduplicated current and compatible rooted legacy scheduling;
- fail-closed handling for rootless or ambiguous legacy calls;
- no dependency on later refresh traffic for pending dormant legacy jobs.

## Lane B — Independent acceptance

This lane must be performed by a worker that did not author the final code being
accepted.

Review implementation candidates for:

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
- `blocked` or `repair` with demonstrated findings and required repairs.

A verdict on one overlapping verifier candidate does not select it over another.
That selection is a separate independent integration responsibility.

## Lane C — Guarded rollout and real ChatGPT verification

Prepare before enabling OAuth:

- required Cloudflare secrets and variables;
- GitHub OAuth callback and allowed-subject configuration;
- exact ChatGPT redirect-origin admission;
- monitoring for registration rejection and client-count pressure;
- one-command or one-step rollback by disabling OAuth configuration;
- one independently selected mutation-free metadata/challenge verifier candidate;
- a bounded test account and dedicated OAuth dogfood project;
- confirmation that the deployed Convex revision includes merged PR #251 and the
  accepted #220 lifecycle implementation.

Execute production rollout only after the implementation and verifier integration
gates are current and the operator approves the consequential deployment,
configuration, and secret changes.

Then:

1. deploy Convex and Worker changes in the required order;
2. enable the OAuth signing secret and hosted-auth configuration;
3. verify:
   - `/.well-known/oauth-protected-resource/mcp`;
   - `/.well-known/oauth-authorization-server`;
   - unauthenticated `/mcp` returns a valid OAuth challenge;
4. create or refresh the Stensibly ChatGPT app and scan tools;
5. complete a read-only test;
6. obtain the exact human approval described below and perform the bounded write;
7. verify refresh or reconnect behaviour;
8. attach evidence and close or update #220 and #286.

## Eligible bounded write candidate

Do not improvise the production write test. This document does **not** approve or
authorise any mutation.

The eligible test action is:

> Create one uniquely named test item in a dedicated OAuth dogfood project using
> an explicit idempotency key. Confirm the item appears through a subsequent
> bounded read.

Immediately before execution, a contemporaneous durable human approval must name
the exact project, bounded action, and idempotency-key reference. Without that
record, the write remains unauthorised. The test must not claim, complete, delete,
merge, deploy, spend money, contact an external system, or mutate unrelated work.
Record the approval, project, item name, idempotency-key reference, write result,
and confirming read.

## Pod context for this wave

The temporary pod bootstrap offers Foundry as the broad default context candidate.
Reading its registry, charter, or memory does not create participation. Workers may
declare explicit run-scoped participation through `docs/pods/enrolment.md` when
that collective context is useful.

A worker-enrolment request and a pod-participation declaration are different
records: the former identifies a disposable worker session; the latter is
descriptive collective context. Neither creates authority by itself.

Pod participation does not replace W01 lanes, exact work ownership, independent
acceptance, operator approval, or current claims and leases.

Do not create another pod solely for one W01 lane. Propose a fork only if the wave
retrospective shows recurring multi-run context or obligations that deserve
separate continuity.

## Work-selection policy for this wave

Until the real connection works:

1. finish or review the blocker chain before starting unrelated Stensibly features;
2. keep one implementation owner per overlapping subsystem;
3. direct spare workers to acceptance, reproduction, rollout preparation,
   documentation, or evidence reconciliation;
4. convert long discussion into exact findings, decisions, patches, tests, or
   handoffs;
5. stop creating adjacent OAuth issues unless an independently buildable boundary
   is demonstrated.

A quiet or dormant interactive worker is not presumed notified or available. Its
unfinished work may be recovered, partitioned, repaired, or deliberately competed
under the current overlap policy while preserving provenance. A returning worker
must reconcile current state before resuming.

## Project-instruction prompt

A ChatGPT Project using this repository should use the compact bootstrap in
`docs/chatgpt-project-instructions.md`. The Project setting should not duplicate
this wave's lanes, pod practices, or detailed gates.

Fresh chats should inspect existing work and select a useful non-conflicting action
from this wave before proposing new roadmap work.

## Wave retrospective

After connection succeeds, record:

- which instructions fresh agents actually followed;
- whether the wave/lane/action and pod vocabulary helped;
- duplicated work or comments that could have been avoided;
- missing observability or API tools;
- whether more or less startup context would have helped;
- missed or excessive parallelism;
- useful pod notes or resource requests;
- whether quiet/dormant workers and returning chats were reconciled correctly;
- which pod, participation, memory, and lifecycle steps should become typed
  Stensibly-enforced records;
- whether Foundry should remain broad, become active, fork, merge, enter dormancy,
  or be replaced;
- what can be removed from these temporary files;
- at least one accepted, rejected, or no-change instruction proposal under #293.
