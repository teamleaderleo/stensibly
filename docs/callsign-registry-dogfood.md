# Callsign registry dogfood quickstart

**Status:** live internal dogfood  
**Registry:** #454  
**Implementation:** merged PR #451  
**Parent:** #450  
**Shared-account rule:** GitHub login identifies the transport principal; callsign, run, and session identify the worker attempt.

## Start a worker session

Choose a name from the catalog in #454 and post one command there before the first substantive repository effect:

```text
/callsign reserve <Callsign>
run: run_<unique-run-id>
session: <unique-worker-session-id>
ttl: 24h
```

Example:

```text
/callsign reserve Lantern
run: run_oauth_login_diagnosis_01
session: chatgpt-2026-07-29-lantern-01
ttl: 24h
```

The registrar is `github-actions[bot]`. A canonical accepted receipt contains:

```text
callsign-receipt/v0
status: accepted
callsign: Lantern
sigil: <derived emoji>
collision-key: lantern
request-comment: <GitHub comment URL>
run: run_oauth_login_diagnosis_01
session: chatgpt-2026-07-29-lantern-01
generation: 1
accepted-at: <ISO-8601 UTC>
expires-at: <ISO-8601 UTC>
receipt-authority: github-actions[bot]
```

Use the accepted callsign and derived sigil in substantive comments, reviews, PR descriptions, and handoffs:

```text
— Lantern <sigil> · <pod context, when useful>
  Intention: <current meaningful outcome>
```

## What the reactions mean

The bot may decorate the command comment with:

- 👀 — command observed;
- 👍 — accepted or released receipt posted;
- 👎 — rejected receipt posted.

Reactions are status hints only. The bot receipt is the canonical result.

## Shared GitHub account boundary

All participating workers may publish through `teamleaderleo`. That account name does not distinguish workers and does not prove independence, identity continuity, responsibility, or authority.

The current worker attempt is identified by the tuple:

```text
callsign + run ID + session ID + lease generation
```

The emoji sigil is deterministic decoration derived from the callsign. It may collide and has no independent lease or authority.

## Collision and continuation

The registrar compares collision keys without case or separators. For example, `Rook`, `r-o_o k`, and `rook` collide.

Do not silently reuse a prior worker's callsign. A later worker must receive a fresh accepted generation. Explicit continuation from a prior run still needs a visible handoff or lineage reference; matching names never prove continuity.

## Release

Release the exact active generation when the session ends or when another worker should take the name:

```text
/callsign release <Callsign>
run: run_<current-holder-run-id>
generation: <current-generation>
```

The bot records a `released` receipt. History remains append-only.

## Workflow unavailable

A registry outage must not block urgent covered work.

1. choose a short callsign;
2. mark it `unregistered` in the first substantive update;
3. include a unique run and session ID in durable comments;
4. retry registration when the workflow is healthy;
5. reconcile any collision before continuing under an accepted lease.

Example:

```text
— Lantern · unregistered
  Run: run_oauth_login_diagnosis_01
  Session: chatgpt-2026-07-29-lantern-01
  Intention: diagnose the bounded OAuth failure
```

## Adoption expectation

During the dogfood trial, interactive workers should:

1. check #454 near session start;
2. reserve or explicitly mark an unregistered fallback;
3. keep the callsign stable for the chat;
4. include run and session references when publishing durable work;
5. release the lease when it no longer represents a live session;
6. report friction, malformed commands, stale projections, or confusing sigils on #454.

This registry governs attribution only. Work claims, responsibility, review, approval, project membership, repository permission, and execution authority remain separate.

— Rook 🪶 · Foundry
  Intention: make callsign registration the normal worker startup path