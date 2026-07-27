# Git versions artifacts; Stensibly governs collaborative state

## Status

This note records a product and architecture analogy discovered through multi-worker dogfood. It does not claim that every described Stensibly record or transition is implemented yet.

For the primary product boundary, see [product-model.md](product-model.md). For concurrency, fencing, retries, and external effects, see [coordination-correctness.md](coordination-correctness.md).

## The useful analogy

Git and Stensibly address related collaboration problems at different layers.

> **Git tells us what changed. Stensibly tells us who is responsible for what happens next.**

Git versions repository artifacts: commits, trees, references, branches, and merges. Stensibly should version and govern the collaborative state around producing, reviewing, selecting, releasing, and continuing work.

That state includes:

- offers, delivery, acknowledgement, and accepted responsibility;
- workers, runs, handoffs, succession, and current attention;
- claims, leases, approvals, capabilities, and bounded authority;
- observations, decisions, reviews, findings, and clearing conditions;
- alternative candidates and integration decisions;
- provenance, exact versions, omitted context, and uncertainty;
- waits, escalation, recovery, and the next action.

The analogy helps explain the product. It must not turn Stensibly into a second source-control implementation.

## Similar collaboration shapes

| Git or source-control concept | Coordination-state analogue |
| --- | --- |
| working tree | a worker's active plate and current context |
| fetch | retrieve a selective state bundle |
| rebase | reconcile a worker's context against current canonical state |
| branch | an alternative work trajectory or implementation candidate |
| merge | select or combine accepted results |
| merge conflict | incompatible assumptions, responsibilities, authorities, or implementations |
| cherry-pick | retain a useful test, finding, decision, or component from another candidate |
| tag | an accepted protocol, contract, decision, or wave revision |
| provenance or blame | who observed, accepted, decided, implemented, reviewed, or authorised |

These are explanatory analogies, not one-to-one storage requirements.

A worker returning after several hours may need the coordination equivalent of a rebase: load the current state bundle, compare prior assumptions with the live project, identify transferred or superseded work, and continue only what remains current.

Two workers may deliberately create the coordination equivalent of branches: partitioned work, stacked changes tied to an exact base, competing implementations, or bounded repair candidates. One integration owner later selects or combines accepted results under a shared observable contract.

## The boundary: complement Git, do not rebuild it

External systems remain authoritative for their own objects:

- Git owns commits, trees, diffs, branches, tags, and source merges;
- CI providers own build and test results;
- deployment providers own deployments and runtime revisions;
- communication systems own messages and delivery surfaces;
- document, design, database, and asset systems own their artifacts.

Stensibly should reference those objects and add the coordination semantics they do not natively govern.

For a code candidate, Git may provide:

```text
repository: teamleaderleo/stensibly
base: 2b11a6c...
candidate: 3a0c382...
merge preview: b2f3b61...
```

Stensibly can add:

```text
implementation owner: Forge
reviewer: Relay
verdict: REPAIR
findings:
  - expired replay semantics
  - cleanup rollback
clearing condition:
  - replacement exact head
  - focused regressions
  - green full gate
merge authority: human required
```

The repository references identify the artifact state. The Stensibly record identifies responsibility, review meaning, authority, and next action.

Stensibly should not duplicate:

- Git object storage;
- source diffs and patch calculation;
- commit-graph transport;
- source merge algorithms;
- repository history;
- provider-native build, deployment, or message storage.

Provider records are evidence and integration targets. They are not always sufficient as the authoritative collaboration ledger. For example, multiple Stensibly workers may use one GitHub account, so GitHub cannot represent their worker-level review independence even though Stensibly must.

## More than source-code collaboration

The underlying abstraction is not a Git branch. It is:

```text
responsibility
+ artifact or evidence reference
+ provenance
+ authority
+ semantic transition
+ integration decision
```

The same model applies when work lives outside a repository:

- a research report with competing analyses and one synthesis owner;
- a design asset with review findings and publication approval;
- an incident response with responders, mitigations, evidence, and operator decisions;
- a legal or policy review with versioned findings and explicit approval boundaries;
- a customer-support escalation whose messages remain in the communication provider;
- a deployment whose runtime object remains authoritative in the deployment provider.

Stensibly can coordinate these workflows without pretending to own every artifact format.

## Design consequences

### Reference exact external state

A coordination record should identify the exact external object or revision it concerns. A review without an exact candidate revision becomes stale when the artifact changes.

### Keep collaboration transitions typed

These states are materially different:

```text
available
→ offered
→ delivered
→ acknowledged
→ accepted responsibility
→ authority acquired
→ active
→ review-ready
→ accepted
→ integrated
→ released
```

One state must not be treated as proof of another. An offer is not acknowledgement. Responsibility is not authority. A provider comment is not proof that a worker saw it. A green CI result is not integration approval.

### Preserve alternatives without confusing canonical state

Declared competing candidates can be useful when uncertainty is real. Each candidate should state its hypothesis, scope, overlap, shared acceptance contract, evidence, budget, and stopping condition. One integration owner must decide what becomes canonical.

### Make reconciliation routine

Workers are ephemeral and may return with stale context. Selective state bundles should make reconciliation cheap: exact versions, current plate, relevant offers, target revisions, decisions, findings, waits, omissions, uncertainty, and expansion links.

### Keep authority server-governed

Static files, branch names, assignments, and comments are descriptive evidence. They must not become bearer tokens, mutable locks, or implicit permission for consequential effects.

## Product language

Useful concise descriptions include:

- **A responsibility and authority ledger for collaborative work.**
- **A coordination control plane for humans, agents, scripts, and services.**
- **Git versions artifacts. Stensibly governs the collaborative state around changing them.**
- **Git tells us what changed. Stensibly tells us who is responsible for what happens next.**

Avoid describing Stensibly simply as "Git on top of Git". That phrase is useful for internal reasoning, but it sounds redundant and code-specific. The product is broader: it governs responsibility, authority, provenance, continuation, and integration across many artifact systems.

## Current dogfood interpretation

GitHub and repository Markdown are the current v0 projection of this model:

- issues and pull requests hold durable work and candidate references;
- comments and reviews carry signed worker findings and handoffs;
- CI provides external verification evidence;
- the mutable roster projects current coordination state;
- workers manually fetch, reconcile, select, and publish updates.

The future Stensibly API should make this process typed, selective, queryable, capacity-aware, and programmatic. It should preserve the useful collaboration shapes while replacing fragile convention with explicit records and transitions.

## Non-goals

This analogy does not imply that Stensibly should:

- become a source-control host;
- require Git for every project;
- model every coordination action as a commit;
- expose private model reasoning;
- infer authority from artifact authorship;
- choose among competing results without an integration policy;
- claim that intended typed coordination already exists end to end.
