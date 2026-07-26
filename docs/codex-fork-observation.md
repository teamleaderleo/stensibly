# Codex fork observation and experiment intake

## Status

This is a point-in-time observation, not a continuously updated statement about either repository.

```yaml
observed_at: "2026-07-26T02:08:00Z"
fork: teamleaderleo/codex
fork_branch: main
fork_head: 20dafe201d91d4405eef05ecd1db0257f13a9ac8
upstream: openai/codex
upstream_branch: main
upstream_head: 61a44880a85d2fd0d8770908dea5733495e571c8
merge_base: 20dafe201d91d4405eef05ecd1db0257f13a9ac8
ahead: 0
behind: 2
```

At the observation time, the connector returned no recent pull requests authored by the connected user in `teamleaderleo/codex`. The visible fork history matched upstream through the merge base.

The default branch therefore contains too little unique evidence to reconstruct the proposed-fix effort. This is an evidence boundary, not a conclusion that the work did not happen.

Possible locations for missing work include local commits, another branch or repository, deleted or force-moved refs, chat-generated documents, and uncommitted patch output.

## Relevant upstream movement

Recent upstream changes overlap Stensibly's orchestration concerns:

- completion events include item start times and subagent activity timing — `af7f6f4d346a71e78869f4c0e507160f921fffed`;
- paginated threads support bounded ephemeral forks — `1811b67a84952b8ebbd0605a0388e02a18453eb8`;
- network approval cancellation and concurrency handling were hardened — `63fe5a6b71d45dfff24a6a1e5da0699e054f145d`;
- remote execution connection setup gained tracing — `c3e926e61cb234fc180d8896bdb9655b58c3e735`.

These commits support preserving lifecycle timing, fork and resume lineage, cancellation ownership, and execution evidence. They do not reveal the user's proposed fix.

## Evidence intake

Import the proposed-fix effort as an execution trace. Minimum useful inputs:

1. diagnosis, plan, implementation, review, and handoff documents;
2. relevant branch and commit references;
3. diffs or patches;
4. test commands and results;
5. authorised conversation exports;
6. agent identities or roles;
7. timestamps;
8. user corrections and decisions;
9. final outcome and abandoned approaches;
10. related upstream issues or proposals.

### Mandatory privacy gate

No artifact enters durable trace storage until all of these checks pass:

- the importing actor is authorised for the source and target project;
- secrets, credentials, unrelated personal data, and disallowed content are removed;
- an access class and allowed-reader set are assigned;
- a retention class and deletion rule are recorded;
- the sanitised content receives a digest;
- provenance records the source, observation time, and transformations;
- deletion can propagate to derived indexes, summaries, and caches where required.

Raw transcripts should remain ephemeral by default. Store the smallest authorised excerpt or derived summary that supports the trace claim.

Each accepted artifact receives:

- stable reference;
- source repository or conversation;
- observed timestamp;
- sanitised-content digest;
- relation to task, run, checkpoint, decision, or commit;
- access, retention, and deletion classes;
- transformation history.

## Trace reconstruction

Segment the history into:

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

- What problem was each worker trying to solve?
- Which facts were verified?
- Which assumptions remained speculative?
- Where did scope expand?
- Which commits correspond to which decisions?
- Which work was duplicated?
- Where did workers disagree or stall?
- Which checkpoints would have reduced recovery cost?
- How much human review did each output require?
- Which findings belong in Codex, Stensibly, or operating practice?

## Experiment record

```yaml
experiment:
  name: "Codex proposed-fix coordination review"
  status: awaiting_evidence
  observed_at: "2026-07-26T02:08:00Z"
  evidence_complete: false

  repository: teamleaderleo/codex
  source_branch: null
  source_commits: []
  source_documents: []
  source_conversations: []

  privacy:
    authorization_confirmed: false
    sanitization_complete: false
    access_class: null
    retention_class: null

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

The record cannot advance from `awaiting_evidence` until evidence and privacy gates are complete.

## Improvement candidate lifecycle

Every proposed improvement links to trace evidence and defines a measurable validation plan.

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
    - name: recovery_time_minutes
      baseline: awaiting_evidence
      target: ">=20% below baseline median"
      direction: decrease
      measurement_method: "minutes from replacement assignment to first verified forward progress"
      comparison_window: "five comparable recoveries before and five after"

    - name: repeated_work_count
      baseline: awaiting_evidence
      target: ">=30% below baseline mean"
      direction: decrease
      measurement_method: "count repeated repository reads, reproductions, or edits already captured by the accepted checkpoint"
      comparison_window: "five comparable interrupted runs before and five after"

    - name: continuity_score
      baseline: awaiting_evidence
      target: ">=0.15 absolute increase"
      direction: increase
      measurement_method: "0-1 rubric covering objective, repository state, tests, decisions, remaining work, and next action"
      comparison_window: "ten continuation packages before and ten after"
```

Targets are provisional until the evidence set supplies baselines and comparable run classes.

Keep product and process changes separate:

- **product** — Codex, Stensibly, tools, interfaces, or runtime behaviour;
- **process** — estimating, dividing, executing, verifying, reviewing, communicating, or resuming work.

## Next evidence step

After authorization and sanitization, import the existing Markdown, commit references, patches, tests, and relevant conversation excerpts into one Stensibly experiment record. Then produce a trace review whose claims link directly to accepted evidence.
