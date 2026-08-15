# Broad mail continuation selection

Refs #1488 and #1493.

This is the read-only fresh-chat path for prompts such as:

- `Take my oldest actionable Stensibly handoff.`
- `Take my highest-value eligible Stensibly review.`
- `Read the latest Stensibly digest and continue one useful lane.`

The selector treats Gmail as a bounded checkpoint index. Current disposition can come from the strongest current evidence, while a GitHub reread newer than the mail checkpoint remains a mandatory pre-action guard. Mail carries continuation and zero repository authority.

## Bounded Gmail discovery

Start from small Stensibly surfaces instead of the mailbox at large. Search message metadata/snippets first; defer full bodies.

```text
in:inbox subject:"[STN-" -in:trash -in:spam
label:Stensibly subject:"[STN-" -in:trash -in:spam
```

Use a small result cap for each query, merge by provider message identity, extract the stable `STN-*` handle, and keep only the newest checkpoint per handle. Drafts are human workspaces and stay outside routine selection.

Archived messages may remain searchable or labeled. A current disposition must classify the newest checkpoint as `actionable` or `stranded` before it is selectable, so archived history alone never becomes operator work.

For a requested class, filter after newest-handle collapse. `oldest_actionable_handoff` admits handoffs; `highest_value_eligible_review` admits reviews; `useful_lane` admits all four attention classes.

## Current-evidence gate

Before fetching any candidate body, record current evidence newer than the mail checkpoint and a GitHub reread newer than that checkpoint:

```text
actionable  current executable action exists
stranded    unresolved executable recovery exists after the quiet threshold
waiting     external prerequisite or another owner must move first
resolved    checkpoint resolution already exists in current evidence
superseded  a newer lane/current outcome replaced this checkpoint
unknown     current evidence cannot classify safely
```

`actionable` and `stranded` are eligible. The other dispositions stay out of action selection. A stale disposition readback is rejected. A stale GitHub readback is rejected independently, even when Gmail or another current source proves the disposition.

This separation is important for provider-oriented handoffs. A Gmail-thread verification can become `resolved` because current Gmail evidence satisfies its resolution condition, while the worker still refreshes the referenced GitHub issue/PR before taking that provider action.

Only after deterministic selection does the worker fetch the selected Gmail body. `selectedNeedsBodyFetch` remains true until that happens. `readyForAction` becomes true only when the selected body has been fetched. If the body reveals a stricter or different current source than the metadata/readback used for selection, refresh that source and GitHub again before acting.

## Deterministic ordering

`oldest_actionable_handoff` chooses the earliest `actionableAt` among eligible handoffs, with handle/message identity as the stable tie break.

`highest_value_eligible_review` orders current value `urgent > high > normal > low`, then stranded ahead of equally valued fresh work, then oldest actionable time, then stable identity.

`useful_lane` uses the same value ordering, then attention class `incident > decision > review > handoff`, then stranded ahead of equally ranked fresh work, then age and stable identity.

A digest email is optional. If a bounded search finds no persisted Stensibly digest, compile the same read-only useful-lane projection from current material checkpoints; keep the mailbox-wide history outside the query.

## Live Gmail dogfood — 2026-08-15

The connected mailbox had roughly nine thousand Inbox messages, while the Stensibly label surfaces were tens of messages. Label membership changed during the run as concurrent mail lanes advanced, so provider labels are discovery views and the selector refreshes them.

The final label refresh returned 17 messages / 7 threads under `Stensibly` and 9 messages / 2 threads under `Stensibly/Handoffs`. A separate bounded Inbox query then surfaced a new two-message `STN-HANDOFF:6X7N` thread that arrived during this implementation pass and had not yet been moved into the Stensibly view.

Current checkpoint outcomes after source refresh and dogfood action:

- `STN-HANDOFF:K8R4` — `waiting`: the source-first fresh-chat relay is accepted; native GitHub reply-by-email remains blocked until an authentic GitHub notification reaches the canonical Gmail mailbox. Its newest Gmail reply contains recursive quoted ancestry, so rejecting it before body fetch saves substantial context.
- `STN-HANDOFF:Q7MP` — `superseded`: the compact exact-handle UX slice merged and this work moved to the broader-entrypoint lane.
- `STN-HANDOFF:6X7N` — `resolved`: it arrived live during the run. After refreshing #1492 and draft PR #1497, the selected body asked only to verify exact-handle search returned the root plus material update in one Gmail provider thread. The bounded search had both message IDs under thread `1a0042906fe7ad02`, satisfying the checkpoint resolution.
- `STN-REVIEW:7K3R` — `resolved`: GitHub already contains the exact repository-facing comment proposed by the Gmail message.
- `STN-REVIEW:R7MK` — `actionable`, high value: PR #1487 remains open/draft at `11273c03a9726ed67be392ebe72763b4453cd2af`, diverged from refreshed main by 10 ahead / 4 behind, and its exact-head CI failed in the Bun-test step. The useful action is inspect the failing evidence and repair/rebase before any land decision.

No persisted `Stensibly digest` message existed in the mailbox during this run. The useful-lane fallback therefore selects the R7MK repair from current checkpoint evidence.

Observed broad-entrypoint results:

```text
oldest actionable handoff       -> STN-HANDOFF:6X7N when it raced into Inbox
                                  -> one useful verification action; now resolved
                                  -> immediate rerun selects none
highest-value eligible review   -> STN-REVIEW:R7MK
digest/useful-lane fallback     -> STN-REVIEW:R7MK
```

Independent useful-action costs from the live run:

```text
entrypoint                       body messages   body bytes   turns   wrong selections
oldest actionable handoff       1               1,665        1       0
highest-value eligible review   1               1,318        1       0
digest/useful-lane fallback     1               1,318        1       0
```

The 1,665-byte handoff body included quoted ancestry; after its resolution, future selection rejects it before any body fetch. Search metadata/snippets are index results and are tracked separately from full-body context bytes.

## Fence

This module is a pure read-only projection. It performs zero Gmail mutation, GitHub mutation, responsibility acceptance, approval, merge, deploy, or other provider effect. Provider operations continue through their existing current-state and authority paths.
