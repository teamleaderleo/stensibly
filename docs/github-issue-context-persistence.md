# Accepted GitHub issue context persistence

Issue #492 keeps GitHub independently usable as the public project record while allowing Stensibly to retain one bounded, attributable view of selected GitHub issues.

This slice adds repository-native SQLite persistence for the canonical `GitHubIssueContext` contract. It does not fetch or mutate GitHub, import issue bodies, or change Stensibly execution authority.

## Stored identity

Every accepted row is scoped by all of:

- workspace;
- project;
- stable external issue identity, such as `github:teamleaderleo/stensibly#403`;
- provider source revision;
- accepted repository instruction-set identity.

Reads require the workspace, project, and external identity. A matching issue number in another repository, project, or workspace is a different record.

The append-only row stores:

- the bounded canonical issue snapshot from `src/github-issue-context.ts`;
- snapshot and content fingerprints;
- provider `updatedAt` and source revision;
- the exact accepted project attachment ID and snapshot fingerprint;
- an exact accepted instruction-set identity;
- synchronization status and optional cursor;
- a bounded observation reference and observation time;
- accepting actor and acceptance time;
- whether the row is the current accepted view;
- the acceptance outcome.

The already-landed issue snapshot contains only issue-body presence, byte length, and a hash. This table does not add raw issue bodies, comments, reviews, private links, or unrestricted provider history.

## Project attachment binding

An acceptance must name the current project attachment ID and its exact snapshot fingerprint. The write fails when:

- the project has no accepted attachment;
- the supplied attachment ID or fingerprint is stale or invented;
- the issue repository is not declared by the accepted attachment.

The accepted attachment remains the static repository-policy contract from #217 and #253. This table references that contract; it does not parse `STENSIBLY.md`, compare authority, or create another attachment system.

Historical GitHub context rows keep their original attachment binding after a newer attachment is accepted. This preserves which project contract governed each acceptance.

## Instruction-set identity

`buildAcceptedRepositoryInstructionSet()` binds the accepted attachment to an explicit bounded list of repository instruction sources. Each source contains:

- a relative traversal-free repository path;
- an opaque stable revision;
- a SHA-256 content fingerprint.

Typical sources include:

- `AGENTS.md`;
- `README.md`;
- `docs/current-wave.md`;
- `docs/product-model.md`;
- applicable nested instruction files.

Sources use explicit Unicode code-unit ordering. Equivalent input order therefore produces the same instruction-set fingerprint and `instructions_<sha256>` identity across runtimes and locales.

The identity proves which repository inputs were accepted as context. It is not a capability, lease, approval, credential, or proof that a worker followed those instructions.

## Acceptance outcomes

The SQLite transaction classifies each write as one of:

- `initial` — first current observation for the scoped issue;
- `updated` — changed provider revision with a non-stale provider `updatedAt`;
- `stale` — changed provider revision whose provider `updatedAt` predates the current view;
- `instruction_rebound` — identical provider content accepted under a changed instruction set.

Current replacement is transactional. `initial`, `updated`, and `instruction_rebound` rows become current and clear the prior current flag. A `stale` row remains durable evidence but never replaces the current accepted view.

Provider timestamps help classify freshness but do not grant authority. A later synchronization adapter must still use provider cursors, ETags, delivery identities, or exact fetched revisions where available.

## Replay and conflict rules

The same workspace, project, issue, source revision, snapshot content, and instruction set is an idempotent replay. The original row is returned and no second row is written.

The same issue and source revision with changed content fails closed with `GitHubIssueContextConflictError`. This is altered-revision reuse, not an update.

The same snapshot and provider revision may be appended under a changed instruction set. That is an explicit `instruction_rebound` row so future run context can identify instruction drift without pretending GitHub changed.

## Synchronization state

Each acceptance records either:

- `synchronized`; or
- `degraded` with a required bounded reason code.

A synchronized row cannot carry a degraded reason. The optional cursor and observation reference are evidence only. This slice does not create polling, webhook intake, retries, or provider reachability checks.

A connector outage may therefore leave a readable current row plus a later degraded observation. GitHub itself remains the recovery source and must not become hidden behind this projection.

## Integrity checks

Reads re-parse and verify:

- the canonical issue snapshot fingerprint;
- external identity, source revision, content hash, snapshot hash, and provider timestamp columns;
- the instruction-set fingerprint and ID;
- the project attachment binding duplicated in the row and instruction set.

Stored JSON or metadata tampering raises an error rather than returning a plausible-looking context.

SHA-256 is used for deterministic identity and consistency, not as a signature. The trusted database transaction and accepted project attachment establish which record is authoritative.

## API surface

The first storage API is intentionally narrow:

```ts
ensureGitHubIssueContextSchema(store)
acceptSqliteGitHubIssueContext(store, input)
getCurrentSqliteGitHubIssueContext(store, scope)
listSqliteGitHubIssueContextHistory(store, scope)
buildAcceptedRepositoryInstructionSet(input)
```

Every read and write is explicitly workspace/project scoped.

## Non-goals

This slice performs no:

- GitHub API or OAuth operation;
- webhook signature verification;
- polling or scheduled synchronization;
- outbound issue comment, label, assignment, body, relationship, state, or closure mutation;
- provider receipt or read-after-write reconciliation;
- REST, MCP, dashboard, or Convex projection;
- work-item creation, claim, lease, run, event, completion, or handoff;
- capability grant, approval, credential use, or provider authority transition;
- inferred relationship or semantic state transition between GitHub and Stensibly.

Closing a GitHub issue still does not complete Stensibly work. Completing Stensibly work still does not close GitHub.

## Next slice

A later reviewed #492 slice can expose this read model through one project-scoped REST/MCP projection and bind the accepted instruction-set ID into one context packet and run record. Outbound GitHub proposals, exact grants, receipts, ambiguity handling, and read-after-write verification remain a separate consequential-mutation lane.
