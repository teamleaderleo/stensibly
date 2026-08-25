# Documentation: intent, evidence, and durable decisions

Documentation exists to make a real reader faster and a consequential decision reconstructible. It should not become a second current-state database.

## Core rule

Keep each mutable fact with one canonical owner and link or query that owner elsewhere.

Examples:

- current PR head, review, checks, and mergeability → GitHub;
- current provider/deployment state → owning provider;
- work responsibility, authority, commands, receipts, decisions, continuations → Stensibly;
- repository policy → exact Git revision and applicable instruction files;
- historical rationale → issue/PR discussion or a durable decision record when it needs a stable home.

A summary may explain a fact. It should avoid becoming the place that fact must also be updated.

## A compact brief

Meaningful issues, pull requests, and decisions usually need only these concepts near the top:

```text
Purpose: why this exists / what outcome changes
Change: behavior, contract, result, or decision
Proof: evidence that decides acceptance
Next: remaining action or clearing condition, when one exists
```

Add authority, risk, recovery, compatibility, or a file/effect boundary only when it changes the decision. Mechanical work can be shorter.

The words are optional; the information need controls the document.

## Write for the nearest reader

| Reader | Main question | Useful information |
| --- | --- | --- |
| Fresh worker | What current responsibility can I continue? | current issue/work identity, exact source refs, blocker/next action |
| Implementer | What must remain true? | behavior, contracts, invariants, examples, tests |
| Reviewer | Is this exact candidate acceptable? | purpose, semantic change, exact reviewed inputs, proof, residual risk |
| Operator | What requires judgement? | exact decision, options, evidence, consequences |
| Future maintainer | Why does this durable choice exist? | context, decision, alternatives, consequences, supersession trigger |
| Product user | How do I accomplish something? | task steps, reference, examples, troubleshooting |

Do not add portfolio, lane, wave, worker-roster, queue, or status sections merely because a template offers them.

## Document types

Use the type that matches the reader's task:

- **Tutorial** — guided first success.
- **How-to** — steps for a concrete task.
- **Reference** — exact API, contract, configuration, schema, or command details.
- **Explanation** — concepts, rationale, history, and trade-offs.
- **Decision record** — a durable consequential choice whose rationale must outlive the immediate issue/PR.

One document may link to another type; avoid turning every page into all of them.

## Issues

An issue should own one problem, outcome, experiment, or durable product decision.

Useful fields are contextual, not mandatory:

- observed problem/evidence;
- desired outcome;
- exact owner/boundary when overlap is plausible;
- acceptance discriminator;
- current blocker or next action.

Current work status belongs in the issue/provider state itself. Avoid parallel Markdown trackers that require the same transition to be copied again.

Close an issue when its procedure has been replaced by deterministic machinery even when the useful mechanism remains in code.

## Pull requests

A pull request should make the candidate decision cheap:

- what changes and why;
- exact behavioral or contract consequence;
- proof already available / still required;
- unusual authority, compatibility, migration, or recovery consequence;
- relationship to the owning issue.

Exact head/check/review state is fetched from GitHub at decision time. Avoid copying long status tables into the description.

## Handoffs and continuations

Keep only facts the next worker cannot cheaply reconstruct:

- non-obvious decision/result and why;
- exact irreversible or ambiguous effect identity;
- current candidate/artifact when it is the work product;
- unresolved blocker/uncertainty;
- one next action or clearing condition.

Fetch current CI, PR, deployment, queue, and provider state from their owners.

When the same continuation can be compiled from canonical records, prefer the generated purpose-bound packet from #311 over hand-maintained prose.

## Durable decision records

Create a separate decision record when rationale/consequences need a stable repository artifact beyond the owning issue or PR. Common examples include long-lived public/internal contract choices, provider/storage strategy, authority/privacy policy, or an expensive compatibility decision.

Use an issue-backed path:

```text
docs/decisions/<issue-number>-<short-lowercase-slug>.md
```

Start from [`docs/decisions/_template.md`](decisions/_template.md).

A useful decision record states:

```text
owning issue
status
context/problem
decision
important alternatives
consequences
proof/observations
supersession or revisit condition
```

Do not allocate sequential ADR numbers merely to create a filing system. The owning issue is already a globally searchable identity.

A later decision supersedes the old record explicitly; Git preserves the historical text.

## Exact evidence and live facts

Use immutable evidence when the claim is historical or candidate-specific:

- commit/tree/blob identity;
- exact run/receipt/artifact identity;
- accepted context/instruction fingerprint;
- exact decision/authority generation.

Use current provider reads when mutable live state can change the next action.

A document can say what was observed at a given revision. It should never silently present that historical observation as current truth.

## Generated views

Prefer a generated projection when readers repeatedly need a combination of reconstructible facts, such as:

- current decisions requiring human input;
- exact remaining integration gate;
- stale/ambiguous effects requiring recovery;
- purpose-bound continuation/review context.

The view should carry source identities/fingerprints and be reproducible from canonical records. Delete hand-maintained reports once the generated view owns the use case.

## Historical and research material

Keep rich investigation/case material when it is evidence or useful explanation. Historical documents may contain terminology or procedures that are no longer current policy.

Mark or relocate material only when readers could reasonably mistake it for current instruction. Avoid rewriting old evidence to make history look consistent with today's policy.

## Maintenance

Before adding a new recurring documentation requirement, answer:

1. Which concrete decision/failure needs this information?
2. Which canonical owner already has it?
3. Can a view/compiler fetch it instead?
4. What condition deletes the procedure?

Prefer deletion when the information becomes reconstructible.

```text
observed gap
-> smallest useful document/instruction
-> repeated use
-> generated view / typed state / deterministic check / better API
-> delete or shrink the document procedure
```

— Kestrel
  Intention: document decisions and explanations while current state stays with current owners
