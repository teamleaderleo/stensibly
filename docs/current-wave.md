# Current dogfood wave: Production MCP connection

**Status:** active execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-07-27 after production OAuth observation and PR #390 merge  
**Tracking issue:** #286  
**Wave:** `W01`  
**Wave revision:** `2`  
**Operating protocol:** `stensibly-agent-ops/0.2.0`  
**Primary outcome:** connect a fresh ChatGPT conversation to the hosted Stensibly MCP server through OAuth and complete one real bounded read/write/reconnect dogfood cycle.

This file is a compact current-focus projection. GitHub issues, pull requests,
exact revisions, deployed configuration, and Stensibly records remain canonical.
Update or replace this file when the wave changes. Increment the wave revision
when its gates, lanes, or accepted test effects change materially.

## Current observed state

Production OAuth is enabled and remains enabled under the operator's current
decision.

Read-only verifier run `30290380944` observed the canonical origin and Worker
fallback at **5/5 enabled** on 2026-07-27:

- health advertised hosted auth and OAuth;
- protected-resource metadata resolved the canonical MCP resource;
- authorization-server metadata resolved the canonical issuer;
- required-token and invalid-token MCP challenges matched the enabled contract.

Source-side lifecycle, registration, refresh-family, discovery, consent, token,
and MCP work is merged. Issue #220 remains open for deployed abuse/lifecycle
evidence and final production-gate reconciliation.

PR #384 merged the read-only provider-subject membership audit. PR #390 merged
the hosted GitHub browser-session dashboard path at merge commit
`9d0275f20fd9e29ac079f0c0b024a0490c21aa2a` after independent exact-head
acceptance and green CI.

The dashboard merge is source evidence. Confirm the hosted deployment serves the
new GitHub sign-in assets before treating the browser path as live.

## Wave completion

W01 is complete only when a fresh ChatGPT conversation can:

1. discover OAuth from `https://api.stensibly.com/mcp`;
2. complete GitHub-backed Stensibly consent;
3. scan the live MCP tools;
4. call a bounded read tool such as `get_brief` or `survey_workspace`;
5. perform the predeclared, explicitly approved low-risk write below;
6. leave a durable item or event proving the connection;
7. reconnect through refresh-token flow or an equivalent verified renewal path;
8. retain bounded rollback and operator-recovery evidence.

Code merges, public metadata checks, and dashboard sign-in alone do not complete
the wave.

## Current blocker chain

### 1. Real ChatGPT journey

The remaining primary action is the real client journey from a fresh ChatGPT
conversation or newly created agent:

- connect to `https://api.stensibly.com/mcp`;
- complete GitHub sign-in and consent;
- scan tools;
- perform one bounded read;
- obtain contemporaneous approval for the predeclared write;
- perform that write with an explicit idempotency key;
- confirm it through a bounded read;
- verify refresh or reconnect.

The journey must use a dedicated OAuth dogfood project and content-minimised
evidence. Do not copy access tokens, provider payloads, or session contents into
GitHub, chat, analytics, or durable project records.

### 2. Deployed production-gate evidence

Issue #220 still owns the remaining deployed evidence:

- registration-limit exhaustion and recovery;
- bounded dynamic-client cleanup and capacity recovery;
- guarded registration and authorisation load checks;
- inspection and explicit repair of malformed lifecycle rows, when any exist;
- exact Convex and Worker deployment revisions;
- current rollback mechanism and bounded verifier output.

OAuth is already enabled. Treat an unexpected disabled state as an incident or
an explicitly approved reconfiguration, not as the expected starting point.

### 3. Recovery packet replay

PR #379 and PR #387 still describe PR #384 as pending or require replay after it
lands. Their product intent remains useful, but their exact branch and evidence
metadata are stale.

Before either can integrate:

- replay the unchanged product diff onto current `main`;
- bind it to the integrated provider-membership audit contract;
- run a fresh full gate;
- refresh exact head/base/merge metadata;
- obtain the required independent exact-head verdict and integration decision.

These recovery artifacts may inspect and prepare bounded evidence. They grant no
login, membership change, OAuth disablement, credential access, or production
mutation authority.

### 4. Hosted dashboard verification and control-room continuation

Verify the deployed dashboard contains the PR #390 assets and supports:

- **Continue with GitHub** on the canonical hosted endpoint;
- session-authenticated REST reads and writes within account/project scope;
- token-only custom endpoints;
- hosted logout with retry on server failure;
- mobile access without reopening overloaded chats.

After deployment verification, continue #334 with the smallest non-overlapping
onboarding slice: show the next required setup action, public MCP endpoint copy,
and a bounded first-read verification. Keep manual bearer-token entry as the
advanced fallback.

## Production decision boundary

The accepted current direction is to keep production OAuth enabled.

Any transition to hosted-auth-only disabled OAuth requires a fresh Tier 3
approval naming:

- the exact current deployment and source revision;
- the exact binding names and removal or version-restore mechanism;
- the intended disabled state;
- the rollback target;
- the bounded verification and compensation steps.

No documentation packet or prior approval silently authorises that transition.

## Predeclared low-risk write

Do not improvise the production write test.

The authorised test class is:

> Create one uniquely named test item in a dedicated OAuth dogfood project using
> an explicit idempotency key and a human approval recorded immediately before
> execution. Confirm the item appears through a subsequent bounded read.

The test must not claim, complete, delete, merge, deploy, spend money, contact an
external system, or mutate unrelated work. Record the project, item name,
idempotency-key reference, approval record, write result, and confirming read.

## Active lanes

### Lane A — real connection and evidence

Primary owner completes the fresh ChatGPT OAuth, tool scan, bounded read,
approved write, confirming read, and refresh/reconnect journey. Stop before the
write until the contemporaneous human approval exists.

### Lane B — recovery and deployed verification

A non-overlapping worker replays #379/#387 against current main or gathers the
remaining read-only #220 evidence. Production mutation requires the applicable
approval.

### Lane C — browser control room

Verify the PR #390 deployment, then advance #334 through a small step-based
onboarding/status slice. Keep account/session UX, setup projection, and control
room work separate from recovery packet changes.

## Work-selection policy

Until the real connection succeeds:

1. finish the real journey or remove a demonstrated blocker before unrelated work;
2. prefer independent acceptance, integration, repair, replay, deployment evidence,
   and control-room access over new adjacent OAuth designs;
3. keep one implementation owner per overlapping subsystem;
4. convert discussion into exact findings, decisions, patches, tests, evidence,
   or handoffs;
5. leave production effects behind their current approval boundary.

## Wave retrospective

After connection succeeds, record:

- which instructions fresh workers followed;
- whether the wave/lane/action vocabulary helped;
- duplicated or abandoned work;
- missing observability or connector capabilities;
- how the mobile/browser control room changed intervention cost;
- which coordination facts should become server-enforced records;
- one accepted, rejected, or no-change operating-instruction proposal under #293.
