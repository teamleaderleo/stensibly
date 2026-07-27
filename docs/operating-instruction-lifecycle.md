# Operating instruction lifecycle

**Protocol:** `stensibly-agent-ops/0.2.0`  
**Bootstrap:** `stensibly-project-bootstrap/v1`  
**Tracking issue:** #293  
**Status:** dogfood

This document defines how Stensibly's agent instructions, pod practices, and
coordination guidance change without turning one pasted prompt into an unreviewed
source of truth.

## Separate version classes

Use the identifier that matches the thing being reviewed or changed:

- software release: `stensibly 0.0.1`;
- deployed revision: exact commit, build, Worker, and Convex deployment identifiers;
- Project bootstrap: `stensibly-project-bootstrap/v1`;
- repository operating protocol: `stensibly-agent-ops/0.2.0`;
- wave and revision: for example `W01 rev 1`;
- contract version: for example `project-attachment-v1`;
- work authority: exact claim, lease, continuation, or approval generation;
- artifact or review: exact commit SHA, PR head, or event sequence.

Never cite only "the current version" in an audit, review, handoff, or migration.
Name the relevant version class and exact identifier.

Protocol `0.2.0` combines the accepted stable-callsign and continuity convention
from #297 with the accepted autonomous-portfolio and dormant-recovery convention
from #330. The Project bootstrap remains `v1` because the repository entrypoint,
authority boundary, and drift-detection contract remain compatible.

## What belongs where

### ChatGPT Project settings

Keep only the stable bootstrap:

- repository identity;
- canonical startup entrypoint;
- instruction-drift detection;
- stable per-chat callsign and explicit succession boundary;
- inspect-before-creating rule;
- bounded autonomous continuation rule;
- authority boundary;
- durable-handoff requirement;
- direction to use Stensibly when available.

Do not paste current lanes, issue numbers, detailed pod practices, or temporary
rollout gates into Project settings.

### `AGENTS.md`

Contains the accepted repository operating protocol: startup order, callsign and
continuity rules, autonomous portfolio execution, general work selection,
authority boundaries, risk-tiered review and merge policy, review independence,
handoff expectations, and shared improvement rules.

### `docs/current-wave.md`

Contains temporary operational focus, gates, lanes, accepted test effects, and
retrospective questions. It has its own wave revision.

### Pod notes and practices

May contain local tips, rituals, repository knowledge, experiments, and working
preferences. Local notes do not become shared policy merely because they are
useful to one pod. Promotion into `AGENTS.md` requires an accepted proposal.

### Stensibly ledger

When available, owns live claims, approvals, responsibilities, requests, survey
results, proposals, decisions, and version references. Git remains canonical for
repository text and exact code revisions.

## Proposal lifecycle

Instruction changes use these states:

1. `observed` — an evidenced problem or opportunity exists;
2. `proposed` — a bounded change and expected effect are stated;
3. `experimenting` — the change is tried in a declared scope;
4. `accepted` — the shared protocol or pod practice adopts a new version;
5. `rejected` — the proposal is declined with evidence and reason;
6. `superseded` — another proposal or version replaces it;
7. `rolled_back` — the previous accepted version is restored with cause.

A survey may produce `no_change_recommended`. Do not create a proposal merely to
show activity.

## Proposal template

```markdown
## Instruction proposal

- State: observed | proposed | experimenting | accepted | rejected | superseded | rolled_back
- Affected set: project bootstrap | operating protocol | wave | pod practice | contract
- Current version:
- Proposed version, if accepted:
- Scope:
- Owner:
- Independent reviewer:

### Observation

What happened? Link exact runs, issues, PRs, comments, surveys, commits, or audit
evidence. Separate facts from interpretation.

### Problem class

Choose one or more:

- context missing;
- context overload or repeated irrelevant detail;
- contradiction or stale guidance;
- duplicate work or verification;
- missed safe parallelism;
- excessive parallelism or integration collision;
- unclear ownership or handoff;
- repeated human intervention;
- unnecessary approval;
- absent independent review;
- useful pod practice;
- resource or capacity request;
- external audit finding;
- tool or observability gap;
- instruction ignored or misinterpreted;
- other, with explanation.

### Proposed change

Show the smallest addition, deletion, reordering, clarification, or local
experiment. Identify what should remain unchanged.

### Expected effect and cost

What should improve? What context, latency, coordination, compatibility, or
maintenance cost might increase?

### Experiment

- Scope and duration:
- Baseline:
- Acceptance signal:
- Failure or rollback condition:
- Data and source coverage:

### Compatibility and rollout

Describe affected chats, pods, repositories, waves, contracts, deployments, and
external users. State whether the Project bootstrap must change.

### Decision

Record reviewer, human approval when required, exact adopted revision, effective
scope, rejected alternatives, residual uncertainty, and follow-up survey.
```

## Risk-tiered review and merge decisions

