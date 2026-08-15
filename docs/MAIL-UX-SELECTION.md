# Broad mail continuation selection

Refs #1488 and #1493.

This is the read-only fresh-chat path for prompts such as:

- `Take my oldest actionable Stensibly handoff.`
- `Take my highest-value eligible Stensibly review.`
- `Read the latest Stensibly digest and continue one useful lane.`

The selector treats Gmail as a bounded checkpoint index and GitHub as the source that must be refreshed before a checkpoint can become eligible. Mail never authorizes a repository operation.

## Bounded Gmail discovery

Start from small Stensibly surfaces instead of the mailbox at large. Search message metadata/snippets first; defer full bodies.

```text
in:inbox subject:"[STN-" -in:trash -in:spam
label:Stensibly subject:"[STN-" -in:trash -in:spam
```

Use a small result cap for each query, merge by provider message identity, extract the stable `STN-*` handle, and keep only the newest checkpoint per handle. Drafts are human workspaces and do not enter routine selection.

Archived messages may remain searchable or labeled. They do not become operator work merely because they exist: a current GitHub reread must classify the newest checkpoint as `actionable` or `stranded` before it is selectable.

For a requested class, filter after newest-handle collapse. `oldest_actionable_handoff` admits handoffs; `highest_value_eligible_review` admits reviews; `useful_lane` admits all four attention classes.

## Current-source gate

Before fetching any candidate body, reread the checkpoint's referenced GitHub object and record a bounded readback newer than the mail checkpoint:

```text
actionable  current executable action exists
stranded    unresolved executable recovery exists after the quiet threshold
waiting     external prerequisite or another owner must move first
resolved    resolution already exists in current GitHub state
superseded  a newer lane/current outcome replaced this checkpoint
unknown     current evidence cannot classify safely
```

`actionable` and `stranded` are eligible. The other dispositions stay out of action selection. A source readback older than the mail checkpoint is rejected.

Only after deterministic selection does the worker fetch the selected Gmail body. `selectedNeedsBodyFetch` remains true until that happens. `readyForAction` becomes true only when the selected body has been fetched. If the body reveals a stricter or different current source than the metadata/readback used for selection, reread GitHub again before acting.

## Deterministic ordering

`oldest_actionable_handoff` chooses the earliest `actionableAt` among eligible handoffs, with handle/message identity as the stable tie break.

`highest_value_eligible_review` orders current value `urgent > high > normal > low`, then stranded ahead of equally valued fresh work, then oldest actionable time, then stable identity.

`useful_lane` uses the same value ordering, then attention class `incident > decision > review > handoff`, then stranded ahead of equally ranked fresh work, then age and stable identity.

A digest email is optional. If a bounded search finds no persisted Stensibly digest, compile the same read-only useful-lane projection from current material checkpoints; do not expand the mailbox merely to manufacture a digest.

## Live Gmail dogfood — 2026-08-15

The connected mailbox had roughly nine thousand Inbox messages, while the Stensibly label surfaces were tens of messages. The labels also changed during the run as another lane advanced mail, so provider label membership is treated as a discovery view rather than durable work state.

Current checkpoint outcomes after GitHub reread:

- `STN-HANDOFF:K8R4` — `waiting`: the source-first fresh-chat relay is accepted; native GitHub reply-by-email remains blocked until an authentic GitHub notification reaches the canonical Gmail mailbox. Its newest Gmail reply contains recursive quoted ancestry, so rejecting it before body fetch saves substantial context.
- `STN-HANDOFF:Q7MP` — `superseded`: the compact exact-handle UX slice merged and this work moved to the broader-entrypoint lane.
- `STN-REVIEW:7K3R` — `resolved`: GitHub already contains the exact repository-facing comment proposed by the Gmail message.
- `STN-REVIEW:R7MK` — `actionable`, high value: PR #1487 remains open/draft at `11273c03a9726ed67be392ebe72763b4453cd2af`, diverged from current main by 10 ahead / 3 behind in the observed comparison, and its exact-head CI failed in the Bun-test step. The useful action is inspect the failing evidence and repair/rebase before any land decision.

No persisted `Stensibly digest` message existed in the mailbox during this run. The useful-lane fallback therefore selects the same R7MK repair from the current checkpoint set.

Observed broad-entrypoint results:

```text
oldest actionable handoff       -> none
highest-value eligible review   -> STN-REVIEW:R7MK
digest/useful-lane fallback     -> STN-REVIEW:R7MK
```

For the selected review, full-body retrieval cost is one Gmail message and 1,318 UTF-8 body bytes. The broad prompt reaches a useful current-source action in one turn and produced zero wrong selections in this dogfood run. Search metadata/snippets are index results and are tracked separately from full-body context bytes.

## Fence

This module is a pure read-only projection. It performs no Gmail mutation, GitHub mutation, responsibility acceptance, approval, merge, deploy, or other provider effect. Provider operations still require their existing current-state and authority paths.
