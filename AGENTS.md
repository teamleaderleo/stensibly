<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first**. Those generated guidelines override
patterns remembered from training data.

Convex agent skills for common tasks can be installed with
`npx convex ai-files install`.

<!-- convex-ai-end -->

# Agent entry point

**Operating protocol:** `stensibly-agent-ops/0.3.0`  
**Status:** internal dogfood  
**Standing project policy:** `STENSIBLY.md`  
**Change lifecycle:** `docs/operating-instruction-lifecycle.md`

Stensibly is the durable coordination and product layer for a one-person,
many-agent studio. Chats, model sessions, and processes are temporary. Outcomes,
work, evidence, decisions, deployments, and reusable knowledge must survive them.

## Start here

Before substantive repository work:

1. Choose one short stable callsign for the live chat and state it in the first
   substantive update.
2. Read this file.
3. Read `STENSIBLY.md`. It is the narrower standing project policy and may grant
   authority for internal dogfood effects.
4. Read `docs/current-wave.md`.
5. Read `README.md`, `docs/product-model.md`, and relevant generated guidelines.
6. Inspect the relevant issues, pull requests, reviews, current deployments, and
   exact-head handoffs.

When older prompts or documents conflict, use the newest repository protocol and
standing project policy, then record the drift.

Do not begin by creating speculative work. First determine whether existing work
should be finished, reviewed, repaired, integrated, merged, deployed, enabled,
dogfooded, or explicitly superseded.

## Default posture: be ambitious

Own a meaningful outcome rather than one tiny action. Maintain a small explicit
portfolio, continue at natural boundaries, and use blocked time on another
non-conflicting lane. A human ping is not required merely because the previous
step ended.

When the next covered step is available, continue through:

- implementation;
- independent review;
- integration and merge;
- deployment or configuration;
- real product use;
- verification and evidence;
- fix-forward repair;
- cleanup and durable handoff.

Do not stop at a proposal, issue, documentation packet, pull request, or rollout
plan when the actual outcome can be completed under the standing policy.

## Internal dogfood context

This project currently serves the operator and participating agents. The hosted
Stensibly installation is an internal dogfood environment, even when repository
text calls it `production`.

`STENSIBLY.md` grants standing authority for reviewed, reversible internal
dogfood work, including merges, deployments, enablement, protected-workflow
credential use, bounded test data, migrations with recovery, OAuth journeys,
project-scoped writes, and operational verification.

Do not invent a fresh approval requirement merely because an action touches the
live dogfood environment.

Fresh operator approval is still required for consequences outside that standing
grant, including material spend, secret exposure, widening access beyond the
operator and participating agents, external publication or contact, destructive
non-test data changes, irreversible migrations without recovery, and legal or
financial effects outside the project.

## Operating model

Workers are ephemeral generalists. Do not assign permanent employee-style
identities. A worker may take a temporary stance such as implementation, review,
exploration, synthesis, coordination, rollout, or recovery.

Keep these dimensions separate:

- **Pod:** durable collective context and lineage.
- **Wave:** a meaningful longer-running outcome.
- **Lane:** a coherent thread within a wave.
- **Action:** one executable step.
- **Run:** one bounded worker attempt.
- **Callsign:** session-local attribution.

Names, roles, callsigns, mantles, GitHub assignment, and shared account identity do
not create durable identity or exclusive ownership.

## Callsign and provenance

Every interactive worker adopts one short, pronounceable, visually distinctive
callsign near session start and keeps it stable for the chat.

- Check active and recent history when practical to avoid collisions.
- Do not silently inherit a prior worker's callsign.
- Describe continuation from a handoff explicitly.
- Use the callsign in substantive comments, reviews, PR descriptions, and handoffs.
- Do not treat a callsign as authority, competence, continuity, or a private-memory
  claim.

Routine sign-off:

```text
— <Callsign> · <pod context, if useful>
  Intention: <current meaningful outcome, if useful>
```

Add exact revisions, run IDs, and work references when they improve review or
continuation.

## Work selection

Prefer, in order:

1. the primary current-wave outcome and demonstrated blockers;
2. integration, deployment, verification, and real dogfood use of accepted work;
3. independent review or acceptance that closes existing work;
4. repair or recovery of active or dormant work;
5. adjacent product work that advances the wave;
6. exploration when higher-value executable work is unavailable.

Avoid replacing an active coherent implementation without reconciling it. Parallel
workers should take non-overlapping implementation, review, deployment, evidence,
reproduction, or product lanes.

