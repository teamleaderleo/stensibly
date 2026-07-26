# Current dogfood wave: Production MCP connection

**Status:** active execution focus  
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
5. perform the predeclared, explicitly approved low-risk write below;
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
- PR #251 is adjacent refresh-family lifetime and cleanup hardening. It remains a
  draft and must stay separate from #220's dynamic-client implementation.
- #289 owns the remaining dormant-legacy-family repair action for PR #251.
- Production OAuth discovery remains absent until the OAuth configuration and
  signing secret are enabled on the deployed Worker.

The two implementation tracks may proceed concurrently and converge on rollout:

```text
#251 repair owner ──→ independent #251 acceptance ──┐
                                                    ├─→ guarded rollout
Lane A #220 implementation ─→ independent acceptance ┘
                                                    └─→ real ChatGPT read/write/reconnect evidence
```

Lane B may prepare both acceptance matrices while avoiding implementation
ownership for the final revisions it accepts. Lane C may prepare rollout work but
must not execute production enablement until both gates are satisfied.

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

## PR #251 repair ownership

PR #251 retains its existing implementation owner until it reaches an exact-head
handoff that closes #289.

- Lane B reviews PR #251 and must not author the final repair it accepts.
- If Lane B blocks the current head and the prior implementation owner is
  unavailable, assign a separate temporary repair owner to #289.
- After any repair, Lane B re-reviews the exact replacement head.
- Keep PR #251's refresh-family code separate from Lane A's #220 dynamic-client
  branch.

## Lane B — Independent acceptance

This lane must be performed by a worker that did not author the final code being
accepted.

Review Lane A for:

- storage exhaustion and ceiling recovery;
- active-client deletion safety;
- retry and replay behaviour;
- cross-workspace isolation;
- scheduler or cleanup amplification;
- idempotency and metadata matching;
- secret and callback-data logging;
- legacy compatibility;
- exact production-gate acceptance.

Independently review PR #251 for its declared refresh-family invariants and #289's
dormant-legacy-family outcome.

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
- metadata and unauthenticated challenge checks;
- a bounded test account and dedicated OAuth dogfood project.

Execute production rollout only after:

1. Lane A receives independent exact-head acceptance; and
2. PR #251 is independently accepted and merged, or explicitly deferred through
   a recorded production-risk decision approved by the human operator.

The preferred production-complete path is to merge PR #251 after #289 is repaired
and accepted. Deferral may support a deliberately bounded protocol experiment,
but it does not count as production-complete without an explicit risk decision.

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

> Create one uniquely named test item in a dedicated OAuth dogfood project using
> an explicit idempotency key and a human approval recorded immediately before
> execution. Confirm the item appears through a subsequent bounded read.

The test must not claim, complete, delete, merge, deploy, spend money, contact an
external system, or mutate unrelated work. Record the project, item name,
idempotency key reference, approval record, write result, and confirming read.

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
3. `README.md`;
4. `docs/product-model.md`;
5. the relevant issue, linked parent issues, open pull requests, review threads,
   and exact-head handoff;
6. repository-root `STENSIBLY.md`, when present;
7. `convex/_generated/ai/guidelines.md` before touching Convex.

Fresh chats should inspect existing work and select a useful non-conflicting
action from this wave before proposing new roadmap work.

## Wave retrospective

After connection succeeds, record:

- which instructions fresh agents actually followed;
- whether the wave/lane/action vocabulary helped;
- duplicated work or comments that could have been avoided;
- missing observability or API tools;
- which steps should become Stensibly-enforced records;
- what can be removed from this temporary file.
