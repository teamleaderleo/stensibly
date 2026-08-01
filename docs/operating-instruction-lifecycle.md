# Operating instruction lifecycle

**Protocol:** `stensibly-agent-ops/0.5.0`  
**Bootstrap:** `stensibly-project-bootstrap/v3`  
**Standing project policy:** `stensibly-internal-dogfood/v2`  
**Tracking issue:** #293  
**Status:** internal dogfood

This document defines how Stensibly's agent instructions and coordination guidance
change without leaving stale caution, temporary gates, or one-off prompts as active
policy forever.

## Sources and precedence

Use the following order when instructions conflict:

1. current direct operator direction;
2. `STENSIBLY.md` standing project policy;
3. `AGENTS.md` repository operating protocol;
4. `docs/current-wave.md` temporary execution focus;
5. accepted versioned contracts and policies;
6. pod practices and historical handoffs.

Live claims, credentials, leases, and exact deployment state still come from their
own canonical systems. Static policy determines what classes of action are already
authorised.

## Version classes

Name the exact class being changed:

- software release;
- deployed source and environment revision;
- ChatGPT Project bootstrap;
- repository operating protocol;
- standing project policy;
- wave revision;
- product or data contract;
- claim, lease, responsibility, or approval generation;
- exact PR head, artifact, or event sequence.

Do not cite only “the current version” in a review or migration.

## What belongs where

### ChatGPT Project settings

Keep a small bootstrap containing:

- repository identity and startup entrypoint;
- callsign and succession boundary;
- instruction-drift handling;
- ambitious autonomous continuation;
- the internal dogfood standing grant and its true external boundaries;
- durable-handoff expectations.

Do not paste current issue numbers, deployments, or temporary gates into Project
settings.

### `STENSIBLY.md`

Contains stable project context and narrower standing policy. It may explicitly grant
authority for classes of internal dogfood action. This is where the project declares
that its live hosted environment is internal dogfood rather than a customer service.

### `AGENTS.md`

Contains startup order, work selection, autonomous portfolios, dormant recovery,
risk-tiered review, merge and deployment behaviour, communication, and handoffs.

### `docs/current-wave.md`

Contains the temporary primary outcome, current live state, active lanes, accepted
internal test effects, and definition of done.

### Stensibly ledger and external systems

Own live claims, approvals outside standing policy, responsibilities, requests,
deployment identifiers, credentials, and exact operational evidence.

## Change lifecycle

Instruction changes may be:

1. `observed`;
2. `proposed`;
3. `experimenting`;
4. `accepted`;
5. `rejected`;
6. `superseded`;
7. `rolled_back`.

Direct operator corrections may become effective immediately when delay would
continue a demonstrated coordination failure. Record the change, exact source, and
follow-up review; do not force the operator to endure the old behaviour while agents
complete ceremony about changing it. The worker receiving the correction may
self-review and integrate a repository-only instruction update directly.

Preserve superseded text in Git history. Do not keep it active merely to show that a
rollback is possible.

## Proposal template

```markdown
## Instruction proposal

- State:
- Affected set:
- Current version:
- Proposed version:
- Operator direction or evidence:
- Owner:
- Independent reviewer, when useful:

### Observation
What happened? Separate facts from interpretation.

### Problem class
Examples: repeated human intervention, unnecessary approval, missed ambition,
context overload, stale guidance, duplicate work, collision, unsafe authority
assumption, absent evidence, or tool gap.

### Change
Show the deletion, replacement, changed default, or experiment. State what remains.

### Expected effect and cost
Describe delivery, coordination, safety, compatibility, and maintenance effects.

### Evaluation
Name the acceptance signal, failure signal, duration, and evidence coverage.

### Decision
Record the effective revision, rejected alternatives, and follow-up.
```

## Risk-tiered review and execution

Review depth follows actual consequences, not vocabulary such as “production” or a
fixed reviewer count. Current operator direction and `STENSIBLY.md` determine when
self-review is sufficient.

### Tier 0 — mechanical

