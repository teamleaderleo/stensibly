# Custodian automation policy

The custodian inspects durable work state and applies a deliberately narrow automation policy.

## Modes

| Mode | Writes | Purpose |
| --- | --- | --- |
| `observe` | No | Default. Report findings and every elapsed claim eligible for reconciliation. |
| `dry-run` | No | Emit the exact bounded action plan that `apply` would attempt. |
| `apply` | Yes, narrowly | Reconcile up to `--max-actions` elapsed claims within the selected scope. |

Examples:

```sh
bun run custodian
bun run custodian --dry-run --project scrapbook --max-actions 20
bun run custodian --apply --project scrapbook --max-actions 20
```

## Allowed automation

The only automatic action is `expire_claim` after the stored claim expiry is already at or before the custodian run time. The write uses compare-and-set conditions, returns the item to `ready`, clears the holder and expiry, advances the item version, and appends `claim.expired`.

Applied expiry events include:

- `automation.source: "custodian"`
- the policy version
- the execution mode

If the claim changes after inspection, apply mode skips it rather than overriding newer state.

## Findings that remain non-automatic

The custodian may report, but never automatically resolve:

- live claims approaching expiry
- missing next actions
- stale ready work
- stale blocked work
- duplicate active titles

It does not block, unblock, complete, hand off, reassign, merge, archive, or rewrite work. Those are semantic decisions and stay with a human or an explicitly authorized agent workflow.

## Scope and limits

`--project <slug>` constrains both inspection and apply mode to that project. A project-scoped run never reconciles another project's claims.

`--max-actions <count>` bounds dry-run and apply mode. Observe mode still reports all eligible claims because it does not write.

## Exit status

`--fail-on-findings` sets exit status `2` when the pre-action report contains any findings. Configuration or runtime errors use exit status `1`.