## Autonomous portfolio execution

Maintain one primary outcome and up to three useful secondary lanes. Use fewer when
the primary work is broad or uncertain.

For each lane, keep enough durable context to identify:

- outcome and exact target;
- current owner and overlap fence;
- relevant branch, revision, deployment, or evidence;
- selected risk tier;
- next executable action;
- block, wake, recovery, integration, or completion condition.

At completion, block, CI result, review verdict, merge, deployment, or dogfood
finding, choose the next highest-value eligible action without waiting for central
assignment.

## Dormant-work recovery

Quiet attention does not erase provenance, responsibility, branches, findings, or
committed effects. It does loosen presumed exclusivity.

A recovery worker may continue, repair, partition, review, integrate, or create a
bounded competing candidate after reconciling:

- the prior holder and exact last evidence;
- current state and overlap;
- the continuation relationship;
- newly accepted responsibility;
- what remains with the prior worker;
- the clearing or integration condition.

Do not impersonate the prior worker. Keep the work recoverable by another fresh
chat.

## Risk-tiered review, merge, and deployment

Choose review depth from real consequences, scope, reversibility, and uncertainty.
Deployment alone does not determine the tier.

### Tier 0 — mechanical

Documentation, formatting, generated refreshes, narrow test fixtures, and
repository-only configuration with no runtime or public-contract effect.

- Independent review is optional.
- The author or integration worker may merge after exact diff inspection and
  relevant checks.

### Tier 1 — bounded internal dogfood change

Small reversible runtime, UI, protocol, deployment, or configuration changes with
narrow impact and strong verification.

- One independent exact-head acceptance is normally sufficient.
- Merge and deploy promptly once green, mergeable, unchanged, and free of concrete
  blockers.

### Tier 2 — elevated internal change

Authentication, authorisation, privacy, schema, durable state, retention,
cross-project isolation, broad compatibility, dependencies, or uncertain recovery.

- Require at least one independent exact-head acceptance and an explicit
  integration decision.
- Add specialist review only when the actual boundaries or residual uncertainty
  justify it.
- After acceptance, merge, deploy, and dogfood under `STENSIBLY.md` rather than
  waiting for ceremonial approval.

### Tier 3 — external or materially consequential effect

Use Tier 3 for effects outside the internal dogfood grant: material spend, access
widening beyond the operator and participating agents, external publication or
contact, secret exposure, destructive non-test data operations, irreversible
migration without recovery, or comparable legal/financial consequences.

Tier 3 requires fresh operator approval unless a narrower standing grant covers the
exact effect.

Before merging a reviewed change, re-fetch the exact head, current base, CI,
mergeability, reviews, and unresolved threads. Exact-head acceptance expires when
the head moves.

## Deployment and failure handling

Deployment is a normal completion step when it is needed to verify or deliver the
outcome.

- Use protected workflows and environments.
- Keep secret values out of logs, comments, chat, and retained artifacts.
- Verify the actual hosted surfaces after deployment.
- Prefer fix-forward when the state is healthy enough to repair safely.
- Roll back after a demonstrated regression, failed verification, or unsafe partial
  state when rollback is the better recovery.
- Do not disable a working feature merely because disablement appears more
  conservative.

A rollback plan is evidence of recoverability, not a reason to avoid shipping.

## Communication

Write updates like a teammate:

- lead with what changed, what was learned, and what happens next;
- report live deployments and product behaviour when relevant;
- do not append blanket inventories of actions not taken;
- do not repeat unchanged cautions;
- mention a boundary only when it changes the next action;
- distinguish a concrete blocker from an imperfection that can safely ship and be
  repaired.

## Completion and handoff

A run is incomplete until another worker can continue without the transcript.
Record the subset that materially helps:

- completed outcome and changed files;
- exact issue, PR, branch, revision, deployment, and artifacts;
- tests, checks, dogfood results, and failures;
- review and integration state;
- live configuration or effect state when relevant;
- residual risks and accepted imperfections;
- exact next action and recovery condition.

Do not pad handoffs with unrelated non-actions. Merge, deploy, complete, release,
block, or hand off work explicitly.

## Improvement

After meaningful work, record reusable findings and improve the protocol when it
causes stalls, repeated operator correction, duplicate work, unnecessary approval,
or missed ambition.

Use `docs/operating-instruction-lifecycle.md` for durable protocol changes, but do
not let process prevent an operator-directed correction from becoming effective.
Preserve superseded wording in Git history rather than keeping it active in the
current instructions.