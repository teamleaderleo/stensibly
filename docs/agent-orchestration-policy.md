# Agent orchestration policy

## Status

This document proposes an orchestration policy for Stensibly. It defines product and execution contracts; it does not imply that every mechanism already exists.

Related work includes #45, #47, #49, #50, #51, #69, #157, and #180.

## Governing principles

1. Keep shared-context groups small.
2. Permit broad portfolio parallelism only when work remains independently verifiable.
3. Treat human review and decisions as separate capacity constraints.
4. Persist enough state to resume without reconstructing a chat.
5. Fence every ownership transfer, recovery, and write-producing continuation.
6. Preserve evidence for estimates, decisions, verification, and policy actions.
7. Store only authorised, sanitised durable content.

A project may remain active for months. A task group should form around one objective, produce a durable result or continuation package, and dissolve.

Stensibly should distinguish:

- **portfolio projects** — every retained project;
- **foreground projects** — projects receiving active human attention;
- **live task groups** — groups consuming execution or near-term review capacity;
- **review-ready items** — completed results waiting for human evaluation.

“Ongoing” means resumable. “Running” means consuming execution, message, tool, review, or decision capacity.

## Canonical execution envelope

Every substantial turn should receive one versioned execution envelope before work begins. This is the canonical field layout for policy, storage, runner adapters, and examples.

```yaml
execution_envelope:
  schema_version: 1
  objective: "Implement and test the account settings flow"
  scope_class: segmented

  estimate:
    low_minutes: 35
    likely_minutes: 65
    high_minutes: 95
    confidence: 0.58

  budget:
    expected_messages: 3
    expected_tool_calls: 40
    expected_review_minutes: 12

  boundaries:
    soft_checkpoint_minutes: 75
    forced_handoff_minutes: 105
    hard_recovery_minutes: 120

  completion:
    required_outputs:
      - working implementation
      - tests
      - changed-file summary
    verification_required: true
    continuation_state_required: true
    acceptance_checks:
      - targeted tests pass
      - changed files match the declared scope

  durable_state:
    access_class: project
    retention_class: standard
    redaction_required: true
    delete_after: null
```

Duration uses a range because a single number hides uncertainty. `low_minutes <= likely_minutes <= high_minutes` must hold. Budget values are forecasts, not permission to consume the full amount.

### Scope classes

- **atomic** — intended to complete in one turn;
- **segmented** — several independently useful phases;
- **exploratory** — discovery first, revised plan second;
- **long-running** — expected to cross checkpoints;
- **portfolio** — coordinates work across projects;
- **review** — verifies, compares, or integrates prior outputs.

The preferred decomposition unit is the smallest independently verifiable result.

## Task success

Retain separate success dimensions:

1. **Outcome** — the requested result exists.
2. **Scope** — work stayed within its boundary or recorded an approved expansion.
3. **Calibration** — actual effort is compared with the estimate.
4. **Continuity** — durable state permits a later turn to resume.
5. **Verification** — important claims and artifacts were checked.
6. **User value** — the work advanced the project or clarified the problem.
7. **Review cost** — the result can be evaluated without reconstructing the run.
8. **Policy compliance** — authority, privacy, and retention controls were followed.

These dimensions remain inspectable even when only some are hard gates.

## Checkpoint, handoff, and recovery

### Soft checkpoint

Before the risky tail of a run, record:

- completed and remaining work;
- blockers and unresolved decisions;
- changed files or artifacts;
- tests and results;
- latest verified repository state;
- next exact action;
- revised estimate and confidence;
- current run and fence generation.

The current worker may continue while its authority remains live.

### Forced handoff

Near the upper execution bound, finish the smallest coherent deliverable or produce a continuation package containing the accepted checkpoint, evidence, remaining work, and exact next action.

### Hard recovery

Recovery is an ownership transfer, not a second concurrent worker.

1. Compare-and-swap the run from its current holder and generation into a new recovery generation.
2. If the compare-and-swap fails, do not queue a replacement; another authority change already won.
3. On success, invalidate the prior worker credential and generation.
4. Require every subsequent state write, artifact registration, and commit association to carry the live generation.
5. Reject stale writes from the previous worker.
6. Only then queue recovery from the latest accepted checkpoint.

The replacement must verify current repository and artifact state before continuing. Checkpoint selection and resume authority remain governed by #180.

## Execution records and estimate calibration

