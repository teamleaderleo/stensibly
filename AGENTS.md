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

**Operating protocol:** `stensibly-agent-ops/0.2.0`  
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
5. Read `docs/pods/registry.yaml` for discovery. Read a candidate pod's charter
   and compact current memory only when that context may help the selected action.
   Read its practices or history only when the action needs that deeper context.
6. Read the relevant issue, linked parent issues, open pull requests, review
   threads, and exact-head handoffs.
7. Read the repository-root `STENSIBLY.md` when present. It declares static
   project context and policy; it is never a live claim, approval, credential,
   lease, or authority grant.
8. When touching Convex, read `convex/_generated/ai/guidelines.md` before editing.

Reading pod files is discovery, not participation. It does not enrol a worker,
add a pod sign-off, accept a commitment, or imply affiliation. Declare pod
participation explicitly before representing yourself as participating.

Do not begin by creating another issue or implementation branch. First determine
whether existing work should be finished, reviewed, repaired, integrated,
unblocked, or explicitly superseded.

If a ChatGPT Project bootstrap names an older protocol version, follow the
repository version and report the bootstrap drift. The pasted Project setting is
an entry point, not the source of truth.

## Operating model

Workers are ephemeral generalists. Do not assign permanent employee-style
identities such as manager, IC, product, security, or marketing. A worker may
take a temporary approach for one action or run: implementation, review,
exploration, synthesis, coordination, rollout, or another useful approach.

Keep these dimensions separate:

- **Pod:** durable collective context, commitments, practices, and lineage.
- **Wave:** longer span pursuing one meaningful outcome.
- **Lane:** medium-lived coherent thread within a wave.
- **Action:** small executable next step.
- **Run:** one bounded worker attempt.
- **Callsign:** stable session attribution for one worker chat or run.
- **Mantle:** optional reusable, versioned presentation and practice bundle.

Pod names, worker names, mantles, roles, issue assignment, and GitHub identity do
not grant authority. Current server-owned claims, approval records, and project
policy remain authoritative.

Choose one short callsign near session start and keep it stable for that
conversation. Do not impersonate another worker or imply identity continuity
with a different chat. A successor may continue another worker's handoff or wear
a mantle, but must state that boundary explicitly.

For human-started interactive chats, silence is not automatic expiry. Before the
configured freshness threshold a worker may be quiet; after the current eight-hour
dogfood threshold treat it as dormant, not expired. Dormancy removes assumptions
of availability or exclusive active execution while preserving history and making
unfinished work recoverable or shareable. The same chat may resume under the same
callsign after reconciling current state. Claims, leases, approvals, credentials,
and other authority expire under their own independent policies.

## Temporary pod bootstrap

Until typed pod and participation records exist in Stensibly, `docs/pods/` is a
readable bootstrap for pod discovery, explicit run-scoped participation, charters,
reusable memory, practices, history, and pod proposals.

- Foundry is the broad default **context candidate** when no better open pod exists.
  It is not automatic participation.
- Pod participation is temporary, non-exclusive, and descriptive; it does not
  create authority or responsibility.
- Join, switch, resume, and leave through the declaration and handoff protocol in
  `docs/pods/enrolment.md`.
- Propose new pods only from recurring multi-run evidence, with a trial and a
  reversible migration or dissolution path.
- Never store secrets or unbounded transcripts in pod memory.
- Treat source issues, commits, reviews, artifacts, and ledger records as
  canonical; Markdown remains a projection.

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
own implementation as the only acceptance signal.

## Before claiming or editing

- Confirm the exact issue, lane, action, repository, branch, and expected output.
- Inspect active pull requests and recent commits for overlapping work.
- Record or respect the current claim generation when Stensibly is available.
- State the files or subsystem you expect to touch.
- Keep consequential actions—merge, deploy, credential changes, spending,
  external communication, destructive data operations, and permission widening—
  behind the applicable approval policy.

Until the ChatGPT MCP connection is enabled, GitHub is a temporary coordination
surface. Do not infer that a GitHub assignee or comment is a Stensibly claim or
that a quiet worker was notified by a comment.

When returning after quiet or dormant time, re-read the current issue, PR, branch,
revision, tests, reviews, and authority records. State what remains current, what
was completed, transferred, superseded, or forked, and what you are continuing or
releasing before modifying anything.

## Completion and handoff

A run is incomplete until another worker can continue without its chat transcript.
Record:

- completed scope;
- exact branch, revision, PR, issue, and artifacts;
- changed files;
- commands and checks with results;
- self-review findings;
- independent review state;
- blockers, uncertainty, and failed approaches;
- next owner or eligible continuation;
- exact next action and wake condition.

Release, block, complete, pause, or hand off accepted commitments explicitly. A
worker going quiet does not erase responsibility or prove termination; after the
freshness threshold, surface unfinished work as recoverable or shareable while
preserving the prior holder and exact evidence.

## Descriptive sign-off

Because many workers use the same GitHub account, end substantive comments,
reviews, and handoffs with a compact generated sign-off when the metadata is
known. The routine form is:

```text
— <Callsign> · <explicit pod context, if useful>
  Intention: <current bounded intention, if useful>
```

Reviews, decisions, handoffs, and succession records may add run ID, work address,
mantle/version, exact reviewed revision, verdict, previous holder, transfer record,
or next action when those fields aid inspection. Do not render a default `Stance`
or runtime/model label. A pod name belongs in the sign-off only after explicit
participation.

The sign-off is attribution metadata, not authority, identity proof, continuity
proof, membership, ownership, or competence.

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
- Keep a pull request in draft while actively iterating. Mark it ready only after the change is coherent and the claimed checks pass.
- Do not request Codex GitHub reviews or mention `@codex review`. Codex usage is reserved for explicit implementation work requested by the human operator.
- Retrigger CodeRabbit or Greptile only when the human operator asks or when a requested review failed for a transient service reason.
- Verify every automated finding against the current code. Prioritize demonstrated correctness, authorization, security, data-loss, state-machine, compatibility, and contract issues.
- Ignore or explain away speculative style, blanket documentation, duplication, and refactoring suggestions that do not improve behavior or reduce a concrete maintenance risk.
- Use the `review-exempt` label or `[skip review]` in the title for mechanical configuration changes, temporary verification pull requests, and other changes where automated review would add little value.
