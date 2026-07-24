# Continuation proposals

A continuation proposal is a durable suggestion for what should happen after one unit of work reaches a useful stopping point.

Completion and continuation remain separate facts:

- completion records that the current item met its completion condition
- a continuation proposes another action and waits for policy, a human, or a supervisor

This separation lets an agent finish its request immediately while the proposed next move survives chat closure, process restarts, delivery failures, and later approval.

## Boundary with agent harnesses

Claude Code, Codex, Cursor, OpenCode, and similar harnesses own execution inside a run: model turns, tools, subagents, worktrees, retries, and run outcomes.

Stensibly owns the durable boundary between those runs:

- what next move was proposed
- who may approve it
- which delivery path should receive it
- where the approved intent was materialized
- what evidence a later actor needs

A continuation proposal does not duplicate run state. Once an approved intent creates or resumes an item, queues a run, opens a decision, or submits a conversation follow-up, the proposal becomes `consumed`. The resulting item, run, decision, or conversation owns everything after that handoff.

## Implemented local slice

The local SQLite state machine lives in `src/continuations.ts`.

A proposal records:

- source item, proposal event, and optional source run
- title, rationale, and instruction
- a typed action
- evidence references
- suggesting actor
- approval and delivery modes
- status, generation, expiry, and resolution metadata
- durable result references after consumption

Typed actions are limited to:

- `create_item`
- `resume_item`
- `dispatch_item`
- `request_decision`

Stored actions are domain intents. They are never arbitrary executable tool calls.

## Lifecycle

```text
proposed ──approve──> approved ──consume──> consumed
    │                    │
    ├──defer────> deferred ──approve──────> approved
    │                ├──reject────────────> rejected
    │                ├──cancel────────────> cancelled
    │                └──supersede─────────> superseded
    ├──reject───> rejected
    ├──cancel───> cancelled
    └──supersede> superseded
```

`consumed` means the intent crossed into another durable owner. It does not mean the resulting work succeeded.

Consumption stores one or more result references:

- `itemId`
- `runId`
- `decisionId`
- `conversationRef`

The action controls which reference is required. For example, `create_item` requires an item ID and `dispatch_item` requires a run ID.

Live `proposed`, `deferred`, and `approved` records with an elapsed expiry become `expired` lazily during reads or commands. Expiry increments the generation and appends one event.

## Concurrency and retries

Every command carries an expected generation. A stale card or duplicate browser response receives a conflict after another actor changes the proposal.

Proposal creation and lifecycle commands support idempotency keys:

- exact replays return the first result
- reuse with different input returns a conflict
- lifecycle replay returns the original command result even after later changes

Each meaningful change appends an event to the source item:

- `continuation.proposed`
- `continuation.approved`
- `continuation.rejected`
- `continuation.deferred`
- `continuation.consumed`
- `continuation.cancelled`
- `continuation.superseded`
- `continuation.expired`

The source item freshness fields advance with each event so polling clients can detect the change.

## Protocol and hosted slices

Issue #69 tracks the remaining work:

1. expose propose, get, list, and resolve through REST v1 and MCP
2. add the same state machine to Convex
3. add optional atomic proposals to completion
4. project approval-required proposals into a human decision inbox
5. render a ChatGPT MCP App card
6. have **Continue here** approve the proposal, submit a fresh follow-up message, and consume the proposal with a conversation reference
7. let a supervisor materialize approved proposals into queued runs according to project policy

The original completion request never stays open. A later click creates a fresh request that reads the current proposal generation before acting.
