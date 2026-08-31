# Stensibly project policy

**Policy:** `stensibly-internal-dogfood/v2`  
**Source:** direct operator instruction, 2026-07-29  
**Scope:** `teamleaderleo/stensibly` and its operator-controlled hosted environments

```stensibly
{
  "version": 1,
  "project": "stensibly",
  "repositories": [
    "teamleaderleo/stensibly"
  ],
  "runnerProfiles": [
    "codex-default"
  ],
  "concurrency": {
    "project": 8,
    "global": 8
  },
  "autonomousActions": [
    "inspect",
    "propose",
    "record_progress",
    "attach_artifact",
    "create_branch",
    "commit",
    "push",
    "create_draft_pr",
    "review",
    "merge",
    "deploy",
    "configure_internal_dogfood",
    "oauth_journey",
    "bounded_test_write",
    "provider_read",
    "provider_write",
    "fix_forward",
    "rollback"
  ],
  "approvalRequired": [
    "material_spend",
    "external_publication",
    "external_contact",
    "access_widening",
    "secret_exposure",
    "destructive_non_test_data",
    "irreversible_migration",
    "legal_effect",
    "financial_effect"
  ],
  "checks": [
    "bun run typecheck",
    "bun run test",
    "bun run test:convex",
    "bun run worker:check"
  ],
  "tags": [
    "internal-dogfood",
    "convex",
    "cloudflare",
    "mcp",
    "github"
  ],
  "relatedProjects": []
}
```

## Goal

Deliver Stensibly as the durable coordination and product layer for a one-person,
many-agent studio, including a real hosted ChatGPT OAuth
read/write/refresh/reconnect journey.

## Boundaries

Keep autonomous work inside `teamleaderleo/stensibly` and its operator-controlled
internal-dogfood environments. The standing grant covers reviewed, reversible
repository, deployment, configuration, OAuth, provider, bounded test-data, migration,
and recovery work described below.

Fresh operator approval is required for material spend, external publication or
contact, access widening beyond the operator and participating agents, exposing or
copying a raw credential, credential rotation except a necessary bounded recovery
action, destructive non-test data changes, irreversible migrations without recovery,
and legal or financial effects outside the project. These boundaries are
consequence-based.

Protected secret values stay inside protected execution surfaces. Credentials may be
used through authorised workflows or environments; raw values stay out of repository
text, issues, pull requests, chat, logs, screenshots, tests, and retained artifacts.

## Evidence and handoff expectations

Record exact commits, pull requests, checks, deployments, Worker version IDs, provider
receipts, live dogfood results, failures, recovery points, and the next executable
action when they affect continuation or recovery. Outcomes and verification must
survive the chat that produced them; continue through an authorised completion step
instead of stopping at a proposal or pull request.

## Escalation

Escalate only when the next necessary effect crosses the standing internal-dogfood grant, when a destructive or irreversible consequence lacks recovery, when protected
credentials cannot remain inside their execution surface, or when an operator choice
would materially change product direction. Diagnose concrete failures inside the grant
and fix forward or roll back with durable evidence.

## Standing internal-dogfood grant

The hosted installation is an internal dogfood environment even where repository text
calls it `production`. Within the scope above, workers have standing authority for the
`autonomousActions` declared in the policy block and for bounded, reversible, tested
migrations/repairs of internal dogfood state needed to complete those actions.

That includes ordinary repository publication and merge, internal deployment and
configuration, OAuth journeys, project-scoped provider reads/writes, bounded test-data
changes, use of protected credentials inside reviewed execution surfaces, operational
verification, fix-forward, and rollback. A direct operator instruction in the active
chat to proceed, fix, merge, deploy, test, connect, or finish a covered action is its
current integration decision.

Relevant accepted changes merged to `main` should follow the repository's normal
automatic delivery path after validation. Manual delivery is a recovery or exceptional
control path when the owning workflow requires it.

## Review and integration

For covered reversible internal-dogfood work, the same worker may implement,
self-review, integrate, merge, deploy, and verify. Self-review must:

- re-fetch and inspect the exact candidate being integrated;
- inspect the complete diff and relevant runtime, data, privacy, and recovery
  boundaries;
- run or confirm relevant exact-head checks;
- distinguish concrete unresolved blockers from stale, optional, or superseded review
  comments;
- refresh current authority and mutable provider state that affects the decision; and
- make an explicit integration decision with enough durable evidence for recovery.

Independent review is required when the operator explicitly requests it or the actual
consequence leaves this standing grant. It is otherwise useful when another perspective
can materially reduce residual uncertainty. Callsign, session, or label changes never
create independence.

Review validity is bound to its declared candidate/source revision, relevant base/merge
context, policy/contract version, and external evidence. Movement of `main` alone does
not invalidate an unchanged review when those inputs remain equivalent; a material
reviewed-input change does.

## Completion and recovery

Own the useful outcome through investigation, implementation, deterministic
verification, justified review, integration, deployment/configuration when needed,
real use/readback, and recovery. Deployment is a normal completion step when required
to deliver or verify a covered internal result.

Use the canonical command/receipt/reconciliation boundary for consequential provider
effects: bind exact target, inputs, current authority, and idempotency before dispatch;
reconcile ambiguous outcomes before retry; preserve durable receipts and recovery
points. See [the product model](docs/product-model.md) and
[coordination correctness](docs/coordination-correctness.md) for those invariants.

Prefer fix-forward while deployed state is safe to repair. Roll back after a
demonstrated regression, failed verification, or unsafe partial state when rollback is
the better recovery path.

## Operator-only prerequisites

When progress genuinely requires a human-only action, put the `Operator action
required` block first in the owning record and follow
[`docs/operator-action-required.md`](docs/operator-action-required.md). Do not use this banner for work agents can complete. Request the minimum protected action and observable clearing evidence. Never ask the operator to paste a token, key, secret, recovery code, session value, or other private credential
into GitHub, chat, logs, screenshots, tests, or artifacts.

## Visual direction

Stensibly is a no-gradient product. Do not add CSS gradients, gradient masks, or
rendered gradient fills unless the operator explicitly requests an exception for a
specific surface. Use flat colour, borders, spacing, typography, and state markers.

## Semantic owners

Use one owner for each durable rule:

- [`docs/product-model.md`](docs/product-model.md) — responsibility, authority,
  canonical state owners, continuations, and product boundaries;
- [`docs/coordination-correctness.md`](docs/coordination-correctness.md) — commands,
  idempotency, fences, receipts, retries, ambiguity, and reconciliation;
- [`docs/agent-nomenclature.md`](docs/agent-nomenclature.md) — worker/run/callsign and
  other execution identities;
- [`docs/engineering-handbook.md`](docs/engineering-handbook.md) — code-level
  invariants and contributor conventions;
- [`docs/operations.md`](docs/operations.md) — hosted deployment, verification,
  bindings, logs, rollback, and credential placement;
- [`docs/mail-continuation.md`](docs/mail-continuation.md) — mail-based continuation;
- [`docs/operator-action-required.md`](docs/operator-action-required.md) — human-only
  prerequisite format and secret-safe escalation.

Git history preserves superseded wording and programme history; evergreen startup docs
should point to the current owner instead of repeating it.
