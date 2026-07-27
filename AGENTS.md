<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

# Agent entry point

**Operating protocol:** `stensibly-agent-ops/0.1.1`  
**Status:** dogfood  
**Change lifecycle:** `docs/operating-instruction-lifecycle.md`

Stensibly is the durable coordination layer for a one-person, many-agent studio.
Individual chats, processes, names, and model sessions are temporary. Work,
authority, evidence, decisions, commitments, and reusable knowledge must survive
them.

## Start here

Before changing code or creating new work, read in this order:

1. Read this file.
2. Read `docs/current-wave.md` when it exists. Treat it as the current dogfood
   focus, not permanent product policy.
3. Read `README.md`.
4. Read `docs/product-model.md`.
5. Read the relevant issue, linked parent issues, open pull requests, review
   threads, and exact-head handoffs.
6. Read the repository-root `STENSIBLY.md` when present. It declares static
   project context and policy; it is never a live claim, approval, credential,
   lease, or authority grant.
7. When touching Convex, read `convex/_generated/ai/guidelines.md` before editing.

Do not begin by creating another issue or implementation branch. First determine
whether existing work should be finished, reviewed, repaired, integrated,
unblocked, or explicitly superseded.

If a ChatGPT Project bootstrap names an older protocol version, follow the
repository version and report the bootstrap drift. The pasted Project setting is
an entry point, not the source of truth.

## Operating model

Workers are ephemeral generalists. Do not assign permanent employee-style
identities such as manager, IC, product, security, or marketing. A worker may
take a temporary stance for one action or run: implementation, review,
exploration, synthesis, coordination, rollout, or another useful approach.

Keep these dimensions separate:

- **Pod:** durable collective context, commitments, practices, and lineage.
- **Wave:** longer span pursuing one meaningful outcome.
- **Lane:** medium-lived coherent thread within a wave.
- **Action:** small executable next step.
- **Run:** one bounded worker attempt.
- **Callsign:** disposable display name for one worker or run.
- **Mantle:** optional reusable, versioned presentation and practice bundle.

Pod names, worker names, mantles, roles, issue assignment, and GitHub identity do
not grant authority. Current server-owned claims, approval records, and project
policy remain authoritative.

## Work-selection rule

Prefer, in order:

1. consequential decisions or expiring responsibilities waiting for attention;
2. independent review or acceptance that can close existing work;
3. integration, repair, or unblocking of active work;
4. ready actions that directly advance the current wave;
5. new exploratory work only when higher-value executable work is unavailable.

Use one implementation owner for overlapping code. Parallel workers should take
non-overlapping lanes such as independent acceptance, reproduction, research,
rollout preparation, or evidence reconciliation. A worker must not approve its
own consequential implementation as the only acceptance signal.

Workers are expected to act independently inside the current scope and authority
boundary. Do not wait for central assignment, unrelated reviewers, or a full-pod
check-in when a bounded action is ready and the applicable risk tier is satisfied.

## Risk-tiered review and merge

Choose review depth from demonstrated risk, scope, reversibility, and uncertainty;
do not choose it from worker headcount.

### Tier 0 — mechanical or documentation-only

Examples include isolated documentation, comments, formatting, generated-file
refreshes, test fixture corrections, and mechanical configuration with no runtime,
authority, security, data, deployment, dependency, or public-contract effect.

- Independent review is optional.
- The author or integration worker may merge after inspecting the exact diff,
  running relevant checks, confirming the head is unchanged and mergeable, and
  clearing concrete findings.
- Use `[skip review]` or `review-exempt` when automated review would add little
  useful evidence.

### Tier 1 — bounded low-risk runtime change

Examples include a small local helper, typed renderer, narrow validation repair,
or isolated behaviour with straightforward rollback and no authorization,
privacy, schema, migration, durable-state, data-loss, deployment, or broad
compatibility boundary.

- Require one independent exact-head `ACCEPT` plus green relevant checks.
- Once the head is unchanged, mergeable, green, and free of unresolved blocking
  threads, the integration worker may merge without another ceremonial wait.

### Tier 2 — elevated or broad change

Use this tier for authentication or authorization, privacy, schema or migration,
durable state machines, exactly-once effects, data retention or deletion,
cross-project isolation, public protocol changes, dependencies, broad
compatibility, or changes whose rollback is uncertain.

- Require at least one independent exact-head acceptance and an explicit
  integration decision.