Review count is a consequence of risk, not a measure of seriousness or worker
participation. Every handoff should identify the selected tier and the evidence
that justifies it.

### Tier 0 — mechanical or documentation-only

Use for changes with no runtime, authority, security, data, deployment,
dependency, or public-contract effect and a trivial rollback.

- Independent review may be omitted.
- Exact diff inspection, relevant checks, unchanged head, mergeability, and no
  unresolved concrete finding are sufficient.
- The author or integration worker may merge under the standing repository policy.

### Tier 1 — bounded low-risk runtime or operating-protocol change

Use for a small isolated runtime, contract, or focused instruction change with
straightforward rollback and no authorization, privacy, schema, migration,
durable-state, data-loss, deployment, or broad compatibility boundary.

- One independent exact-head acceptance is normally sufficient.
- Green relevant checks, an unchanged mergeable head, and no unresolved blocking
  thread complete the gate.
- The integration worker should merge promptly rather than waiting for unrelated
  workers or another ceremonial approval.

### Tier 2 — elevated or broad

Use for authentication or authorization, privacy, schema or migration, durable
state machines, exactly-once effects, deletion or retention, cross-project
isolation, public protocol changes, dependencies, broad compatibility, or
uncertain rollback.

- Require at least one independent exact-head acceptance and a separate integration
  decision when the reviewer is not the integration owner.
- Add another independent or specialist review when multiple high-risk boundaries
  are crossed, evidence conflicts, the relevant failure mode cannot be exercised,
  or material residual uncertainty remains.
- Competing candidates require a selector independent of the selected final
  revision.

### Tier 3 — consequential operation

Production deployment or enablement, credentials, permission widening,
destructive data operations, spending, external publication, irreversible
migration, and comparable real-world effects require contemporaneous human
approval unless a narrower standing policy explicitly grants them.

A residual regression may be accepted only when it is bounded, reversible,
documented, outside safety, authorization, privacy, and data-loss boundaries,
and has a clear follow-up or rollback condition. Reviewers should distinguish a
blocking defect from an imperfection that can safely ship.

Before merging any reviewed PR, re-fetch the exact head, current base, CI,
mergeability, reviews, and unresolved threads. Exact-head acceptance expires when
the head moves. A worker may never use its own review as the sole acceptance for
its own Tier 1 or Tier 2 final revision.

This policy does not require the whole pod or every available worker to review a
change. It requires only the independence and specialist coverage justified by
the selected tier.

## Version changes

For the operating protocol:

- patch: wording or clarification that preserves obligations and authority;
- minor: new optional capability, new shared practice, or changed default workflow;
- major: incompatible startup, authority, acceptance, or handoff semantics.

While the protocol remains `0.x`, use judgement but still record whether the
change is clarification, additive behaviour, or incompatible behaviour.

The Project bootstrap uses integer versions and should change rarely. A bootstrap
version changes only when the canonical entrypoint, authority boundary, or drift
handling changes—not whenever `AGENTS.md` or the current wave changes.

Increment a wave revision when its lanes, execution gates, accepted test effects,
or completion criteria change materially. Preserve prior revisions in Git history
and never rewrite a cited revision without a replacement identifier.

## External audit intake

An external audit finding must state:

- auditor or source and date;
- exact software, deployment, bootstrap, protocol, wave, and contract versions
  reviewed, as applicable;
- scope and source coverage;
- severity and confidence;
- evidence and reproduction;
- affected authority or compatibility boundaries;
- proposed repair and alternatives;
- migration, rollout, and rollback requirements;
- acceptance and re-audit criteria.

An audit may result in code, protocol, contract, pod-practice, or deployment
changes. Version only the affected classes. Preserve the audit finding even when
its recommendation is rejected.

## Pod learning and tips

Pods may record concise notes such as:

- commands and verification recipes;
- recurring failure modes;
- successful decomposition or review techniques;
- context that fresh workers routinely need;
- information that repeatedly proves unnecessary;
- useful collaboration patterns with other pods;
- hypotheses worth testing.

Each note should carry provenance, scope, confidence, freshness, and sensitivity
when relevant. Notes may be revised or retired. Do not promote anecdotal tips into
shared protocol without comparable evidence or a bounded experiment.

## Resource requests

A pod or worker may request additional capacity without inventing a permanent
role. A request should contain:

- requested outcome or capability;
- reason and evidence;
- relevant wave, lane, or action;
- urgency and expiry or wake condition;
- expected duration;
- context packet or source links;
- conflicts or independence requirements;
- acceptable response: accept, decline, defer, delegate, or propose another pod;
- current response owner.

The request survives the initiating worker and closes explicitly.

## Survey cadence

Run an instruction survey:

- after a wave completes or stalls;
- after material coordination failure;
- after repeated human correction;
- after an external audit;
- before a major protocol change;
- periodically when enough new after-action evidence exists.

Surveys should remain quiet when there is no material change. They should compare
observed behaviour with the protocol version actually in force, not with an
uncited memory of prior instructions.
