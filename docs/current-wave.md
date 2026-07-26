# Current dogfood wave: Production MCP connection

**Status:** active planning and execution focus  
**Date established:** 2026-07-27  
**Tracking issue:** #286  
**Primary outcome:** connect ChatGPT to the hosted Stensibly MCP server through OAuth and complete one real read/write dogfood cycle.

This file is a compact current-focus projection. GitHub issues, pull requests,
exact revisions, deployed configuration, and Stensibly records remain canonical.
Update or replace this file when the wave changes.

## Wave

**W01 — Production MCP Connection**

The wave is complete only when a fresh ChatGPT conversation can:

1. discover OAuth from `https://api.stensibly.com/mcp`;
2. complete GitHub-backed Stensibly consent;
3. scan the live MCP tools;
4. call a bounded read tool such as `get_brief` or `survey_workspace`;
5. perform one explicitly approved low-risk write;
6. leave a durable event or item proving the connection;
7. reconnect through refresh-token flow or an equivalent verified renewal path;
8. document rollback and operator recovery.

A successful code merge without the real ChatGPT flow is not wave completion.

## Current blocker chain

- #220 owns the remaining dynamic-client lifecycle, capacity recovery,
  idempotency policy, combined load verification, and final production-gate
  sign-off.
- PR #256 already added Worker-side registration rate limiting and exact redirect
  origin gating.
- PR #251 is adjacent refresh-family lifetime and cleanup hardening. Keep it
  separate from #220's dynamic-client implementation and review it at an exact
  revision before merge.
- Production OAuth discovery remains absent until the OAuth configuration and
  signing secret are enabled on the deployed Worker.

## Lane A — Finish dynamic-client lifecycle

**Single implementation owner.** Do not open competing code branches against the
same schema and registration mutations.

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

## Lane B — Independent acceptance

This lane must be performed by a worker that did not author Lane A's final code.

Review:

- storage exhaustion and ceiling recovery;
- active-client deletion safety;
- retry and replay behaviour;
- cross-workspace isolation;
- scheduler or cleanup amplification;
- idempotency and metadata matching;
- secret and callback-data logging;
- legacy compatibility;
- exact production-gate acceptance.

The verdict must name the exact reviewed revision and contain either:

- `accepted` with residual risks; or
- `blocked` with demonstrated findings and required repairs.

Also reconcile PR #251 independently. Do not merge its refresh-family changes
into the #220 branch merely because both involve OAuth.

## Lane C — Guarded rollout and real ChatGPT verification

Prepare before enabling OAuth:

- required Cloudflare secrets and variables;
- GitHub OAuth callback and allowed-subject configuration;
- exact ChatGPT redirect-origin admission;
- monitoring for registration rejection and client-count pressure;
- one-command or one-step rollback by disabling OAuth configuration;
- metadata and unauthenticated challenge checks;
- a bounded test account and project.

After Lane A acceptance:

1. deploy Convex and Worker changes in the required order;
2. enable the OAuth signing secret and hosted-auth configuration;
3. verify:
   - `/.well-known/oauth-protected-resource/mcp`;
   - `/.well-known/oauth-authorization-server`;
   - unauthenticated `/mcp` returns a valid OAuth challenge;
4. create or refresh the Stensibly ChatGPT app and scan tools;
5. complete a read-only test;
6. complete one approved low-risk write;
7. verify refresh or reconnect behaviour;
8. attach evidence and close or update #220 and #286.

## Work-selection policy for this wave

Until the real connection works:

1. finish or review the blocker chain before starting unrelated Stensibly
   features;
2. keep one implementation owner per overlapping subsystem;
3. direct spare workers to acceptance, reproduction, rollout preparation,
   documentation, or evidence reconciliation;
4. convert long discussion into exact findings, decisions, patches, tests, or
   handoffs;
5. stop creating adjacent OAuth issues unless an independently buildable boundary
   is demonstrated.

## Project-instruction prompt

A ChatGPT Project using this repository should direct fresh chats to read:

1. `AGENTS.md`;
2. `docs/current-wave.md`;
3. `README.md` and `docs/product-model.md`;
4. the relevant issue, PR, review threads, and exact-head handoff.

Fresh chats should be told to inspect existing work and select a useful
non-conflicting action from this wave before proposing new roadmap work.

## Wave retrospective

After connection succeeds, record:

- which instructions fresh agents actually followed;
- whether the wave/lane/action vocabulary helped;
- duplicated work or comments that could have been avoided;
- missing observability or API tools;
- which steps should become Stensibly-enforced records;
- what can be removed from this temporary file.
