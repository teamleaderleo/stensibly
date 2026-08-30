# Stensibly-to-Lazy workstation adapter

The Lazy workstation adapter maps one exact Stensibly command reservation to
one repository-owned, observation-only Lazy owner profile. Stensibly remains
the work, claim, run-authority, command-replay, and settlement owner. Lazy gets
no work-acquisition or effect authority.

## Binding

`LazyWorkstationAdapterV1.prepare` checks the repository profile and freezes:

- project, item ID, and item claim generation;
- run ID, run generation, and lease generation;
- exact authority holder and expiry;
- upstream command ID and idempotency key;
- exact runner profile version, profile-manifest hash, source hash, and compiled
  owner-observation command hash; and
- every owner-profile parameter that repeats the authority binding.

`SqliteLazyWorkstationCommandLedgerV1` then checks the item claim and run lease
inside the same `BEGIN IMMEDIATE` transaction as the existing runner adapter
command reservation. It delegates durable replay and settlement to
`runner_adapter_commands`; it does not add another scheduler or replay ledger.

`bindLazyCampaignProposal` maps a strict Lazy campaign v2 acceptance proposal
onto that same reservation. The idempotency key is the transition ID, while the
command ID also includes a digest of the complete proposal. Exact replay thus
returns the existing command; changed proposal fields under the same transition
conflict in the existing immediate reservation transaction. The mapping records
requested Codex tokens but does not itself execute or authorize work and does
not create a second Stensibly budget or acceptance ledger.

The checked repository profile is
`.lazy/observation-profiles.json#stensibly-workstation-snapshot`. Its source,
`tools/lazy_workstation_snapshot.py`, opens the SQLite database read-only,
requires one exact item/run/reservation projection, and writes its detailed
result to a mode-0600 private file. Lazy returns only hashes and byte counts to
the adapter.

## Outcomes

- A fresh live reservation executes one owner observation and settles one
  bounded outcome.
- An exact settled retry returns `settled_replay`, including the original
  terminal hashes, even after authority expiry.
- An exact reserved-but-unsettled retry returns `ambiguous_reserved` and never
  calls the owner profile again.
- Changed stable input conflicts with the durable reservation.
- A new stale claim/run generation or expired authority conflicts before owner
  observation.

Every terminal receipt fixes `rawContentEmitted`, `containsPrivateContent`,
`containsCredentials`, `authorizesWork`, `authorizesEffects`, and
`authorizesRedispatch` to `false`.

## Local dogfood

Run from a clean isolated Stensibly worktree with a fresh output location:

```bash
bun scripts/dogfood-lazy-workstation-adapter.ts \
  --repository-root "$PWD" \
  --database "$PWD/.lazy/private/dogfood/stensibly.sqlite" \
  --observation-output-root "$PWD/.lazy/private/dogfood/observations" \
  --report /absolute/private/report.json \
  --lazy-owner-profiles-script /absolute/lazy-commander/scripts/owner_profiles.py
```

The dogfood intentionally refuses existing database, observation, or report
paths. This makes a run auditable and prevents accidental reuse of an old raw
observation directory.
