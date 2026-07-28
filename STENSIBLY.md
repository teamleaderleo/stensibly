# Stensibly project policy

**Policy:** `stensibly-internal-dogfood/v1`  
**Source:** direct operator instruction, 2026-07-28  
**Scope:** `teamleaderleo/stensibly` and its operator-controlled hosted environments

## Project context

Stensibly is currently an internal one-person, many-agent studio. It has no external
customers or unrelated users to protect from ordinary dogfood iteration. The operator
and participating agents are building, deploying, using, breaking, repairing, and
improving the product together.

This context changes the default operating posture.

## Default: be ambitious and finish the outcome

Workers should own meaningful outcomes, not stop after the smallest safe-looking
artifact. When reviewed work naturally leads to integration, deployment, configuration,
enablement, migration of bounded test state, or real dogfood use, continue through
those steps and verify the result.

The normal sequence is:

1. inspect current state and overlapping work;
2. implement a coherent outcome;
3. test and review at the level justified by actual risk;
4. merge promptly;
5. deploy or enable when needed for the outcome;
6. exercise the real product path;
7. fix forward when verification exposes a defect;
8. leave durable evidence and the next useful continuation.

Do not stop at a proposal, documentation packet, pull request, or rollout plan when the
next executable step is available and covered by this standing policy.

## Standing internal-dogfood grant

The operator grants workers standing authority to perform the following inside the
operator-controlled Stensibly dogfood environment, subject to the repository's normal
review and evidence requirements:

- merge accepted repository changes;
- deploy reviewed code to the Stensibly hosted dashboard, Worker, and Convex dogfood
  deployments;
- enable or reconfigure internal product capabilities;
- use protected credentials through reviewed workflows or protected environments;
- create, update, complete, and clean up bounded test records in dedicated dogfood
  workspaces and projects;
- run migrations and repair operations that are bounded, reversible, tested, and
  limited to internal dogfood state;
- perform OAuth login, consent, token exchange, refresh, reconnect, tool discovery,
  reads, and bounded project-scoped writes;
- collect content-minimised operational evidence;
- choose and execute a fix-forward or rollback response after a demonstrated failure.

Protected secret values must stay inside the protected execution surface. Using a
credential is normal authorised work; printing, copying, publishing, or retaining the
secret value is not.

## Deployment is not automatically Tier 3

The word `production` in this repository often means the live internal dogfood
installation. It does not by itself make an action exceptional.

Classify an internal deployment or enablement by its real consequences:

- **Tier 0:** documentation or mechanical repository-only work;
- **Tier 1:** reversible internal deployment, configuration, UI, or runtime work with
  narrow impact and strong verification;
- **Tier 2:** authentication, authorisation, schema, durable-state, compatibility, or
  broader internal effects requiring independent exact-head review and an integration
  decision;
- **Tier 3:** effects beyond the internal dogfood boundary or effects that create
  material external, financial, destructive, irreversible, or access-widening
  consequences.

An internal deployment does not require a fresh human approval merely because it
changes the live dogfood environment. The direct operator instruction embodied in this
policy is the standing grant.

## What still requires explicit operator approval

Obtain fresh explicit approval before:

- increasing paid capacity, incurring material spend, or purchasing a service;
- exposing, copying, or rotating a credential except as a necessary bounded recovery
  action;
- widening access beyond the operator and participating agents;
- publishing or contacting external people or systems as the operator;
- deleting or irreversibly transforming non-test data;
- performing an irreversible migration without a tested recovery path;
- taking legal, financial, contractual, or other real-world action outside the
  internal Stensibly dogfood environment.

These boundaries are consequence-based. Do not invent an approval requirement for an
internal reversible action already covered by the standing grant.

## Rollback and caution

Rollback is a recovery technique, not the default product strategy.

- Prefer completion and fix-forward when the deployed state is healthy enough to
  repair safely.
- Roll back when a demonstrated regression, failed verification, or unsafe partial
  state makes rollback the better recovery path.
- Do not move a working enabled capability back to disabled merely because disabled
  feels more conservative.
- Preserve a recovery point for consequential changes, but do not treat the existence
  of a rollback plan as a reason to avoid shipping.

## Obsolete blanket defaults

The following interpretations are superseded for this project:

- “Do not deploy unless the operator separately approves every deployment.”
- “Production enablement is always Tier 3.”
- “Stop after opening a PR or writing a rollout plan.”
- “Ask before every bounded internal test write.”
- “Prefer rollback or disablement whenever authority wording is ambiguous.”
- “List every production action that was not taken.”
- “Wait for another operator ping after each completed action.”

When older instructions conflict with this file, apply this narrower standing project
policy and record the conflict for later cleanup.

## Communication

Report what changed, what was learned, what is live, and what happens next. Do not pad
updates with inventories of actions not taken. Mention a boundary only when it actually
changes the next action.

## Success measure

The policy is working when workers deliver larger coherent outcomes, deploy and use the
real product, recover each other's dormant work, reduce operator micromanagement, and
finish W01 through a real ChatGPT OAuth read/write/refresh/reconnect journey.