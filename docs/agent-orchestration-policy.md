# Agent orchestration policy

## Status

This document records a proposed orchestration policy for Stensibly. It is a product and execution design, not a claim that every mechanism described here already exists.

The policy sits above the current run, continuation, checkpoint, runner-adapter, and portfolio work. It defines how those pieces should combine when one person supervises many long-running agent tasks across several projects.

Related work:

- [#45 — Build the supervisory orchestration loop](https://github.com/teamleaderleo/stensibly/issues/45)
- [#47 — Add a durable supervisor dispatcher and run lifecycle](https://github.com/teamleaderleo/stensibly/issues/47)
- [#49 — Add active context packets and historical retention](https://github.com/teamleaderleo/stensibly/issues/49)
- [#50 — Add runner adapters for Hermes, OpenClaw, Codex, and generic MCP agents](https://github.com/teamleaderleo/stensibly/issues/50)
- [#51 — Add portfolio goals and cross-project supervision](https://github.com/teamleaderleo/stensibly/issues/51)
- [#69 — Add durable continuation proposals and human-approved resume flows](https://github.com/teamleaderleo/stensibly/issues/69)
- [#157 — Define retry, deadline, and escalation budgets as first-class policy](https://github.com/teamleaderleo/stensibly/issues/157)
- [#180 — Define run checkpoint consistency and resume ownership](https://github.com/teamleaderleo/stensibly/issues/180)

## Governing idea

> Keep shared-context groups small, permit broad portfolio parallelism, and throttle completed work according to human review capacity.

A project may remain alive for months. A task group should form around one objective, leave a durable result, and dissolve. An individual agent turn should have an explicit execution envelope, checkpoints, and a recovery path.

Stensibly should distinguish three different counts:

1. **Portfolio projects** — every project retained in the ledger.
2. **Foreground projects** — projects receiving active human attention.
3. **Live task groups** — work currently executing or producing a near-term review obligation.

“Ongoing” means resumable. “Running” means consuming execution, message, tool, review, or decision capacity.

## Per-message execution envelopes

Every substantial agent turn should receive an execution envelope before work begins.

An envelope should record:

- objective;
- scope class;
- required outputs;
- expected duration range;
- estimate confidence;
- soft-checkpoint boundary;
- forced-handoff boundary;
- hard-recovery boundary;
- completion conditions;
- verification requirements;
- continuation-state requirements;
- estimated review effort;
- expected message and tool budget.

Example:

```yaml
objective: "Implement and test the account settings flow"
scope_class: segmented

estimate:
  low_minutes: 35
  likely_minutes: 65
  high_minutes: 95
  confidence: 0.58

execution:
  soft_checkpoint_minutes: 75
  forced_handoff_minutes: 105
  hard_recovery_minutes: 120
  expected_messages: 3
  expected_review_minutes: 12

completion:
  required_outputs:
    - working implementation
    - tests
    - changed-file summary
  verification_required: true
  continuation_state_required: true
```

Duration should be a range. A single number hides uncertainty and encourages false precision.

### Task classes

- **Atomic** — intended to complete in one turn.
- **Segmented** — several independently useful phases.
- **Exploratory** — discovery first, revised plan second.
- **Long-running** — expected to cross one or more checkpoints.
- **Portfolio** — coordinates work across projects.
- **Review** — verifies, compares, or integrates earlier outputs.

The useful decomposition unit is the smallest independently verifiable result.

## Task success

Elapsed time alone gives a weak success signal. Stensibly should preserve separate result dimensions:

1. **Outcome** — the requested result exists.
2. **Scope** — the run stayed within its intended boundary or recorded an approved expansion.
3. **Calibration** — actual duration and effort fit the estimated range.
4. **Continuity** — a later turn can resume from durable state.
5. **Verification** — important claims, tests, and artifacts were checked.
6. **User value** — the work advanced the project, clarified the problem, produced learning, or created a useful artifact.
7. **Review cost** — the result arrived in a form the human could evaluate without reconstructing the run.

These dimensions should remain inspectable. Some may become hard gates for consequential work.

A long task can succeed with strong output and a clean handoff. A shorter task can fail through ambiguity, missing evidence, or an unusable continuation state.

## Checkpoint, handoff, and recovery boundaries

### Soft checkpoint

Before the risky tail of a long run, record:

- completed work;
- remaining work;
- current blockers;
- changed files or artifacts;
- tests run and results;
- latest verified state;
- next exact action;
- revised completion estimate;
- confidence that the current turn can finish.

The run may continue.

### Forced handoff

Near the upper execution bound, bias toward one of two outcomes:

1. finish the smallest coherent deliverable; or
2. produce a continuation package.

This gives the worker a legitimate exit point before it spends the remaining turn searching for a perfect stopping point.

### Hard recovery

At the hard cap, create or queue a recovery turn from the latest accepted checkpoint.

A recovery prompt should require the new worker to verify current repository and artifact state before continuing. Recovery must preserve the original objective, completed work, remaining work, known failures, decisions, evidence, and next action.

Checkpoint selection and resume authority remain governed by the run-generation rules in #180.

## Execution ledger and estimate calibration

For each task, retain both estimate and actual execution facts.

```yaml
task_category: implementation

estimate:
  minutes: [40, 70]
  confidence: 0.62
  expected_files: 6
  expected_messages: 3

actual:
  minutes: 84
  files_changed: 14
  messages_consumed: 4
  tool_calls: 47
  interruptions: 1

result:
  completed: true
  user_accepted: true
  continuation_needed: false

estimate_error_reasons:
  - hidden dependency
  - broader test failures
```

Candidate calibration inputs include:

- task category;
- repository size and familiarity;
- expected and actual files changed;
- test-suite duration;
- dependency count;
- group size;
- external research;
- prior failures;
- runner profile;
- tool-call count;
- review cycles;
- user interventions.

Calibration should eventually recommend:

- duration range;
- confidence;
- task class;
- checkpoint timing;
- group size;
- review effort;
- likely failure modes.

## Detecting low progress

Elapsed time becomes useful when combined with evidence of progress.

Candidate signals:

- repeated reads or searches over the same material;
- repeated reproduction of the same failure;
- continuously expanding file scope;
- repeated reversal of the same decision;
- remaining-work estimates staying flat;
- tool-call volume rising while verified completion stays unchanged;
- long periods without an accepted checkpoint or artifact;
- conflicting claims between checkpoints.

A simple derived signal is:

```text
progress_velocity =
  verified_completion_gained
  / elapsed_execution_time
```

A sustained drop can trigger reassessment, scope reduction, independent review, checkpointing, handoff, or recovery.

The trigger should preserve its evidence and remain explainable.

## Temporary task groups

A task group is a small, temporary team formed around one shared deliverable.

Suggested defaults:

- **2 agents** — builder and reviewer.
- **3 agents** — discovery, execution, synthesis.
- **4 agents** — lead, implementer, tester, reviewer.
- **5 agents** — lead, three specialists, integrator.
- **6 agents** — suitable when the work divides cleanly.
- **Above 6** — split into cells with a coordinator or liaison.

The important count is the number of agents that must understand and reconcile one another’s work.

Independent searches can run as a broad batch. Shared editing, joint design, and mutual revision require a compact shared context.

Each group should have:

- one objective;
- explicit member roles;
- one output per member;
- one shared deliverable;
- an integration owner;
- recorded disagreements;
- a continuation package;
- a dissolution condition.

Example:

```yaml
objective: "Produce one tested implementation"

members:
  - role: lead
    output: plan and final synthesis
  - role: implementer
    output: code changes
  - role: tester
    output: tests and failure report
  - role: reviewer
    output: independent defect review

completion:
  shared_artifact_required: true
  unresolved_disagreements_recorded: true
  continuation_package_required: true
  dissolve_after_completion: true
```

Task groups are execution units. Projects and their histories remain durable after the group dissolves.

## Portfolio and foreground limits

A useful starting policy:

```yaml
portfolio:
  total_projects: 12-30
  foreground_projects: 3
  warm_projects: 3-5
  remaining_projects: parked

execution:
  task_groups_per_foreground_project: 1
  normal_group_size: 3-5
  live_long_running_tasks: 8
  hard_live_task_cap: 12

review:
  ready_item_cap: 3
  high_decision_item_cap: 1
```

These are initial defaults and future calibration targets.

Parked projects retain goals, next actions, dependencies, evidence, and continuation packets. Promotion into the foreground should be explicit and explainable.

## Message and interaction budgets

Message capacity is a portfolio resource. It should be budgeted alongside runner concurrency, tool use, review effort, and human decisions.

Budget classes:

- foreground project work;
- background exploration;
- review and integration;
- recovery and retries;
- spontaneous human conversation;
- untouched reserve.

Example:

```yaml
rolling_window:
  observed_maximum_messages: 160
  usable_messages: 128

allocation:
  foreground_projects: 96
  background_exploration: 16
  review_and_recovery: 16
  untouched_reserve: 32
```

The observed maximum is an input, not a promise. The scheduler should adapt to real platform behaviour and avoid exhausting the full envelope during normal operation.

Unused project allowance can return to a shared pool. Budgets should operate over rolling windows and record overruns with reasons.

## Completion fan-in

Many long-running tasks can execute concurrently because one launch message may occupy a worker for a long period. The human bottleneck appears when several results finish together.

Stensibly should track:

- expected completion time;
- estimate confidence;
- review effort;
- decision burden;
- dependency on human input;
- artifact size;
- unresolved questions.

Completed work beyond the review cap should enter `completed_awaiting_review`. Scheduling should stagger likely completion times where practical.

Execution capacity and review capacity are separate controls.

## Codex and ChatGPT runner implications

Codex and ChatGPT chats should be treated as disposable execution contexts with durable state outside the chat.

A runner adapter should preserve:

- session or thread reference where the host permits it;
- objective and execution envelope;
- current run and fence generation;
- accepted checkpoints;
- artifacts and commit references;
- tests and verification evidence;
- next action;
- continuation instruction;
- message-budget consumption;
- review estimate.

A chat ending, timing out, becoming unavailable, or reaching a platform limit should create a recoverable run state instead of an orphaned project state.

## Recommended initial defaults

```yaml
foreground_projects: 3

task_group_size:
  minimum: 2
  default: 4
  split_above: 6

live_tasks:
  normal: 8
  maximum: 12

review_queue:
  ready_items: 3
  high_decision_items: 1

message_budget:
  usable_fraction: 0.80
  reserve_fraction: 0.20

execution:
  duration_ranges: true
  long_task_checkpoints: true
  continuation_packages: true
  stagger_expected_completions: true
```

These defaults should begin as policy, then become evidence-backed recommendations.

## Open questions

- Which success dimensions should become hard gates?
- How should completion percentage be estimated?
- Which checkpoint fields belong in canonical records?
- Which work can continue speculatively after authority loss?
- How should group integration responsibility be fenced?
- How should message budgets adapt to changing platform limits?
- How should the scheduler estimate review effort?
- Which tasks benefit from parallel workers?
- Which tasks benefit from sequential handoffs?
- How should useful exploration be distinguished from drift?
- How should unfinished tasks age and return to the foreground?
- Which chat-history content requires redaction before analysis?
