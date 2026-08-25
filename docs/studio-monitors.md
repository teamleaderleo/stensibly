# Studio status monitors (read-only)

- **Issue:** #1632 (monitor path)
- **Supersedes:** the August 17 wishlist entries `scripts/autonomous-worker-daemon.ts` and
  `scripts/night-shift-daemon.ts` (`abdbf928…`, `7580dfd…`)
- **Boundary test:** `test/studio-monitors-read-only.test.ts`

## In simple words / purpose

Two small helpers observe the studio and print what they see. They are monitors,
not runners: they hold no lease, claim no work, emit no approvals, dispatch
nothing, and settle nothing. The earlier names claimed autonomous behaviour the
code never had; the names, output, and tests now match the read-only reality.

## Commands

```bash
bun scripts/studio-brief-monitor.ts [--endpoint URL] [--token TOKEN] [--project P] [--once] [--poll-interval SECONDS]
bun scripts/overnight-studio-summary.ts [--endpoint URL] [--token TOKEN] [--project P] [--once] [--poll-interval SECONDS]
```

- **Studio brief monitor** polls the coordination ledger item list and prints an
  observed brief (in-motion / blocked / ready counts plus a suggested focus).
  Suggested items are observations only; claiming happens through the canonical
  ledger by whoever chooses to pick the work up.
- **Overnight studio summary** runs local repository health checks (git status,
  typecheck, focused dashboard tests) and takes one ledger snapshot for morning
  review. A failed ledger read degrades into a note instead of hiding local
  results.

The old daemons' unused `--callsign` / `STENSIBLY_CALLSIGN` input was dropped:
these monitors perform no authenticated writes, so there is nothing to
attribute. Callsigns remain owned by enrolment for actors who actually act.

## Read-only contract

1. The only network effect of either monitor is `GET /api/v1/items`.
   `src/studio-status-read-client.ts` is the sole module allowed to build that
   request. It refuses every other method or path before opening a connection.
2. Monitor scripts contain no fetch calls, no API path or endpoint literals, no
   mutation request markers, and import nothing outside the allowlisted
   dependency surface pinned by the boundary test.
3. The declared CLI flag surface is exactly `endpoint, token, project, once,
   poll-interval`. There is no claim/apply/dispatch/approve/settle mode to
   reach.

These controls are structural (`test/studio-monitors-read-only.test.ts`), not
prose assertions: any new flag, dependency, mutation marker, or direct network
call in a monitor script fails the suite.

## Deprecated aliases

`scripts/autonomous-worker-daemon.ts` and `scripts/night-shift-daemon.ts`
remain as thin read-only aliases so existing operator schedules do not break
silently. Each prints an explicit deprecation notice on stderr and forwards to
the renamed entry point. They add no capability and can be deleted once
operator schedules use the new names.

## Authority boundary

Unattended execution remains owned by the canonical supervisor/runner
lifecycle (durable claims, leases, generations, reservations, heartbeats,
checkpoints, settlement). These monitors deliberately sit outside it. Controls
for stale generation and expired lease claims are owned by the existing runner
tests (for example `test/claim-run-model.test.ts`,
`test/runner-command-authority.test.ts`, `test/leases.test.ts`) and are not
duplicated here.

Judgment provenance stays descriptive per #1661:
`src/independence-provenance.ts` reports provider/family/identity/harness/
instruction-lineage/context facts and literal prior-judgment exposure; it is
not a numeric independence oracle and grants no review authority.
