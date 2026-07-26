# Custodian automation policy

The custodian inspects durable work state and follows one deliberately narrow automation policy. This policy was extracted from closed PR #137 and rebuilt from current `main` without its stacked ancestry.

## Modes

| Mode | Writes | Purpose |
| --- | --- | --- |
| `observe` | No | Default. Report findings and every elapsed claim eligible for reconciliation. |
| `dry-run` | No | Emit the exact bounded action plan that `apply` would attempt from the same snapshot. |
| `apply` | Yes, narrowly | Reconcile up to `--max-actions` elapsed claims within the selected project scope. |

Examples:

```sh
bun run custodian
bun run custodian --dry-run --project scrapbook --max-actions 20
bun run custodian --apply --project scrapbook --max-actions 20
```

## Allowed automation

The sole automatic action is `expire_claim` after the stored claim expiry is at or before the custodian run time.

Planning records the exact:

- item ID and project;
- claimant;
- stored expiry;
- claim generation;
- item version.

Apply mode sends that snapshot to the canonical `expireClaims` operation. The write compares every recorded field, confirms the expiry remains elapsed, advances the canonical claim generation, returns the item to `ready`, clears the holder and expiry, advances the item version, and appends `claim.expired`. Any intervening renewal, reassignment, transition, generation change, or version change produces a `state_changed` skip.

Applied expiry events include durable metadata for:

- `automation.source: "custodian"`;
- the policy identifier;
- the policy version;
- the execution mode;
- the previous and next claim generations;
- the previous and next item versions.

Issue #217 owns the claim-fencing contract. Its local claim-generation foundation landed in PR #234 while this extraction was underway. Custodian reconciliation now consumes that canonical generation fence directly and adds no independent authority-clearing path.

## Backend boundary

The custodian command in this slice operates on the local SQLite store. Hosted Convex scheduled expiry remains a separate server-owned path and is outside this PR. This policy does not claim exact field-for-field parity with that scheduler, and it does not invoke or replace hosted expiry.

## Findings reserved for authorised decision-makers

The custodian reports these findings and leaves them unchanged:

- live claims approaching expiry;
- missing next actions;
- stale ready work;
- stale blocked work;
- duplicate active titles.

Automatic block, unblock, completion, handoff, reassignment, merge, archive, and content rewriting are prohibited. Those actions carry semantic intent and remain with a human or an explicitly authorised agent workflow.

## Scope and limits

`--project <slug>` constrains both inspection and apply mode to that project. A project-scoped run reads and reconciles claims from that project alone. A supplied empty or malformed project fails before inspection or reconciliation; only an omitted project requests an unscoped run.

`--max-actions <count>` bounds dry-run and apply mode. Observe mode reports every eligible claim because it performs zero writes. The canonical SQLite query applies this bound before returning candidates.

Eligible claims are ordered by stored expiry and then item ID, giving dry-run and apply the same deterministic action order.

## Exit status

`--fail-on-findings` sets exit status `2` when the pre-action report contains any finding, including an elapsed claim eligible for reconciliation. The exit decision deliberately reflects the observed pre-action state even when `apply` reconciles that claim during the same run. Configuration or runtime errors use exit status `1`.

## Transplanted material from PR #137

Adapted from #137:

- the `observe`, `dry-run`, and `apply` policy model;
- the bounded action result and audit vocabulary;
- CLI mode flags and help text;
- policy, scope, audit, and semantic-prohibition tests;
- this policy document.

Rebuilt for current `main`:

- read-only expired-claim discovery;
- exact snapshot planning with claim-generation and item-version comparison;
- project-scoped canonical expiry reconciliation;
- fail-closed public project-scope validation;
- concurrency and replay coverage for fenced claims;
- direct CLI parsing coverage.

The old `expireClaimIds` helper was deliberately left behind. It re-read claims by ID through a separate path. The replacement extends the canonical generation-fenced `expireClaims` operation introduced under #217.