- Add a second or specialist review when the change spans multiple high-risk
  boundaries, evidence conflicts, tests cannot cover the failure mode, or the
  first reviewer records material residual uncertainty.
- Competing candidates require an independent integration owner who did not
  author the selected final revision.

### Tier 3 — consequential operation

Production deployment or enablement, credentials, permission widening,
destructive data operations, spending, external publication, irreversible
migration, and comparable real-world effects require contemporaneous human
approval unless a narrower standing policy explicitly grants them.

A known regression may be accepted as residual risk only when it is bounded,
reversible, documented, outside safety/authorization/privacy/data-loss
boundaries, and paired with a clear follow-up or rollback condition. Do not block
a useful low-risk change merely because it is imperfect; do not downgrade a
serious finding merely because the diff is small.

After the required evidence exists, merge promptly. Re-fetch the exact head,
current base, CI, mergeability, reviews, and unresolved threads immediately
before merging. Do not merge a moved head on stale acceptance.

## Before claiming or editing

- Confirm the exact issue, lane, action, repository, branch, and expected output.
- Inspect active pull requests and recent commits for overlapping work.
- Record or respect the current claim generation when Stensibly is available.
- State the files or subsystem you expect to touch.
- Classify the review and merge tier before handoff; record why deeper or lighter
  review is appropriate.
- Keep Tier 3 actions behind the applicable approval policy.

Until the ChatGPT MCP connection is enabled, GitHub is a temporary coordination
surface. Do not infer that a GitHub assignee or comment is a Stensibly claim.

## Completion and handoff

A run is incomplete until another worker can continue without its chat transcript.
Record:

- completed scope;
- exact branch, revision, PR, issue, and artifacts;
- changed files;
- commands and checks with results;
- self-review findings;
- independent review state and selected risk tier;
- blockers, accepted residual risks, uncertainty, and failed approaches;
- next owner or eligible continuation;
- exact next action and wake condition.

Release, block, complete, merge, or hand off accepted commitments explicitly.
Never let a worker simply disappear while remaining the only holder of necessary
context.

## Descriptive sign-off

Because many workers use the same GitHub account, end substantive comments,
reviews, and handoffs with a compact generated sign-off when the metadata is
known:

```text
— <Callsign or anonymous worker> · <pod or mantle, if any>
  Run: <run ID or chat-local identifier>
  Stance: <implementation | review | synthesis | rollout | ...>
  Work: <project / wave / lane / action>
  Revision: <exact commit SHA, when applicable>
```

The sign-off is attribution metadata, not authority or proof of competence.

## Surveys and improvement

When entering stale or confusing work, run a bounded survey before adding prose:
identify material changes, ready actions, stalled responsibilities, review gaps,
conflicting guidance, and a possible no-op result. Separate observations from
recommendations.

After meaningful work, record reusable findings and improvement proposals with
provenance. Pod charters, prompts, practices, mantles, and this protocol should
evolve through versioned, reversible, evidence-backed changes rather than silent
rewriting.

Use `docs/operating-instruction-lifecycle.md` when proposing more or less context,
revised parallelism, pod tips, resource requests, audit repairs, or another change
to how workers are instructed. Local pod notes may remain local; promotion into
this shared protocol requires a reviewed proposal.

## Pull-request review workflow

- CodeRabbit is already configured to review non-draft pull requests automatically. Do not manually invoke it after every push.
- Greptile is an opt-in second review and runs only when the human operator applies the `deep-review` label. Do not apply that label or mention `@greptileai` unless explicitly asked.
- Keep a pull request in draft while actively iterating. Mark it ready when the change is coherent and the checks required by its risk tier pass.
- Do not request Codex GitHub reviews or mention `@codex review`. Codex usage is reserved for explicit implementation work requested by the human operator.
- Retrigger CodeRabbit or Greptile only when the human operator asks or when a requested review failed for a transient service reason.
- Verify every automated finding against the current code. Prioritize demonstrated correctness, authorization, security, data-loss, state-machine, compatibility, and contract issues.
- Ignore or explain away speculative style, blanket documentation, duplication, and refactoring suggestions that do not improve behavior or reduce a concrete maintenance risk.
- Do not involve every worker by default. Request only the independent or specialist review justified by the selected tier.
- An `ACCEPT` applies only to the exact reviewed revision. A bounded documented residual risk may remain; a concrete unresolved blocker may not.
- Use the `review-exempt` label or `[skip review]` in the title for Tier 0 changes where automated review would add little value.
