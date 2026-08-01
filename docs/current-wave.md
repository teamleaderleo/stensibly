# Current dogfood wave: GitHub-first MCP reliability

**Status:** active P0 execution focus  
**Date established:** 2026-07-27  
**Last reconciled:** 2026-08-02 after guarded GitHub read integration and backlog consolidation  
**Tracking incident:** #490  
**Programme:** #491  
**Canonical queue:** #301  
**GitHub context integration:** #492  
**Wave:** `W01`  
**Wave revision:** `6`  
**Operating protocol:** `stensibly-agent-ops/0.4.0` plus standing policy `stensibly-internal-dogfood/v2`

## Primary outcome

Restore a repeatable ChatGPT journey in which GitHub and Stensibly remain executable together through repeated reads and mutations, disconnect, reconnect, and recovery.

The required lifecycle is:

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
  → survey
  → further GitHub read/write
  → disconnect/reconnect
  → repeat bounded read/write
```

One successful login, tool scan, read, or initial write is meaningful evidence. It does not complete the wave unless sustained same-conversation execution and reconnect recovery also pass.

Read `STENSIBLY.md` before interpreting older approval, review, deployment, or disablement language. Current direct operator direction authorises accountable self-review, integration, deployment, and verification for covered reversible internal dogfood work.

## Current state

The hosted OAuth and MCP path reached real initial success:

- GitHub and Stensibly were both discovered and used in one authenticated ChatGPT conversation;
- repository instructions and open issues were read;
- the Stensibly workspace was surveyed;
- an idempotent Stensibly item was created and claimed;
- the existing bearer and enabled OAuth public verification remained healthy.

Continued live use then failed:

- later Stensibly mutations disappeared or returned no useful result;
- artifact attachment and completion did not reliably complete;
- subsequent Stensibly reads and writes stopped executing;
- tool rediscovery returned schemas without reliably restoring execution;
- GitHub disappeared from the connector registry and later returned a developer-MCP-only restriction despite earlier coexistence;
- Stensibly later became unavailable while the incident was being recorded.

GitHub-first execution has advanced since that incident:

- the guarded hosted GitHub surface now covers repository metadata, immutable file reads, pull-request metadata, bounded diff or patch text, bounded review threads, exact combined commit status, exact-commit workflow runs, and exact-run job metadata;
- PR #911 merged the combined-status mount as `eda72ac74367e2c02f3345b571fe63286e7b3aec`, and #796 is complete;
- each mounted read remains bound to the accepted project attachment, repository identity, narrow GitHub App permission, bounded result contract, and credential-safe receipt;
- hosted GitHub-context persistence has one canonical source candidate, #909, with executable admission controls in #912; superseded carrier parents #901 and #908 are closed;
- public GitHub-context MCP registration in #560 remains blocked until the repaired hosted persistence boundary lands.

The sustained-use incident is #490. Initial authentication evidence remains in #220 and #286. Keep those milestones open until #490 passes its repeated lifecycle and reconnect gate. The expanded GitHub read surface improves diagnosis and recovery; it does not prove sustained GitHub-and-Stensibly coexistence by itself.

Production OAuth remains enabled unless concrete hosted evidence shows that rollback or disablement is the safer recovery action. Do not disable a healthy authentication surface merely because another layer is unreliable.

## Temporary degraded operating mode

GitHub is the independently usable public coordination and recovery surface while #490 is open.

### GitHub owns the public project record

- repository and operating instructions;
- issues, priorities, discussion, assignments, dependencies, and sub-issues;
- source code, commits, pull requests, reviews, checks, and deployments;
- public progress, evidence, blockers, handoffs, and exact next actions.

### Stensibly adds execution state when available

- claims, leases, responsibility, run identity, and generation;
- blockers, continuations, handoffs, approval, grants, and budgets;
- attached commits, PRs, reviews, tests, logs, and deployments;
- attributable execution history and reconciliation state.

A Stensibly, connector, runner, or chat outage must never hide the backlog or repository instructions.

Until #490 passes:

1. use Stensibly mutations only inside an explicitly identified #490 reliability run or another narrowly approved test lane;
2. keep ordinary implementation, review, issue, PR, and handoff work fully recoverable through GitHub;
3. reconcile ambiguous Stensibly writes by unique operation or idempotency identity before retrying;
4. avoid parallel workers mutating the same dedicated dogfood record;
5. continue useful GitHub-only work when another worker owns the active Stensibly reproduction.

This is degraded operation, not abandonment of the hosted service.

## Definition of done

W01 is complete when fresh authenticated ChatGPT conversations repeatedly prove:

1. repository instructions and the current GitHub backlog remain readable;
2. OAuth discovery, GitHub-backed login, consent, and token exchange succeed;
3. Stensibly tools are discovered and remain executable;
4. bounded reads continue after several tool calls;
5. the complete create/claim/event/artifact/read/complete/reread lifecycle succeeds;
6. every mutation returns a visible typed success, actionable failure, or explicit ambiguity with a deterministic reconciliation path;
7. GitHub and Stensibly remain usable together throughout the conversation;
8. disconnect and reconnect restore authorised functionality;
9. the lifecycle passes repeatedly in one conversation and across reconnects;
10. automated regression coverage exercises repeated same-session operations and reconnects;
11. diagnostics identify the layer that rejected, timed out, lost, or ambiguously completed a call without exposing secrets;
12. GitHub remains independently readable and writable during Stensibly degradation.

A merged PR, setup document, metadata check, dashboard sign-in, or single successful write does not complete the wave by itself.

## Standing execution grant

Under `STENSIBLY.md`, eligible workers may continue without another operator prompt through:

- exact-candidate review and fix-forward repair;
- merge and automatic deployment of reviewed internal dogfood changes;
- protected workflow and environment use without exposing secret values;
- OAuth login, consent, token exchange, refresh, reconnect, and tool discovery;
- uniquely named, idempotent, attributable test records in the dedicated dogfood project;
- bounded operational evidence and diagnostics;
- cleanup or reconciliation of dedicated test state when it improves the evidence.

Fresh operator approval remains required for effects outside the standing internal-dogfood grant, including material spend, secret exposure, access widening, external publication or contact, destructive non-test data changes, or irreversible work without recovery.

## Primary lane — #490 sustained-use incident

Own the failing journey rather than stopping at a connector screenshot or another plan.

1. start from one fresh authenticated conversation and unique run identity;
2. checkpoint GitHub reads and writes before Stensibly discovery;
3. execute the complete bounded Stensibly lifecycle;
4. checkpoint GitHub coexistence between lifecycle segments;
5. identify the first exact registry, routing, transport, server-completion, serialization, or result-delivery transition that fails;
6. preserve operation IDs, request IDs, session classifications, and typed errors without private payloads or secrets;
7. repair the responsible layer and add focused regression coverage;
8. redeploy when required, repeat the failing segment, then repeat the whole lifecycle;
9. disconnect, reconnect, and repeat again.

Only one worker should mutate the same dedicated lifecycle record at a time. Parallel #490 workers must use distinct run and idempotency identities.

## Supporting lanes

### Lane B — repair and regression coverage

Convert demonstrated #490 failures into bounded code changes covering, where evidence points:

- OAuth token refresh;
- MCP session and Streamable HTTP transport state;
- dynamic tool registration and executable binding;
- connector coexistence and conversation-level eviction;
- mutation response serialization and delivery;
- timeout, cancellation, retry, and ambiguity handling;
- generation fencing and stale-session rejection;
- server completion versus client result delivery;
- privacy-safe diagnostics.

### Lane C — GitHub-first execution and backlog accuracy

#491 owns the operating model. Keep every active task visible through a real issue or PR. Review, implementation, verification, repair, and handoff are activities inside delivery rather than waiting-only roles.

Keep #301, #24, and the relevant issue bodies synchronized with actual live evidence. Close genuinely complete or superseded work and preserve one exact next action for every active lane.

### Lane D — additive GitHub context integration

#492 owns stable GitHub issue identity, source revision, synchronization freshness, accepted instruction-set identity, degraded state, and deterministic reconciliation.

Reuse the existing project-attachment and context contracts from #217, #253, and #49. Do not create a second `STENSIBLY.md` parser, attachment snapshot, authority model, or context-packet system.

The hosted persistence path is now consolidated around:

```text
#909 source-only hosted Convex candidate
  + #912 executable admission controls
  → repaired current-main hosted persistence
  → #560 guarded public GitHub-context read
