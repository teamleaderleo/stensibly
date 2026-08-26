# Supervision throughput

## Purpose

A one-person, many-agent studio eventually hits a different bottleneck from raw model capability: the operator can generate more useful work than one human can personally inspect in detail.

Stensibly should help the operator govern a growing volume of autonomous work while keeping consequential decisions, uncertainty, authority, and recovery legible.

The useful quantity is closer to:

```text
useful throughput
  = min(
      model capacity,
      execution capacity,
      coordination capacity,
      operator review capacity
    )
```

The product goal is to raise useful throughput by reducing the operator attention required per unit of trustworthy completed work.

## Supervision ratio

A useful working measure is:

```text
supervision ratio
  = operator minutes consumed / autonomous work completed
```

This is intentionally a behavioral measure rather than a universal score. Different work has different risk, ambiguity, and reversibility.

Examples:

- a reversible internal refactor may consume near-zero operator minutes after checks and readback;
- a public API change may deserve a short semantic review even with complete deterministic checks;
- an irreversible provider action may deserve explicit operator approval before execution;
- a research branch may deserve operator attention only when it changes the governing premise or produces a decision-worthy result.

The desired trend is simple: more useful autonomous work per unit of operator attention, without hiding uncertainty or widening authority.

## Review compression

The operator should review decisions and residual uncertainty, rather than replay every worker step.

A useful completion projection can separate outcomes such as:

```text
173 items
  completed inside standing policy
  deterministic checks passed
  evidence and recovery references retained

19 items
  completed with minor semantic judgments
  compact rationale available on demand

6 items
  externally visible or behavior-changing
  before/after evidence retained

2 items
  operator decision required
```

The exact counts are illustrative. The product principle is that large work volume should collapse into a small set of decision-worthy interruptions.

A summary earns operator attention when it changes one of these:

- what should happen next;
- whether authority is sufficient;
- whether a risk or uncertainty remains consequential;
- whether recovery is credible;
- whether the project premise should change;
- whether scarce compute, money, or human attention should move elsewhere.

## Escalation instead of universal review

Every work item already carries an authority boundary. Supervision should build on that boundary.

A project may define broad autonomous regions such as:

```text
may proceed autonomously
- internal reversible edits
- deterministic test repair
- bounded refactors
- documentation updates
- internal dogfood deployment with recovery

operator decision required
- material spend
- external publication or contact
- irreversible data effects
- access widening
- legal or financial effects
- ambiguous product direction
```

The operator should receive the second category as an attention queue. The first category should usually surface through receipts, rollups, exceptions, and focused drill-down.

Visibility and authority remain separate. A work item can be highly visible while fully autonomous, or quiet while blocked on one explicit approval.

## Evidence before escalation

An escalation should arrive with enough evidence to decide quickly.

A strong escalation packet contains:

```text
Decision:
Why now:
Current recommendation:
Alternatives:
Evidence:
Residual uncertainty:
Downstream work blocked:
Authority/effect boundary:
Recovery implications:
```

The packet should preserve links to canonical code, pull requests, CI, deployments, provider state, experiments, or research receipts. Stensibly should retain the decision surface and provenance rather than copying entire external systems into the ledger.

## Verification should absorb routine review

Deterministic checks should decide defect classes they can actually decide.

Useful verification layers can include:

```text
candidate
-> static checks
-> unit/integration tests
-> runtime/readback verification
-> performance comparison when relevant
-> focused semantic review when uncertainty remains
-> operator escalation only when a real decision survives
```

Independent agent review is valuable when another perspective can reduce residual uncertainty. It should earn its compute and attention through a real discriminator.

The operator should usually review evidence about correctness and consequences instead of manually reproducing every worker action.

## Trees of responsibility

Human coordination should remain bounded even when worker count grows.

A large project may have responsibility nested by outcome:

```text
operator
  -> project outcome
      -> research outcome
          -> bounded investigations
      -> engineering outcome
          -> implementation / validation work
      -> operations outcome
          -> deployment / readback / recovery work
```

One current responsible actor remains legible for each coherent item. That actor can delegate bounded parts while retaining responsibility for the parent item's next state.

The useful scaling property is fan-in: many worker results should reconcile into a much smaller number of parent decisions and exceptions.

## Resource budgets

Agent work consumes more than inference. It can consume CI runners, CPUs, GPUs, memory, storage, browser sessions, provider quotas, test environments, API calls, and money.

Stensibly should eventually support bounded resource policy at project or work-item level, for example:

```text
priority: release blocker
inference budget: high
CI budget: burst allowed
local compute: prefer overnight saturation
cloud spend: capped
operator attention: escalate only on listed boundaries
```

A resource budget grants zero extra effect authority. It says how aggressively authorized work may consume available resources.

Scheduling should prefer work that clears dependencies, protects scarce resources, or has high expected value under the active project goal. Low-value experiments should be cheap to stop.

## Premise challenge

Efficient execution can amplify a bad premise.

Long-running work therefore needs an explicit way to challenge the parent goal while ordinary workers continue execution.

Useful challenge questions include:

- Which assumption would reverse the current direction if false?
- Has new evidence weakened the original objective?
- Are several workers agreeing because they inherited the same premise?
- Is the measured target still a good proxy for the desired outcome?
- Which observation would justify stopping or redirecting this branch?

A premise challenge should create a concise decision record when it changes the project direction. Routine disagreement should stay inside normal work unless it crosses that threshold.

## Attention as a schedulable resource

Operator attention is finite and should be treated as an explicitly conserved resource.

Attention queues should therefore support:

- oldest-actionable ordering where delay creates debt;
- consequence and uncertainty signals;
- blocked fan-out;
- concise recommended decisions;
- focused detail only after selection;
- explicit quiet states when autonomous work is progressing inside policy.

The existing work-stack projection already separates hot work, review work, warm summaries, cold metadata, and focused detail. Supervision throughput adds a stronger product question: **which subset of that admitted work actually deserves operator interruption now?**

## Product test

A supervision feature earns promotion when it measurably improves one or more of these outcomes:

- fewer operator minutes per trustworthy completed item;
- fewer missed consequential decisions;
- fewer repeated investigations;
- fewer stalls caused by unnecessary approval;
- earlier discovery of a wrong project premise;
- better utilization of available compute;
- cheaper recovery after autonomous failure;
- clearer operator understanding of current project state.

The target experience is a studio where autonomous work can grow dramatically while the operator's attention remains concentrated on judgment, direction, and genuinely consequential exceptions.
