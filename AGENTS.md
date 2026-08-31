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

Stensibly is the durable coordination layer; chats, model sessions, and worker
processes are disposable. Current work, responsibility, authority, commands, receipts,
continuations, and provider state come from their canonical owners rather than copied
status prose.

## Start from current sources

Before substantive work:

1. When authenticated `enrol_worker` is available, enrol with the project and one
   stable per-chat `workerSessionId`, omit `callsign`, and use exactly the returned
   callsign, sigil, lease generation, and `workerRef`. An explicit callsign is an operator override/fallback.
2. Read `STENSIBLY.md` and the current issue or assignment.
3. Inspect current repository, pull-request, provider, and overlapping-work state before
   creating another candidate.
4. Read generated or tool-specific guidance for the surface you will touch.
5. Read deeper design/history documents only when they affect the current decision.

For mail-based continuation, follow
[`docs/mail-continuation.md`](docs/mail-continuation.md) before provider lookup, then
refresh referenced GitHub/provider state. Current repository policy and direct operator
direction control current work when older text conflicts.

## Identity and authority

Keep responsibility and authority distinct from worker/run identity. Project, current
work/responsibility generation, run, worker/actor, continuation, and authority/approval
carry different correctness semantics. A callsign is display metadata only; assignment,
labels, branches, names, or prior activity never substitute for current server-owned
authority.

See [`docs/agent-nomenclature.md`](docs/agent-nomenclature.md) and
[`docs/product-model.md`](docs/product-model.md) for the canonical identity and owner
model.

## Own the useful cycle

Prefer demonstrated correctness/recovery repairs, finishing or integrating active work,
clearing concrete dependencies, then bounded unclaimed issues with an explicit outcome.
Inspect overlap before editing shared surfaces and use the owning atomic
claim/responsibility mechanism when an effect requires one current owner.

For covered work, continue through the steps the outcome needs:

```text
investigate
-> implement/repair
-> deterministic verification
-> review when it can change the decision
-> integrate
-> deploy/configure when needed
-> real use/readback
-> fix-forward/recover
-> complete or leave one exact continuation
```

A proposal, branch, or pull request is an intermediate artifact while an authorised
completion step remains available.

## Review and integration

Apply `STENSIBLY.md` as the policy owner. For covered reversible internal-dogfood work,
the same worker may implement, self-review, integrate, merge, deploy, and verify; direct
operator instruction to proceed with a covered action supplies its integration decision.
Separate review is required when the operator requests it or the consequence leaves the
standing grant, and is otherwise useful whenever another perspective can materially
reduce uncertainty.

Use deterministic checks for defect classes they decide. Bind semantic review to its
complete declared inputs: candidate/source revision, relevant base/merge context,
policy/contract version, and external evidence where applicable. A moved `main` alone
does not expire an unchanged review when those inputs remain equivalent; a material
reviewed-input change does.

Before integration, refresh the candidate head, base/merge relation, required checks,
unresolved substantive findings, current authority, and mutable provider state that can
change the decision. Changing callsigns or sessions never manufactures independent
review.

## External effects and recovery

Use the owning command/receipt/reconciliation contract for provider writes:

- bind exact target, inputs, current authority generation, and idempotency identity
  before dispatch;
- exact replay returns the stored outcome and changed replay conflicts;
- read back canonical provider state when the action contract requires it;
- reconcile an ambiguous remote outcome before retrying;
- treat provider acknowledgement as evidence, with settlement determined by the owning
  contract.

Refresh mutable provider facts before consequential action and keep provider objects in
the provider rather than creating a parallel status ledger. See
[`docs/product-model.md`](docs/product-model.md) and
[`docs/coordination-correctness.md`](docs/coordination-correctness.md).

## Continuation, privacy, and human prerequisites

Recover from canonical work/provider records plus the smallest purpose-bound context or
continuation packet. Preserve only facts a successor cannot cheaply reconstruct: a
non-obvious decision, exact irreversible/ambiguous effect identity, current candidate
when it is the work product, unresolved blocker, and one next action or clearing
condition. Refetch mutable CI, PR, deployment, and provider state.

Keep credentials and private provider payloads inside their protected execution
surfaces and out of repository text, comments, chat, logs, screenshots, tests, and
retained artifacts. When progress truly requires a human-only action, use
[`docs/operator-action-required.md`](docs/operator-action-required.md) and request the
minimum protected action without asking for a secret value.

## Communication

Write updates for decisions and continuation. A compact owning record usually needs:

```text
Purpose: why this exists
Change: what changed
Proof: evidence that decides acceptance
Next: remaining action or clearing condition
```

Include exact revision, receipt, or source identity when it changes review or recovery.
Use Git history for superseded process wording and move repeated machine-decidable rules
into typed state, deterministic checks, generated projections, or safer APIs.
