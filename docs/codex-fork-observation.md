# Codex fork observation and experiment intake

## Status

Observed from the GitHub-visible state of `teamleaderleo/codex` on 2026-07-26.

This note records what can be established from the connected repository and what evidence still needs to be imported before drawing conclusions about the proposed Codex fix.

## Visible repository state

The fork's default branch is `main`.

At the time of observation:

- `teamleaderleo/codex:main` was **0 commits ahead** and **1 commit behind** `openai/codex:main`;
- the merge base was commit `20dafe201d91d4405eef05ecd1db0257f13a9ac8`;
- the fork exposed no recent pull requests authored by the connected user;
- the visible default-branch history was the upstream Codex history.

The GitHub-visible `main` branch therefore does not contain enough unique evidence to reconstruct the proposed-fix effort.

Possible locations for the missing work include:

- local commits that were never pushed;
- a non-default branch that is no longer visible through the current connector view;
- deleted or force-moved branches;
- chat-generated Markdown stored outside the fork;
- commits in another repository;
- patch output that was produced but never committed.

This is a boundary on the current observation, not a conclusion that the work did not happen.

## Relevant upstream movement

Recent visible upstream commits include work that overlaps with Stensibly's orchestration concerns:

- item start times added to completion events, including subagent activity lifecycles;
- ephemeral forks of paginated threads;
- strengthened cancellation, concurrency, and stale-owner handling;
- tracing around remote execution setup.

These changes reinforce the value of preserving lifecycle timing, fork/resume lineage, cancellation ownership, and execution evidence in Stensibly's runner model.

They do not reveal the content of the user's proposed fix.

## Evidence intake for the Codex experiment

The proposed-fix effort should be imported as an execution trace.

Minimum useful inputs:

1. Markdown documents produced during diagnosis, planning, implementation, review, or handoff.
2. Every relevant branch and commit SHA.
3. Diff or patch output.
4. Test commands and results.
5. Chat histories or exported transcripts.
6. Agent identities or roles.
7. Timestamps where available.
8. User corrections and decisions.
9. Final outcome, including abandoned approaches.
10. Any upstream issue or proposal the fix addresses.

Each artifact should receive:

- stable reference;
- source repository or conversation;
- observed timestamp;
- content digest where practical;
- relation to task, run, checkpoint, decision, or commit;
- confidentiality and retention class.

## Trace reconstruction

The history should be segmented into:

```text
request
-> interpretation
-> diagnosis
-> plan
-> implementation attempt
-> test
-> correction
-> review
-> handoff or completion
-> user evaluation
```

The reconstruction should answer:

- What problem was each agent trying to solve?
- Which facts were verified?
- Which assumptions remained speculative?
- Where did scope expand?
- Which commits correspond to which decisions?
- Which work was duplicated?
- Which agents disagreed?
- Where did progress stall?
- Which checkpoints would have made recovery cheaper?
- How much human review did each output require?
- Which Codex changes are product improvements?
- Which lessons belong in Stensibly's orchestration policy?

## Proposed experiment record

```yaml
experiment:
  name: "Codex proposed-fix coordination review"
  repository: "teamleaderleo/codex"
  source_branch: null
  source_commits: []
  source_documents: []
  source_conversations: []

objectives:
  - reconstruct the diagnostic and implementation sequence
  - evaluate multi-agent division of labour
  - measure scope, timing, continuity, and verification quality
  - identify Codex product improvements
  - identify Stensibly process improvements

outputs:
  - timeline
  - task and agent map
  - commit-to-decision map
  - failure and recovery analysis
  - accepted findings
  - rejected hypotheses
  - product improvement candidates
  - orchestration improvement candidates
  - issue drafts
```

## Improvement candidate lifecycle

Every proposed improvement should link back to trace evidence.

```yaml
title: "Require a verified checkpoint before long-run continuation"

source:
  experiment: "Codex proposed-fix coordination review"
  evidence:
    - repeated repository-state reconstruction
    - missing test state after interruption

proposal:
  change: "Persist a checkpoint after each major verification phase"
  expected_benefits:
    - cheaper recovery
    - fewer repeated tool calls
    - clearer completion state

validation:
  experiment_required: true
  success_metrics:
    - recovery time
    - repeated-work count
    - continuity score
```

Product-level and process-level improvements should remain separate:

- **Product-level** — changes to Codex, Stensibly, tools, prompts, interfaces, or runtime behaviour.
- **Process-level** — changes to estimating, dividing, executing, verifying, reviewing, communicating, or resuming work.

## Next evidence step

Import the existing Markdown, commit references, and chat histories into one Stensibly project attachment or experiment record. Once those sources are present, produce a trace review whose claims link directly to documents, commits, tests, and conversation events.