Store the envelope unchanged and append actual results rather than rewriting the original estimate.

```yaml
execution_record:
  envelope_ref: env_123

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

Calibration inputs may include task class, repository familiarity, file count, test duration, dependency count, group size, external research, prior failures, runner profile, tool calls, review cycles, and user interventions.

Calibration should recommend an estimate range, confidence, checkpoint timing, group size, review effort, and likely failure modes. Recommendations must retain their evidence and sample size.

## Detecting low progress

Candidate signals include:

- repeated reads over the same material;
- repeated reproduction of one failure;
- continuously expanding file scope;
- repeated reversal of one decision;
- flat remaining-work estimates;
- rising tool volume without verified completion;
- long periods without an accepted checkpoint;
- conflicting claims between checkpoints.

A derived signal may be recorded as:

```text
progress_velocity = verified_completion_gained / elapsed_execution_time
```

A sustained drop can trigger reassessment, scope reduction, independent review, checkpointing, handoff, or fenced recovery. The trigger must preserve its evidence and remain explainable.

## Temporary task groups

A task group is a small team formed around one shared deliverable.

Suggested starting sizes:

- **2** — builder and reviewer;
- **3** — discovery, execution, synthesis;
- **4** — lead, implementer, tester, reviewer;
- **5** — lead, specialists, integrator;
- **6** — only when work divides cleanly;
- **above 6** — split into cells with explicit integration ownership.

Each group requires one objective, explicit roles, one output per member, one integration owner, recorded disagreements, a continuation package, and a dissolution condition.

Independent research can use a broad batch. Shared editing and joint design require a compact shared context.

## Portfolio, execution, and review limits

Initial policy defaults:

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

These values are experiment defaults, not universal limits. Promotion into the foreground should be explicit and explainable. Parked projects retain goals, dependencies, evidence, next actions, and continuation packets.

## Message and interaction budgets

Message capacity is a portfolio resource alongside runner concurrency, tool use, review effort, and human decisions.

Budget classes remain independently attributable:

- foreground project work;
- background exploration;
- review and integration;
- recovery and retries;
- spontaneous human conversation;
- untouched reserve.

```yaml
rolling_window:
  observed_maximum_messages: 160
  usable_messages: 128

allocation:
  foreground_projects: 80
  background_exploration: 12
  review_and_integration: 16
  recovery_and_retries: 8
  spontaneous_human_conversation: 12

untouched_reserve: 32
```

The observed maximum is an input, not a platform promise. The scheduler should adapt to observed behaviour, preserve the reserve, and record overruns by class and reason.

## Completion fan-in

Execution capacity and review capacity are separate controls. Stensibly should track expected completion time, confidence, review effort, decision burden, human dependency, artifact size, and unresolved questions.

Completed work beyond the review cap enters `completed_awaiting_review`. Scheduling should stagger likely completion times where practical.

## Runner durable-state contract

Chat sessions are disposable execution contexts. Durable state belongs in Stensibly and should preserve:

- runner and session references where permitted;
- objective and execution envelope;
- live run and fence generation;
- accepted checkpoints;
- sanitised artifact and commit references;
- verification evidence;
- next action and continuation instruction;
- budget consumption and review estimate.

Before durable storage, every imported transcript, attachment, artifact, or generated summary must pass:

1. **authorization** — the actor may persist it into the target project;
2. **sanitization** — secrets, credentials, unrelated personal data, and disallowed content are removed;
3. **access classification** — readers are explicitly bounded;
4. **retention classification** — a retention period or durable exception is recorded;
5. **deletion handling** — removal propagates to derived indexes and cached copies where required;
6. **provenance** — source, timestamp, digest, and transformation history are retained.

Raw chat history should remain ephemeral by default. A run ending, timing out, or reaching a host limit should create recoverable state rather than orphaning project work.

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
  fenced_recovery: true
  continuation_packages: true
  stagger_expected_completions: true
```

These defaults should begin as explicit policy and become evidence-backed recommendations.

## Open decisions

- Which success dimensions become hard gates?
- How is verified completion estimated?
- Which checkpoint fields become canonical records?
- Which work may continue after authority loss?
- How is group integration ownership fenced?
- How should budgets adapt to changing host limits?
- How is review effort estimated?
- Which tasks benefit from parallel workers versus sequential handoffs?
- How is useful exploration distinguished from drift?
- How should unfinished work age and return to the foreground?
