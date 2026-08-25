<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first**. Those generated guidelines override
patterns remembered from training data.

Convex agent skills for common tasks can be installed with
`npx convex ai-files install`.

<!-- convex-ai-end -->

# Agent entry point

**Standing project policy:** `STENSIBLY.md`

Stensibly is the durable coordination and product layer for a one-person,
many-agent studio. Chats, model sessions, and worker processes are disposable.
Durable work, authority, commands, receipts, decisions, continuations, and provider
objects survive them.

## Start from current sources

Before substantive work:

1. When authenticated `enrol_worker` is available, enrol with the project and one
   stable per-chat `workerSessionId`, omit `callsign`, and use exactly the returned
   callsign and sigil. Optionally pass one broad `callsignCategory`. Use an explicit
   callsign only for deliberate operator direction. When hosted enrolment is
   unavailable, use the documented manual fallback.
2. Read this file and `STENSIBLY.md`.
3. Read generated/tool-specific guidance for the code or workflow you will actually
   touch.
4. Inspect the current issue, pull request, repository/provider state, and existing
   work before creating another candidate.
5. Read deeper product/design/history documents only when they affect the current
   decision.

Do not require a broad startup reading list or a hand-maintained current-wave packet
when the needed facts can be fetched from their canonical owners.

For mail-based continuation, read [`docs/mail-continuation.md`](docs/mail-continuation.md)
before provider lookup. Source-explicit launch wording controls the first lookup; when
it names Gmail, search Gmail for the exact `STN-*` handle first. Refresh referenced
GitHub state before acting.

When older prompts or documents conflict, current repository policy and direct
operator direction control current work. Historical text remains evidence of the
older decision.

## Durable identities

Keep machine identities separate where they carry different correctness semantics:

- **project** — durable product/repository policy boundary;
- **work item / responsibility generation** — outcome still owed and its current
  accepted obligation;
- **run** — one bounded execution attempt;
- **worker / actor** — attributable principal/session reference;
- **continuation** — durable successor state after a worker disappears;
- **authority / approval** — permission for a bounded action/effect;
- **callsign** — human-readable display metadata only.

`wave`, `lane`, `campaign`, `phase`, `reviewer`, `coordinator`, and similar words may
be useful prose. They are optional labels unless a current machine contract gives
them a distinct invariant.

See `docs/agent-nomenclature.md` for the compact identity model.

## Callsigns

Use one stable callsign for a live interactive worker when human-readable attribution
helps. The name grants zero identity continuity, responsibility, competence, or
authority.

The normal hosted path is programmatic: call `enrol_worker(project, workerSessionId)`,
omit `callsign`, optionally provide `callsignCategory`, and use exactly the accepted
callsign, sigil, lease generation, and `workerRef`. The existing lease boundary owns
collisions and replay. Manual/explicit callsigns remain an override and fallback.

Keep run/session provenance when continuing earlier work. A callsign is display
metadata; it never proves that a fresh chat is the previous worker.

## Work selection and claims

Choose useful work from current evidence. Prefer, when applicable:

1. repair a demonstrated correctness/authority/recovery defect;
2. finish, verify, integrate, deploy, reconcile, or retire already-active work;
3. clear a concrete dependency;
4. take a bounded unclaimed issue with an explicit consequence and stopping
   condition;
5. explore when the result can change an implementation or product decision.

Inspect overlap before editing shared mutable surfaces. Parallel work is welcome when
its files/contracts/effects are disjoint enough to reconcile cheaply.

Use the owning atomic claim/responsibility mechanism when shared effects require one
current owner. Labels, GitHub assignment, callsigns, branches, or prose do not
substitute for claim/authority generation.

Do not maintain a separate portfolio queue or repeatedly ask a manager process to
select ordinary work.

## Own the useful cycle

For covered internal work, continue through the steps the outcome actually needs:

```text
investigate
-> implement/repair
-> deterministic verification
-> review when it adds a discriminator
-> integrate
-> deploy/configure when needed
-> real use/readback
-> fix-forward/recover
-> complete or leave one exact continuation
```

A proposal, issue, plan, branch, or pull request is an intermediate artifact when the
actual outcome can be completed under current authority.

Blocked time may move to another non-conflicting executable item. Avoid waiting-only
reviewer/manager lanes.

## Internal dogfood authority

The hosted installation is an internal dogfood environment even when repository text
calls it `production`.

`STENSIBLY.md` grants standing authority for reviewed, reversible internal dogfood
work within its exact boundary, including ordinary merges, deployments, bounded test
data, covered migrations with recovery, OAuth journeys, project-scoped writes, and
operational verification.