Repository-only documentation, formatting, generated refreshes, and narrow fixtures.
Independent review is optional. Merge after exact inspection and relevant checks.

### Tier 1 — bounded internal dogfood

Small reversible runtime, UI, configuration, deployment, or protocol changes with
narrow impact and strong verification. Self-review is normally sufficient for work
covered by standing policy or current operator direction. Seek independent review only
when it materially reduces uncertainty. Merge and deploy promptly.

### Tier 2 — elevated internal dogfood

Authentication, authorisation, privacy, schema, durable state, retention,
cross-project isolation, public contracts, dependencies, broad compatibility, or
uncertain recovery. Require deliberate exact-candidate inspection, relevant checks, an
explicit integration decision, and a credible recovery or fix-forward path. Current
direct operator direction satisfies the integration-decision requirement for covered
internal dogfood work, and the implementing or integration worker may perform the
review. Add independent or specialist review only when actual residual uncertainty,
consequences, or operator direction justify it. After the decision, merge, deploy, and
dogfood under `STENSIBLY.md`.

### Tier 3 — external or materially consequential

Use Tier 3 only for consequences outside the standing internal dogfood grant, such as:

- material spend;
- access widening beyond the operator and participating agents;
- secret exposure;
- external publication or contact;
- destructive non-test data operations;
- irreversible migration without recovery;
- legal, financial, or contractual effects.

Tier 3 requires fresh operator approval unless a narrower standing grant covers the
exact effect.

Deployment, enablement, use of protected credentials inside reviewed workflows, and
bounded internal test writes are not automatically Tier 3.

Before merging a change, re-fetch the exact head, current base, CI, mergeability,
reviews, and unresolved threads when present. Reassess concrete findings rather than
using stale comments as ceremonial blockers. Any acceptance or self-review expires when
the head moves materially.

## Rollback and failure conditions

A rollback condition belongs in an experiment or deployment plan when it makes
recovery clearer. It is not the desired outcome.

- Prefer fix-forward when safe.
- Roll back after a demonstrated regression or unsafe partial state when rollback is
  the better recovery.
- Do not restore an old cautious default merely because ambitious execution found a
  repairable defect.
- Evaluate whether the new default improves completed outcomes without causing hidden
  collisions, unrecoverable state, or genuine external consequences.

## Surveys

Run an instruction survey after:

- repeated operator correction;
- a wave completion or stall;
- material coordination failure;
- an external audit;
- enough evidence accumulates to change a default.

Surveys should look specifically for:

- caution being treated as the objective;
- work stopping at PRs or documentation;
- deployments deferred without a real blocker;
- repeated approval requests for standing-authorised actions;
- independent-review ceremony blocking operator-directed internal work;
- rollback chosen instead of the stated product goal;
- missed safe parallelism;
- duplicate or abandoned portfolios;
- genuine unsafe authority assumptions.

A survey may recommend no change. It should not use process to avoid an obvious direct
operator correction.

## Protocol history

Protocol `0.5.0` removes the finish-existing-work-first gate. Existing work remains
required context for dependencies, useful continuations, and overlap. New bounded lanes
may start whenever they advance the current outcome. Priority follows expected value,
coherence, collision risk, and recoverability instead of work age alone.

Bootstrap `v3` carries the same work-selection rule into ChatGPT Project settings and
replaces bootstrap `v2`.

Protocol `0.4.0` makes accountable self-review the default for operator-directed,
reversible internal dogfood work. It removes the blanket second-agent gate for Tier 1
and Tier 2 changes while retaining exact-candidate inspection, relevant checks,
integration decisions, recovery evidence, and Tier 3 operator approval.

Protocol `0.3.0` replaced the blanket rule that every production deployment,
enablement, credentialed workflow, and internal write is Tier 3. It adopted
consequence-based review and the standing ambitious internal-dogfood grant in
`STENSIBLY.md`.

Bootstrap `v2` changed the default execution and authority posture and replaced
bootstrap `v1`.
