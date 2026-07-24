# Continuation proposals

A continuation proposal is a durable suggestion for what should happen after one unit of work reaches a useful stopping point.

Completion and continuation remain separate facts:

- completion records that the current item met its completion condition
- a continuation proposes another action and waits for policy, a human, or a supervisor

This separation lets an agent finish its request immediately while the proposed next move survives chat closure, process restarts, delivery failures, and later approval.

## First implemented slice

The local SQLite state machine lives in `src/continuations.ts`.

A proposal records:

- source item, proposal event, and optional source run
- title, rationale, and instruction
- a typed action
- evidence references
- suggesting actor
- approval and delivery modes
- status, generation, expiry, and resolution metadata

Typed actions are limited to:

- `create_item`
- `resume_item`
- `dispatch_item`
- `request_decision`

Stored actions are domain intents. They are never arbitrary executable tool calls.

## Lifecycle

```text
proposed ──approve──> approved ──queue──> queued ──start──> started
    │                    │                    │                 ├──succeed──> succeeded
    │                    │                    │                 └──fail─────> failed
    │                    │                    └──fail───────────> failed
    │                    ├──start────────────> started
    │                    ├──cancel───────────> cancelled
    │                    └──supersede────────> superseded
    ├──defer────> deferred ──approve──> approved
    │                ├──reject────────> rejected
    │                ├──cancel────────> cancelled
    │                └──supersede─────> superseded
    ├──reject───> rejected
    ├──cancel───> cancelled
    └──supersede> superseded
```

Live proposals with an elapsed expiry become `expired` lazily during reads or commands. Expiry increments the generation and appends one event.

## Concurrency and retries

Every command carries an expected generation. A stale card or duplicate browser response receives a conflict after another actor changes the proposal.

Proposal creation and lifecycle commands support idempotency keys:

- exact replays return the first result
- reuse with different input returns a conflict
- lifecycle replay returns the original command result even when later transitions have occurred

Each meaningful change appends an event to the source item:

- `continuation.proposed`
- `continuation.approved`
- `continuation.rejected`
- `continuation.deferred`
- `continuation.queued`
- `continuation.started`
- `continuation.succeeded`
- `continuation.failed`
- `continuation.cancelled`
- `continuation.superseded`
- `continuation.expired`

The source item freshness fields advance with each event so polling clients can detect the change.

## Planned hosted and client slices

Issue #69 tracks the remaining work:

1. add the same state machine to Convex
2. add shared `WorkLedger` contracts
3. expose propose, get, list, and resolve through REST v1 and MCP
4. add optional atomic proposals to completion after the dashboard completion slice settles
5. project proposals into a human decision inbox
6. render a ChatGPT MCP App card
7. have **Continue here** resolve the proposal and send a fresh follow-up message containing the durable continuation ID
8. let a supervisor dispatch approved proposals according to project policy

The original completion request never stays open. A later click creates a fresh tool call and a fresh model turn that reads the current proposal state before acting.