Direct operator instruction to proceed/fix/merge/deploy/test/finish a covered action
counts as the integration decision for that action.

Fresh operator approval is still required for effects outside the standing grant,
including material spend, secret exposure, access widening beyond the operator and
participating agents, external publication/contact, destructive non-test data
changes, irreversible migration without recovery, and legal/financial effects.

## Review policy

Use deterministic checks for defect classes they can decide. Use human/agent semantic
review when product meaning, authority, privacy, security, durability, broad novel
behavior, or another consequence leaves a real discriminator.

Self-review is sufficient for covered reversible work when deterministic evidence and
scope leave no meaningful independent question. Independent/specialist review is
useful when another perspective can materially reduce residual uncertainty or the
operator requests it.

Never manufacture independence by changing callsign/chat/label.

Bind review to its complete declared input set: candidate/source revision, relevant
base/merge context, policy/contract version, and external evidence where applicable.
A moved `main` alone does not invalidate an unchanged review when the reviewed input
set remains equivalent; a material reviewed-input change does.

Before integration, refresh the exact facts that can change the decision: candidate
head, merge/base relation, required checks, unresolved substantive findings, current
authority, and provider state where relevant.

## External effects and ambiguous outcomes

External/provider writes use the owning command/receipt/reconciliation boundary:

- bind exact target, inputs, authority generation, and idempotency identity before
  dispatch;
- exact replay returns the stored outcome;
- changed replay conflicts;
- read back canonical provider state when the action contract requires it;
- if the remote outcome is ambiguous, reconcile before retry;
- provider acknowledgement alone never proves complete settlement.

Do not add a second status ledger around provider objects. Query current mutable
provider state when it can change the next action.

Some provider/platform effects require an explicit trigger even after a repository
mutation. For example, the Bun lock writer must explicitly dispatch exact-SHA CI
because a workflow-token-authored branch push does not start another workflow. Keep
such triggers fenced to the exact resulting revision and prevent recursion through
the event contract.

## Continuation and wakeups

Future work should resume from durable conditions rather than worker polling.

- #46 owns deterministic wake-condition semantics;
- #327 owns explicit cross-item material-event → wake-intent compilation;
- runner liveness belongs to the execution-attempt owner;
- effect ambiguity belongs to receipt/reconciliation owners.

A wake makes work eligible. It grants zero responsibility or authority by itself.

Use scheduled polling only for explicit time conditions or sources without a reliable
event path. Avoid general “check whether the worker progressed” loops.

## Context and recovery

When a worker disappears, recover from canonical work/provider records plus the
smallest purpose-bound continuation/context packet available. #311 owns the intended
compiler boundary.

Historical accepted GitHub context under #492 proves what a run consumed. Refetch
current mutable GitHub/provider state before a consequential action.

A handoff should preserve only facts another worker cannot cheaply reconstruct, such
as:

- non-obvious result/decision and why;
- exact irreversible or ambiguous effect identity;
- exact candidate/artifact when it is the work product;
- unresolved blocker/uncertainty;
- one next action or clearing condition.

Current CI, PR, deployment, roster, and queue state should normally be fetched from
their owners instead of copied into handoff prose.

## Merge, deployment, and recovery

Merge/deploy when the current candidate is accepted under the relevant policy and the
required exact evidence is green. Deployment is a normal completion step when needed
to verify or deliver the outcome.

- use protected workflows/environments for privileged effects;
- keep secrets out of logs/comments/chat/artifacts;
- verify the actual hosted surface after deployment;
- prefer fix-forward when the state is safe to repair;
- roll back after demonstrated regression/unsafe partial state when rollback is the
  better recovery.

## Communication

Write updates for decisions and continuation, not for occupancy reporting.

Lead with what changed, what was learned, and the next useful action. Include an exact
revision/receipt/source reference when it changes review or recovery. Omit repeated
status that a reader can fetch directly.

For a meaningful PR/issue/decision, these concepts are usually enough:

```text
Purpose: why this exists
Change: what behavior/contract changed
Proof: evidence that decides acceptance
Next: remaining action or clearing condition
```

Add risk/recovery/authority detail only when it changes the decision.

## Improve by deleting process

Use Git for instruction history. A meaningful policy change should cite the concrete
failure/product decision, make the smallest useful diff, and state a deletion/revert
condition when the procedure is temporary.

Move repeated rules into software when possible:

```text
observed failure
-> temporary instruction/default
-> repeated evidence
-> typed state / deterministic check / generated projection / safer API
-> delete or shrink the prose procedure
```

Do not create periodic retrospectives, surveys, worker scorecards, copied status
reports, or permanent manager roles by default. Open the smallest owning defect when
a concrete failure shows a missing invariant.
