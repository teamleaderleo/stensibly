# Workspace survey snapshot

Stensibly exposes a read-only `survey_workspace` MCP tool that compiles one bounded snapshot from current ledger state.

Use it when a caller explicitly needs a workspace/project overview, a recovery comparison, or a material-change discriminator. It does not claim work, run models, create notifications, or own an ongoing scheduling loop.

## What the survey returns

Each response includes bounded current facts such as:

- counts across work statuses;
- per-project counts and latest activity;
- ready candidates;
- active work ordered by lease urgency;
- invalid, expired, and soon-expiring claim groups;
- blockers and recent completions;
- a SHA-256 fingerprint over material ledger state;
- `changed` when the caller supplies a previous fingerprint;
- `notifyRecommended` as an advisory projection over that snapshot.

Elapsed seconds are excluded from the fingerprint. Equivalent material ledger state produces the same material fingerprint even when the clock advances inside one urgency class.

## MCP input

```json
{
  "project": "glaeda",
  "limit": 10,
  "expiringWithinSeconds": 900,
  "previousFingerprint": "sha256:..."
}
```

All fields are optional. An all-project read principal may omit `project`; a principal with a project allowlist must remain inside its authorised project scope.

## Appropriate uses

### Fresh explicit overview

A worker/operator that needs a bounded overview may call `survey_workspace` once, then inspect the specific work/provider records that affect its decision.

For ordinary worker bootstrap, direct composition is usually clearer:

```text
enrol_worker
-> list_work / get_brief
-> inspect exact item/provider facts
-> claim_work atomically
-> get_runner_context
```

### Compare with a previously observed snapshot

A caller that already holds a prior survey fingerprint may pass it back to distinguish materially equivalent ledger state from changed state.

The prior fingerprint is a cache/comparison input. It creates no wake subscription, polling obligation, claim, authority, or current-state guarantee.

### Recovery/diagnostics

A diagnostic tool may use the survey to answer questions such as:

- did the ledger materially change between two explicit observations?;
- which leases are currently expired or nearing expiry?;
- which project currently contains ready work or blockers?;
- is a previously observed summary stale?

The caller then reads the owning work/run/provider records before acting.

## Ongoing coordination

Use event/condition owners for ongoing future work:

- #46 — durable wake conditions;
- #327 — explicit material event -> cross-item wake intent;
- run/lease liveness — execution-attempt owner;
- human decisions — typed decision owner;
- provider-effect ambiguity — command/receipt reconciliation.

Do not create periodic worker/supervisor polling merely because `survey_workspace` exposes a fingerprint. Scheduled polling remains an explicit fallback for sources that cannot provide a suitable event or for a deliberate external diagnostic task.

A scheduler or external client that chooses to poll owns its own cadence and cost. Stensibly's survey result does not recommend a recurrence.

## Authority boundary

Survey output is read-only evidence. `ready`, `urgent`, `changed`, ranking, or `notifyRecommended` grants zero responsibility, approval, provider authority, or execution capability.

Any mutation must pass through its owning atomic claim/command/approval boundary using current generations/state.

## Deletion rule

If callers can obtain the same bounded overview directly from owner-specific read APIs with equal material-change identity, delete `survey_workspace` instead of keeping a redundant aggregate surface.

— Kestrel
  Intention: keep one useful snapshot while ongoing work moves through events and exact owners