```

The first visible guarded feature chain remains:

```text
#149 causal event envelopes and sequence
  → #273 authorised external chat and runner surfaces
  → #403 attributable response thread
```

Use #403 as the first complete GitHub-first feature cycle after #490 and the bounded #492 context slice pass their gates.

## Work-selection rule

Prefer, in order:

1. reproduce or repair the exact #490 failure;
2. review and integrate active work that removes a real blocker;
3. keep GitHub instructions, queue, issues, PRs, and evidence accurate;
4. advance the smallest non-overlapping #492 contract or read-only integration slice;
5. advance the #149/#273/#403 feature chain without claiming sustained reliability already exists;
6. continue broader autonomy work only from reliable measured foundations.

When another worker owns the active Stensibly reproduction, use GitHub-only review, repair, implementation, or backlog work instead of creating overlapping mutations.

## Failure handling

When a step fails:

- identify the exact failing stage and responsible surface where possible;
- preserve bounded evidence and ambiguity identity;
- do not blindly replay a possible successful mutation;
- repair and redeploy when fix-forward is safe;
- use rollback only when the deployed state is materially worse or cannot be repaired safely in place;
- resume the failing segment and then repeat the complete journey;
- leave GitHub with the current fact, evidence, and one exact next action.

A failed dogfood attempt is useful product evidence. It is not a reason to retreat into indefinite disablement or documentation-only work.

## Immediate next actions

- Complete the active fresh-conversation #490 reproduction and record the first exact failure or full successful lifecycle.
- Absorb #912 or equivalent admission controls into #909, replay the repaired source fence onto current `main`, and integrate the hosted GitHub-context persistence boundary.
- Exercise an authenticated hosted `get_commit_combined_status` call through the guarded public path, preserve its attributable receipt, and use the read between #490 lifecycle segments.
- Recover the source-only checkpoint chronology and holder-authority repair from #875 into parent #659; retire the inert self-registering carrier instead of retrying it.

## Retrospective

After #490 passes, record:

- which layer caused each lost, rejected, or ambiguous call;
- whether GitHub remained usable throughout degradation;
- whether read-after-write reconciliation prevented duplicate effects;
- which instructions caused workers to ship versus stall;
- whether self-review preserved quality while reducing operator interruption;
- defects found only through sustained same-conversation use;
- duplicated or abandoned work;
- the next accepted, rejected, or no-change operating-instruction proposal under #293.
