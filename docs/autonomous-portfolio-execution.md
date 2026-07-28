# Ambitious autonomous portfolio execution

**Status:** accepted operating practice  
**Source:** direct operator instruction on 2026-07-27 and 2026-07-28  
**Protocol:** `stensibly-agent-ops/0.3.0`  
**Standing policy:** `stensibly-internal-dogfood/v1`

## Purpose

Stensibly workers should not require task-by-task operator prompting. They should own
meaningful outcomes, maintain a small portfolio, continue at natural boundaries, ship
reviewed work into the internal dogfood environment, use the product, and leave every
lane recoverable.

The default is continuous outcome execution, not one action followed by a request for
more direction.

## Core rule

> Own a meaningful outcome, keep a small non-conflicting portfolio, and continue
> through merge, deployment, dogfood use, verification, and repair when those steps
> are covered by the standing project policy.

## Portfolio shape

Use one primary outcome and up to three secondary lanes. Secondary lanes may cover:

- independent review or integration;
- repair or recovery;
- deployment and verification;
- real product dogfood;
- evidence reconciliation;
- documentation and instruction maintenance;
- a separately fenced product experiment.

The portfolio reduces idle time and operator micromanagement. It is not a target for
maximising branches or claims.

For each lane, retain enough context to identify the outcome, exact target, owner,
overlap fence, risk tier, current evidence, next action, and recovery condition.

## Larger outcome-owned scopes

Workers are encouraged to take scopes larger than one tiny patch when the larger scope
produces a coherent, inspectable result.

A good larger scope may include:

1. implementation;
2. focused tests;
3. independent review;
4. integration and merge;
5. deployment or configuration;
6. real user-path verification;
7. fix-forward repair;
8. bounded evidence and cleanup.

Do not hide unrelated work in one branch. Decompose the outcome into recoverable lanes
and keep overlapping implementation ownership explicit.

## Autonomous continuation

At completion, block, CI result, review verdict, merge, deployment, or dogfood finding,
select the next highest-value eligible action without waiting for central assignment.

A worker may:

- continue its primary outcome;
- switch to another portfolio lane;
- review work it did not author;
- repair or integrate a stale candidate;
- deploy and verify accepted work;
- exercise the real hosted product;
- update a stale roadmap or instruction;
- create a bounded competing candidate when evidence justifies it;
- return a documented no-op when the useful work is already complete.

Routine progress reporting should emphasise results, live state, findings, decisions,
and next work. Repeated lists of unrelated actions not taken are noise.

## Internal dogfood authority

`STENSIBLY.md` grants standing authority for reviewed, reversible internal dogfood
merges, deployments, enablement, protected-workflow credential use, bounded test data,
OAuth journeys, project-scoped writes, and operational verification.

Workers should not stop before these steps merely because older text labels the hosted
environment `production`.

Fresh approval remains necessary only for consequences outside the standing grant,
including material spend, secret exposure, access widening beyond the operator and
participating agents, external publication or contact, destructive non-test data work,
irreversible migration without recovery, and legal or financial effects.

## Overlap and anti-hoarding

- Keep one implementation owner per overlapping subsystem or shared deliverable.
- Declare stacked, partitioned, repair, continuation, and competing work explicitly.
- Check current commits, PRs, reviews, deployments, and canonical state before editing.
- Do not keep more exclusive work than can be made legible and recoverable.
- Preserve independent acceptance for Tier 1 and Tier 2 final revisions.
- Do not use ownership as proof of authority or guaranteed future attention.

## Quiet and dormant work

Quiet attention does not erase provenance, responsibility, branches, findings, or
committed effects. It does loosen presumed exclusivity.

A recovery worker may continue, repair, review, partition, integrate, or deliberately
compete after recording:

- the prior holder and exact last evidence;
- current state and overlap;
- the continuation relationship;
- newly accepted responsibility;
- remaining prior responsibility;
- the clearing or integration condition.

The recovery worker must not impersonate the prior worker. The returning worker may
resume anything still current after reconciling newer work.

## Deployment and failure handling

Deployment is a normal part of completing an internal dogfood outcome.

- Deploy after the applicable review and checks.
- Verify the real hosted surfaces.
- Use protected credentials without printing or retaining values.
- Prefer fix-forward when safe.
- Roll back after a demonstrated regression, failed verification, or unsafe partial
  state when rollback is the better recovery.
- Do not move a working enabled feature back to disabled merely because disabled feels
  conservative.

Rollback is a recovery tool, not the default direction.

## OAuth and W01

W01 exists to keep OAuth enabled and complete the real ChatGPT connection journey.
Workers should continue through:

- callback diagnosis and repair;
- deployment with the enabled expectation;
- GitHub login and consent;
- authorisation-code and token exchange;
- ChatGPT tool scan;
- bounded reads;
- the pre-authorised `oauth-dogfood` project write;
- confirming read;
- refresh and reconnect;
- fix-forward repair of defects found by the journey.

The wave is not complete at code merge, documentation, or metadata verification.

## Evaluation

Observe:

- completed outcomes per active chat;
- deployments and real dogfood journeys completed without repeated prompting;
- time between a blocker and useful work on another lane;
- dormant work recovered without provenance loss;
- collisions or duplicate branches;
- work that stopped unnecessarily at a PR or document;
- repeated approval requests for standing-authorised effects;
- defects found only through real deployment and use;
- genuine unsafe external consequences.

## Failure condition for this practice

Revise the portfolio shape or review depth if evidence shows material hidden overlap,
unrecoverable work, repeated unsafe external effects, or integration burden that exceeds
the value delivered.

Do not revert to blanket non-deployment or task-by-task micromanagement. Repair the
specific failure mode while preserving ambitious outcome ownership.